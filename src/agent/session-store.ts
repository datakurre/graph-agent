import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphRevision, SessionDetail, SessionStats, SessionSummary, TurnRecord } from "../studio/types.ts";
import type { Paths } from "./paths.ts";

/**
 * On-disk shape of a session, under the user-level state directory.
 *
 *   $XDG_STATE_HOME/graph-agent/sessions/<id>/
 *     meta.json        session identity, the project it ran against, and history
 *     engine.json      bpmn-engine state snapshot (source stripped; see graph/)
 *     graph/000.bpmn   graph revisions, oldest first -- the session mutates, so
 *     graph/001.bpmn   every splice lands as a new revision rather than an overwrite
 *     session.jsonl    Pi's transcript, written by graph-agent (restored on resume)
 *
 * Ordering matters on write: the transcript is Pi's, the graph revision is ours,
 * and the engine snapshot points at both. Committing them in that order means a
 * crash can leave a revision with no engine state (recoverable by replaying to the
 * last snapshot) but never engine state referencing a graph that was never written.
 */
export interface InflightTool {
  name: string;
  arguments: Record<string, unknown>;
  activityId: string;
  startedAt: number;
}

export interface SessionMeta {
  id: string;
  /**
   * Side-effecting calls whose intent was recorded before they ran (issue
   * #117), keyed by tool call id (`shell:<activityId>` for the `shell`
   * harness). An entry still present when the same call is dispatched again
   * means the process died mid-call.
   */
  inflightTools?: Record<string, InflightTool>;
  name?: string;
  /** Absolute path of the project directory this session ran against. */
  project: string;
  /** Initial task prompt passed to the session. */
  prompt?: string;
  /** Model spec string (provider/model) used for the run. */
  model?: string;
  /**
   * The `--graph <id>` this session was started from (the graph file's own
   * basename, without its `.bpmn` extension) -- set once, at `runSession`
   * time. Recorded directly rather than parsed back out of a revision's own
   * free-text `reason` string, so a reattached TUI (issue #73) or anything
   * else that wants to name the graph a session runs has a stable field to
   * read instead of scraping prose.
   */
  graph?: string;
  status: SessionSummary["status"];
  createdAt: number;
  updatedAt: number;
  turns: TurnRecord[];
  steps?: TurnRecord[];
  revisions: GraphRevision[];
  /** Activity ids the token currently rests on. */
  tokens: string[];
  /** Activity ids executed at least once. */
  visited: string[];
  /**
   * The pid of the process currently driving this session, set while
   * `status` is `"running"` and cleared once it settles. Lets `summary()`
   * tell a genuinely live run apart from one a killed process left claiming
   * to be running forever (issue #52).
   */
  pid?: number;
  startedAt?: number;
  /**
   * Set by a harness that gave up and deliberately ended the run outside the
   * ordinary agent:turn path (graph:lint's redraft-attempt cap, chiefly).
   * bpmn-elements re-wraps a thrown error at every callActivity boundary it
   * crosses, and the original message is not reliably reachable off the
   * resulting error's own `.message` by the time it reaches the CLI -- this
   * is a channel this project controls instead.
   */
  harnessError?: string;
}

/** One queued steering/follow-up message, as stored in `inbox.jsonl` (issue #48). */
export interface InboxEntry {
  kind: "steer" | "follow-up";
  text: string;
  at: number;
}

/** One queued human-gate answer, as stored in `answers.jsonl` (issue #51). */
export interface AnswerEntry {
  activityId: string;
  payload: Record<string, unknown>;
  at: number;
}

