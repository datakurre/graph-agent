/**
 * The job types a graph can dispatch to.
 *
 * Each `zeebe:taskDefinition type="..."` in a diagram names one of these. They
 * are deliberately thin: the decisions live in the graph, and the state lives in
 * the Pi session, so a harness is mostly a translation between the two.
 */
import { spawn } from "node:child_process";
import { layoutProcess } from "../js/lib/bpmn-auto-layout.ts";
import { applyGraphOps, checkSplice, type GraphOp, type HarnessIOContract } from "./graph.ts";
import { failed, HARNESS_RESULT_BASE_FIELDS, ok, type Harness, type HarnessRegistry, type HarnessResult } from "./harness.ts";
import type { PiSession, ToolCallRequest, ToolOutcome } from "./pi-session.ts";
import { REPLAY_SAFE_TOOLS, type ToolExecutor } from "./tool-executor.ts";
import { GraphRevisionConflictError, type SessionStore } from "./session-store.ts";
import type { TurnRecord } from "../studio/types.ts";
import { SUPPORTED_ELEMENT_TYPES, SUPPORTED_EVENT_DEFINITIONS } from "../js/lib/supported-bpmn-elements.ts";
import { ensureLabelDi } from "../js/lib/bpmn-label-layout.ts";

/** Matches craft-graph.bpmn's own `gw_lint` condition (`lint_attempts >= 3`). */
const MAX_LINT_ATTEMPTS = 3;

/**
 * Canned instructions for `zeebe:taskHeaders`' `agent_role` header, layered in
 * front of whatever the graph maps as the turn's own `prompt`. draft_fragment
 * has always carried `agent_role="graph_architect"`, but nothing ever read it
 * (issue #37): the model drafting a splice got only the generic session
 * prompt, with no hint of the output format at all -- so the first attempt,
 * and every attempt after it, was a blind guess.
 *
 * `graph_architect` used to be asked for a complete replacement `<bpmn:definitions>`
 * document -- the current graph's own content in full, verbatim, with new
 * elements woven in. That failed for any graph of realistic size: the model
 * either garbled a multi-thousand-character echo (rejected as "removed or
 * renamed") or reproduced it exactly and added nothing, which `graph:extend`
 * treats as a no-op splice with nothing for the review gate to approve. It now
 * drafts a small ops list instead -- see `GraphOp` (`src/agent/graph.ts`) and
 * `applyGraphOps`'s own header comment for how each op mirrors a real bpmn-js
 * `Modeling` method (`createShape`/`appendShape`/`insertShape`/`connect`).
 * There is nothing left to echo, so "added 0 elements" cannot recur.
 */
