/**
 * The bpmn-engine host.
 *
 * BPMN owns the control flow: the token moves, and each activity that declares a
 * `harness` in `camunda:properties` dispatches to the matching implementation.
 * Nothing here loops -- the loop, when there is one, is drawn in the diagram.
 */
import { Engine } from "bpmn-engine";
import { EventEmitter } from "node:events";
import {
  activityProperties,
  applyZeebeLoop,
  harnessOf,
  ioMapping,
  resolveInput,
  resolveOutput,
  retriesOf,
  type ActivityLike,
} from "./zeebe.ts";
import { camundaExpressions, evaluateFeel } from "./expressions.ts";
import {
  MODDLE_OPTIONS,
  recoverWithGraph,
  toSourceContext,
  type EngineConstructor,
  type EngineInstance,
  type EngineState,
} from "./graph.ts";
import type { HarnessContext, HarnessRegistry, HarnessResult } from "./harness.ts";

const EngineCtor = Engine as unknown as EngineConstructor;

export interface ActivityOutcome {
  activityId: string;
  activityName?: string;
  harness: string;
  result: HarnessResult;
  startedAt: number;
  endedAt: number;
}

export interface RunnerOptions {
  harnesses: HarnessRegistry;
  variables?: Record<string, unknown>;
  name?: string;
  signal?: AbortSignal;
  /** Called after each harness-backed activity completes. */
  onActivity?: (outcome: ActivityOutcome) => void | Promise<void>;
  /** Called whenever the token moves, with the ids currently waiting. */
  onTokens?: (tokens: string[], visited: string[]) => void | Promise<void>;
  /**
   * Called when an activity parks -- a user task, a receive task, an
   * intermediate catch event. Return a payload to answer it and let the token
   * carry on; return undefined to leave it parked.
   *
   * This is the seam a human gate lives behind, and the one an `agent:tool`
   * activity uses: the tool call parks the token until its result arrives.
   */
  onWait?: (activityId: string) => Promise<unknown> | unknown;
  /**
   * When an activity parks unanswered, stop the engine and snapshot rather than
   * hanging. Defaults to true: parking is how a graph asks for something the
   * engine cannot supply on its own, and the caller decides what happens next.
   */
  stopOnWait?: boolean;
  /**
   * FEEL evaluation warnings, chiefly "Variable 'x' not found". FEEL is total,
   * so a misspelled gateway condition silently takes the wrong branch unless
   * someone looks at these.
   */
  onExpressionWarning?: (warning: { expression: string; message: string }) => void;
  /**
   * How long the hang guard waits with nothing dispatched before forcing a
   * stop (see `drive()`). Defaults to 5000ms; overridable so a test can prove
   * the guard fires without actually waiting out the production value.
   */
  hangGuardMs?: number;
  /**
   * Polled after every activity ends; a `true` stops the engine right there
   * instead of letting the current pass run on to its own end event. Issue
   * #45: `graph:extend` replaces the definition a *running* engine holds in
   * memory, which that engine never re-reads -- a splice only takes effect
   * once whatever is driving it stops and resumes against the new graph. The
   * runner uses this to force exactly that the moment a splice lands, so the
   * elements it added get a chance to run before the session can reach a
   * true end event without them.
   */
  checkStopAfterActivity?: () => boolean;
  /**
   * Called with a fresh engine snapshot after a harness-backed activity ends
   * (issue #116), so a crash mid-pass loses at most the activity in flight.
   * Calls are serialized and coalesced: at most one runs and one more is
   * queued, and every call is settled before the run returns.
   *
   * Only harness-backed activities checkpoint -- they are the ones that cost
   * money or have side effects; gateways and events are cheap to replay.
   * Nothing is checkpointed *inside* a turn: an `agent:turn` that dies
   * mid-stream is simply re-run on resume, which costs one turn.
   */
  onCheckpoint?: (state: EngineState) => void | Promise<void>;
}

