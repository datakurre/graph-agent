// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createHarnesses, stripCodeFence, type HarnessDeps } from "./harnesses.ts";
import type { HarnessContext } from "./harness.ts";
import { GraphRevisionConflictError, SessionStore } from "./session-store.ts";
import { ensurePaths, paths as resolvePaths } from "./paths.ts";
import { PiSession } from "./pi-session.ts";

function context(properties: Record<string, string>): HarnessContext {
  return { activityId: "run_it", harness: "shell", properties, input: {}, variables: {} };
}

/** The shell harness never touches pi/tools/store, so those can stay empty stubs. */
function shellHarness(cwd?: string) {
  const deps = {
    pi: {} as HarnessDeps["pi"],
    tools: {} as HarnessDeps["tools"],
    store: {} as HarnessDeps["store"],
    getGraph: () => "",
    setGraph: () => {},
    takeSteering: () => [],
    takeFollowUp: () => [],
    ...(cwd === undefined ? {} : { cwd }),
  };
  const harness = createHarnesses(deps).shell;
  if (!harness) throw new Error("no 'shell' harness registered");
  return harness;
}

describe("shell harness", () => {
  it("runs the command and reports a zero exit as success", async () => {
    const result = await shellHarness()(context({ command: "echo hi" }));
    expect(result.status).toBe("success");
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("fails the activity on a non-zero exit by default", async () => {
    const result = await shellHarness()(context({ command: "exit 3" }));
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(3);
  });

  it("reports a non-zero exit as success when fail_on_error is 'false'", async () => {
    const result = await shellHarness()(context({ command: "exit 3", fail_on_error: "false" }));
    expect(result.status).toBe("success");
    expect(result.exit_code).toBe(3);
  });

  it("runs the command in the configured cwd", async () => {
    const dir = realpathSync(tmpdir());
    const result = await shellHarness(dir)(context({ command: "pwd" }));
    expect(String(result.stdout).trim()).toBe(dir);
  });

  it("fails without running anything when no command is configured", async () => {
    const result = await shellHarness()(context({}));
    expect(result.status).toBe("failed");
  });
});

describe("graph:lint attempt counter (issue #31)", () => {
  function lintHarness(): { lint: NonNullable<ReturnType<typeof createHarnesses>["graph:lint"]>; store: SessionStore } {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-lint-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");
    const deps: HarnessDeps = {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => "<bpmn:definitions />",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
    const lint = createHarnesses(deps)["graph:lint"];
    if (!lint) throw new Error("no 'graph:lint' harness registered");
    return { lint, store };
  }

  it("counts attempts from its own closure rather than trusting context.variables.lint_attempts", async () => {
    const { lint } = lintHarness();

    // Every call reports variables exactly as an unresolved cross-process
    // round-trip would: lint_attempts is never there. The old implementation
    // read that as "no attempts yet" every single time and never reached
    // gw_lint's lint_attempts >= 3 cap (issue #31).
    const call = (): ReturnType<typeof lint> =>
      lint({ activityId: "lint_fragment", harness: "graph:lint", properties: {}, input: {}, variables: {} });

    const attempts = [await call(), await call()].map((r) => r.attempt);
    expect(attempts).toEqual([1, 2]);
  });

  it("gives up (throws) rather than trust gw_lint's own routing once the cap is reached (issue #34)", async () => {
    // gw_lint's `lint_attempts >= 3` gateway condition exists to route the cap
    // to craft_rejected, but a real run found bpmn-elements replay a stale
    // routing decision on a resumed run and redraft forever regardless of what
    // that condition evaluates to. Throwing on the terminal attempt does not
    // depend on that gateway at all.
    const { lint, store } = lintHarness();
    const call = (): ReturnType<typeof lint> =>
      lint({ activityId: "lint_fragment", harness: "graph:lint", properties: {}, input: {}, variables: {} });

    await call();
    await call();
    await expect(call()).rejects.toThrow(/gave up after 3 attempts/);

    // Recorded where the CLI can find it regardless of how bpmn-elements
    // re-wraps the thrown error crossing a callActivity boundary.
    expect(store.readMeta().harnessError).toMatch(/gave up after 3 attempts/);

    // Terminal (the cap was hit) starts the next, unrelated craft invocation
    // fresh rather than staying exhausted forever.
    expect((await call()).attempt).toBe(1);
  });
});

describe("graph:lint and graph:extend reject an unregistered job type (issue #40)", () => {
  const baseGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;

  function fragmentWith(jobType: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="run_it" />
    <bpmn:serviceTask id="run_it">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="${jobType}" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="run_it" targetRef="end" />
    <bpmn:endEvent id="end" />
  </bpmn:process>
</bpmn:definitions>`;
  }

  // graph:lint's input is now an ops list (GraphOp[], see src/agent/graph.ts),
  // not a full document -- graph:extend's stays a full document (it receives
  // whatever graph:lint already merged and published back onto `fragment`).
  function opsWith(jobType: string): string {
    return JSON.stringify([
      { op: "appendShape", type: "bpmn:ServiceTask", id: "run_it", after: "start" },
      { op: "setTaskDefinition", id: "run_it", jobType },
    ]);
  }

  function graphHarnesses(): ReturnType<typeof createHarnesses> {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-jobtype-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");
    const deps: HarnessDeps = {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => baseGraph,
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
    return createHarnesses(deps);
  }

  it("graph:lint rejects a fragment naming a job type nothing handles", async () => {
    const harnesses = graphHarnesses();
    const lint = harnesses["graph:lint"];
    if (!lint) throw new Error("no 'graph:lint' harness registered");

    const result = await lint({
      activityId: "lint_fragment",
      harness: "graph:lint",
      properties: {},
      input: { fragment: opsWith("shell:exec") },
      variables: {},
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/'shell:exec'/);
  });

  it("graph:lint accepts a fragment naming a real, registered job type", async () => {
    const harnesses = graphHarnesses();
    const lint = harnesses["graph:lint"];
    if (!lint) throw new Error("no 'graph:lint' harness registered");

    const result = await lint({
      activityId: "lint_fragment",
      harness: "graph:lint",
      properties: {},
      input: { fragment: opsWith("shell") },
      variables: {},
    });
    expect(result.status).toBe("success");
    expect(result.fragment).toContain('<zeebe:taskDefinition type="shell"');
  });

  it("graph:lint rejects a fragment naming an unsupported element type", async () => {
    const harnesses = graphHarnesses();
    const lint = harnesses["graph:lint"];
    if (!lint) throw new Error("no 'graph:lint' harness registered");

    const ops = JSON.stringify([{ op: "appendShape", type: "bpmn:InclusiveGateway", id: "gw", after: "start" }]);
    const result = await lint({
      activityId: "lint_fragment",
      harness: "graph:lint",
      properties: {},
      input: { fragment: ops },
      variables: {},
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/not supported/);
  });

  it("graph:extend also refuses to commit a fragment with an unregistered job type", async () => {
    // graph:lint is what feeds a redraft loop, but graph:extend is the actual
    // commit point ("before anything applies it") -- it must not trust that
    // something upstream already checked.
    const harnesses = graphHarnesses();
    const extend = harnesses["graph:extend"];
    if (!extend) throw new Error("no 'graph:extend' harness registered");

    const result = await extend({
      activityId: "apply_extension",
      harness: "graph:extend",
      properties: {},
      input: { fragment: fragmentWith("shell:exec") },
      variables: {},
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/'shell:exec'/);
  });
});

describe("graph:extend is a no-op on an empty splice (issue #60)", () => {
  const currentGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_session">
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;

  function extendHarness(setGraph: HarnessDeps["setGraph"]) {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-extend-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");
    const deps: HarnessDeps = {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => currentGraph,
      setGraph,
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
    const extend = createHarnesses(deps)["graph:extend"];
    if (!extend) throw new Error("no 'graph:extend' harness registered");
    return extend;
  }

  it("succeeds without calling setGraph when the fragment adds nothing", async () => {
    let calls = 0;
    const extend = extendHarness(() => {
      calls++;
    });

    // The model "drafted" the graph it was shown, unchanged -- a valid
    // additive splice (nothing removed or renamed) that adds zero elements.
    const result = await extend({
      activityId: "apply_extension",
      harness: "graph:extend",
      properties: {},
      input: { fragment: currentGraph },
      variables: {},
    });

    expect(result.status).toBe("success");
    expect(result.added).toEqual([]);
    expect(calls).toBe(0);
  });

  it("still calls setGraph, and reports what was added, for a genuine splice", async () => {
    const withMarker = currentGraph.replace(
      "<bpmn:startEvent id=\"start\" />",
      '<bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent><bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="marker" /><bpmn:endEvent id="marker"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>',
    );
    const setGraph = (
      _xml: string,
      _reason: string,
      added: string[],
    ) => {
      expect(added).toEqual(["f1", "marker"]);
    };
    const extend = extendHarness(setGraph);

    const result = await extend({
      activityId: "apply_extension",
      harness: "graph:extend",
      properties: {},
      input: { fragment: withMarker },
      variables: {},
    });
    expect(result.status).toBe("success");
    expect(result.added).toEqual(["f1", "marker"]);
  });

  it("passes the revision count read alongside the graph as setGraph's expectedIndex (issue #75)", async () => {
    const withMarker = currentGraph.replace(
      "<bpmn:startEvent id=\"start\" />",
      '<bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent><bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="marker" /><bpmn:endEvent id="marker"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>',
    );
    let seenExpectedIndex: number | undefined;
    const extend = extendHarness((_xml, _reason, _added, expectedIndex) => {
      seenExpectedIndex = expectedIndex;
    });

    await extend({
      activityId: "apply_extension",
      harness: "graph:extend",
      properties: {},
      input: { fragment: withMarker },
      variables: {},
    });
    // A freshly-created store has no revisions yet, so the splice this
    // handler validated is extending revision 0.
    expect(seenExpectedIndex).toBe(0);
  });

  it("reports a revision conflict as a failed splice instead of an uncaught throw (issue #75)", async () => {
    const withMarker = currentGraph.replace(
      "<bpmn:startEvent id=\"start\" />",
      '<bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent><bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="marker" /><bpmn:endEvent id="marker"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>',
    );
    // Simulates SessionStore.appendGraph rejecting the write because someone
    // else's revision landed first.
    const extend = extendHarness(() => {
      throw new GraphRevisionConflictError(3);
    });

    const result = await extend({
      activityId: "apply_extension",
      harness: "graph:extend",
      properties: {},
      input: { fragment: withMarker },
      variables: {},
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/revision 3/);
    expect(result.summary).toMatch(/retry/);
  });
});

describe("graph:layout strips a wrapping markdown fence (issue #37)", () => {
  function layoutHarness() {
    const deps = {
      pi: {} as HarnessDeps["pi"],
      tools: {} as HarnessDeps["tools"],
      store: {} as HarnessDeps["store"],
      getGraph: () => "",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    };
    const layout = createHarnesses(deps)["graph:layout"];
    if (!layout) throw new Error("no 'graph:layout' harness registered");
    return layout;
  }

  it("removes a ```xml fence a model wraps its draft in", async () => {
    const layout = layoutHarness();
    const fenced = '```xml\n<bpmn:definitions id="d"><bpmn:process id="p" /></bpmn:definitions>\n```';
    const bare = await layout({ activityId: "layout_fragment", harness: "graph:layout", properties: {}, input: { fragment: fenced }, variables: {} });
    // auto-layout only succeeds on real, unfenced BPMN XML -- a status of
    // "success" here proves the fence markers did not reach the parser.
    expect(bare.status).toBe("success");
  });

  it("leaves fragment text with no fence alone", async () => {
    const layout = layoutHarness();
    const plain = '<bpmn:definitions id="d"><bpmn:process id="p" /></bpmn:definitions>';
    const result = await layout({ activityId: "layout_fragment", harness: "graph:layout", properties: {}, input: { fragment: plain }, variables: {} });
    expect(result.status).toBe("success");
  });
});

describe("agent:turn consumes agent_role and lint_feedback (issue #37)", () => {
  it("layers the role's instructions and any redraft feedback in front of the graph's own prompt", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("<bpmn:definitions />")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => "<bpmn:definitions />",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "draft_fragment",
      harness: "agent:turn",
      properties: { agent_role: "graph_architect" },
      input: { prompt: "add a lint step", lint_feedback: "the fragment is not valid BPMN: unexpected end of file" },
      variables: {},
    });

    expect(sentUserText).toContain("no markdown code fences");
    expect(sentUserText).toContain("add a lint step");
    expect(sentUserText).toContain("the fragment is not valid BPMN: unexpected end of file");
  });

  it("gives graph_architect the current graph so an additive splice is possible", async () => {
    // checkSplice rejects a fragment that renames or drops any existing element
    // id; a real Haiku run showed the model has no way to honor that without
    // seeing what already exists, and reused nothing every single attempt.
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-graph-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("<bpmn:definitions />")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => '<bpmn:definitions id="craft_graph"><bpmn:startEvent id="craft_start" /></bpmn:definitions>',
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "draft_fragment",
      harness: "agent:turn",
      properties: { agent_role: "graph_architect" },
      input: { prompt: "add a lint step" },
      variables: {},
    });

    expect(sentUserText).toContain("craft_start");
    expect(sentUserText).toContain("current graph you are splicing into");
    // A single-process graph has nothing linked in, so no warning is needed.
    expect(sentUserText).not.toContain("Do not target a flow inside");
  });

  it("warns graph_architect away from a linked (isExecutable=false) process, which checkSplice would reject anyway (issue #86)", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-linked-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("<bpmn:definitions />")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const linkedGraph =
      '<bpmn:definitions id="session">' +
      '<bpmn:process id="session" isExecutable="true"><bpmn:startEvent id="root_start" /></bpmn:process>' +
      '<bpmn:process id="craft_graph" isExecutable="false"><bpmn:startEvent id="craft_start" /></bpmn:process>' +
      "</bpmn:definitions>";

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => linkedGraph,
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "draft_fragment",
      harness: "agent:turn",
      properties: { agent_role: "graph_architect" },
      input: { prompt: "add a step after the extension is applied" },
      variables: {},
    });

    expect(sentUserText).toContain("Do not target a flow inside");
    expect(sentUserText).toContain("craft_graph");
  });

  it("gives graph_architect the real job-type vocabulary so it does not invent one (issue #40)", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-jobtypes-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("<bpmn:definitions />")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => "<bpmn:definitions />",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "draft_fragment",
      harness: "agent:turn",
      properties: { agent_role: "graph_architect" },
      input: { prompt: "add a lint step" },
      variables: {},
    });

    // "shell" is a real registered job type; "shell:exec" is the invented one
    // issue #40 found the model reach for -- listing the real vocabulary means
    // there is no need to guess.
    expect(sentUserText).toContain("shell");
    expect(sentUserText).not.toContain("shell:exec");
    expect(sentUserText).toContain("zeebe:taskDefinition");
  });

  it("does not inject a current-graph block for roles that don't ask for it", async () => {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-role-none-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    faux.setResponses([fauxAssistantMessage([fauxText("ok")], { stopReason: "stop" })] as never);

    let sentUserText = "";
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "test",
      tools: [],
      sessionId: "s1",
      streamFn: (m, c, o) => {
        const messages = (c as { messages: Array<{ role: string; content: unknown }> }).messages;
        const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
        sentUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
        return faux.provider.streamSimple(m, c, o);
      },
    });

    const turn = createHarnesses({
      pi,
      tools: {} as HarnessDeps["tools"],
      store,
      getGraph: () => '<bpmn:definitions id="craft_graph"><bpmn:startEvent id="craft_start" /></bpmn:definitions>',
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
    })["agent:turn"];
    if (!turn) throw new Error("no 'agent:turn' harness registered");

    await turn({
      activityId: "some_turn",
      harness: "agent:turn",
      properties: {},
      input: { prompt: "say hi" },
      variables: {},
    });

    expect(sentUserText).not.toContain("craft_start");
    expect(sentUserText).not.toContain("current graph you are splicing into");
  });
});

