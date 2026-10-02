// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runGraph, resumeGraph, type ActivityOutcome } from "./engine.ts";
import { ok, type Harness, type HarnessContext } from "./harness.ts";

const DEFS = 'id="Defs_t" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

/** start -> turn (harness) -> XOR on the harness's status -> done | failed */
const routed = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <serviceTask id="turn" name="Agent turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:taskHeaders>
          <zeebe:header key="role" value="planner" />
        </zeebe:taskHeaders>
        <zeebe:ioMapping>
          <zeebe:input source="=goal" target="instructions" />
          <zeebe:output source="=status" target="agent_status" />
        </zeebe:ioMapping>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="turn" targetRef="gw" />
    <exclusiveGateway id="gw" />
    <sequenceFlow id="f3" sourceRef="gw" targetRef="done">
      <conditionExpression xsi:type="tFormalExpression">=agent_status = "success"</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="f4" sourceRef="gw" targetRef="failed">
      <conditionExpression xsi:type="tFormalExpression">=agent_status != "success"</conditionExpression>
    </sequenceFlow>
    <endEvent id="done" />
    <endEvent id="failed" />
  </process>
</definitions>`;

describe("runGraph", () => {
  it("dispatches an activity to the harness named by zeebe:taskDefinition", async () => {
    const seen: HarnessContext[] = [];
    const harness: Harness = async (context) => {
      seen.push(context);
      return ok("planned");
    };

    const result = await runGraph(routed, {
      harnesses: { "agent:turn": harness },
      variables: { goal: "add a health check" },
    });

    expect(result.outcome).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.harness).toBe("agent:turn");
    expect(seen[0]?.activityId).toBe("turn");
    expect(seen[0]?.activityName).toBe("Agent turn");
    // the job type lives in zeebe:taskDefinition, so headers carry only real metadata
    expect(seen[0]?.properties).toEqual({ role: "planner" });
    // zeebe:input resolved against process variables
    expect(seen[0]?.input).toEqual({ instructions: "add a health check" });
  });

  it("publishes zeebe:output so the next gateway can route on it", async () => {
    const result = await runGraph(routed, {
      harnesses: { "agent:turn": async () => ok("planned") },
      variables: { goal: "g" },
    });
    expect(result.variables.agent_status).toBe("success");
    expect(result.activities.map((a: ActivityOutcome) => a.activityId)).toEqual(["turn"]);
  });

  it("routes down the failure branch when the harness fails", async () => {
    const result = await runGraph(routed, {
      harnesses: {
        "agent:turn": async () => ({
          status: "failed" as const,
          summary: "nope",
          findings: [],
          artifacts: [],
          next_action: "stop" as const,
        }),
      },
      variables: { goal: "g" },
    });
    expect(result.outcome).toBe("completed");
    expect(result.variables.agent_status).toBe("failed");
  });

  it("errors when the graph names a harness nothing implements", async () => {
    const result = await runGraph(routed, { harnesses: {}, variables: { goal: "g" } });
    expect(result.outcome).toBe("error");
    expect(result.error?.message).toMatch(/no harness registered for 'agent:turn'/);
  });

  it("reports the ids the token rests on as it moves", async () => {
    const tokenReports: string[][] = [];
    await runGraph(routed, {
      harnesses: { "agent:turn": async () => ok("planned") },
      variables: { goal: "g" },
      onTokens: (tokens) => {
        tokenReports.push(tokens);
      },
    });
    expect(tokenReports.length).toBeGreaterThan(0);
  });
});

const retried = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <serviceTask id="turn" name="Flaky step">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" retries="3" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="turn" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

describe("zeebe:taskDefinition retries", () => {
  it("retries a harness that throws, up to the configured count", async () => {
    let calls = 0;
    const result = await runGraph(retried, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          if (calls < 3) throw new Error(`flaky, attempt ${calls}`);
          return ok("finally");
        },
      },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toBe(3);
  });

  it("gives up once the configured retries are exhausted", async () => {
    let calls = 0;
    const result = await runGraph(retried, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          throw new Error(`always flaky, attempt ${calls}`);
        },
      },
    });
    expect(result.outcome).toBe("error");
    expect(calls).toBe(3);
    expect(result.error?.message).toMatch(/always flaky, attempt 3/);
  });

  it("does not retry when no retries are configured", async () => {
    let calls = 0;
    const result = await runGraph(routed, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          throw new Error("boom");
        },
      },
      variables: { goal: "g" },
    });
    expect(result.outcome).toBe("error");
    expect(calls).toBe(1);
  });

  it("never retries a harness that returns status: 'failed' rather than throwing", async () => {
    // A `failed(...)` result is a business error the graph routes on with a
    // gateway, not a job failure -- retrying it would just run it again
    // unconditionally, which is not what C8's retries model.
    let calls = 0;
    const result = await runGraph(retried, {
      harnesses: {
        "agent:turn": async () => {
          calls += 1;
          return { status: "failed" as const, summary: "business error", findings: [], artifacts: [], next_action: "stop" as const };
        },
      },
    });
    expect(result.outcome).toBe("completed");
    expect(calls).toBe(1);
  });
});

/** A user task the process parks on, so a run can be snapshotted mid-flight. */
const parking = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" />
    <sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

/** the same graph, with a harness-backed task spliced in after the gate */
const parkingExtended = parking
  .replace('<sequenceFlow id="f2" sourceRef="gate" targetRef="end" />', '<sequenceFlow id="f2" sourceRef="gate" targetRef="added" />')
  .replace('<endEvent id="end" />', `<serviceTask id="added">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f3" sourceRef="added" targetRef="end" />
    <endEvent id="end" />`);

describe("runGraph parking", () => {
  it("reports the token on the very first activity, not just later ones", async () => {
    // engine.execution -- what postponedIds() normally reads -- is not assigned
    // yet the first time a fresh run parks on its own first activity, so this
    // has to come from the wait event itself rather than the postponed set.
    const tokenReports: string[][] = [];
    const result = await runGraph(parking, {
      harnesses: {},
      onTokens: (tokens) => {
        tokenReports.push(tokens);
      },
    });

    expect(result.outcome).toBe("stopped");
    expect(tokenReports.at(-1)).toEqual(["gate"]);
  });
});

describe("resumeGraph", () => {
  it("continues a parked run into a node the graph gained while it waited", async () => {
    const first = await runGraph(parking, { harnesses: {} });
    // the run is parked on the user task, not finished
    expect(first.outcome).toBe("stopped");

    const ran: string[] = [];
    const second = await resumeGraph(first.state, parkingExtended, {
      // answering the gate is what releases the token into the new node
      onWait: () => ({ approved: true }),
      harnesses: {
        "agent:turn": async (context) => {
          ran.push(context.activityId);
          return ok("ran the spliced node");
        },
      },
    });

    expect(ran).toEqual(["added"]);
    expect(second.activities.map((a) => a.activityId)).toEqual(["added"]);
    expect(second.outcome).toBe("completed");
  });

  it("answers a parked gate into a callActivity's process, reached for the first time (issue #30)", async () => {
    // Answering synchronously, in the same tick a resumed run reaches a
    // callActivity it has never entered before, used to throw "cannot resume
    // running process <callee>": bpmn-elements' own message-redelivery
    // handling races with instantiating that brand-new child process during a
    // resume cycle. session-skeleton.bpmn hits this on every self-extending
    // session, since `craft`'s first callActivity sits right behind the very
    // gate `resume --answer` exists to answer.
    const parkingWithCall = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <userTask id="gate" />
    <sequenceFlow id="f2" sourceRef="gate" targetRef="call" />
    <callActivity id="call" calledElement="callee" />
    <sequenceFlow id="f3" sourceRef="call" targetRef="end" />
    <endEvent id="end" />
  </process>
  <process id="callee" isExecutable="false">
    <startEvent id="c_start" />
    <sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_turn" />
    <serviceTask id="c_turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="cf2" sourceRef="c_turn" targetRef="c_end" />
    <endEvent id="c_end" />
  </process>
</definitions>`;

    const first = await runGraph(parkingWithCall, { harnesses: {} });
    expect(first.outcome).toBe("stopped");

    const ran: string[] = [];
    const second = await resumeGraph(first.state, parkingWithCall, {
      // A plain, synchronous answer -- exactly what `resume --answer` gives.
      onWait: () => ({ approved: true }),
      harnesses: {
        "agent:turn": async (context) => {
          ran.push(context.activityId);
          return ok("ran the callee");
        },
      },
    });

    expect(second.error).toBeUndefined();
    expect(ran).toEqual(["c_turn"]);
    expect(second.outcome).toBe("completed");
  });

  it("the hang guard still settles a resume against a snapshot with nothing left to dispatch (issue #52/#63)", async () => {
    // `runner.ts`'s resumeSession now refuses this case outright once a
    // session's own status is "completed" (issue #63), but the underlying
    // mechanism this proves -- engine.resume() dispatching nothing at all,
    // with none of drive()'s raced promises ever settling on their own --
    // is a property of resumeGraph itself, reachable by anything that hands
    // it a snapshot with no token left, regardless of what a caller's own
    // bookkeeping says. This is that guard, exercised directly.
    const trivial = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

    const first = await runGraph(trivial, { harnesses: {} });
    expect(first.outcome).toBe("completed");

    const second = await resumeGraph(first.state, trivial, { harnesses: {}, hangGuardMs: 50 });

    expect(second.outcome).toBe("stopped");
    expect(second.note).toMatch(/dispatched nothing/);
  });

  it("does not force-stop a resume that is genuinely waiting on a slow answer (issue #69)", async () => {
    // Resuming into an already-parked user task re-announces it via
    // "activity.wait" without ever firing "activity.start" first -- bpmn-elements
    // is re-signalling a postponed activity, not starting a new one. Before
    // issue #69's fix, dispatchedAnything was only ever set from
    // "activity.start", so this looked identical to the #52 hang the guard
    // exists for: `graph-agent tui --resume` showed the parked gate, then the
    // hang guard fired and force-stopped the engine before the person
    // watching it could type an answer. A short hangGuardMs and an onWait
    // that resolves well after it proves the guard no longer mistakes this
    // for silence.
    const first = await runGraph(parking, { harnesses: {} });
    expect(first.outcome).toBe("stopped");

    const answeredAfter = new Promise<Record<string, unknown>>((resolve) => {
      setTimeout(() => resolve({ approved: true }), 80);
    });

    const second = await resumeGraph(first.state, parking, {
      harnesses: {},
      hangGuardMs: 20,
      onWait: () => answeredAfter,
    });

    expect(second.note).toBeUndefined();
    expect(second.outcome).toBe("completed");
  });
});