export interface RunResult {
  /** `completed` when the process reached an end event, `stopped` otherwise. */
  outcome: "completed" | "stopped" | "error";
  state: EngineState;
  variables: Record<string, unknown>;
  activities: ActivityOutcome[];
  error?: Error;
  /**
   * Set when `outcome` was forced rather than genuinely reported by the
   * engine -- currently only the hang guard below. `drive()` in runner.ts
   * surfaces this on the session so a forced outcome is never silently
   * indistinguishable from an ordinary one.
   */
  note?: string;
  /**
   * `outcome === "stopped"` because `checkStopAfterActivity` said so, not
   * because a human gate went unanswered. runner.ts's `drive()` uses this to
   * tell "resume automatically, a splice just landed" apart from "hand
   * control back, something is genuinely waiting on a person" -- see issue
   * #45.
   */
  splicePending?: boolean;
}

/**
 * Install harness dispatch on an activity.
 *
 * bpmn-engine has no notion of `camunda:properties`, so this is where a diagram's
 * `harness` declaration turns into an actual call. Modelled on paed01's
 * "Extend service task behaviour" example.
 */
/**
 * zeebe:ioMapping sources are FEEL. The mapping module stays pure and takes an
 * evaluator, so this is where it is supplied: a flat scope, since the source is
 * evaluated against process variables (input) or the job result (output).
 *
 * `content` is forwarded rather than hardcoded empty: bpmn-elements binds a
 * multi-instance loop's `elementVariable` (a subProcess's `zeebe:loopCharacteristics
 * inputElement`, e.g. tool_batch's `tool_call`) as a process variable literally
 * named `content` holding that iteration's message, not as a bare top-level
 * name -- so `scope` already carries it under that key when present. Hardcoding
 * `content: {}` here clobbered it back to empty, since feelContext() lets its own
 * explicit `content` win over whatever the environment.variables spread already
 * produced under the same bare name. An ordinary activity has no such variable,
 * so `scope.content` is `undefined` and this stays `{}` exactly as before.
 */
const feelIn = (expression: string, scope: Record<string, unknown>): unknown =>
  evaluateFeel(expression, { environment: { variables: scope, output: {} }, content: scope.content ?? {} });

/**
 * Retries a harness call on a thrown/rejected error only -- a job failure in C8
 * terms. A harness that *returns* `status: "failed"` is a business error the
 * graph routes on with a gateway, and retrying it would just run it again
 * unconditionally; that path is untouched.
 */
async function callWithRetries(call: () => Promise<HarnessResult>, attempts: number): Promise<HarnessResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

type RegisteredActivity = ActivityLike & Record<string, unknown>;