const AGENT_ROLES: Record<string, string> = {
  graph_architect:
    "You are drafting a small patch for the session graph below, not a " +
    "replacement for it. Do not call any tool for this response, even if one " +
    "is offered to you -- nothing in this drafting step can run a tool call, " +
    "and one left unanswered wedges the rest of this session. Read the " +
    "current graph from the block below; there is nothing to inspect on " +
    "disk. Respond with ONLY a JSON array of operations -- no markdown code " +
    "fences, no prose before or after, nothing but the JSON. Every id you " +
    "invent must be brand-new; an id already in the current graph may be " +
    "*referenced* by an operation but never redefined, renamed, or removed.\n\n" +
    "Operations:\n" +
    '  {"op":"createProcess","id":"...","name":"..."} -- starts a new, ' +
    'separate sub-process (not the main one); later operations build inside ' +
    'it via "process":"<that id>".\n' +
    '  {"op":"appendShape","type":"bpmn:...","id":"...","after":"<existing id>"} ' +
    "-- a new node plus one new flow from an existing node into it.\n" +
    '  {"op":"insertShape","type":"bpmn:...","id":"...","into":"<an existing ' +
    'sequenceFlow id>","flowId":"<optional>"} -- splices a new node into the ' +
    "middle of an existing path: that flow keeps its own id but now points " +
    "at the new node, and a new flow -- \"flowId\" if you name one, " +
    'otherwise generated -- carries on from the new node to the flow\'s old ' +
    "target. Name \"flowId\" when a later op in this same list needs to " +
    "target that continuation (see the fork/join and merge recipes below) " +
    "-- otherwise you would have to guess the generated id.\n" +
    '  {"op":"connect","from":"<id>","to":"<id>","condition":"<FEEL, ' +
    'optional>"} -- a new sequence flow between two already-named nodes.\n' +
    '  {"op":"setTaskDefinition","id":"<a service/user task named earlier in ' +
    'this same list>","jobType":"...","headers":{"key":"value"},' +
    '"inputs":[{"source":"=...","target":"..."}],"outputs":[{"source":"=...",' +
    '"target":"..."}]} -- wires zeebe:taskDefinition/taskHeaders/ioMapping ' +
    "onto a new task.\n" +
    '  {"op":"setDocumentation","id":"<id>","text":"..."}\n' +
    '  {"op":"attachBoundaryEvent","id":"...","attachedTo":"<existing activity ' +
    'id>","eventDefinitionType":"bpmn:TimerEventDefinition"|"bpmn:ErrorEventDefinition"|"bpmn:ConditionalEventDefinition",' +
    '"timerDuration":"<ISO-8601 duration, timers only>","condition":"<Camunda 8 FEEL expression like =_session.total_cost >= 0.01, conditional events only>","cancelActivity":true|false} -- ' +
    "attaches a timeout, condition (such as cost limit), or error handler to an existing activity (default " +
    'cancelActivity true, interrupting). It has no incoming flow of its own -- ' +
    'route where it goes next with a separate "connect" op naming it as "from".\n\n' +
    '`appendShape`/`insertShape` accept an optional "process":"<id>" ' +
    '(defaults to the main process); when "type" is "bpmn:CallActivity", ' +
    '"calledElement":"<a process id from an earlier createProcess op>"; and, ' +
    'on a start or end event, an optional "eventDefinitionType" (one of the ' +
    'event definitions listed below), with "timerDuration" required alongside ' +
    'a timer one.\n\n' +
    "When extending the workflow, the most direct and reliable approach is to " +
    'insertShape the new task(s) or gateway(s) into an existing sequenceFlow ' +
    '(such as "to_applied" in craft-graph or "crafted_ok" in session-craft). ' +
     'If you define a separate sub-process with createProcess, you MUST also ' +
     'insertShape a bpmn:CallActivity (with "calledElement":"<process id>") ' +
     "into an existing sequenceFlow so the sub-process is connected to the execution path.\n\n" +
     "Diagram authoring rules: do not create an embedded bpmn:SubProcess in a " +
     "crafting patch; use createProcess plus a bpmn:CallActivity instead. Keep " +
     "event and gateway names short because bpmn-js places their external labels " +
     "around the shape. Avoid adding lanes unless they are required by the " +
     "request. The layout stage generates diagram interchange and label bounds; " +
     "never invent or hand-edit coordinates in this operation list.\n\n" +
     'Every new element\'s "type" must be exactly one of these -- anything ' +
    "else has no tested behaviour here and will be rejected:\n" +
    [...SUPPORTED_ELEMENT_TYPES].sort().join(", ") +
    "\n\n" +
    '"eventDefinitionType" (on a start/end event or attachBoundaryEvent) must ' +
    "be exactly one of these:\n" +
    [...SUPPORTED_EVENT_DEFINITIONS].sort().join(", ") +
    "\n\n" +
    "Never insertShape or connect a second incoming flow into a plain task " +
    "or event -- that looks like a join but is not one, and bpmn-elements " +
    "re-triggers the activity once per arriving token instead of waiting for " +
    "both. appendShape never removes or redirects a node's existing outgoing " +
    "flow, so appendShape-ing a merge/fork gateway and connecting existing " +
    "sources into it does NOT work -- each source keeps its old flow too, " +
    "which is instantly an implicit split, and the shared target still ends " +
    "up with the fake join you were trying to avoid. Use insertShape " +
    "instead, which is the only op that redirects an existing flow:\n\n" +
    "  To reconverge two paths without waiting for both (a retry path " +
    "alongside a host activity's own normal continuation, say): insertShape " +
    "a bpmn:ExclusiveGateway into the flow that already leads to the shared " +
    'target (this retargets it into the gateway; its own continuation -- ' +
    'name it "flowId" -- already carries on to that same target), then ' +
    "connect the other, freshly-created source directly into the gateway. " +
    "Example -- a retry path from an attachBoundaryEvent reconverging with " +
    'gate\'s own continuation before "end": ' +
    '[{"op":"attachBoundaryEvent","id":"err","attachedTo":"gate",' +
    '"eventDefinitionType":"bpmn:ErrorEventDefinition"},' +
    '{"op":"appendShape","type":"bpmn:ServiceTask","id":"retry","after":"err"},' +
    '{"op":"insertShape","type":"bpmn:ExclusiveGateway","id":"gw","into":"<gate\'s own flow to end>"},' +
    '{"op":"connect","from":"retry","to":"gw"}].\n\n' +
    "  For a genuine parallel fork/join -- run several branches at once and " +
    "wait for all of them -- insertShape a bpmn:ParallelGateway into the " +
    'flow leading to the shared next step (naming its continuation ' +
    '"flowId"), insertShape the first branch\'s own task into that named ' +
    'flow (naming its own continuation "flowId" in turn), then insertShape ' +
    "a second bpmn:ParallelGateway into THAT flow for the join. Every " +
    "additional branch is one appendShape (its task, from the fork) plus " +
    "one connect (that task, to the join). Example -- two branches: " +
    '[{"op":"insertShape","type":"bpmn:ParallelGateway","id":"fk","into":"<the flow into the shared next step>","flowId":"fk_out"},' +
    '{"op":"insertShape","type":"bpmn:ServiceTask","id":"b1","into":"fk_out","flowId":"to_join"},' +
    '{"op":"insertShape","type":"bpmn:ParallelGateway","id":"jn","into":"to_join"},' +
    '{"op":"appendShape","type":"bpmn:ServiceTask","id":"b2","after":"fk"},' +
    '{"op":"connect","from":"b2","to":"jn"}]. A ParallelGateway with more ' +
    "than one incoming flow is a real join, not the fake-join mistake " +
    "above -- but only because every branch was routed into it this way; a " +
    "bare appendShape from the fork alone leaves the join's other incoming " +
    "unaccounted for.",
};

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const exact = /^(`{3,}|~{3,})[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?\1\s*$/.exec(trimmed);
  if (exact) return (exact[2] ?? "").trim();

  const embedded = /(`{3,}|~{3,})[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?\1/.exec(trimmed);
  if (embedded) return (embedded[2] ?? "").trim();

  return trimmed;
}

