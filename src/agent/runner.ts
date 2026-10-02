/**
 * Running a session.
 *
 * The BPMN engine holds the control flow, the Pi session holds the transcript,
 * and the store holds both on disk. The three are committed in a fixed order --
 * transcript, then graph revision, then engine state -- so a crash can leave a
 * revision with no snapshot (recoverable by replaying) but never a snapshot
 * pointing at a graph that was never written.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { inspect } from "node:util";
import { indexLibrary, linkGraph } from "./link.ts";
import { bundledWorkflowsDir, listBpmnFiles } from "./paths.ts";
import { runGraph, resumeGraph, type ActivityOutcome, type RunResult } from "./engine.ts";
import { createHarnesses } from "./harnesses.ts";
import { PiSession } from "./pi-session.ts";
import { mergeVisited, SessionStore } from "./session-store.ts";
import type { ToolExecutor } from "./tool-executor.ts";
import type { EngineState } from "./graph.ts";
import type { Paths } from "./paths.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

export interface RunSessionOptions {
  paths: Paths;
  project: string;
  /** Graph to start from; a path to a `.bpmn` file. */
  graphPath: string;
  prompt?: string;
  name?: string;
  model: Model<any>;
  systemPrompt: string;
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
  tools: ToolExecutor;
  sessionId?: string;
  /** Emitted as the run progresses, for the CLI to print. */
  onProgress?: (line: string) => void;
  /**
   * Called once, right after the session's `PiSession` is constructed and
   * before the first turn runs. `PiSession.agent` (`pi-agent-core`'s `Agent`)
   * emits `message_start`/`message_update`/`message_end` and
   * `tool_execution_start`/`_update`/`_end` via `.subscribe()` -- a caller
   * that wants to render a transcript live (`graph-agent tui`, issue #50)
   * subscribes here rather than waiting for a whole turn's `onActivity`
   * summary.
   */
  onSessionReady?: (pi: PiSession) => void;
  /** Called after each harness-backed activity completes, alongside `onProgress`'s formatted line. */
  onActivity?: (activity: ActivityOutcome) => void;
  /**
   * Called when the graph parks on a human gate -- a user task, a receive task.
   * Return a payload to answer it and let the run continue, or undefined to stop
   * with a snapshot so it can be resumed once someone answers.
   */
  onWait?: (activityId: string) => Promise<unknown> | unknown;
  /** Aborting stops the engine -- a snapshot is still saved, so `resume` picks up from there. */
  signal?: AbortSignal;
  /** See `RunnerOptions.hangGuardMs` (engine.ts) -- overridable so tests need not wait out the production value. */
  hangGuardMs?: number;
  /** Queued before the run starts, for "queue it before we start" -- see also `graph-agent steer`/`follow-up` for queuing one into a run already in flight (issue #48). */
  steering?: string[];
  followUp?: string[];
}