interface SessionStatsTracker {
  total_cost: number;
  turn_count: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

function initSessionStats(existing?: unknown): SessionStatsTracker {
  const s = existing as Partial<SessionStatsTracker> | undefined;
  return {
    total_cost: s?.total_cost ?? 0,
    turn_count: s?.turn_count ?? 0,
    total_tokens: s?.total_tokens ?? 0,
    input_tokens: s?.input_tokens ?? 0,
    output_tokens: s?.output_tokens ?? 0,
    cache_read_tokens: s?.cache_read_tokens ?? 0,
    cache_write_tokens: s?.cache_write_tokens ?? 0,
  };
}

function makeExtension(
  options: RunnerOptions,
  activities: ActivityOutcome[],
  byId: Map<string, RegisteredActivity>,
  sharedOutput: Record<string, unknown>,
) {
  const sessionStats = initSessionStats(sharedOutput._session);
  sharedOutput._session = { ...sessionStats };

  return function harnessExtension(activity: RegisteredActivity): void {
    // Multi-instance activities carry their collection in a zeebe: extension the
    // engine does not read; translate it before anything tries to run the loop.
    applyZeebeLoop(activity);
    // Recorded for every activity, harness-backed or not: a userTask has no
    // Service to hook zeebe:ioMapping through, so `drive()`'s activity.end
    // listener applies its output mapping directly, and needs the definition.
    byId.set(activity.id, activity);

    const harnessName = harnessOf(activity);
    if (!harnessName) return;

    const implementation = options.harnesses[harnessName];
    const properties = activityProperties(activity);
    // zeebe:taskDefinition retries="n" is a count of attempts, not extra retries
    // on top of the first: no attribute (or retries="0") means the current
    // one-shot behaviour, retries="3" means up to three tries before giving up.
    const attempts = Math.max(1, retriesOf(activity) ?? 1);

    const environment = (activity as unknown as { environment: { variables: Record<string, unknown>; output: Record<string, unknown> } })
      .environment;

    environment.output._session = { ...sessionStats };
    environment.variables._session = { ...sessionStats };

    activity.behaviour.Service = function HarnessService() {
      return {
        type: `${activity.type}:harness`,
        execute(
          executionMessage: { content?: Record<string, unknown> },
          callback: (error: Error | null, result?: unknown) => void,
        ): void {
          const startedAt = Date.now();
          const variables = { ...environment.variables };
          if (!implementation) {
            callback(new Error(`no harness registered for '${harnessName}' (activity ${activity.id})`));
            return;
          }

          const context: HarnessContext = {
            activityId: activity.id,
            ...(activity.name === undefined ? {} : { activityName: activity.name }),
            harness: harnessName,
            properties,
            input: resolveInput(
              activity,
              { ...variables, ...sharedOutput, ...environment.output, ...(executionMessage.content ?? {}) },
              feelIn,
            ),
            variables: { ...variables, ...sharedOutput, ...environment.output },
            ...(options.signal ? { signal: options.signal } : {}),
          };

          void callWithRetries(() => implementation(context), attempts).then(
            (result) => {
              // Publish camunda:outputParameter / camunda:resultVariable before the
              // token leaves, so the next gateway sees the values.
              //
              // It has to go to `environment.output`, not `environment.variables`:
              // Environment.clone() copies `variables` by value, so every activity
              // gets its own snapshot and a write there is invisible to the rest of
              // the run. `output` is passed through by reference and is shared --
              // but only *within* the process that activity belongs to: a
              // callActivity's called process is a genuinely separate bpmn-elements
              // process instance with its own Environment, which does not inherit
              // this one's `output`. `sharedOutput` is this project's own bridge
              // across that boundary: every resolved output goes there too, and
              // every activity's scope reads it back, regardless of which linked
              // process it runs in. See docs/harnesses.md.
              for (const [key, value] of Object.entries(resolveOutput(activity, result, feelIn))) {
                if (value !== undefined) {
                  environment.output[key] = value;
                  sharedOutput[key] = value;
                }
              }

              if (result && typeof result === "object" && "usage" in result && result.usage) {
                const u = (result as { usage?: any }).usage;
                if (u) {
                  sessionStats.turn_count += 1;
                  sessionStats.input_tokens += u.input ?? 0;
                  sessionStats.output_tokens += u.output ?? 0;
                  sessionStats.cache_read_tokens += u.cacheRead ?? 0;
                  sessionStats.cache_write_tokens += u.cacheWrite ?? 0;
                  sessionStats.total_tokens += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0));
                  if (u.cost?.total) {
                    sessionStats.total_cost += u.cost.total;
                  }
                  environment.output._session = { ...sessionStats };
                  sharedOutput._session = { ...sessionStats };
                  environment.variables._session = { ...sessionStats };
                }
              }

              activities.push({
                activityId: activity.id,
                ...(activity.name === undefined ? {} : { activityName: activity.name }),
                harness: harnessName,
                result,
                startedAt,
                endedAt: Date.now(),
              });
              void options.onActivity?.(activities[activities.length - 1] as ActivityOutcome);
              callback(null, result);
            },
            (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
          );
        },
      };
    };
  };
}

