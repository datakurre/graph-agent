// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runSession, resumeSession, graphOffersTools, type RunSessionOptions } from "./runner.ts";
import { SessionStore } from "./session-store.ts";
import { createNoopToolExecutor } from "./tool-executor.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "./paths.ts";
import { bundledWorkflowsDir } from "./paths.ts";

let home: string;
let paths: Paths;
const project = "/tmp/some-project";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "graph-agent-run-"));
  paths = ensurePaths(
    resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
  );
});

function scripted(responses: unknown[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  faux.setResponses(responses as never);
  return faux;
}

function options(faux: ReturnType<typeof scripted>, extra: Record<string, unknown> = {}) {
  return {
    paths,
    project,
    graphPath: join(bundledWorkflowsDir(), "pi-default-loop.bpmn"),
    model: faux.getModel(),
    systemPrompt: "test agent",
    streamFn: ((m: never, context: never, o: never) => faux.provider.streamSimple(m, context, o)) as RunSessionOptions["streamFn"],
    tools: createNoopToolExecutor(["read", "bash"]),
    ...extra,
  };
}

describe("runSession on the built-in loop", () => {
  it("runs a turn with no tool calls straight to the end", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("Nothing to do.")], { stopReason: "stop" })]);
    const result = await runSession(options(faux, { prompt: "say hello" }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(1);

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns[0]?.stopReason).toBe("stop");
    expect(detail.turns[0]?.summary).toBe("Nothing to do.");
    expect(detail.project).toBe(project);
  });

  it("drives the tool batch and comes back for another turn", async () => {
    const faux = scripted([
      fauxAssistantMessage([fauxText("Looking."), fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("All done.")], { stopReason: "stop" }),
    ]);
    const result = await runSession(options(faux, { prompt: "read a.ts" }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    // one turn that called a tool, then one that finished
    expect(result.turns).toBe(2);

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns.map((t) => t.stopReason)).toEqual(["toolUse", "stop"]);
    expect(detail.turns[0]?.toolCalls).toEqual(["read"]);
    expect(detail.turns[0]?.toolCallDetails?.[0]?.name).toBe("read");
    expect(detail.turns[0]?.toolCallDetails?.[0]?.arguments).toEqual({ path: "a.ts" });
    expect(detail.turns[0]?.prompt).toContain("read a.ts");
    expect(detail.turns[0]?.response).toContain("Looking.");
    expect(detail.status).toBe("completed");

    const transcript = new SessionStore(paths, result.sessionId).readTranscript();
    expect(transcript.length).toBeGreaterThan(0);
  });

  it("reads the later turn's prompt prefix from cache", async () => {
    // The whole reason one Pi session spans the session: turn two must not pay
    // for turn one's context again.
    const faux = scripted([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Done.")], { stopReason: "stop" }),
    ]);
    const result = await runSession(options(faux, { prompt: "read a.ts and summarise it for me" }));

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns).toHaveLength(2);
    expect(detail.turns[0]?.usage?.cacheRead).toBe(0);
    expect(detail.turns[1]?.usage?.cacheRead).toBeGreaterThan(0);
  });

  it("records a graph revision and the project it ran in", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("hi")], { stopReason: "stop" })]);
    const result = await runSession(options(faux, { prompt: "hi", name: "named run" }));

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.name).toBe("named run");
    expect(detail.revisions).toHaveLength(1);
    expect(detail.graph).toContain("pi_default_loop");
  });

  it("leaves no token behind on a completed run", async () => {
    // Token reports come from getPostponed() as the run proceeds, so the last
    // one seen is whatever was in flight. A finished run must not keep drawing a
    // token on the diagram.
    const faux = scripted([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const result = await runSession(options(faux, { prompt: "go" }));
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.tokens).toEqual([]);
    expect(detail.visited.length).toBeGreaterThan(0);
  });

  it("takes the failure branch when the model errors", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("")], { stopReason: "error" })]);
    const result = await runSession(options(faux, { prompt: "go" }));

    // the loop terminates rather than looping forever, and reports the failure
    // rather than looking like any other completed run (issue #18)
    expect(result.outcome).toBe("error");
    // Names the real, known fact (which turn's own stopReason was "error"
    // with no message) rather than the fabricated "llm_turn stopped: error"
    // this used to assert -- the engine itself never reported an error here,
    // it reached a plain terminate end event (issue #52).
    expect(result.error?.message).toContain("llm_turn");
    expect(result.error?.message).toContain('stopReason "error"');
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.status).toBe("error");
    expect(detail.turns[0]?.stopReason).toBe("error");
    expect(detail.harnessError).toBe(result.error?.message);
  });

  it("does not re-send the initial prompt once the transcript has a tool result (issue #25)", async () => {
    const faux = scripted([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const userMessageCounts: number[] = [];
    const streamFn = ((m: never, context: never, o: never) => {
      const messages = (context as { messages: Array<{ role: string }> }).messages;
      userMessageCounts.push(messages.filter((message) => message.role === "user").length);
      return faux.provider.streamSimple(m, context, o);
    }) as RunSessionOptions["streamFn"];

    const result = await runSession(options(faux, { prompt: "run echo hi", streamFn }));

    expect(result.error).toBeUndefined();
    expect(result.turns).toBe(2);
    // Both requests saw exactly one user message: the loop's second llm_turn
    // continues the same transcript on the tool result rather than handing the
    // model its own original request again as a fresh one.
    expect(userMessageCounts).toEqual([1, 1]);
  });

  it("runs each call in a multi-call batch exactly once (issue #27)", async () => {
    const faux = scripted([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "echo A" }), fauxToolCall("bash", { command: "echo B" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const ran: string[] = [];
    const tools = {
      list: () => [{ name: "bash", description: "Run a bash command.", parameters: { type: "object", additionalProperties: true } }],
      run: async (name: string, args: Record<string, unknown>) => {
        ran.push(`${name} ${JSON.stringify(args)}`);
        return { content: "ok" };
      },
    };

    const result = await runSession(options(faux, { prompt: "run two commands", tools }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(ran).toEqual(['bash {"command":"echo A"}', 'bash {"command":"echo B"}']);
  });
});

describe("callActivity into the shared library", () => {
  /** A caller and a callee that live in two different files, as they would. */
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

  const caller = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_caller" ${NS}>
  <bpmn:process id="caller" isExecutable="true">
    <bpmn:startEvent id="k_start"><bpmn:outgoing>kf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="kf1" sourceRef="k_start" targetRef="k_call" />
    <bpmn:callActivity id="k_call" name="Delegate" calledElement="helper">
      <bpmn:incoming>kf1</bpmn:incoming><bpmn:outgoing>kf2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="kf2" sourceRef="k_call" targetRef="k_end" />
    <bpmn:endEvent id="k_end"><bpmn:incoming>kf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  const helper = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_helper" ${NS}>
  <bpmn:process id="helper" isExecutable="true">
    <bpmn:startEvent id="h_start"><bpmn:outgoing>hf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="hf1" sourceRef="h_start" targetRef="h_turn" />
    <bpmn:serviceTask id="h_turn" name="Helper turn">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping><zeebe:input source="=prompt" target="prompt" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>hf1</bpmn:incoming><bpmn:outgoing>hf2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="hf2" sourceRef="h_turn" targetRef="h_end" />
    <bpmn:endEvent id="h_end"><bpmn:incoming>hf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  function libraryWith(files: Record<string, string>): void {
    for (const [name, xml] of Object.entries(files)) {
      writeFileSync(join(paths.workflowsDir, name), xml);
    }
  }

  it("runs a process that lives in another file in the library", async () => {
    // bpmn-elements resolves calledElement only within one definition, so
    // without linking this call would park forever instead of running.
    libraryWith({ "caller.bpmn": caller, "helper.bpmn": helper });
    const faux = scripted([fauxAssistantMessage([fauxText("helped")], { stopReason: "stop" })]);
    const result = await runSession(
      options(faux, { graphPath: join(paths.workflowsDir, "caller.bpmn"), prompt: "delegate this" }),
    );

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");

    const detail = new SessionStore(paths, result.sessionId).detail();
    // the callee's own activity ran, so the call resolved across files
    expect(detail.visited).toContain("h_turn");
    expect(detail.turns[0]?.activityId).toBe("h_turn");
    expect(detail.revisions[0]?.reason).toMatch(/linked helper/);
  });

  it("stores the linked graph with the callee marked non-executable", async () => {
    // Left executable, the callee is auto-started as a top-level process as well
    // as being called, and its body runs twice.
    libraryWith({ "caller.bpmn": caller, "helper.bpmn": helper });
    const faux = scripted([fauxAssistantMessage([fauxText("helped")], { stopReason: "stop" })]);
    const result = await runSession(
      options(faux, { graphPath: join(paths.workflowsDir, "caller.bpmn"), prompt: "go" }),
    );

    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.graph).toMatch(/<bpmn:process id="helper"[^>]*isExecutable="false"/);
    expect(detail.graph).toMatch(/<bpmn:process id="caller"[^>]*isExecutable="true"/);
    // the helper ran exactly once, not once as a root and once through the call
    expect(detail.turns).toHaveLength(1);
  });

  it("refuses to start when a calledElement is not in the library", async () => {
    libraryWith({ "caller.bpmn": caller });
    const faux = scripted([fauxAssistantMessage([fauxText("x")], { stopReason: "stop" })]);
    await expect(
      runSession(options(faux, { graphPath: join(paths.workflowsDir, "caller.bpmn"), prompt: "go" })),
    ).rejects.toThrow(/no graph in the library defines a process 'helper'/);
  });
});

describe("resumeSession", () => {
  it("refuses a session that was never run", () => {
    return expect(
      resumeSession({ ...options(scripted([])), sessionId: "nope" } as never),
    ).rejects.toThrow(/unknown session/);
  });
});

describe("graphOffersTools (issue #36)", () => {
  it("is true for a graph with an agent:tool activity, false for one without", () => {
    const withTools = readFileSync(join(bundledWorkflowsDir(), "pi-default-loop.bpmn"), "utf8");
    const withoutTools = readFileSync(join(bundledWorkflowsDir(), "craft-graph.bpmn"), "utf8");
    expect(graphOffersTools(withTools)).toBe(true);
    expect(graphOffersTools(withoutTools)).toBe(false);
  });
});

describe("a splice executes in the same run that drafted it (issue #45)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

  // draft (agent:turn) drafts a whole replacement definition, extend
  // (graph:extend) splices it in. Mirrors craft-graph.bpmn's own
  // draft_fragment -> apply_extension shape, minus the layout/lint/approval
  // steps this test does not need.
  const original = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_splice_test" ${NS}>
  <bpmn:process id="splice_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  // What the model "drafts": same ids throughout (additive, per checkSplice),
  // but f3 now targets a new `marker` shell step before reaching `end`.
  const spliced = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_splice_test" ${NS}>
  <bpmn:process id="splice_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="marker" />
    <bpmn:serviceTask id="marker" name="Marker">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
        <zeebe:taskHeaders>
          <zeebe:header key="command" value="echo spliced" />
        </zeebe:taskHeaders>
        <zeebe:ioMapping><zeebe:output source="=stdout" target="marker_output" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f4" sourceRef="marker" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  it("runs the spliced-in activity within the same run, not just the next resume", async () => {
    const graphPath = join(home, "splice_test.bpmn");
    writeFileSync(graphPath, original);
    const faux = scripted([fauxAssistantMessage([fauxText(spliced)], { stopReason: "stop" })]);

    // `shell`'s marker step needs a real cwd to spawn in -- the shared
    // `project` constant is a placeholder path that does not exist on disk.
    const result = await runSession(options(faux, { graphPath, project: home, prompt: "splice in a marker step" }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");

    const detail = new SessionStore(paths, result.sessionId).detail();
    // Before the fix, `marker` never ran in this run -- only a *subsequent*
    // `resume` would pick up the new revision and reach it.
    expect(detail.visited).toContain("marker");
    expect(detail.revisions.length).toBe(2);
    // Issue #59: the splice re-entry above is a second pass through the
    // engine (a fresh `visited` set per `resumeGraph` call) -- `draft` and
    // `extend` only ran in the *first* pass. Before the fix, `onTokens`
    // replaced `meta.visited` wholesale on the re-entry's own token moves,
    // so the studio's migration guard would stop protecting them the moment
    // the splice landed, even though both are still live (the token passed
    // through them to get here, and `Definition.recover()` would replay
    // their state by id on any future resume).
    expect(detail.visited).toContain("draft");
    expect(detail.visited).toContain("extend");
  });

  it("bounds re-entry against a graph that never stops growing", async () => {
    // draft -> extend loops back to draft unconditionally, with no end event
    // reachable at all; each "draft" turn adds one more, genuinely new marker
    // element (issue #60 made an unchanged fragment a no-op that never
    // triggers a splice-forced stop at all, so a loop that never actually
    // adds anything is now bounded by BPMN itself having nowhere else to go
    // -- not by this re-entry cap. What this still has to bound is a splice
    // that keeps genuinely growing the graph, which is exactly what
    // session-skeleton's own outer loop does in practice, re-invoking
    // craft_graph with a fresh intent each lap).
    const loopGraph = (n: number): string => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_loop_splice" ${NS}>
  <bpmn:process id="loop_splice" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gw_loop" />
    <bpmn:exclusiveGateway id="gw_loop">
      <bpmn:incoming>f1</bpmn:incoming>
      <bpmn:incoming>loop</bpmn:incoming>
      <bpmn:outgoing>to_draft</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:sequenceFlow id="to_draft" sourceRef="gw_loop" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>to_draft</bpmn:incoming>
      <bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>loop</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="loop" sourceRef="extend" targetRef="gw_loop" />
    ${Array.from(
      { length: n },
      // A plain <bpmn:task> used to work as a throwaway "something new" marker,
      // but checkSplice now also rejects an element type this project's
      // runtime doesn't support (src/js/lib/supported-bpmn-elements.ts) --
      // graph:extend applies that check too, so an unsupported marker would
      // fail every splice here and this test would never see the bounded
      // re-entry behaviour it exists to check at all. A bare bpmn:serviceTask
      // naming a real, registered job type satisfies every layer of
      // checkSplice (element type, job type, and the I/O contract, trivially,
      // since it maps no zeebe:input/taskHeaders/output at all).
      (_, i) =>
        `<bpmn:serviceTask id="marker_${i}"><bpmn:extensionElements><zeebe:taskDefinition type="shell" /></bpmn:extensionElements></bpmn:serviceTask>`,
    ).join("\n    ")}
  </bpmn:process>
</bpmn:definitions>`;

    const graphPath = join(home, "loop_splice_test.bpmn");
    writeFileSync(graphPath, loopGraph(0));
    // Each turn's draft adds one more marker than the last -- always
    // additive, always accepted, always a genuine (non-empty) splice.
    const faux = scripted(
      Array.from({ length: 20 }, (_, i) => fauxAssistantMessage([fauxText(loopGraph(i + 1))], { stopReason: "stop" })),
    );

    const result = await runSession(options(faux, { graphPath, prompt: "splice forever" }));

    // Settles rather than hanging (the test's own timeout would otherwise
    // catch that) and stops rather than completing, since the graph itself
    // has no end event this can ever reach.
    expect(result.outcome).toBe("stopped");
    expect(result.turns).toBeLessThanOrEqual(6);
  }, 10000);

  it("an unchanged fragment does not trigger a splice re-entry at all (issue #60)", async () => {
    const graphPath = join(home, "noop_splice_test.bpmn");
    writeFileSync(graphPath, original);
    // "draft" echoes the graph back completely unchanged -- checkSplice
    // accepts it (nothing removed or renamed), but there is nothing to add.
    const faux = scripted([fauxAssistantMessage([fauxText(original)], { stopReason: "stop" })]);

    const result = await runSession(options(faux, { graphPath, project: home, prompt: "nothing to add" }));

    expect(result.error).toBeUndefined();
    // Before the fix, `graph:extend` committing a no-op still forced a
    // stop-and-resume re-entry, appending an identical revision each time.
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.revisions.length).toBe(1);
  });
});

describe("a studio edit landing mid-run is not silently discarded (issue #75)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

  // Same shape as the #45 splice test: draft (agent:turn) drafts a whole
  // replacement definition, extend (graph:extend) splices it in.
  const original = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_studio_edit_test" ${NS}>
  <bpmn:process id="studio_edit_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  // What the model "drafts" from `original` -- it has no way to know about a
  // studio edit that lands while it is thinking, so this is additive relative
  // to `original` alone, not relative to whatever is on disk by the time it
  // resolves.
  const spliced = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_studio_edit_test" ${NS}>
  <bpmn:process id="studio_edit_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="marker" />
    <bpmn:serviceTask id="marker" name="Marker">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
        <zeebe:taskHeaders>
          <zeebe:header key="command" value="echo spliced" />
        </zeebe:taskHeaders>
        <zeebe:ioMapping><zeebe:output source="=stdout" target="marker_output" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f4" sourceRef="marker" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  it("picks up a revision another process appended while `draft` was still in flight, and never overwrites it", async () => {
    const graphPath = join(home, "studio_edit_test.bpmn");
    writeFileSync(graphPath, original);
    const sessionId = "studio-edit-1";

    const faux = scripted([fauxAssistantMessage([fauxText(spliced)], { stopReason: "stop" })]);
    let edited = false;
    // Simulate a studio `PUT /api/sessions/:id/graph` landing while `draft`
    // is still running: a *second* SessionStore instance (a separate
    // process, in reality) appends a revision this run's own drive() never
    // called setGraph for.
    const streamFn = ((m: never, context: never, o: never) => {
      if (!edited) {
        edited = true;
        const studioStore = new SessionStore(paths, sessionId);
        const current = studioStore.currentGraph() ?? "";
        const withStudioEdit = current.replace(
          "</bpmn:process>",
          '<bpmn:task id="studio_added" name="Studio added" /></bpmn:process>',
        );
        studioStore.appendGraph(withStudioEdit, "studio edit", ["studio_added"]);
      }
      return faux.provider.streamSimple(m, context, o);
    }) as RunSessionOptions["streamFn"];

    const progress: string[] = [];
    const result = await runSession(
      options(faux, {
        graphPath,
        project: home,
        sessionId,
        streamFn,
        prompt: "splice in a marker step",
        onProgress: (line: string) => progress.push(line),
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");

    // The mid-run pickup is reported on a progress line (issue #75's own
    // acceptance criterion), naming it as an external revision rather than
    // this run's own splice.
    expect(progress.some((line) => /revision \d+ applied externally, resuming/.test(line))).toBe(true);

    const detail = new SessionStore(paths, sessionId).detail();
    // The studio edit survives as the final graph -- not overwritten by
    // `extend` committing a fragment drafted from the pre-edit graph, which
    // is exactly what issue #75 reports: checkSplice must compare against
    // what is actually on disk, not a cached copy, so it catches "draft"'s
    // fragment silently dropping `studio_added` and refuses to commit it.
    expect(detail.graph).toContain("studio_added");
    expect(detail.revisions).toHaveLength(2);
  });
});

describe("hang guard and phantom-running status (issue #52)", () => {
  it('never leaves status:"running" when resuming throws before the engine settles', async () => {
    // runSession's own linkGraph/appendGraph setup runs before drive() is ever
    // called, so a broken *graph* throws before status even becomes
    // "running" -- not the gap this guards. resumeSession's start() callback
    // (resumeGraph) is invoked from *inside* drive(), after status:"running"
    // is already written, so a state snapshot bpmn-elements' own recovery
    // cannot make sense of is what actually exercises the gap issue #52
    // found: nothing between such a throw and the ordinary return path wrote
    // a terminal status.
    //
    // The session must be genuinely parked ("wait"), not completed -- issue
    // #63 gives a *completed* session its own, earlier refusal, which would
    // otherwise short-circuit this test before it ever reaches the corrupted
    // engine state this is actually about.
    const NS =
      'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
    const parkGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_park_test" ${NS}>
  <bpmn:process id="park_test" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
    const graphPath = join(home, "park_test.bpmn");
    writeFileSync(graphPath, parkGraph);

    const first = await runSession(options(scripted([]), { graphPath, hangGuardMs: 50 }));
    expect(first.outcome).toBe("stopped");
    expect(new SessionStore(paths, first.sessionId).readMeta().status).toBe("wait");

    const store = new SessionStore(paths, first.sessionId);
    store.writeEngineState({ nonsense: true, definitions: "not an array" });

    await expect(
      resumeSession({ ...options(scripted([]), { hangGuardMs: 50 }), sessionId: first.sessionId }),
    ).rejects.toThrow();

    const meta = store.readMeta();
    expect(meta.status).toBe("error");
    expect(meta.pid).toBeUndefined();
    expect(meta.harnessError).toBeDefined();
  });
});

describe("resume refuses a completed session outright (issue #63)", () => {
  it("rejects fast, with a clear message, instead of stalling on the hang guard", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const first = await runSession(options(faux, { prompt: "say hello", hangGuardMs: 5000 }));
    expect(first.outcome).toBe("completed");

    const store = new SessionStore(paths, first.sessionId);
    const before = store.readMeta();

    const startedAt = Date.now();
    await expect(
      resumeSession({ ...options(scripted([]), { hangGuardMs: 5000 }), sessionId: first.sessionId }),
    ).rejects.toThrow(/already completed/);
    // Well under the 5s hang guard configured above -- this must never reach
    // resumeGraph (let alone wait out its guard) at all.
    expect(Date.now() - startedAt).toBeLessThan(1000);

    // meta.json is untouched -- not even `updatedAt` -- since the refusal
    // happens before any store.update() call.
    expect(store.readMeta()).toEqual(before);
  });
});

describe("studio-queued answers (issue #51)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const gateGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_answer_test" ${NS}>
  <bpmn:process id="answer_test" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="gate_form">{"components":[{"key":"key","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="Gate">
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="gate_form" />
        <zeebe:ioMapping><zeebe:output source="=key" target="answered_key" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  it("onWait consumes a studio-queued answer before falling back to the caller's own onWait", async () => {
    const graphPath = join(home, "answer_test.bpmn");
    writeFileSync(graphPath, gateGraph);

    const first = await runSession(options(scripted([]), { graphPath, hangGuardMs: 50 }));
    expect(first.outcome).toBe("stopped");

    const store = new SessionStore(paths, first.sessionId);
    store.queueAnswer("gate", { key: "from the studio" });

    let callerOnWaitCalled = false;
    const second = await resumeSession({
      ...options(scripted([]), { hangGuardMs: 50 }),
      sessionId: first.sessionId,
      onWait: () => {
        callerOnWaitCalled = true;
        return undefined;
      },
    });

    expect(second.outcome).toBe("completed");
    expect(callerOnWaitCalled).toBe(false);
    // Consumed, not left behind for a second resume to replay.
    expect(store.takeAnswer("gate")).toBeUndefined();
  });

  it("falls back to the caller's own onWait when nothing is queued", async () => {
    const graphPath = join(home, "answer_test2.bpmn");
    writeFileSync(graphPath, gateGraph);

    const first = await runSession(options(scripted([]), { graphPath, hangGuardMs: 50 }));
    expect(first.outcome).toBe("stopped");

    const second = await resumeSession({
      ...options(scripted([]), { hangGuardMs: 50 }),
      sessionId: first.sessionId,
      onWait: () => ({ key: "from --answer" }),
    });
    expect(second.outcome).toBe("completed");
  });
});

describe("steering and follow-up queues (issue #48)", () => {
  it("a seeded follow-up drives a second outer iteration", async () => {
    // With no tool calls the agent would stop here -- pi-default-loop's own
    // drain_followup is exactly the seam that decides whether the outer loop
    // takes another lap. Before this fix nothing ever filled the queue it
    // drains, so gw_followup's has_followup branch was unreachable.
    const faux = scripted([
      fauxAssistantMessage([fauxText("first turn done")], { stopReason: "stop" }),
      fauxAssistantMessage([fauxText("second turn done")], { stopReason: "stop" }),
    ]);

    const result = await runSession(options(faux, { prompt: "go", followUp: ["now write a test"] }));

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(2);
  });

  it("a seeded steering message is injected before the next turn", async () => {
    // agent:steer calls pi.steer() for each queued message; the only
    // observable effect from outside PiSession is that the next turn's
    // request transcript carries it as an extra user message.
    const faux = scripted([fauxAssistantMessage([fauxText("ok")], { stopReason: "stop" })]);
    let sawSteerMessage = false;
    const streamFn = ((m: never, context: never, o: never) => {
      const messages = (context as { messages: Array<{ role: string; content?: unknown }> }).messages;
      sawSteerMessage ||= messages.some(
        (message) => message.role === "user" && JSON.stringify(message.content).includes("focus on tests"),
      );
      return faux.provider.streamSimple(m, context, o);
    }) as RunSessionOptions["streamFn"];

    const result = await runSession(options(faux, { prompt: "go", steering: ["focus on tests"], streamFn }));

    expect(result.error).toBeUndefined();
    expect(sawSteerMessage).toBe(true);
  });

  it("graph-agent steer/follow-up queue into a session's inbox, drained by the running graph", async () => {
    // The out-of-band seam: a message queued into inbox.jsonl from outside
    // the process driving the session (SessionStore.queueInbox, what the CLI
    // commands write to) reaches the graph the same way a seeded one does.
    const faux = scripted([
      fauxAssistantMessage([fauxText("first turn done")], { stopReason: "stop" }),
      fauxAssistantMessage([fauxText("second turn done")], { stopReason: "stop" }),
    ]);
    const sessionId = "inbox-session";
    const store = new SessionStore(paths, sessionId);
    store.create(project);
    store.queueInbox("follow-up", "queued from another terminal");

    const result = await runSession({ ...options(faux, { prompt: "go" }), sessionId });

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(2);
    // Drained, not left behind for the next run to see again.
    expect(store.drainInbox("follow-up")).toEqual([]);
  });
});

describe("resume restores the Pi transcript (issue #115)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const gated = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_gated" ${NS}>
  <bpmn:process id="gated" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="gate_form">{"components":[{"key":"ok","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="turn1" />
    <bpmn:serviceTask id="turn1"><bpmn:extensionElements><zeebe:taskDefinition type="agent:turn" />
      <zeebe:ioMapping><zeebe:input source="=prompt" target="prompt" /></zeebe:ioMapping></bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="turn1" targetRef="gate" />
    <bpmn:userTask id="gate" name="Gate"><bpmn:extensionElements><zeebe:userTask />
      <zeebe:formDefinition formId="gate_form" /></bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing></bpmn:userTask>
    <bpmn:sequenceFlow id="f3" sourceRef="gate" targetRef="turn2" />
    <bpmn:serviceTask id="turn2"><bpmn:extensionElements><zeebe:taskDefinition type="agent:turn" />
      <zeebe:ioMapping><zeebe:input source="=&quot;second prompt&quot;" target="prompt" /></zeebe:ioMapping></bpmn:extensionElements>
      <bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing></bpmn:serviceTask>
    <bpmn:sequenceFlow id="f4" sourceRef="turn2" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  function userTexts(messages: unknown[]): string[] {
    return (messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
  }

  it("shows the model what was said before the gate, and keeps it on disk", async () => {
    const graphPath = join(home, "gated.bpmn");
    writeFileSync(graphPath, gated);

    const first = await runSession(
      options(scripted([fauxAssistantMessage([fauxText("one")], { stopReason: "stop" })]), {
        graphPath,
        prompt: "first prompt",
        hangGuardMs: 50,
      }),
    );
    expect(first.outcome).toBe("stopped");
    const store = new SessionStore(paths, first.sessionId);
    expect(userTexts(store.readTranscript())).toEqual(["first prompt"]);

    const requests: Array<{ messages: unknown[] }> = [];
    const faux = scripted([fauxAssistantMessage([fauxText("two")], { stopReason: "stop" })]);
    const second = await resumeSession({
      ...options(faux, { hangGuardMs: 50 }),
      streamFn: ((m: never, context: { messages: unknown[] }, o: never) => {
        requests.push({ messages: [...context.messages] });
        return faux.provider.streamSimple(m, context as never, o);
      }) as unknown as RunSessionOptions["streamFn"],
      sessionId: first.sessionId,
      onWait: () => ({ ok: "1" }),
    });
    expect(second.outcome).toBe("completed");

    expect(userTexts(requests[0]!.messages).join("|")).toContain("first prompt");
    expect(userTexts(store.readTranscript())).toEqual(["first prompt", "second prompt"]);
  });

  it("writeTranscript refuses to write less than is on disk", () => {
    const store = new SessionStore(paths, "shrink");
    store.create(project);
    store.writeTranscript([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    expect(() => store.writeTranscript([{ role: "user", content: "b" }])).toThrow(/refusing to overwrite/);
  });
});

describe("checkpoints after every activity (issue #116)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const turn = (id: string, prompt: string, from: string, to: string) =>
    `<bpmn:serviceTask id="${id}"><bpmn:extensionElements><zeebe:taskDefinition type="agent:turn" />
      <zeebe:ioMapping><zeebe:input source="=&quot;${prompt}&quot;" target="prompt" /></zeebe:ioMapping></bpmn:extensionElements>
      <bpmn:incoming>${from}</bpmn:incoming><bpmn:outgoing>${to}</bpmn:outgoing></bpmn:serviceTask>`;
  const three = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_three" ${NS}>
  <bpmn:process id="three" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="turn1" />
    ${turn("turn1", "p1", "f1", "f2")}
    <bpmn:sequenceFlow id="f2" sourceRef="turn1" targetRef="turn2" />
    ${turn("turn2", "p2", "f2", "f3")}
    <bpmn:sequenceFlow id="f3" sourceRef="turn2" targetRef="turn3" />
    ${turn("turn3", "p3", "f3", "f4")}
    <bpmn:sequenceFlow id="f4" sourceRef="turn3" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f4</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  it("has turn1 on disk while turn2 runs, and a snapshot from then resumes without re-sending turn1", async () => {
    const graphPath = join(home, "three.bpmn");
    writeFileSync(graphPath, three);
    const say = (t: string) => fauxAssistantMessage([fauxText(t)], { stopReason: "stop" });
    let snapshot: { id: string } | undefined;
    let onDisk: { transcript: number; state: boolean } | undefined;
    const faux = scripted([say("a"), say("b"), say("c")]);
    const first = await runSession(
      options(faux, {
        graphPath,
        prompt: "go",
        onActivity: (a: { activityId: string }) => {
          if (a.activityId !== "turn2") return;
          const sid = readdirSync(paths.sessionsDir)[0]!;
          const dir = join(paths.sessionsDir, sid);
          onDisk = {
            transcript: new SessionStore(paths, sid).readTranscript().length,
            state: existsSync(join(dir, "engine.json")),
          };
          const copy = join(paths.sessionsDir, "crashed");
          cpSync(dir, copy, { recursive: true });
          snapshot = { id: "crashed" };
        },
      }),
    );
    expect(first.outcome).toBe("completed");
    // user + assistant of turn1 at minimum
    expect(onDisk?.transcript).toBeGreaterThanOrEqual(2);
    expect(onDisk?.state).toBe(true);

    const crashed = new SessionStore(paths, snapshot!.id);
    crashed.update((m) => {
      m.id = "crashed";
      m.status = "running";
      m.pid = 2 ** 22 - 1;
    });
    const requests: unknown[][] = [];
    const faux2 = scripted([say("b2"), say("c2")]);
    const second = await resumeSession({
      ...options(faux2),
      streamFn: ((m: never, context: { messages: unknown[] }, o: never) => {
        requests.push([...context.messages]);
        return faux2.provider.streamSimple(m, context as never, o);
      }) as unknown as RunSessionOptions["streamFn"],
      sessionId: "crashed",
    });
    expect(second.outcome).toBe("completed");
    // Only the turns after the checkpoint were sent (turn1 was not re-run).
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(crashed.readTranscript().length).toBeGreaterThanOrEqual(6);
  });
});

describe("a splice that adds agent:tool enables tools mid-session (issue #118)", () => {
  const NS =
    'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
  const head = (tail: string, fromExtend: string) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_late_tools" ${NS}>
  <bpmn:process id="late_tools" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="draft" />
    <bpmn:serviceTask id="draft" name="Draft">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:input source="=prompt" target="prompt" />
          <zeebe:output source="=text" target="fragment" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="draft" targetRef="extend" />
    <bpmn:serviceTask id="extend" name="Extend">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="graph:extend" />
        <zeebe:ioMapping><zeebe:input source="=fragment" target="fragment" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="extend" targetRef="${fromExtend}" />
    ${tail}
  </bpmn:process>
</bpmn:definitions>`;
  const original = head(`<bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>`, "end");
  const spliced = head(
    `<bpmn:serviceTask id="ask" name="Ask">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping><zeebe:input source="=&quot;now read a.ts&quot;" target="prompt" /></zeebe:ioMapping>
      </bpmn:extensionElements>
      <bpmn:incoming>f3</bpmn:incoming><bpmn:outgoing>f4</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f4" sourceRef="ask" targetRef="run_tool" />
    <bpmn:serviceTask id="run_tool" name="Run tool">
      <bpmn:extensionElements><zeebe:taskDefinition type="agent:tool" /></bpmn:extensionElements>
      <bpmn:incoming>f4</bpmn:incoming><bpmn:outgoing>f5</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f5" sourceRef="run_tool" targetRef="collect" />
    <bpmn:serviceTask id="collect" name="Collect">
      <bpmn:extensionElements><zeebe:taskDefinition type="agent:collect-tools" /></bpmn:extensionElements>
      <bpmn:incoming>f5</bpmn:incoming><bpmn:outgoing>f6</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f6" sourceRef="collect" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f6</bpmn:incoming></bpmn:endEvent>`,
    "ask",
  );

  it("declares the tools to the model on the turn after the splice, and routes its call", async () => {
    const graphPath = join(home, "late_tools.bpmn");
    writeFileSync(graphPath, original);
    const faux = scripted([
      fauxAssistantMessage([fauxText(spliced)], { stopReason: "stop" }),
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" }),
    ]);
    const declared: string[][] = [];
    const progress: string[] = [];
    const result = await runSession(
      options(faux, {
        graphPath,
        project: home,
        prompt: "splice in a tool step",
        onProgress: (line: string) => progress.push(line),
        streamFn: ((m: never, context: { tools?: Array<{ name: string }>; messages: Array<{ role: string; toolsAdded?: Array<{ name: string }> }> }, o: never) => {
          declared.push([
            ...(context.tools ?? []).map((t) => t.name),
            ...context.messages.flatMap((msg) => (msg.role === "system" ? (msg.toolsAdded ?? []).map((t) => t.name) : [])),
          ]);
          return faux.provider.streamSimple(m, context as never, o);
        }) as unknown as RunSessionOptions["streamFn"],
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.outcome).toBe("completed");
    expect(progress.join("\n")).toContain("graph now offers tools");
    expect(declared[0]).toEqual([]);
    expect(declared[1]).toContain("read");
    const detail = new SessionStore(paths, result.sessionId).detail();
    expect(detail.turns[1]?.toolCalls).toEqual(["read"]);
    expect(detail.turns[1]?.toolCallDetails?.[0]?.result).toBeDefined();
  });
});