/**
 * Roles whose prompt must also carry the session's current graph. Now that
 * `graph_architect` drafts an ops list rather than a full-document echo, this
 * is no longer about being able to reproduce the graph -- it is about giving
 * the model real, existing ids to hook `after`/`into`/`from`/`to` onto (and
 * to avoid, when inventing new ones). Capped well under a typical context
 * window: the graph a splice targets is a single session graph, not the
 * whole shared library, so this is a safety margin against a pathological
 * one, not an expected truncation.
 *
 * 20,000 was that margin until session-craft.bpmn (issue #66): a session
 * graph that links two called graphs at once -- craft_graph and
 * pi_default_loop, rather than session-skeleton's one -- runs to over 41,000
 * characters even before anything is spliced in. Raised well past what
 * composing two of today's bundled graphs needs, with headroom for a third,
 * and still small next to Haiku's own context window.
 */
const ROLES_NEEDING_CURRENT_GRAPH = new Set(["graph_architect"]);
const MAX_CURRENT_GRAPH_CHARS = 100_000;

/**
 * `<bpmn:process>` ids `linkGraph` marked `isExecutable="false"` -- brought
 * in via a `calledElement` rather than authored on this session. A cheap
 * regex scan rather than a full moddle parse: `currentGraphBlock` already
 * hands the model the raw XML text as-is, and this only needs to name the
 * off-limits ids for the prompt, not validate anything (`checkSplice`'s own
 * `checkProcessScope` is the actual enforcement).
 */
function linkedProcessIds(xml: string): string[] {
  const ids: string[] = [];
  for (const match of xml.matchAll(/<(?:bpmn:)?process\b([^>]*)>/g)) {
    const attrs = match[1] ?? "";
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const isExecutable = /\bisExecutable="([^"]+)"/.exec(attrs)?.[1];
    if (id && isExecutable === "false") ids.push(id);
  }
  return ids;
}

function currentGraphBlock(xml: string): string {
  const truncated = xml.length > MAX_CURRENT_GRAPH_CHARS;
  const body = truncated ? xml.slice(0, MAX_CURRENT_GRAPH_CHARS) : xml;
  const linked = linkedProcessIds(xml);
  return (
    "The current graph you are splicing into is:\n\n" +
    "```xml\n" +
    body +
    (truncated ? "\n... (truncated)" : "") +
    "\n```" +
    (linked.length > 0
      ? `\n\nDo not target a flow inside ${linked.join(", ")} -- ${linked.length === 1 ? "it is" : "they are"} ` +
        `linked in via calledElement (isExecutable="false"), and recovery cannot replay state there if the ` +
        `session resumes after a splice lands: target a flow in the session's own (executable) process instead.`
      : "")
  );
}

/**
 * Roles whose prompt must also carry the session's job-type vocabulary --
 * issue #40 found the model invents plausible-looking `zeebe:taskDefinition`
 * types (`shell:exec` instead of the registered `shell`) with nothing to tell
 * it the real ones, and checkSplice used to have no way to catch that either,
 * so the graph shipped it and it only died the next time something reached
 * that activity. checkSplice now rejects it (a `graph:lint` failure feeds
 * back into `lint_feedback`), but naming the real vocabulary up front means
 * the model has a chance of getting it right the first time instead of
 * guessing into the redraft-attempt cap.
 */
const ROLES_NEEDING_JOB_TYPES = ROLES_NEEDING_CURRENT_GRAPH;

function jobTypesBlock(jobTypes: Iterable<string>): string {
  return (
    '`setTaskDefinition`\'s "jobType" must be exactly one of these -- anything ' +
    "else has no harness to run it and will be rejected:\n" +
    [...jobTypes].sort().join(", ") +
    "\n\n" +
    // checkSplice only catches an unregistered type, not a right type wired
    // wrong -- issue #40's own repro used the real `shell` type but still
    // passed `command` through zeebe:ioMapping (setTaskDefinition's "inputs"),
    // where the harness never looks.
    "'shell' reads its command from setTaskDefinition's \"headers\", not " +
    '"inputs", because the command is a fixed part of what the activity is, ' +
    "not something a previous activity computes; route on the result with an " +
    "output like {\"source\":\"=exit_code\",\"target\":\"...\"} (or =stdout/=stderr)."
  );
}

/**
 * The I/O contract each job type actually honours: which `zeebe:input`
 * `name`s it reads off `context.input`, which `zeebe:taskHeader` `key`s it
 * reads off `context.properties`, and which extra fields (beyond
 * `HARNESS_RESULT_BASE_FIELDS`) a `zeebe:output source` may name.
 *
 * This exists because nothing previously checked an element template's
 * bindings against what its harness actually reads or publishes --
 * `pi_agent_task.json` mapped `instructions` while `agent:turn` read
 * `prompt`, and every turn built from that template started with nothing to
 * say (issue #49). `element_templates/element-templates.test.ts` asserts
 * every template in the repo against this map; keep it in sync with the
 * harness bodies below (and with `docs/harnesses.md`'s table) when either
 * changes.
 */