function engineOptions(
  options: RunnerOptions,
  activities: ActivityOutcome[],
  byId: Map<string, RegisteredActivity>,
  sharedOutput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: options.name ?? "graph-agent",
    moddleOptions: MODDLE_OPTIONS,
    variables: options.variables ?? {},
    // Gateways in Camunda-flavoured diagrams compare values; the default
    // handler only does truthy lookups. See src/agent/expressions.ts.
    expressions: camundaExpressions({
      ...(options.onExpressionWarning ? { onWarning: options.onExpressionWarning } : {}),
      sharedOutput,
    }),
    extensions: { harness: makeExtension(options, activities, byId, sharedOutput) },
  };
}

/** Answer a parked activity by looking up a live api for it. */
function signalPostponed(engine: EngineInstance, activityId: string, message: unknown): void {
  const postponed = (engine.execution?.getPostponed() ?? []) as Array<{
    id: string;
    signal?: (message?: unknown) => void;
  }>;
  const target = postponed.find((activity) => activity.id === activityId);
  if (target?.signal) target.signal(message);
}

/**
 * Applies `zeebe:ioMapping` output for an activity the harness Service wrapper
 * never touched -- a `zeebe:userTask`, chiefly. bpmn-engine has no notion of
 * Camunda IO outside that wrapper, so a user task's answered form (the
 * `output` bpmn-elements attaches to its `activity.end` content) would
 * otherwise never become a named process variable: `session-skeleton.bpmn`'s
 * `await_intent` publishes `session_done` this way, and without it `gw_more`
 * never sees a true `session_done` and loops forever.
 *
 * A `bpmn:CallActivity`'s own signaled output has one extra layer a user
 * task's does not: bpmn-elements relays a called process's completion back
 * through its own delegate-signal machinery, which wraps it as
 * `{ executionId, output: {...theCalledProcess'sOwnEnvironmentOutput} }`
 * rather than handing the plain fields directly the way an answered form
 * does. Unwrapped, a `zeebe:output source="=x"` on the callActivity would
 * only ever see `executionId` and a nested `output` object, never `x` itself
 * -- and `=output.x` does not work either, since `output` is itself a
 * reserved root in `feelContext` (`src/agent/expressions.ts`) pointing at
 * `environment.output`, not at this payload's own nested key. Unwrapping
 * here, before handing the scope to `resolveOutput`, is what lets a
 * callActivity's `zeebe:output` read the called process's published
 * variables by their bare names, symmetrically with every other unharnessed
 * activity (issue #66: `session-craft.bpmn`'s `gw_crafted` routes on
 * `extend_status`, set deep inside `craft_graph`, only once `craft`'s own
 * `zeebe:output source="=extend_status"` can see it).
 */
function applyUnharnessedOutput(
  activity: RegisteredActivity | undefined,
  signaled: unknown,
  sharedOutput: Record<string, unknown>,
): void {
  if (!activity || harnessOf(activity)) return;
  const outputs = ioMapping(activity).output;
  if (outputs.length === 0) return;
  const isCallActivity = (activity as unknown as { type?: string }).type === "bpmn:CallActivity";
  const nested =
    isCallActivity && signaled && typeof signaled === "object" && typeof (signaled as { output?: unknown }).output === "object"
      ? (signaled as { output: unknown }).output
      : signaled;
  const scope = nested && typeof nested === "object" ? nested : {};
  const environment = (activity as unknown as { environment: { output: Record<string, unknown> } }).environment;
  for (const [key, value] of Object.entries(resolveOutput(activity, scope, feelIn))) {
    if (value !== undefined) {
      environment.output[key] = value;
      sharedOutput[key] = value;
    }
  }
}