export interface SessionOutcome {
  sessionId: string;
  outcome: RunResult["outcome"];
  turns: number;
  error?: Error;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a coding agent whose control flow is described by a BPMN process. " +
  "Do the work the current step asks for and nothing more.";

/**
 * Whether a graph has an `agent:tool` activity anywhere -- the only thing
 * that can actually run a tool call an `agent:turn` model asks for. A cheap
 * substring check rather than a parse: `zeebe:taskDefinition` always writes
 * its job type as a quoted attribute (`type="agent:tool"`), and a false
 * positive here only costs offering a tool that then goes unused, not a wedged
 * run -- the failure mode this exists to avoid only comes from the opposite,
 * a false *negative*, which a literal match on the attribute does not produce.
 */
export function graphOffersTools(xml: string): boolean {
  return xml.includes('type="agent:tool"');
}

/**
 * Property names a wrapped error's real cause is known to hide behind.
 * bpmn-elements re-wraps a thrown error at every callActivity boundary it
 * crosses (issue #52), so `error.message` alone is not reliably where the
 * original cause ends up by the time it reaches here.
 */
const ERROR_WRAP_KEYS = ["inner", "error", "source", "cause"] as const;

/**
 * Recursively looks for a real, non-empty message on a thrown value or
 * anything it wraps -- `.message` first, then each of `ERROR_WRAP_KEYS`, plus
 * `.content.error` (the shape bpmn-elements itself uses). Bounded depth
 * against a cyclic or pathological wrapper; five is already more than any
 * observed wrapping chain needs.
 */
export function walkErrorMessage(error: unknown, depth = 0): string | undefined {
  if (depth > 5 || error === null || error === undefined) return undefined;
  if (typeof error === "string") return error.length > 0 ? error : undefined;
  if (typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.length > 0) return record.message;
  const content = record.content as Record<string, unknown> | undefined;
  if (content && typeof content === "object") {
    const found = walkErrorMessage(content.error, depth + 1);
    if (found) return found;
  }
  for (const key of ERROR_WRAP_KEYS) {
    const found = walkErrorMessage(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** A last-resort, still-honest label for an error with no diagnosable message anywhere. */
function errorShape(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || "Error";
  if (error === null || error === undefined) return String(error);
  return typeof error;
}

/**
 * `GRAPH_AGENT_DEBUG=1` dumps the raw, un-walked error to stderr so a cause
 * `walkErrorMessage` still can't reach is diagnosable without patching the
 * bundle -- see issue #52.
 */
function debugLogError(label: string, error: unknown): void {
  if (process.env.GRAPH_AGENT_DEBUG !== "1") return;
  process.stderr.write(`graph-agent debug: ${label}\n${inspect(error, { depth: 10 })}\n`);
}

export async function runSession(options: RunSessionOptions): Promise<SessionOutcome> {
  const sessionId = options.sessionId ?? randomUUID().slice(0, 8);
  const store = new SessionStore(options.paths, sessionId);
  if (!store.exists()) {
    store.create(options.project, options.name);
    const graphId = basename(options.graphPath, extname(options.graphPath));
    store.update((meta) => {
      meta.graph = graphId;
      if (options.prompt) meta.prompt = options.prompt;
      if (options.model) {
        meta.model = options.model.provider ? `${options.model.provider}/${options.model.id}` : options.model.id;
      }
    });
  }

  // Resolve callActivity targets from the shared library before the session owns
  // the graph: bpmn-elements only finds a called process inside the same
  // definition. Revision 0 is therefore the linked graph, which is what makes the
  // session self-contained and its recovery safe.
  const source = readFileSync(options.graphPath, "utf8");
  const linked = await linkGraph(source, await libraryIndex(options.paths));
  for (const target of linked.dynamic) {
    options.onProgress?.(`  note: calledElement '${target}' is an expression and cannot be linked ahead of the run`);
  }
  const reason =
    linked.linked.length > 0
      ? `started from ${options.graphPath}, linked ${linked.linked.join(", ")}`
      : `started from ${options.graphPath}`;
  store.appendGraph(linked.xml, reason, []);

  return drive(store, options, (harnessOptions) => runGraph(store.currentGraph() ?? linked.xml, harnessOptions));
}

/**
 * The graphs a session may call: the user's library, with the bundled graphs
 * behind it so a user copy shadows a built-in of the same process id.
 */
async function libraryIndex(paths: Paths) {
  const files = [...listBpmnFiles(bundledWorkflowsDir()), ...listBpmnFiles(paths.workflowsDir)].map((file) => ({
    source: file.path,
    xml: readFileSync(file.path, "utf8"),
  }));
  return indexLibrary(files);
}

export interface ResumeSessionOptions extends Omit<RunSessionOptions, "graphPath" | "prompt" | "name"> {
  sessionId: string;
}

export async function resumeSession(options: ResumeSessionOptions): Promise<SessionOutcome> {
  const store = new SessionStore(options.paths, options.sessionId);
  if (!store.exists()) throw new Error(`unknown session '${options.sessionId}'`);
  // A completed process has no token to dispatch and nowhere left to go --
  // knowable up front from meta.status, without ever handing the snapshot to
  // the engine. Without this check, resumeGraph would park on the #52 hang
  // guard (5000ms of "nothing dispatched"), report a diagnostic that reads
  // like snapshot corruption when the snapshot is fine, and -- worst -- the
  // drive() below would downgrade the session's own recorded outcome from
  // "completed" to "wait" (issue #63).
  if (store.readMeta().status === "completed") {
    throw new Error(
      `session '${options.sessionId}' has already completed; start a new one, or \`graph-agent promote\` its graph`,
    );
  }
  const state = store.readEngineState() as EngineState | null;
  if (!state) throw new Error(`session '${options.sessionId}' has no saved engine state to resume`);
  const graph = store.currentGraph();
  if (!graph) throw new Error(`session '${options.sessionId}' has no graph`);

  return drive(store, options, (harnessOptions) =>
    resumeGraph(state, store.currentGraph() ?? graph, harnessOptions),
  );
}

type Drive = (harnessOptions: Parameters<typeof runGraph>[1]) => Promise<RunResult>;

async function drive(
  store: SessionStore,
  options: Omit<RunSessionOptions, "graphPath">,
  start: Drive,
): Promise<SessionOutcome> {
  let graph = store.currentGraph() ?? "";
  const priorTranscript = store.readTranscript();

  // agent:tool is what actually runs a tool call the model asks for; a graph
  // with no such activity anywhere has nowhere to send one. A graph like
  // craft-graph's draft_fragment otherwise offers the model four tools it can
  // never actually run, and the model reaching for one wedges the run one
  // activity downstream of the real cause, surfacing as "a turn is already in
  // flight" on the *next* turn rather than naming the stuck call (issue #36).
  // With no tools declared, Pi's request carries none at all.
  //
  // This is decided up front but can flip once: if a later splice adds an
  // agent:tool activity, the splice re-entry below declares the tools then
  // (issue #118). Since Pi 0.86 the system prompt and tool set live in the
  // transcript, so the change lands as a `system` message with a
  // toolsAdded diff rather than rewriting the request's top-level tools
  // field. On models with `supportsMidConvoSystemMessages` the cached prefix
  // survives; other models get the transcript collapsed, which costs a
  // one-time cache miss, never an error. Splices are additive-only, so tools
  // are only ever added, never removed.
  let canRunTools = graphOffersTools(graph);

  const pi = new PiSession({
    model: options.model,
    systemPrompt: options.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    tools: canRunTools ? options.tools.list() : [],
    streamFn: options.streamFn,
    sessionId: store.id,
    // Empty for a fresh session; on resume this is the conversation so far, so
    // the model sees what was said before the gate and the final
    // writeTranscript below rewrites a superset of the file (issue #115).
    messages: priorTranscript as AgentMessage[],
  });
  options.onSessionReady?.(pi);

  // Steering and follow-up arrive from outside the graph; the graph decides when
  // to drain them. The initial prompt is not one of these -- it enters as a
  // process variable that the turn activity maps in. Two producers feed these:
  // `options.steering`/`.followUp` queue a message before the run even starts,
  // and `store.drainInbox` (issue #48) picks up whatever `graph-agent
  // steer`/`follow-up` queued from another process while this one is already
  // looping -- both are merged every time the graph actually asks.
  const steering: string[] = [...(options.steering ?? [])];
  const followUp: string[] = [...(options.followUp ?? [])];

  // Set whenever graph:extend lands a splice; checkStopAfterActivity below
  // reads it live, and it is reset before each re-entry so only a *new*
  // splice during that pass triggers another one (issue #45).
  let splicedThisPass = false;

  // The revision count this pass started from. checkStopAfterActivity below
  // compares the live count against this on every activity.end, which is how
  // a revision appended by someone *other* than this process's own setGraph
  // -- a studio edit landing mid-run -- is noticed at all: `splicedThisPass`
  // alone only catches a splice this process caused itself (issue #75).
  let revisionsAtPassStart = store.readMeta().revisions.length;

  const harnesses = createHarnesses({
    pi,
    tools: options.tools,
    store,
    cwd: options.project,
    // Re-read from disk on every call rather than trusting the local
    // `graph` -- otherwise a studio edit that lands mid-run is invisible to
    // `graph:lint`/`graph:extend`'s own `checkSplice` (issue #75): the
    // additive-only guard would compare a fragment against a baseline that
    // no longer matches what is actually on disk. `graph` remains only as
    // the fallback for the window before the first revision exists.
    getGraph: () => store.currentGraph() ?? graph,
    setGraph: (xml, reason, added, expectedIndex) => {
      store.appendGraph(xml, reason, added, expectedIndex);
      graph = xml;
      splicedThisPass = true;
    },
    takeSteering: () => [...steering.splice(0, steering.length), ...store.drainInbox("steer")],
    takeFollowUp: () => [...followUp.splice(0, followUp.length), ...store.drainInbox("follow-up")],
  });

  store.update((meta) => {
    meta.status = "running";
    // A pid this session's process can be checked against: `graph-agent
    // ls`/`show` report "stale" instead of "running" once that process is
    // gone, rather than leaving a phantom "running" session forever if this
    // function throws, or the process is killed, before the write below that
    // would otherwise correct it (issue #52).
    meta.pid = process.pid;
    meta.startedAt = Date.now();
  });

  const harnessOptions = {
    harnesses,
    name: store.id,
    variables: { prompt: options.prompt ?? "", project: options.project },
    onActivity: (activity: ActivityOutcome) => {
      options.onProgress?.(`${activity.activityId}  ${activity.harness}  ${activity.result.summary}`);
      options.onActivity?.(activity);
    },
    onTokens: (tokens: string[], visited: string[]) => {
      store.update((meta) => {
        meta.tokens = tokens;
        // `visited` is this call's own, per-pass set -- merged, never
        // replacing meta.visited outright (see `mergeVisited`/`markVisited`
        // in session-store.ts). Issue #59 found the studio's migration guard
        // silently un-protecting an earlier pass's activities without this.
        meta.visited = mergeVisited(meta.visited, visited);
      });
    },
    // A queued studio answer (issue #51) always takes precedence over --answer:
    // the studio never runs a model itself, it only queues the submitted form
    // here for whichever process is driving the session to pick up. Consuming
    // it removes it, so it cannot be replayed the way an unscoped --answer can
    // (issue #44).
    onWait: (activityId: string) => {
      const queued = store.takeAnswer(activityId);
      if (queued !== undefined) return queued;
      return options.onWait?.(activityId);
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.hangGuardMs === undefined ? {} : { hangGuardMs: options.hangGuardMs }),
    onExpressionWarning: (warning: { expression: string; message: string }) => {
      options.onProgress?.(`  FEEL warning: ${warning.message} in ${warning.expression}`);
    },
    // Same order as the end-of-pass write below: transcript, then engine state
    // (graph revisions are already on disk by the time any later activity ends).
    // meta.status stays "running"; a killed process reads as "stale" via pid.
    onCheckpoint: (state: EngineState) => {
      if (pi.messages.length > 0) store.writeTranscript(pi.messages, { allowShrink: pi.compacted });
      store.writeEngineState(state);
    },
    checkStopAfterActivity: () =>
      splicedThisPass || store.readMeta().revisions.length > revisionsAtPassStart,
  };

  // `graph:extend` replaces the definition a live engine holds in memory,
  // which that same engine never re-reads (issue #45): the elements a splice
  // adds cannot run until whatever is driving the session stops and resumes
  // against the new graph. checkStopAfterActivity forces exactly that the
  // instant a splice lands (see engine.ts), reporting it back as
  // `splicePending` rather than a genuine "nothing answered this gate" stop
  // -- so re-enter automatically here, against the freshest graph, rather
  // than handing an artificial stop back to the CLI for a park nobody asked
  // for. Bounded against a graph that re-splices every time it is entered.
  const MAX_SPLICE_REENTRIES = 5;
  let spliceReentries = 0;
  let result: RunResult;
  try {
    result = await start(harnessOptions);
    while (result.outcome === "stopped" && result.splicePending && spliceReentries < MAX_SPLICE_REENTRIES) {
      spliceReentries++;
      // This process's own setGraph already advanced `graph` and set
      // splicedThisPass; an external revision bump did neither, so re-sync
      // both from disk before resuming (issue #75).
      const external = !splicedThisPass;
      graph = store.currentGraph() ?? graph;
      if (!canRunTools && graphOffersTools(graph)) {
        pi.setTools(options.tools.list());
        canRunTools = true;
        options.onProgress?.("  note: graph now offers tools; declared them to the model");
      }
      splicedThisPass = false;
      revisionsAtPassStart = store.readMeta().revisions.length;
      const revisionIndex = revisionsAtPassStart - 1;
      options.onProgress?.(
        external
          ? `  note: graph revision ${revisionIndex} applied externally, resuming`
          : `  note: graph revision ${revisionIndex} applied, resuming`,
      );
      result = await resumeGraph(result.state, graph, harnessOptions);
    }
    if (result.outcome === "stopped" && result.splicePending) {
      options.onProgress?.(
        `  note: stopped after ${MAX_SPLICE_REENTRIES} splice-triggered re-entries without settling; resume manually to continue`,
      );
    }
  } catch (error) {
    // Nothing between here and the ordinary return path below writes a
    // terminal status -- so without this, any throw out of `start()` (engine.ts
    // itself catches everything it recognizes, but this is the backstop for
    // whatever it does not) leaves `meta.status: "running"` forever, exactly
    // the phantom-running session issue #52 describes.
    debugLogError("uncaught throw driving the session", error);
    store.update((meta) => {
      meta.status = "error";
      meta.harnessError = meta.harnessError ?? walkErrorMessage(error) ?? `run failed: ${errorShape(error)}`;
      delete meta.pid;
    });
    throw error;
  }

  if (result.note) options.onProgress?.(`  note: ${result.note}`);

  // bpmn-engine reports "completed" for any run that reaches an end event, even
  // pi-default-loop's own error path: end_error is a plain terminate end event,
  // not a thrown error, so a turn that errored looks exactly like one that
  // finished cleanly unless something checks. A *graph* is free to route a
  // failed() harness result anywhere it likes (craft-graph's lint_exhausted ->
  // craft_rejected is a legitimate, non-error outcome), so this deliberately
  // does not treat every failed() activity in the run as trouble -- only the
  // last turn actually reaching Pi, since that is what end_error's own
  // condition (`stop_reason = "error"`) keys on.
  const meta = store.readMeta();
  const lastTurn = meta.turns.at(-1);
  const trouble = result.outcome === "completed" && lastTurn?.stopReason === "error" ? lastTurn : undefined;
  const outcome = trouble ? "error" : result.outcome;
  if (result.error) debugLogError("engine reported an error", result.error);
  // Prefer `result.error`'s own message, but a harness that gave up outside
  // the ordinary turn path (graph:lint's redraft-attempt cap, chiefly) may
  // have already recorded a clearer one in meta.harnessError, and a message
  // buried in `result.error`'s own wrapping is worth more than a fabricated
  // one naming whichever activity happened to run the most recent turn --
  // issue #52 found the latter reported a confident, wrong cause when
  // `result.error.message` came back empty. Only when none of those turns up
  // anything does this fall back to an honest "no message" rather than a
  // guess.
  const recovered = result.error ? walkErrorMessage(result.error) : undefined;
  const fallbackMessage =
    meta.harnessError ??
    trouble?.error ??
    lastTurn?.error ??
    recovered ??
    (trouble
      ? // The engine itself reported nothing wrong -- it reached a plain
        // terminate end event -- so the only real fact here is which turn's
        // own stopReason was "error" with no message of its own attached.
        `${trouble.activityId} reported stopReason "error" with no message`
      : `run failed: the engine reported an error with no diagnosable message (${errorShape(result.error)}). ` +
        `Set GRAPH_AGENT_DEBUG=1 and re-run to see the raw error.`);
  const error =
    outcome !== "error" ? undefined : result.error?.message ? result.error : new Error(fallbackMessage);

  store.writeEngineState(result.state);
  if (pi.messages.length > 0 || priorTranscript.length > 0) {
    store.writeTranscript(pi.messages, { allowShrink: pi.compacted });
  }
  // A terminal "completed" status is never written backwards. resumeSession
  // already refuses to even start against a completed session, but this is
  // the general invariant issue #63 asks for rather than a fix scoped to one
  // call site: a pass that dispatched nothing at all has no business
  // overwriting whatever the session's last real outcome was.
  const alreadyCompleted = meta.status === "completed";
  const dispatchedNothing = result.activities.length === 0;
  store.update((meta) => {
    if (alreadyCompleted && dispatchedNothing && outcome !== "completed") {
      delete meta.pid;
      return;
    }
    meta.status = outcome === "completed" ? "completed" : outcome === "error" ? "error" : "wait";
    // The token reports come from getPostponed() as the run proceeds, so the
    // last one seen is whatever was in flight at the time. A run that reached an
    // end event has no token anywhere; leaving the stale set behind would draw
    // one on the diagram forever.
    if (outcome === "completed") meta.tokens = [];
    if (outcome === "error" && meta.harnessError === undefined) meta.harnessError = fallbackMessage;
    if (result.note && meta.harnessError === undefined) meta.harnessError = result.note;
    delete meta.pid;
  });

  return {
    sessionId: store.id,
    outcome,
    turns: store.readMeta().turns.length,
    ...(error === undefined ? {} : { error }),
  };
}