export const HARNESS_IO: Record<string, { inputs?: string[]; headers?: string[]; outputs?: string[] }> = {
  "agent:turn": {
    inputs: ["prompt", "lint_feedback"],
    headers: ["agent_role"],
    outputs: ["stop_reason", "tool_calls", "usage", "text", "prompt"],
  },
  "agent:tool": {
    inputs: ["tool_call"],
    outputs: ["tool", "terminate", "isError"],
  },
  "agent:collect-tools": {
    outputs: ["batch_terminate", "tool_results"],
  },
  "agent:fail-truncated-tools": {
    outputs: ["batch_terminate", "tool_results"],
  },
  "agent:steer": {
    outputs: ["injected"],
  },
  "agent:follow-up": {
    outputs: ["has_followup"],
  },
  "agent:prepare-next-turn": {
    // Reads `context.variables.stop_reason` -- an ordinary process variable a
    // prior activity's zeebe:output already published, not a zeebe:input
    // mapping of its own.
    outputs: ["should_stop"],
  },
  "graph:layout": {
    inputs: ["fragment"],
    outputs: ["fragment"],
  },
  "graph:lint": {
    inputs: ["fragment"],
    outputs: ["added", "attempt", "fragment"],
  },
  "graph:extend": {
    inputs: ["fragment"],
    outputs: ["added"],
  },
  shell: {
    headers: ["command", "fail_on_error"],
    outputs: ["exit_code", "stdout", "stderr"],
  },
};

/**
 * `HARNESS_IO` with `HARNESS_RESULT_BASE_FIELDS` folded into every type's
 * `outputs` -- every `HarnessResult` carries those five fields regardless of
 * which harness produced it (see `harness.ts`), so a `zeebe:output` naming
 * one of them is always valid no matter what job type the activity names.
 * `checkSplice`/`checkMigration` (`graph.ts`) validate a new activity's I/O
 * bindings against exactly this (issue #65) -- computed here, once, rather
 * than in `graph.ts` itself, since `graph.ts` has no dependency on the
 * harness registry and importing `HARNESS_RESULT_BASE_FIELDS` there would
 * still need this same union logic duplicated.
 */
export function harnessIOContract(): Record<string, HarnessIOContract> {
  const contract: Record<string, HarnessIOContract> = {};
  for (const [type, io] of Object.entries(HARNESS_IO)) {
    contract[type] = { ...io, outputs: [...HARNESS_RESULT_BASE_FIELDS, ...(io.outputs ?? [])] };
  }
  return contract;
}

export interface HarnessDeps {
  pi: PiSession;
  tools: ToolExecutor;
  store: SessionStore;
  /** Current session graph; `graph:extend` replaces it. */
  getGraph: () => string;
  /**
   * `expectedIndex`, when given, is the revision count read alongside the
   * graph `graph:extend` validated its splice against -- passed straight
   * through to `SessionStore.appendGraph`'s own optimistic-concurrency check
   * (issue #75), so a splice raced by someone else's write (a studio edit
   * landing mid-run) is rejected rather than silently overwritten.
   */
  setGraph: (xml: string, reason: string, addedElementIds: string[], expectedIndex?: number) => void;
  /** Steering and follow-up text the CLI has queued for this session. */
  takeSteering: () => string[];
  takeFollowUp: () => string[];
  /** Workspace `shell` steps run their command in. Defaults to `process.cwd()`. */
  cwd?: string;
}

function recordStep(
  store: SessionStore | undefined,
  record: Omit<TurnRecord, "index">,
  isTurn: boolean = false,
): void {
  if (store && typeof store.update === "function") {
    store.update((meta) => {
      if (!meta.steps) meta.steps = [];
      meta.steps.push({
        index: meta.steps.length + 1,
        ...record,
      });
      if (isTurn) {
        meta.turns.push({
          index: meta.turns.length + 1,
          ...record,
        });
      }
    });
  }
}

function clearInflight(meta: { inflightTools?: Record<string, unknown> }, key: string): void {
  if (!meta.inflightTools) return;
  delete meta.inflightTools[key];
  if (Object.keys(meta.inflightTools).length === 0) delete meta.inflightTools;
}