describe("stripCodeFence", () => {
  it("strips standard 3-backtick fences with or without language tags", () => {
    expect(stripCodeFence("```json\n[{\"op\":\"appendShape\"}]\n```")).toBe("[{\"op\":\"appendShape\"}]");
    expect(stripCodeFence("```\n[{\"op\":\"appendShape\"}]\n```")).toBe("[{\"op\":\"appendShape\"}]");
  });

  it("strips fences with 4 or more backticks or tildes", () => {
    expect(stripCodeFence("````json\n[{\"op\":\"appendShape\"}]\n````")).toBe("[{\"op\":\"appendShape\"}]");
    expect(stripCodeFence("~~~xml\n<bpmn:definitions />\n~~~")).toBe("<bpmn:definitions />");
  });

  it("extracts embedded fenced block when surrounded by prose", () => {
    const text = "Here is the JSON:\n```json\n[{\"op\":\"appendShape\"}]\n```\nHope that helps!";
    expect(stripCodeFence(text)).toBe("[{\"op\":\"appendShape\"}]");
  });

  it("returns raw text when no fences are present", () => {
    expect(stripCodeFence("[{\"op\":\"appendShape\"}]")).toBe("[{\"op\":\"appendShape\"}]");
    expect(stripCodeFence("")).toBe("");
  });
});