describe("a callActivity's own zeebe:output (issue #66)", () => {
  it("reads the called process's published variable by its bare name, for a gateway back in the caller", async () => {
    // Unlike a harness-backed activity's zeebe:ioMapping (bridged session-wide
    // via sharedOutput) or a user task's answered form (applied directly from
    // its flat signaled output), a callActivity's own signaled output arrives
    // wrapped one layer deeper -- bpmn-elements relays it through the same
    // delegate-signal machinery a message end event uses, as
    // `{ executionId, output: {...theCalledProcess'sOwnEnvironmentOutput} }`.
    // Unwrapped, "=status" would read undefined (there is no bare `status` at
    // that depth) and "=output.status" would *also* fail, since `output` is
    // itself a reserved root in feelContext pointing at this activity's own
    // (empty) environment.output, not at the nested payload. This is the
    // general mechanism `session-craft.bpmn`'s `gw_crafted` needs to route on
    // `extend_status`, set by `apply_extension` deep inside `craft_graph`.
    const callerReadsCallee = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="call" />
    <callActivity id="call" calledElement="callee">
      <extensionElements>
        <zeebe:ioMapping>
          <zeebe:output source="=status" target="result" />
        </zeebe:ioMapping>
      </extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="call" targetRef="gw" />
    <exclusiveGateway id="gw" default="no" />
    <sequenceFlow id="yes" sourceRef="gw" targetRef="end_yes">
      <conditionExpression xsi:type="tFormalExpression">=result = "success"</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="no" sourceRef="gw" targetRef="end_no" />
    <endEvent id="end_yes" />
    <endEvent id="end_no" />
  </process>
  <process id="callee" isExecutable="false">
    <startEvent id="c_start" />
    <sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_turn" />
    <serviceTask id="c_turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
        <zeebe:ioMapping>
          <zeebe:output source="=status" target="status" />
        </zeebe:ioMapping>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="cf2" sourceRef="c_turn" targetRef="c_end" />
    <endEvent id="c_end" />
  </process>
</definitions>`;

    const warnings: string[] = [];
    const visited = new Set<string>();
    const result = await runGraph(callerReadsCallee, {
      harnesses: { "agent:turn": async () => ok("did the thing", { status: "success" }) },
      onExpressionWarning: (w) => warnings.push(w.message),
      onTokens: (_tokens, v) => v.forEach((id) => visited.add(id)),
    });

    expect(result.outcome).toBe("completed");
    expect(warnings).toEqual([]);
    expect(result.variables.result).toBe("success");
    expect(visited.has("end_yes")).toBe(true);
    expect(visited.has("c_turn")).toBe(true);
  });

  it("injects _session metrics into FEEL evaluation scope for gateway routing", async () => {
    const costGated = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p_cost" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <serviceTask id="turn">
      <extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="turn" targetRef="gw_cost" />
    <exclusiveGateway id="gw_cost" default="under_budget" />
    <sequenceFlow id="over_budget" sourceRef="gw_cost" targetRef="end_expensive">
      <conditionExpression xsi:type="tFormalExpression">=_session.total_cost &gt;= 0.05</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="under_budget" sourceRef="gw_cost" targetRef="end_cheap" />
    <endEvent id="end_expensive" />
    <endEvent id="end_cheap" />
  </process>
</definitions>`;

    const visited = new Set<string>();
    const harness: Harness = async () =>
      ok("done turn", {
        usage: {
          input: 1000,
          output: 500,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.02, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.06 },
        },
      });

    const result = await runGraph(costGated, {
      harnesses: { "agent:turn": harness },
      onTokens: (_tokens, v) => v.forEach((id) => visited.add(id)),
    });

    expect(result.outcome).toBe("completed");
    expect(visited.has("end_expensive")).toBe(true);
    expect(visited.has("end_cheap")).toBe(false);
    expect((result.variables._session as any).total_cost).toBe(0.06);
    expect((result.variables._session as any).turn_count).toBe(1);
  });

  it("interrupts a host subprocess when cost limit is breached", async () => {
    const costBoundaryXml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p_boundary" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="sub_start" />
      <sequenceFlow id="sf1" sourceRef="sub_start" targetRef="gate" />
      <userTask id="gate" name="Human Gate" />
      <sequenceFlow id="sf2" sourceRef="gate" targetRef="sub_end" />
      <endEvent id="sub_end" />
    </subProcess>
    <boundaryEvent id="cost_breach" attachedToRef="sub" cancelActivity="true">
      <conditionalEventDefinition>
        <condition xsi:type="tFormalExpression">=_session.total_cost &gt;= 0.05</condition>
      </conditionalEventDefinition>
    </boundaryEvent>
    <sequenceFlow id="f_normal" sourceRef="sub" targetRef="end_normal" />
    <sequenceFlow id="f_breach" sourceRef="cost_breach" targetRef="end_breach" />
    <endEvent id="end_normal" />
    <endEvent id="end_breach" />
  </process>
</definitions>`;

    const visited = new Set<string>();
    const result = await runGraph(costBoundaryXml, {
      harnesses: {},
      variables: { _session: { total_cost: 0.10 } },
      onTokens: (_tokens, v) => v.forEach((id) => visited.add(id)),
    });

    expect(result.outcome).toBe("completed");
    expect(visited.has("cost_breach")).toBe(true);
    expect(visited.has("end_breach")).toBe(true);
    expect(visited.has("gate")).toBe(false);
    expect(visited.has("end_normal")).toBe(false);
  });

  it("remains dormant on a host subprocess when cost is under limit", async () => {
    const costBoundaryXml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p_boundary" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="sub_start" />
      <sequenceFlow id="sf1" sourceRef="sub_start" targetRef="turn" />
      <serviceTask id="turn">
        <extensionElements>
          <zeebe:taskDefinition type="agent:turn" />
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="sf2" sourceRef="turn" targetRef="sub_end" />
      <endEvent id="sub_end" />
    </subProcess>
    <boundaryEvent id="cost_breach" attachedToRef="sub" cancelActivity="true">
      <conditionalEventDefinition>
        <condition xsi:type="tFormalExpression">=_session.total_cost &gt;= 0.05</condition>
      </conditionalEventDefinition>
    </boundaryEvent>
    <sequenceFlow id="f_normal" sourceRef="sub" targetRef="end_normal" />
    <sequenceFlow id="f_breach" sourceRef="cost_breach" targetRef="end_breach" />
    <endEvent id="end_normal" />
    <endEvent id="end_breach" />
  </process>
</definitions>`;

    const visited = new Set<string>();
    const harness: Harness = async () =>
      ok("done turn", {
        usage: {
          input: 100,
          output: 50,
          cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
        },
      });

    const result = await runGraph(costBoundaryXml, {
      harnesses: { "agent:turn": harness },
      onTokens: (_tokens, v) => v.forEach((id) => visited.add(id)),
    });

    expect(result.outcome).toBe("completed");
    expect(visited.has("turn")).toBe(true);
    expect(visited.has("end_normal")).toBe(true);
    expect(visited.has("end_breach")).toBe(false);
  });

  it("interrupts a host subprocess once cost crosses the limit mid-run (issue #83)", async () => {
    // Neither test above covers the case the feature exists for: a limit that
    // is already breached before the subprocess starts never exercises the
    // re-evaluation path at all, and a limit that never becomes true proves
    // nothing about whether re-evaluation works. Here the subprocess starts
    // under budget and three sequential agent:turn activities, each costing
    // 0.04, push total_cost from 0 -> 0.04 -> 0.08 -> 0.12 -- crossing the
    // 0.05 limit after the second turn, while the subprocess is still
    // running. _session lives on the boundary event's own bpmn-elements
    // Environment.clone() (subProcess gives its inner execution a fresh,
    // disconnected .output), so this only works via the engine's own
    // sharedOutput bridge now threaded into FEEL evaluation generally, not
    // only into a harness activity's own input/output.
    const costBoundaryXml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="p_boundary" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="sub" />
    <subProcess id="sub">
      <startEvent id="sub_start" />
      <sequenceFlow id="sf1" sourceRef="sub_start" targetRef="turn1" />
      <serviceTask id="turn1">
        <extensionElements>
          <zeebe:taskDefinition type="agent:turn" />
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="sf2" sourceRef="turn1" targetRef="turn2" />
      <serviceTask id="turn2">
        <extensionElements>
          <zeebe:taskDefinition type="agent:turn" />
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="sf3" sourceRef="turn2" targetRef="turn3" />
      <serviceTask id="turn3">
        <extensionElements>
          <zeebe:taskDefinition type="agent:turn" />
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="sf4" sourceRef="turn3" targetRef="sub_end" />
      <endEvent id="sub_end" />
    </subProcess>
    <boundaryEvent id="cost_breach" attachedToRef="sub" cancelActivity="true">
      <conditionalEventDefinition>
        <condition xsi:type="tFormalExpression">=_session.total_cost &gt;= 0.05</condition>
      </conditionalEventDefinition>
    </boundaryEvent>
    <sequenceFlow id="f_normal" sourceRef="sub" targetRef="end_normal" />
    <sequenceFlow id="f_breach" sourceRef="cost_breach" targetRef="end_breach" />
    <endEvent id="end_normal" />
    <endEvent id="end_breach" />
  </process>
</definitions>`;

    const visited = new Set<string>();
    const harness: Harness = async () =>
      ok("done turn", {
        usage: {
          input: 1000,
          output: 500,
          cost: { input: 0.02, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.04 },
        },
      });

    const result = await runGraph(costBoundaryXml, {
      harnesses: { "agent:turn": harness },
      onTokens: (_tokens, v) => v.forEach((id) => visited.add(id)),
    });

    expect(result.outcome).toBe("completed");
    expect(visited.has("turn1")).toBe(true);
    expect(visited.has("turn2")).toBe(true);
    expect(visited.has("turn3")).toBe(false);
    expect(visited.has("cost_breach")).toBe(true);
    expect(visited.has("end_breach")).toBe(true);
    expect(visited.has("sub_end")).toBe(false);
    expect(visited.has("end_normal")).toBe(false);
  });
});

describe("onCheckpoint (issue #116)", () => {
  const task = (id: string, from: string, to: string) =>
    `<serviceTask id="${id}"><extensionElements><zeebe:taskDefinition type="t" /></extensionElements></serviceTask>`;
  const chain = `<?xml version="1.0" encoding="UTF-8"?>
<definitions ${DEFS}>
  <process id="chain" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="a" />
    ${task("a", "f1", "f2")}
    <sequenceFlow id="f2" sourceRef="a" targetRef="b" />
    ${task("b", "f2", "f3")}
    <sequenceFlow id="f3" sourceRef="b" targetRef="c" />
    ${task("c", "f3", "f4")}
    <sequenceFlow id="f4" sourceRef="c" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

  it("runs checkpoints strictly one at a time and settles them before returning", async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    let finished = 0;
    const result = await runGraph(chain, {
      harnesses: { t: async () => ok("x") },
      onCheckpoint: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        finished++;
      },
    });
    expect(result.outcome).toBe("completed");
    expect(maxRunning).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(1);
    // none left in flight when the run returns
        expect(finished).toBe(calls);
  });
});