export function createHarnesses(deps: HarnessDeps): HarnessRegistry {
  const { pi, tools, store } = deps;
  const cwd = deps.cwd ?? process.cwd();

  /** Tool calls of the turn in flight, so `agent:tool` can find them by index. */
  let currentToolCalls: ToolCallRequest[] = [];

  /**
   * `graph:lint`'s own redraft-attempt count, keyed by activity id -- kept here
   * rather than trusted from `context.variables.lint_attempts` alone. That
   * variable is meant to round-trip through zeebe:ioMapping (lint_fragment
   * publishes it, draft_fragment/lint_fragment read it back next time round),
   * but craft-graph runs as a nested, separately-recovered process behind a
   * callActivity, and issue #31 found a real run where the round-trip did not
   * happen: the count stayed at 1 forever and the redraft loop never reached
   * `lint_exhausted`, burning one model call per iteration with nothing to
   * stop it. This is the belt-and-braces bound its own suggested fix asked
   * for -- a count that survives regardless of what the variable graph does.
   */
  const lintAttempts = new Map<string, number>();

  const agentTurn: Harness = async (context) => {
    const prompt = context.input.prompt;
    const raw = typeof prompt === "string" && prompt.length > 0 ? prompt : undefined;
    if (raw === undefined && !pi.hasConversation) {
      return failed(
        `${context.activityId} starts a turn with nothing to say: map a 'prompt' input, ` +
          `or place it after an activity that has already spoken.`,
      );
    }
    // Layered in front of the graph's own mapped prompt, never in place of it:
    // an agent_role header says what kind of work this turn is (draft_fragment's
    // is "graph_architect"), and lint_feedback -- when a graph maps it, as
    // craft-graph does -- is the previous redraft attempt's own rejection
    // reason, so a second guess is not as blind as the first.
    const agentRole = context.properties.agent_role ?? "";
    const role = AGENT_ROLES[agentRole];
    const graphBlock = ROLES_NEEDING_CURRENT_GRAPH.has(agentRole) ? currentGraphBlock(deps.getGraph()) : undefined;
    const jobBlock = ROLES_NEEDING_JOB_TYPES.has(agentRole) ? jobTypesBlock(Object.keys(registry)) : undefined;
    const feedback = typeof context.input.lint_feedback === "string" ? context.input.lint_feedback : undefined;
    const text =
      raw === undefined
        ? undefined
        : [
            role,
            graphBlock,
            jobBlock,
            raw,
            feedback && `The previous attempt was rejected: ${feedback}. Fix that and try again.`,
          ]
            .filter((part): part is string => Boolean(part))
            .join("\n\n");
    const startedAt = Date.now();
    const outcome = await pi.beginTurn(text);
    currentToolCalls = outcome.toolCalls;

    recordStep(
      store,
      {
        activityId: context.activityId,
        ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
        harness: context.harness,
        stopReason: outcome.stopReason,
        toolCalls: outcome.toolCalls.map((call) => call.name),
        toolCallDetails: outcome.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        prompt: text ?? raw,
        response: outcome.text,
        ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
        inputs: { ...context.input },
        outputs: {
          stop_reason: outcome.stopReason,
          text: outcome.text,
          usage: outcome.usage,
          ...(outcome.thinking ? { thinking: outcome.thinking } : {}),
        },
        ...(outcome.text ? { summary: outcome.text.slice(0, 400) } : {}),
        ...(outcome.errorMessage === undefined ? {} : { error: outcome.errorMessage }),
        usage: outcome.usage,
        startedAt,
        endedAt: Date.now(),
      },
      true,
    );

    const summary =
      outcome.stopReason === "error" && outcome.errorMessage
        ? `error: ${outcome.errorMessage}`
        : outcome.text.slice(0, 200) || `stopped: ${outcome.stopReason}`;

    return ok(summary, {
      stop_reason: outcome.stopReason,
      // FEEL sees a list, so `count(tool_calls)` and the loop over the batch work.
      tool_calls: outcome.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      usage: outcome.usage,
      // `summary` above is truncated for the turn log; a graph that needs the
      // model's full response as data (craft-graph.bpmn's drafted fragment,
      // say) reads this instead.
      text: outcome.text,
      // The resolved input this turn actually used (before the role/graph/job
      // blocks were layered on), or null when this turn continued an existing
      // transcript instead of starting one. `resolveOutput` only ever sees a
      // harness's own result fields, never other process variables directly
      // (issue #66) -- so a graph that needs its *input* prompt visible again
      // downstream, across a callActivity boundary sharedOutput does bridge,
      // has to read it back from here rather than re-deriving it in a
      // zeebe:output expression.
      prompt: raw ?? null,
    });
  };

  const agentTool: Harness = async (context) => {
    const raw = context.input.tool_call;
    const resolved = resolveToolCall(raw, currentToolCalls, new Set(pi.pendingToolCalls));
    if (!resolved.ok) return failed(resolved.reason);
    const call = resolved.call;

    // Record intent before running (issue #117). A marker that is already there
    // means a previous attempt of this very call died mid-flight.
    const interrupted = store?.readMeta?.().inflightTools?.[call.id] !== undefined;
    const replaySafe = tools.replaySafe ? tools.replaySafe(call.name) : REPLAY_SAFE_TOOLS.has(call.name);
    const toolStart = Date.now();
    let outcome: ToolOutcome;
    if (interrupted && !replaySafe) {
      outcome = {
        content:
          `Interrupted: graph-agent stopped while this ${call.name} call was running, so it may or may not have ` +
          `taken effect. It was not re-run automatically. Check the current state before retrying.`,
        isError: true,
      };
    } else {
      store?.update?.((meta) => {
        meta.inflightTools = {
          ...meta.inflightTools,
          [call.id]: { name: call.name, arguments: call.arguments, activityId: context.activityId, startedAt: toolStart },
        };
      });
      try {
        outcome = await tools.run(call.name, call.arguments, context.signal);
      } catch (error) {
        // Threw rather than crashed: the process is alive, so nothing is in flight.
        store?.update?.((meta) => {
          clearInflight(meta, call.id);
        });
        throw error;
      }
    }
    const durationMs = Date.now() - toolStart;
    pi.resolveTool(call.id, outcome);

    if (store && typeof store.update === "function") {
      store.update((meta) => {
        clearInflight(meta, call.id);
        meta.toolOutcomes = {
          ...meta.toolOutcomes,
          [call.id]: {
            content: outcome.content,
            ...(outcome.isError === true ? { isError: true } : {}),
            ...(outcome.terminate === true ? { terminate: true } : {}),
          },
        };
        const lastTurn = meta.turns[meta.turns.length - 1];
        if (lastTurn?.toolCallDetails) {
          const detail = lastTurn.toolCallDetails.find((d) => d.id === call.id || (d.name === call.name && !d.result));
          if (detail) {
            detail.result = { content: outcome.content, isError: outcome.isError };
            detail.durationMs = durationMs;
          }
        }
        if (meta.steps) {
          const lastStep = meta.steps.slice().reverse().find((s) => s.toolCallDetails && s.toolCallDetails.length > 0);
          if (lastStep?.toolCallDetails) {
            const detail = lastStep.toolCallDetails.find((d) => d.id === call.id || (d.name === call.name && !d.result));
            if (detail) {
              detail.result = { content: outcome.content, isError: outcome.isError };
              detail.durationMs = durationMs;
            }
          }
        }
      });
    }

    return ok(`${call.name}: ${outcome.isError ? "failed" : "ok"}`, {
      tool: call.name,
      terminate: outcome.terminate === true,
      isError: outcome.isError === true,
    });
  };

  /** Let Pi finish the turn once the graph has answered every tool call. */
  const finishTurn = async (summary: string): Promise<HarnessResult> => {
    const end = await pi.endTurn();
    currentToolCalls = [];
    store?.update?.((meta) => {
      delete meta.toolOutcomes;
    });
    return ok(summary, { batch_terminate: end.terminate, tool_results: end.toolResults });
  };

  // Captured by "graph:lint" and "graph:extend" below, so a drafted fragment's
  // taskDefinition types can be checked against what this session can
  // actually run rather than only against additiveness (issue #40). `const`
  // is enough even though these closures are defined as its own properties:
  // none of them read `registry` until invoked, by which point the object
  // literal below has finished constructing and the binding is initialized.
  const registry: HarnessRegistry = {
    "agent:turn": agentTurn,
    "agent:tool": agentTool,

    "agent:collect-tools": async (context) => {
      const startedAt = Date.now();
      const end = await pi.endTurn();
      currentToolCalls = [];
      const count = typeof end.toolResults === "number" ? end.toolResults : (Array.isArray(end.toolResults) ? (end.toolResults as any[]).length : 0);
      const summary = `Recorded ${count} tool result(s) into transcript`;
      const extra = { batch_terminate: end.terminate, tool_results: end.toolResults };
      recordStep(store, {
        activityId: context.activityId,
        ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
        harness: "agent:collect-tools",
        inputs: { ...context.input },
        outputs: extra,
        summary,
        startedAt,
        endedAt: Date.now(),
      });
      return ok(summary, extra);
    },

    // A response cut off by the output token limit has every tool call failed
    // without execution; Pi does that itself, so this only has to settle the run.
    "agent:fail-truncated-tools": async (context) => {
      const startedAt = Date.now();
      currentToolCalls = [];
      const end = await pi.endTurn();
      const summary = "Truncated response: tool calls failed unexecuted";
      const extra = { batch_terminate: end.terminate, tool_results: end.toolResults };
      recordStep(store, {
        activityId: context.activityId,
        ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
        harness: "agent:fail-truncated-tools",
        inputs: { ...context.input },
        outputs: extra,
        summary,
        error: summary,
        startedAt,
        endedAt: Date.now(),
      });
      return ok(summary, extra);
    },

    "agent:steer": async (context) => {
      const startedAt = Date.now();
      const messages = deps.takeSteering();
      for (const text of messages) pi.steer(text);
      const summary = messages.length ? `Injected ${messages.length} steering message(s)` : "No steering messages pending";
      const extra = { injected: messages.length, ...(messages.length ? { messages } : {}) };
      recordStep(store, {
        activityId: context.activityId,
        ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
        harness: "agent:steer",
        inputs: { ...context.input },
        outputs: extra,
        summary,
        startedAt,
        endedAt: Date.now(),
      });
      return ok(summary, { injected: messages.length });
    },

    "agent:follow-up": async (context) => {
      const startedAt = Date.now();
      const messages = deps.takeFollowUp();
      for (const text of messages) pi.followUp(text);
      const summary = messages.length ? `Drained ${messages.length} follow-up(s)` : "No follow-up queued";
      const extra = { has_followup: messages.length > 0, ...(messages.length ? { messages } : {}) };
      recordStep(store, {
        activityId: context.activityId,
        ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
        harness: "agent:follow-up",
        inputs: { ...context.input },
        outputs: extra,
        summary,
        startedAt,
        endedAt: Date.now(),
      });
      return ok(summary, { has_followup: messages.length > 0 });
    },

    /**
     * Pi's prepareNextTurn seam. Deliberately does *not* swap the system prompt
     * or the tool list: both sit in front of every message in the prompt cache,
     * so changing them here would discard the conversation's cache on every
     * iteration. See docs/research/05-pi-loops-and-token-cache.md.
     */
    "agent:prepare-next-turn": async (context) => {
      const startedAt = Date.now();
      const stopReason = String(context.variables.stop_reason ?? "");
      const shouldStop = stopReason === "stop" || stopReason === "";
      const summary = shouldStop ? "Agent has finished (stop condition met)" : "Preparing next turn in loop";
      const extra = { should_stop: shouldStop, stop_reason: stopReason };
      recordStep(store, {
        activityId: context.activityId,
        ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
        harness: "agent:prepare-next-turn",
        inputs: { stop_reason: stopReason },
        outputs: extra,
        summary,
        startedAt,
        endedAt: Date.now(),
      });
      return ok(shouldStop ? "agent has finished" : "another turn", { should_stop: shouldStop });
    },

    "graph:layout": async (context) => {
      const startedAt = Date.now();
      const source = stripCodeFence(String(context.input.fragment ?? deps.getGraph()));
      try {
        const layouted = await ensureLabelDi(await layoutProcess(source));
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:layout",
          inputs: { fragment_chars: source.length },
          outputs: { fragment_chars: layouted.length },
          summary: "Auto-layout BPMN process diagram",
          startedAt,
          endedAt: Date.now(),
        });
        return ok("laid out", { fragment: layouted });
      } catch (error) {
        const errSummary = `auto-layout failed: ${message(error)}`;
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:layout",
          summary: errSummary,
          error: errSummary,
          startedAt,
          endedAt: Date.now(),
        });
        return failed(errSummary);
      }
    },

    /**
     * Reports `attempt` so the crafting graph can bound its redraft loop: a
     * model that never produces a valid fragment would otherwise loop forever,
     * spending a turn each time round.
     */
    "graph:lint": async (context) => {
      const startedAt = Date.now();
      const attempt = (lintAttempts.get(context.activityId) ?? 0) + 1;
      const exhausted = attempt >= MAX_LINT_ATTEMPTS;
      // A terminal result (accepted, or exhausted) starts the next, unrelated
      // craft invocation fresh rather than accumulating across it.
      const settle = (terminal: boolean): void => {
        if (terminal) lintAttempts.delete(context.activityId);
        else lintAttempts.set(context.activityId, attempt);
      };
      // gw_lint's own `lint_attempts >= 3` condition exists to catch this and
      // route to craft_rejected -- but issue #34 found bpmn-elements replay a
      // stale routing decision from an earlier pass through this same gateway
      // on a *resumed* run, silently ignoring a live "true" evaluation and
      // redrafting forever regardless of what the condition says. Throwing
      // here does not depend on that gateway at all: a harness rejection ends
      // the whole run (issue #30 made sure the engine actually stops on that
      // path), so the cap holds even when the graph's own routing cannot be
      // trusted to.
      const giveUp = (reason: string): never => {
        settle(true);
        const summary = `${context.activityId}: gave up after ${attempt} attempts -- ${reason}`;
        store.update((meta) => {
          meta.harnessError = summary;
        });
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:lint",
          inputs: { attempt },
          summary,
          error: summary,
          startedAt,
          endedAt: Date.now(),
        });
        throw new Error(summary);
      };

      const raw = stripCodeFence(String(context.input.fragment ?? ""));
      if (!raw) {
        if (exhausted) giveUp("nothing to lint");
        settle(false);
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:lint",
          inputs: { fragment: "" },
          outputs: { attempt },
          summary: "Nothing to lint",
          error: "nothing to lint",
          startedAt,
          endedAt: Date.now(),
        });
        return failed("nothing to lint", { attempt });
      }
      try {
        // `graph_architect` drafts an ops list (GraphOp[]), not a full document
        // -- applyGraphOps materializes it into a complete graph before the
        // same additive/job-type/element-type checks run against that, exactly
        // as they always have against a full nextXml.
        const ops = JSON.parse(raw) as GraphOp[];
        const merged = await applyGraphOps(deps.getGraph(), ops);
        const splice = await checkSplice(
          deps.getGraph(),
          merged,
          new Set(Object.keys(registry)),
          harnessIOContract(),
          SUPPORTED_ELEMENT_TYPES,
          SUPPORTED_EVENT_DEFINITIONS,
        );
        if (splice.ok) {
          settle(true);
          const summary = `adds ${splice.added.length} element(s)`;
          recordStep(store, {
            activityId: context.activityId,
            ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
            harness: "graph:lint",
            inputs: { ops_count: ops.length },
            outputs: { added: splice.added, attempt },
            summary: `Lint passed: ${summary}`,
            startedAt,
            endedAt: Date.now(),
          });
          return ok(summary, { added: splice.added, attempt, fragment: merged });
        }
        const reason = splice.reason ?? "the fragment is not an additive splice";
        if (exhausted) giveUp(reason);
        settle(false);
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:lint",
          inputs: { ops_count: ops.length },
          outputs: { attempt, reason },
          summary: `Lint failed: ${reason}`,
          error: reason,
          startedAt,
          endedAt: Date.now(),
        });
        return failed(reason, { attempt });
      } catch (error) {
        const reason = `the patch could not be applied: ${message(error)}`;
        if (exhausted) giveUp(reason);
        settle(false);
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:lint",
          outputs: { attempt, reason },
          summary: `Lint error: ${reason}`,
          error: reason,
          startedAt,
          endedAt: Date.now(),
        });
        return failed(reason, { attempt });
      }
    },

    /**
     * The self-mutation primitive: replace the session graph with a version that
     * has the fragment spliced in. Additive with stable ids only -- recovery
     * replays child state by element id.
     */
    "graph:extend": async (context) => {
      const startedAt = Date.now();
      const fragment = String(context.input.fragment ?? "");
      if (!fragment) return failed("no fragment to apply");
      try {
        // The revision count read alongside the graph the splice below is
        // validated against -- passed to setGraph so a write raced by
        // someone else's edit (issue #75) is caught rather than silently
        // overwritten. Must be read right next to getGraph(), before the
        // `await`, so nothing else in this handler can observe a newer graph
        // in between.
        const expectedIndex = store.readMeta().revisions.length;
        const splice = await checkSplice(
          deps.getGraph(),
          fragment,
          new Set(Object.keys(registry)),
          harnessIOContract(),
          SUPPORTED_ELEMENT_TYPES,
          SUPPORTED_EVENT_DEFINITIONS,
        );
        if (!splice.ok) {
          const reason = splice.reason ?? "the fragment is not an additive splice";
          recordStep(store, {
            activityId: context.activityId,
            ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
            harness: "graph:extend",
            summary: `Extend rejected: ${reason}`,
            error: reason,
            startedAt,
            endedAt: Date.now(),
          });
          return failed(reason);
        }
        if (splice.added.length === 0) {
          const summary = "no new elements; graph unchanged";
          recordStep(store, {
            activityId: context.activityId,
            ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
            harness: "graph:extend",
            outputs: { added: [] },
            summary,
            startedAt,
            endedAt: Date.now(),
          });
          return ok(summary, { added: [] });
        }
        deps.setGraph(fragment, "graph:extend", splice.added, expectedIndex);
        const summary = `spliced in ${splice.added.length} element(s)`;
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:extend",
          outputs: { added: splice.added },
          summary: `Graph extended: ${summary}`,
          startedAt,
          endedAt: Date.now(),
        });
        return ok(summary, { added: splice.added });
      } catch (error) {
        if (error instanceof GraphRevisionConflictError) {
          const reason = `the graph changed to revision ${error.currentIndex} while this splice was being validated; retry against the new graph`;
          recordStep(store, {
            activityId: context.activityId,
            ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
            harness: "graph:extend",
            summary: reason,
            error: reason,
            startedAt,
            endedAt: Date.now(),
          });
          return failed(reason);
        }
        const reason = `could not apply the fragment: ${message(error)}`;
        recordStep(store, {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "graph:extend",
          summary: reason,
          error: reason,
          startedAt,
          endedAt: Date.now(),
        });
        return failed(reason);
      }
    },

    /**
     * A deterministic step: no model call, just a command and its exit status.
     * `element_templates/shell_task.json` binds the taskHeaders this reads.
     */
    "shell": async (context) => {
      const command = context.properties.command;
      if (!command) return failed("no 'command' header configured for this shell step");
      const failOnError = context.properties.fail_on_error !== "false";

      // Intent is recorded before the command runs (issue #117): the graph chose
      // this command, so there is no model to hand an "interrupted" result to --
      // a re-entry that finds the marker fails the activity instead of re-running.
      const markerKey = `shell:${context.activityId}${context.instance === undefined ? "" : `#${context.instance}`}`;
      if (store?.readMeta?.().inflightTools?.[markerKey] !== undefined) {
        store.update?.((meta) => {
          clearInflight(meta, markerKey);
        });
        return failed(
          `\`${command}\` was interrupted: graph-agent stopped while it was running, so it may or may not ` +
            `have taken effect. It was not re-run automatically.`,
        );
      }
      const startedAt = Date.now();
      store?.update?.((meta) => {
        meta.inflightTools = {
          ...meta.inflightTools,
          [markerKey]: { name: "shell", arguments: { command }, activityId: context.activityId, startedAt },
        };
      });
      let result: Awaited<ReturnType<typeof runCommand>>;
      try {
        result = await runCommand(command, cwd, context.signal);
      } finally {
        store?.update?.((meta) => {
          clearInflight(meta, markerKey);
        });
      }
      const { exit_code, stdout, stderr } = result;
      const endedAt = Date.now();
      const summary = `\`${command}\` exited ${exit_code}`;
      // `exit_code`, never `status`: HarnessResult already reserves `status` for
      // "success" | "failed", and zeebe:output reads this object by field name.
      const extra = { exit_code, stdout, stderr };

      recordStep(
        store,
        {
          activityId: context.activityId,
          ...(context.activityName === undefined ? {} : { activityName: context.activityName }),
          harness: "shell",
          stopReason: exit_code === 0 ? "stop" : "error",
          inputs: { command, fail_on_error: context.properties.fail_on_error },
          outputs: extra,
          summary,
          startedAt,
          endedAt,
          ...(exit_code !== 0 ? { error: `exited ${exit_code}: ${stderr || stdout || "command failed"}` } : {}),
        },
        true,
      );

      if (exit_code !== 0 && failOnError) return failed(summary, extra);
      return ok(summary, extra);
    },
  };
  return registry;
}