describe("replay safety for interrupted calls (issue #117)", () => {
  function setup(cwd?: string) {
    const home = mkdtempSync(join(tmpdir(), "graph-agent-replay-"));
    const paths = ensurePaths(
      resolvePaths({ XDG_CONFIG_HOME: join(home, "c"), XDG_STATE_HOME: join(home, "s") } as NodeJS.ProcessEnv),
    );
    const store = new SessionStore(paths, "s1");
    store.create("/tmp/some-project");
    const resolved: Array<{ id: string; content: string; isError?: boolean }> = [];
    const ran: string[] = [];
    const registry = createHarnesses({
      pi: {
        pendingToolCalls: [],
        resolveTool: (id: string, o: { content: string; isError?: boolean }) => resolved.push({ id, ...o }),
      } as unknown as HarnessDeps["pi"],
      tools: {
        list: () => [],
        run: async (name: string) => {
          ran.push(name);
          return { content: "ran" };
        },
      } as HarnessDeps["tools"],
      store,
      getGraph: () => "",
      setGraph: () => {},
      takeSteering: () => [],
      takeFollowUp: () => [],
      ...(cwd === undefined ? {} : { cwd }),
    });
    const call = (name: string) =>
      registry["agent:tool"]!({
        activityId: "tool",
        harness: "agent:tool",
        properties: {},
        input: { tool_call: { id: "c1", name, arguments: {} } },
        variables: {},
      });
    return { store, resolved, ran, call, registry };
  }
  const marker = { name: "x", arguments: {}, activityId: "tool", startedAt: 1 };

  it("does not re-run an interrupted bash call; the model gets an interrupted error", async () => {
    const { store, resolved, ran, call } = setup();
    store.update((m) => (m.inflightTools = { c1: { ...marker, name: "bash" } }));
    await call("bash");
    expect(ran).toEqual([]);
    expect(resolved[0]?.isError).toBe(true);
    expect(resolved[0]?.content).toMatch(/Interrupted: .*bash.*not re-run/);
    expect(store.readMeta().inflightTools).toBeUndefined();
  });

  it("re-runs an interrupted read", async () => {
    const { store, ran, call } = setup();
    store.update((m) => (m.inflightTools = { c1: { ...marker, name: "read" } }));
    await call("read");
    expect(ran).toEqual(["read"]);
  });

  it("leaves no marker behind after a normal call", async () => {
    const { store, ran, call } = setup();
    await call("bash");
    expect(ran).toEqual(["bash"]);
    expect(store.readMeta().inflightTools).toBeUndefined();
  });

  it("fails an interrupted shell step naming the command instead of re-running it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-agent-replay-cwd-"));
    const { store, registry } = setup(dir);
    store.update((m) => (m.inflightTools = { "shell:run_it": { ...marker, name: "shell" } }));
    const result = await registry.shell!(context({ command: "touch ran.txt" }));
    expect(result.status).toBe("failed");
    expect(String(result.summary)).toContain("touch ran.txt");
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    expect(store.readMeta().inflightTools).toBeUndefined();
    // the next attempt is a fresh one
    const again = await registry.shell!(context({ command: "touch ran.txt" }));
    expect(again.status).toBe("success");
    expect(existsSync(join(dir, "ran.txt"))).toBe(true);
  });
});