/** The one place `meta.visited`'s union-not-replace semantics live -- see `SessionStore.markVisited`. */
export function mergeVisited(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

/**
 * Thrown by `SessionStore.appendGraph` when the caller's `expectedIndex` no
 * longer matches the revision count on disk -- another writer (a studio edit
 * landing mid-run, or a second concurrent studio PUT, see issues #75/#76)
 * appended a revision between when the caller read the graph it validated a
 * change against and when it tried to write the result. `currentIndex` is
 * the revision index actually on disk, so a caller can re-read and retry
 * rather than silently overwrite it.
 */
export class GraphRevisionConflictError extends Error {
  readonly currentIndex: number;
  constructor(currentIndex: number) {
    super(`graph has moved to revision ${currentIndex} since this write was validated`);
    this.currentIndex = currentIndex;
  }
}

export class SessionStore {
  private readonly paths: Paths;
  readonly id: string;
  constructor(paths: Paths, id: string) {
    this.paths = paths;
    this.id = id;
  }

  get dir(): string {
    return join(this.paths.sessionsDir, this.id);
  }

  get graphDir(): string {
    return join(this.dir, "graph");
  }

  get metaPath(): string {
    return join(this.dir, "meta.json");
  }

  get enginePath(): string {
    return join(this.dir, "engine.json");
  }

  get transcriptPath(): string {
    return join(this.dir, "session.jsonl");
  }

  /**
   * Steering/follow-up messages queued from *outside* the process driving
   * this session -- `graph-agent steer`/`follow-up` append here from another
   * terminal; `agent:steer`/`agent:follow-up` (harnesses.ts) drain it every
   * time the graph reaches them, which is how a message posted while a run is
   * already looping actually reaches it (issue #48).
   */
  get inboxPath(): string {
    return join(this.dir, "inbox.jsonl");
  }

  /** Queue a steering/follow-up message for whichever process is (or next is) driving this session. */
  queueInbox(kind: InboxEntry["kind"], text: string): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.inboxPath, `${JSON.stringify({ kind, text, at: Date.now() } satisfies InboxEntry)}\n`);
  }

  /** Every queued message of one kind, removing them from the inbox; messages of the other kind are left for their own drain. */
  drainInbox(kind: InboxEntry["kind"]): string[] {
    if (!existsSync(this.inboxPath)) return [];
    const entries = readFileSync(this.inboxPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as InboxEntry);
    const matching = entries.filter((entry) => entry.kind === kind).map((entry) => entry.text);
    const remaining = entries.filter((entry) => entry.kind !== kind);
    writeAtomic(this.inboxPath, remaining.map((entry) => JSON.stringify(entry)).join("\n") + (remaining.length > 0 ? "\n" : ""));
    return matching;
  }

  /**
   * Answers to a parked human gate, queued from the studio (issue #51) for
   * whichever process is -- or next is -- driving this session. A run only
   * resumes when a process resumes it, so the studio never runs a model
   * itself: it queues the answered form here, and `runSession`/`resumeSession`
   * consume a matching one from `onWait(activityId)` before falling back to
   * `--answer`.
   */
  get answersPath(): string {
    return join(this.dir, "answers.jsonl");
  }

  /** Queue an answer for one activity. A later queueAnswer for the same activity id replaces the earlier one. */
  queueAnswer(activityId: string, payload: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    const entries = this.readAnswers().filter((entry) => entry.activityId !== activityId);
    entries.push({ activityId, payload, at: Date.now() });
    this.writeAnswers(entries);
  }

  /** Every activity id with a queued answer. */
  pendingAnswers(): string[] {
    return this.readAnswers().map((entry) => entry.activityId);
  }

  /** Consumes (removes) the queued answer for one activity, if any, so it cannot be replayed (see issue #44 on why that matters). */
  takeAnswer(activityId: string): Record<string, unknown> | undefined {
    const entries = this.readAnswers();
    const index = entries.findIndex((entry) => entry.activityId === activityId);
    if (index === -1) return undefined;
    const [taken] = entries.splice(index, 1);
    this.writeAnswers(entries);
    return taken?.payload;
  }

  private readAnswers(): AnswerEntry[] {
    if (!existsSync(this.answersPath)) return [];
    return readFileSync(this.answersPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AnswerEntry);
  }

  private writeAnswers(entries: AnswerEntry[]): void {
    writeAtomic(this.answersPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : ""));
  }

  exists(): boolean {
    return existsSync(this.metaPath);
  }

  delete(): void {
    if (existsSync(this.dir)) {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  create(project: string, name?: string): SessionMeta {
    mkdirSync(this.graphDir, { recursive: true });
    const now = Date.now();
    const meta: SessionMeta = {
      id: this.id,
      project,
      ...(name === undefined ? {} : { name }),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      turns: [],
      steps: [],
      revisions: [],
      tokens: [],
      visited: [],
    };
    this.writeMeta(meta);
    return meta;
  }

  readMeta(): SessionMeta {
    return JSON.parse(readFileSync(this.metaPath, "utf8")) as SessionMeta;
  }

  writeMeta(meta: SessionMeta): void {
    mkdirSync(this.dir, { recursive: true });
    meta.updatedAt = Date.now();
    writeAtomic(this.metaPath, JSON.stringify(meta, null, 2));
  }

  update(mutate: (meta: SessionMeta) => void): SessionMeta {
    const meta = this.readMeta();
    mutate(meta);
    this.writeMeta(meta);
    return meta;
  }

  /**
   * Merges `ids` into `meta.visited` rather than replacing it. `visited` is
   * the studio's migration guard's only record of which elements have live
   * state and must not be removed or renamed -- but the engine's own
   * `visited` set (`src/agent/engine.ts`) is fresh per `runGraph`/`resumeGraph`
   * call, so every automatic splice re-entry (issue #45) starts a new one.
   * Overwriting `meta.visited` with that per-pass set on every token move
   * silently un-protects everything a session did before the most recent
   * resume (issue #59) -- this is the one place that is allowed to write it.
   */
  markVisited(ids: readonly string[]): SessionMeta {
    return this.update((meta) => {
      meta.visited = mergeVisited(meta.visited, ids);
    });
  }

  /** Revision file names, oldest first. */
  graphRevisionFiles(): string[] {
    if (!existsSync(this.graphDir)) return [];
    return readdirSync(this.graphDir)
      .filter((f) => f.endsWith(".bpmn"))
      .sort();
  }

  /**
   * Append a new graph revision and record it in meta. `expectedIndex`, when
   * given, is the revision index the caller believed it was extending (e.g.
   * the count read alongside the graph a splice was validated against) --
   * a mismatch means someone else's write landed first, and this throws
   * `GraphRevisionConflictError` instead of silently overwriting it.
   */
  appendGraph(xml: string, reason: string, addedElementIds: string[] = [], expectedIndex?: number): GraphRevision {
    mkdirSync(this.graphDir, { recursive: true });
    const index = this.graphRevisionFiles().length;
    if (expectedIndex !== undefined && expectedIndex !== index) {
      throw new GraphRevisionConflictError(index);
    }
    writeAtomic(join(this.graphDir, `${String(index).padStart(3, "0")}.bpmn`), xml);
    const revision: GraphRevision = { index, at: Date.now(), reason, addedElementIds };
    this.update((meta) => {
      meta.revisions.push(revision);
    });
    return revision;
  }

  /** The graph as it now stands. */
  currentGraph(): string | null {
    const files = this.graphRevisionFiles();
    const last = files[files.length - 1];
    return last === undefined ? null : readFileSync(join(this.graphDir, last), "utf8");
  }

  readEngineState(): unknown | null {
    if (!existsSync(this.enginePath)) return null;
    return JSON.parse(readFileSync(this.enginePath, "utf8")) as unknown;
  }

  writeEngineState(state: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.enginePath, JSON.stringify(state));
  }

  /**
   * Never writes less than it reads (issue #115) unless the caller says the
   * transcript was deliberately compacted.
   */
  writeTranscript(messages: readonly unknown[], options: { allowShrink?: boolean } = {}): void {
    mkdirSync(this.dir, { recursive: true });
    const onDisk = this.readTranscript().length;
    if (messages.length < onDisk && options.allowShrink !== true) {
      throw new Error(
        `refusing to overwrite session.jsonl (${onDisk} messages) with a shorter transcript (${messages.length}): history would be lost`,
      );
    }
    const content = messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length > 0 ? "\n" : "");
    writeAtomic(this.transcriptPath, content);
  }

  readTranscript(): unknown[] {
    if (!existsSync(this.transcriptPath)) return [];
    return readFileSync(this.transcriptPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  summary(): SessionSummary {
    const meta = this.readMeta();
    let prompt = meta.prompt;
    if (!prompt) {
      const engine = this.readEngineState() as any;
      if (engine?.environment?.variables?.prompt && typeof engine.environment.variables.prompt === "string") {
        prompt = engine.environment.variables.prompt;
      }
    }
    return {
      id: meta.id,
      project: meta.project,
      ...(meta.name === undefined ? {} : { name: meta.name }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(meta.model === undefined ? {} : { model: meta.model }),
      status: effectiveStatus(meta),
      updatedAt: meta.updatedAt,
      turnCount: meta.turns.length,
      stats: computeSessionStats(meta.turns),
    };
  }

  detail(): SessionDetail {
    const meta = this.readMeta();
    return {
      ...this.summary(),
      graph: this.currentGraph() ?? "",
      tokens: meta.tokens,
      visited: meta.visited,
      turns: meta.turns,
      steps: meta.steps || [],
      revisions: meta.revisions,
      ...(meta.harnessError === undefined ? {} : { harnessError: meta.harnessError }),
    };
  }
}

/** Computes cumulative token and cost statistics across recorded turns. */
export function computeSessionStats(turns: readonly TurnRecord[]): SessionStats {
  let totalCostUSD = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalTokens = 0;

  for (const turn of turns) {
    if (!turn.usage) continue;
    const u = turn.usage;
    totalInputTokens += u.input ?? 0;
    totalOutputTokens += u.output ?? 0;
    totalCacheReadTokens += u.cacheRead ?? 0;
    totalCacheWriteTokens += u.cacheWrite ?? 0;
    totalTokens += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0));
    if (u.cost?.total) {
      totalCostUSD += u.cost.total;
    }
  }

  const denominator = totalInputTokens + totalCacheReadTokens;
  const cacheHitRatio = denominator > 0 ? totalCacheReadTokens / denominator : 0;

  return {
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalTokens,
    cacheHitRatio,
  };
}

/**
 * Sessions, newest first. `project` narrows to one project directory -- the
 * usual case, since the CLI and studio both run inside one.
 */
export function listSessions(paths: Paths, project?: string): SessionStore[] {
  if (!existsSync(paths.sessionsDir)) return [];
  return readdirSync(paths.sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => new SessionStore(paths, e.name))
    .filter((s) => s.exists())
    .filter((s) => project === undefined || s.readMeta().project === project)
    .sort((a, b) => b.readMeta().updatedAt - a.readMeta().updatedAt);
}

/**
 * Whether `pid` still names a live process (issue #52). `EPERM` means alive,
 * just owned by someone else. Exported so a caller outside this module (the
 * studio's session-graph PUT route, issue #76) can tell whether a session is
 * genuinely being driven right now, the same way `effectiveStatus` does.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `meta.status`, except a `"running"` session whose recorded process is gone reports `"stale"` instead. */
function effectiveStatus(meta: SessionMeta): SessionSummary["status"] {
  if (meta.status === "running" && (meta.pid === undefined || !isProcessAlive(meta.pid))) return "stale";
  return meta.status;
}

/** Write via a temp file + rename so a reader never observes a half-written file. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}