/** Run a command line in a shell, rooted at `cwd`. Resolves rather than rejects on a non-zero exit. */
function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signalName) => {
      resolve({ exit_code: signalName ? -1 : (code ?? -1), stdout, stderr });
    });
  });
}

export type ResolvedToolCall = { ok: true; call: ToolCallRequest } | { ok: false; reason: string };

/**
 * A multi-instance batch hands each instance its own element (`content.tool_call`
 * for pi-default-loop's tool_batch). Accept the tool call itself or an index
 * into the turn's calls when one was mapped in.
 *
 * When nothing was mapped, falling back to `calls[0]` is only ever safe if
 * there is exactly one call still unanswered -- the ordinary single-call
 * case. With two or more outstanding, guessing runs the wrong call, runs one
 * twice, or leaves one never answered (issue #27), so that case fails loudly
 * instead: a graph with a real multi-instance batch that stops mapping
 * `tool_call` should be told, not silently misrouted.
 */
export function resolveToolCall(
  raw: unknown,
  calls: ToolCallRequest[],
  pending: ReadonlySet<string>,
): ResolvedToolCall {
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<ToolCallRequest>;
    if (typeof candidate.id === "string" && typeof candidate.name === "string") {
      return { ok: true, call: { id: candidate.id, name: candidate.name, arguments: candidate.arguments ?? {} } };
    }
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    const call = calls[raw];
    return call ? { ok: true, call } : { ok: false, reason: `no tool call at index ${raw}` };
  }
  const unanswered = calls.filter((call) => pending.has(call.id));
  if (unanswered.length === 1) return { ok: true, call: unanswered[0]! };
  if (unanswered.length === 0) return { ok: false, reason: "the activity received no tool call to run" };
  return {
    ok: false,
    reason:
      `${unanswered.length} tool calls are still unanswered and none was mapped in -- ` +
      `map 'tool_call' (e.g. a multi-instance element variable) to say which one`,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