/**
 * Rebuilds `sharedOutput` for a resumed run.
 *
 * `sharedOutput` itself is never persisted -- it lives only in `drive()`'s
 * closure -- but everything ever written to it was *also* written to
 * whichever process's own `environment.output` produced it, and
 * `engine.getState()` does capture that, once per still-running process
 * (`definitions[].execution.processes[]`, one entry per linked process a
 * callActivity has parked inside as well as the top-level one). Recovery
 * just re-unions them.
 */
function collectSharedOutput(state: EngineState): Record<string, unknown> {
  const shared: Record<string, unknown> = {};
  const definitions = (state.definitions ?? []) as Array<{
    execution?: { processes?: Array<{ environment?: { output?: Record<string, unknown> } }> };
  }>;
  for (const definition of definitions) {
    for (const process of definition.execution?.processes ?? []) {
      Object.assign(shared, process.environment?.output ?? {});
    }
  }
  return shared;
}

/** Ids the token is currently resting on (waiting activities and running ones). */
export function postponedIds(engine: EngineInstance): string[] {
  try {
    return (engine.execution?.getPostponed() ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}

async function drive(
  engine: EngineInstance,
  options: RunnerOptions,
  activities: ActivityOutcome[],
  byId: Map<string, RegisteredActivity>,
  sharedOutput: Record<string, unknown>,
  start: (listener: EventEmitter) => Promise<unknown>,
): Promise<RunResult> {
  const visited = new Set<string>();
  const listener = new EventEmitter();

  // `engine.execution` (what postponedIds reads) is not yet assigned the very
  // first time a fresh run parks on its own first activity -- execute() has not
  // finished its own setup by the time that "activity.wait" fires -- so
  // postponedIds alone would silently report no token at all for exactly the
  // case session-skeleton.bpmn hits on every run: await_intent, first thing.
  // Tracking waits directly from the events that announce them covers that gap;
  // postponedIds stays the primary source once the engine is up, chiefly for
  // multi-instance batches whose individual instances postponedIds sees but a
  // single "activity.wait" on the subProcess would not.
  const waiting = new Set<string>();
  const currentTokens = (): string[] => [...new Set([...postponedIds(engine), ...waiting])];

  // Set the moment bpmn-elements dispatches *anything*, well before any
  // harness's own async work returns -- see the hang guard below. Also set
  // from "activity.wait" (issue #69): a resumed run re-announcing an
  // already-parked activity is real activity too, not silence.
  let dispatchedAnything = false;
  listener.on("activity.start", (api?: { id?: string }) => {
    dispatchedAnything = true;
    if (api?.id) visited.add(api.id);
  });
  listener.on("flow.take", (api?: { id?: string }) => {
    if (api?.id) visited.add(api.id);
  });

  // Serialize + coalesce checkpoints: getState() serializes the whole
  // definition, so one snapshot per event in parallel would interleave writes.
  let checkpointing: Promise<void> | null = null;
  let checkpointDirty = false;
  const scheduleCheckpoint = (): void => {
    if (!options.onCheckpoint) return;
    if (checkpointing) {
      checkpointDirty = true;
      return;
    }
    checkpointing = (async () => {
      try {
        do {
          checkpointDirty = false;
          try {
            await options.onCheckpoint?.(await engine.getState());
          } catch (error) {
            // A failed checkpoint must not take the run down with it; the
            // end-of-pass write in runner.ts is still the authoritative one.
            if (process.env.GRAPH_AGENT_DEBUG) console.error("checkpoint failed:", error);
          }
        } while (checkpointDirty);
      } finally {
        checkpointing = null;
      }
    })();
  };

  const waitingConditionals = new Map<string, { signal?: (message?: unknown) => void }>();

  let stoppedForSplice = false;
  listener.on("activity.end", (api: { id: string; content?: { output?: unknown } }) => {
    visited.add(api.id);
    waiting.delete(api.id);
    waitingConditionals.delete(api.id);
    applyUnharnessedOutput(byId.get(api.id), api.content?.output, sharedOutput);
    for (const [, condApi] of waitingConditionals) {
      try {
        condApi.signal?.();
      } catch {
        // Best effort
      }
    }
    void options.onTokens?.(currentTokens(), [...visited]);
    if (byId.has(api.id)) scheduleCheckpoint();
    if (options.checkStopAfterActivity?.()) {
      stoppedForSplice = true;
      void engine.stop();
    }
  });
  listener.on("activity.wait", (api: { id: string; type?: string; signal?: (message?: unknown) => void }) => {
    // A resumed run can reach this without ever firing "activity.start" first
    // -- bpmn-elements re-announces an activity that was already parked when
    // the snapshot was taken, rather than starting it again -- so relying on
    // "activity.start" alone left a legitimately-waiting resume indistinguishable
    // from the #52 hang this guard exists for: `graph-agent tui --resume`
    // showed the parked gate, then the hang guard fired 5s later and stopped
    // the engine out from under the person still typing an answer (issue #69).
    // A wait is real activity, proof the engine is alive and responsive.
    dispatchedAnything = true;
    waiting.add(api.id);
    void options.onTokens?.(currentTokens(), [...visited]);

    // Background event definitions (conditional/timer) wait for their condition or timer to fire,
    // rather than parking for an interactive human answer.
    if (api.type === "bpmn:ConditionalEventDefinition" || api.type === "bpmn:TimerEventDefinition") {
      if (api.type === "bpmn:ConditionalEventDefinition") {
        waitingConditionals.set(api.id, api);
      }
      return;
    }

    const answer = options.onWait?.(api.id);
    if (answer === undefined) {
      if (options.stopOnWait !== false) void engine.stop();
      return;
    }

    // Always settle on a fresh microtask and re-acquire a live api from the
    // postponed set, even for a synchronous answer: the api handed to this
    // listener is only good for the duration of the event, and signalling it
    // inline -- in the same synchronous pass that can instantiate a brand-new
    // nested process, e.g. a callActivity reached for the first time mid-resume
    // -- hits a bpmn-elements message-redelivery race that throws "cannot
    // resume running process" on that fresh child (issue #30). A one-microtask
    // deferral sidesteps it without any real latency.
    void Promise.resolve(answer).then((resolved) => {
      if (resolved === undefined) {
        if (options.stopOnWait !== false) void engine.stop();
        return;
      }
      waiting.delete(api.id);
      signalPostponed(engine, api.id, resolved);
    });
  });

  const ended = engine.waitFor("end").then(() => "completed" as const);
  const stopped = engine.waitFor("stop").then(() => "stopped" as const);
  const errored = engine.waitFor("error").then((error) => {
    // A non-Error thrown value used to be flattened to `new Error(String(error))`,
    // discarding everything but a lossy toString -- issue #52 found this is
    // exactly what leaves a real cause unreachable by the time it gets to the
    // CLI. Attaching it as `cause` keeps it reachable for walkErrorMessage
    // (runner.ts) without changing what a plain `Error` already reported.
    throw error instanceof Error ? error : new Error(String(error), { cause: error });
  });

  // Issue #52: a resumed run whose snapshot bpmn-elements cannot actually
  // recover can leave engine.resume() dispatching nothing at all -- no
  // activity, no wait, no end, no error -- so none of the three promises
  // above ever settles and the whole CLI process hangs (Node exits 13 on an
  // "unsettled top-level await", with the session stuck reporting
  // status:"running" forever). `dispatchedAnything` is set the instant
  // bpmn-elements dispatches *anything*, which happens near-instantly for any
  // engine that is actually alive -- well before a harness's own async work
  // (a model call, chiefly) returns -- so a generous grace period with no
  // dispatch at all is a safe, specific signal that this run is never going
  // to settle on its own, not a false positive against a slow first turn.
  const hangGuardMs = options.hangGuardMs ?? 5000;
  let hangGuardTimer: ReturnType<typeof setTimeout> | undefined;
  const hangGuard = new Promise<"stopped">((resolve) => {
    // Deliberately NOT `.unref()`'d: the hang this exists for is precisely a
    // Node process whose event loop has otherwise gone idle with nothing left
    // to fire ended/stopped/errored -- an unref'd timer does not count as
    // outstanding work, so Node would drain the loop and force-exit (the
    // "unsettled top-level await" warning, issue #52) *before* this timer
    // ever got a chance to run, defeating the guard entirely. It must hold
    // the process open until it fires or `clearTimeout` below cancels it.
    hangGuardTimer = setTimeout(() => {
      if (dispatchedAnything) return;
      void engine.stop();
      resolve("stopped");
    }, hangGuardMs);
  });

  if (options.signal) {
    options.signal.addEventListener("abort", () => void engine.stop(), { once: true });
  }

  try {
    await start(listener);
    const outcome = await Promise.race([ended, stopped, errored, hangGuard]);
    clearTimeout(hangGuardTimer);
    await checkpointing;
    return {
      outcome,
      state: await engine.getState(),
      variables: { ...engine.environment.variables, ...engine.environment.output, ...sharedOutput },
      activities,
      ...(outcome === "stopped" && !dispatchedAnything
        ? {
            note: `the engine dispatched nothing at all within ${hangGuardMs}ms and was stopped rather than hung -- this usually means the resumed snapshot could not be recovered`,
          }
        : {}),
      ...(outcome === "stopped" && stoppedForSplice ? { splicePending: true } : {}),
    };
  } catch (error) {
    clearTimeout(hangGuardTimer);
    await checkpointing;
    // `engine.waitFor("error")` resolves on the first error event and we return
    // right away, but nothing else here ever told the engine to stop -- so
    // whatever kept running (a nested process mid-callActivity, chiefly: see
    // issue #30, where resuming into one that had not started yet threw
    // "cannot resume running process") kept right on running, detached from
    // this call and from anything that could interrupt it. A caller await-ing
    // this function sees it return; the model calls and BPMN activity churn
    // do not stop with it unless told to here.
    //
    // Not awaited: an engine that has already errored out cleanly (nothing left
    // running, e.g. "no harness registered for X") never settles its own stop()
    // promise, and awaiting it here would hang this call over a stop that has
    // nothing to do. Firing it and moving on matches the abort-signal handler
    // above, which does the same for the same reason.
    try {
      void Promise.resolve(engine.stop()).catch(() => {});
    } catch {
      // Already broken; stopping is a best-effort cleanup, not a second error
      // to report over the one that actually happened.
    }
    return {
      outcome: "error",
      state: await engine.getState(),
      variables: { ...engine.environment.variables, ...engine.environment.output, ...sharedOutput },
      activities,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Start a fresh process instance from BPMN XML. */
export async function runGraph(xml: string, options: RunnerOptions): Promise<RunResult> {
  const activities: ActivityOutcome[] = [];
  const byId = new Map<string, RegisteredActivity>();
  const sharedOutput: Record<string, unknown> = {};
  const sourceContext = await toSourceContext(xml);
  const engine = new EngineCtor({ ...engineOptions(options, activities, byId, sharedOutput), sourceContext });
  return drive(engine, options, activities, byId, sharedOutput, (listener) => engine.execute({ listener }));
}

/**
 * Resume a snapshot, optionally against a graph that has since been extended.
 * This is how a session picks up after a splice.
 */
export async function resumeGraph(state: EngineState, xml: string, options: RunnerOptions): Promise<RunResult> {
  const activities: ActivityOutcome[] = [];
  const byId = new Map<string, RegisteredActivity>();
  const sharedOutput = collectSharedOutput(state);
  const engine = await recoverWithGraph(EngineCtor, state, xml, {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.variables ? { variables: options.variables } : {}),
    engineOptions: engineOptions(options, activities, byId, sharedOutput),
  });
  return drive(engine, options, activities, byId, sharedOutput, (listener) => engine.resume({ listener }));
}
