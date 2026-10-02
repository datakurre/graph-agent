/**
 * One Pi agent, for the whole session.
 *
 * The BPMN engine decides *when* a turn happens; Pi owns the transcript it
 * happens in. That split is not an aesthetic choice -- Pi's prompt cache covers
 * the prefix `system prompt -> tools -> messages`, so a transcript that only ever
 * grows keeps every earlier turn cached, while building a fresh agent per graph
 * activity would pay full price on every step. See
 * docs/research/05-pi-loops-and-token-cache.md.
 *
 * The awkward part is tool execution. The graph wants to run the tools, but Pi
 * wants to run them itself and record the results in its own transcript. Rather
 * than fight that, every tool is registered as a *parked* tool: Pi calls it, the
 * call suspends, the graph runs the real work and hands the result back, and Pi
 * finalises it into the transcript exactly as it would have anyway. The
 * transcript stays byte-identical to a normal Pi run, which is precisely what
 * the cache needs.
 */
import { Agent, type AgentMessage, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { TurnUsage } from "../studio/types.ts";

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** What the model is told a tool looks like -- name, description, and parameter schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

export interface TurnOutcome {
  /** Why the assistant stopped: `stop`, `toolUse`, `length`, `error`, `aborted`. */
  stopReason: string;
  /** Tool calls the assistant asked for, in the order it asked. */
  toolCalls: ToolCallRequest[];
  usage: TurnUsage;
  /** Assistant text, for the session log. */
  text: string;
  /** Assistant reasoning/thinking text, when the model uses extended thinking. */
  thinking?: string;
  errorMessage?: string;
}

/** What the graph hands back for one tool call. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /**
   * Ask the agent to stop after this batch. Pi only honours it when *every*
   * result in the batch sets it.
   */
  terminate?: boolean;
}

export interface PiSessionOptions {
  model: Model<any>;
  systemPrompt: string;
  /**
   * Tools the model may call, with the schema it should be told about --
   * kept stable for the session: see the note above. Execution is always
   * parked regardless of what description/parameters say; only what the
   * model sees comes from here.
   */
  tools: ToolSpec[];
  /** Injected so tests can drive a scripted provider. */
  streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
  sessionId?: string;
  /**
   * A transcript to continue from -- what a resumed session read back from
   * `session.jsonl`. Pi >= 0.86 keeps the system prompt as a leading
   * `role: "system"` message and `Agent` only prepends one when
   * `messages[0]` is not already system, so a transcript saved by an older Pi
   * (no system message) gets the current prompt prepended, while a newer one
   * keeps the prompt and tools it started with, which is what the prompt cache
   * wants.
   */
  messages?: AgentMessage[];
}

interface Parked {
  resolve: (outcome: ToolOutcome) => void;
}

/**
 * stopReasons after which Pi never calls the tools, so nothing will park:
 * a truncated response has its whole batch failed without execution, and an
 * errored or aborted turn ends immediately.
 */
const NO_TOOLS_RUN = new Set(["length", "error", "aborted"]);

const EMPTY_USAGE: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export class PiSession {
  readonly agent: Agent;
  private run: Promise<void> | null = null;
  private runError: unknown = null;
  private readonly parked = new Map<string, Parked>();
  private lastBatch: ToolOutcome[] = [];
  /** Wakes beginTurn once every tool call of the current turn has parked. */
  private onParked: (() => void) | null = null;
  /**
   * Tool calls of a restored transcript's last assistant message that have no
   * result yet: the session was parked between `agent:turn` and `agent:tool`.
   * There is no live run holding them, so they are answered by appending the
   * `toolResult` straight into the transcript.
   */
  /** Set once compactHistory has deliberately shortened the transcript. */
  compacted = false;
  private readonly dangling = new Map<string, string>();
  private readonly danglingAnswered = new Set<string>();

  constructor(options: PiSessionOptions) {
    this.agent = new Agent({
      streamFn: options.streamFn,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      // The graph owns iteration: every run is exactly one turn, and the graph
      // decides whether there is another.
      shouldStopAfterTurn: () => true,
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: options.tools.map((spec) => this.parkingTool(spec)),
        messages: options.messages ? [...options.messages] : [],
      },
    });
    this.collectDangling();
  }

  private collectDangling(): void {
    const msgs = this.agent.state.messages;
    let lastAssistant = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    if (lastAssistant < 0) return;
    const answered = new Set<string>();
    for (const m of msgs.slice(lastAssistant + 1)) {
      if (m.role === "toolResult") answered.add((m as { toolCallId: string }).toolCallId);
    }
    const content = (msgs[lastAssistant] as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
      if (block.type === "toolCall" && block.id && !answered.has(block.id)) {
        this.dangling.set(block.id, block.name ?? "");
      }
    }
  }

  /** Append a result for a restored, unanswered tool call. */
  private answerDangling(toolCallId: string, outcome: ToolOutcome): void {
    const toolName = this.dangling.get(toolCallId) ?? "";
    this.dangling.delete(toolCallId);
    this.danglingAnswered.add(toolCallId);
    this.agent.state.messages = [
      ...this.agent.state.messages,
      {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: outcome.content }],
        isError: outcome.isError === true,
        timestamp: Date.now(),
      } as AgentMessage,
    ];
    this.lastBatch.push(outcome);
  }

  private failDangling(): void {
    for (const id of [...this.dangling.keys()]) {
      this.answerDangling(id, { content: `Tool call ${id} was never executed by the graph.`, isError: true });
    }
  }

  /**
   * A tool that does nothing except wait for the graph. Pi -- and the model --
   * see the real tool's own name, description and parameter schema; only
   * `execute` is swapped out, so the model gets real argument names instead of
   * guessing them against an undescribed `{ type: "object" }` (issue #26).
   */
  private parkingTool(spec: ToolSpec): AgentTool<any> {
    return {
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.parameters as never,
      execute: async (toolCallId: string): Promise<AgentToolResult<unknown>> => {
        const outcome = await new Promise<ToolOutcome>((resolve) => {
          this.parked.set(toolCallId, { resolve });
          this.onParked?.();
        });
        this.lastBatch.push(outcome);
        return {
          content: [{ type: "text", text: outcome.content }],
          details: {},
          ...(outcome.terminate === true ? { terminate: true } : {}),
        };
      },
    } as unknown as AgentTool<any>;
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** Tool calls still waiting for the graph to answer them. */
  get pendingToolCalls(): string[] {
    return [...this.parked.keys(), ...this.dangling.keys()];
  }

  /**
   * Start a turn and return as soon as the assistant has finished speaking --
   * before its tool calls run, because running them is the graph's job.
   */
  async beginTurn(prompt?: string): Promise<TurnOutcome> {
    // A graph that never calls tools has no reason to know about batch
    // collection, so a previous run that has nothing left to wait for is settled
    // here rather than making every graph pair `agent:turn` with
    // `agent:collect-tools`. A run with tool calls still parked is genuinely in
    // flight and must not be trampled.
    if (!this.run && this.dangling.size > 0) this.failDangling();
    if (this.run && this.parked.size === 0) await this.endTurn();
    if (this.run) throw new Error("a turn is already in flight with unanswered tool calls");
    this.lastBatch = [];
    this.danglingAnswered.clear();
    this.runError = null;

    let sawAssistant = false;
    const settled = new Promise<AssistantMessage>((resolve) => {
      const unsubscribe = this.agent.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          sawAssistant = true;
          unsubscribe();
          resolve(event.message as AssistantMessage);
        }
      });
    });

    // Deliberately not awaited: the run stays suspended inside the parked tools
    // until the graph answers them, and endTurn() collects it.
    this.run = (
      prompt === undefined
        ? this.agent.continue()
        : this.agent.prompt([{ role: "user", content: prompt, timestamp: Date.now() } as AgentMessage])
    ).catch((error: unknown) => {
      this.runError = error;
    });

    // A run can fail before the model ever speaks -- continuing an empty
    // transcript, for instance. Waiting only on the assistant message would hang
    // forever, so race it against the run finishing.
    const message = await Promise.race([
      settled,
      this.run.then(() => {
        if (sawAssistant) return settled;
        this.run = null;
        const cause = this.runError;
        this.runError = null;
        throw cause instanceof Error
          ? cause
          : new Error(cause ? String(cause) : "the turn ended without a response from the model");
      }),
    ]);
    const stopReason = String(message.stopReason ?? "stop");
    const toolCalls = message.content
      .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments ?? {} }));

    // message_end fires before Pi calls the tools, so the parked map is still
    // empty here. Wait for the calls to actually arrive, or the graph would try
    // to answer tool calls that are not yet waiting.
    if (toolCalls.length > 0 && !NO_TOOLS_RUN.has(stopReason)) {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (toolCalls.every((call) => this.parked.has(call.id))) {
            this.onParked = null;
            resolve();
          }
        };
        this.onParked = check;
        check();
      });
    }

    const thinking = message.content
      .filter((block): block is Extract<typeof block, { type: "thinking" }> => (block as any).type === "thinking")
      .map((block) => (block as any).thinking)
      .filter(Boolean)
      .join("\n\n");

    return {
      stopReason,
      toolCalls,
      usage: readUsage(message),
      text: message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join(""),
      ...(thinking ? { thinking } : {}),
      ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    };
  }

  /** Answer one parked tool call. */
  resolveTool(toolCallId: string, outcome: ToolOutcome): void {
    if (this.dangling.has(toolCallId)) return this.answerDangling(toolCallId, outcome);
    const parked = this.parked.get(toolCallId);
    if (!parked) throw new Error(`no tool call is waiting with id '${toolCallId}'`);
    this.parked.delete(toolCallId);
    parked.resolve(outcome);
  }

  /**
   * Let Pi finish the turn: it writes the tool results into the transcript and
   * settles the run. Returns whether the whole batch asked to terminate, which
   * is Pi's rule -- all of them, not any of them.
   */
  async endTurn(): Promise<{ terminate: boolean; toolResults: number }> {
    if (!this.run) {
      if (this.dangling.size === 0 && this.danglingAnswered.size === 0) return { terminate: false, toolResults: 0 };
      this.failDangling();
      const batch = this.lastBatch;
      this.danglingAnswered.clear();
      return {
        terminate: batch.length > 0 && batch.every((outcome) => outcome.terminate === true),
        toolResults: batch.length,
      };
    }
    // A tool the graph never answered would hang the run; fail it instead.
    this.onParked = null;
    for (const [id, parked] of this.parked) {
      this.parked.delete(id);
      parked.resolve({ content: `Tool call ${id} was never executed by the graph.`, isError: true });
    }
    await this.run;
    this.run = null;
    if (this.runError) throw this.runError instanceof Error ? this.runError : new Error(String(this.runError));

    const batch = this.lastBatch;
    return {
      terminate: batch.length > 0 && batch.every((outcome) => outcome.terminate === true),
      toolResults: batch.length,
    };
  }

  /** Queue a message for the next turn boundary. */
  steer(text: string): void {
    this.agent.steer({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
  }

  followUp(text: string): void {
    this.agent.followUp({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
  }

  abort(): void {
    this.agent.abort();
  }

  /** Update the active model and optionally the stream function for subsequent turns. */
  setModel(model: Model<any>, streamFn?: ConstructorParameters<typeof Agent>[0]["streamFn"]): void {
    this.agent.state.model = model;
    if (streamFn) {
      this.agent.streamFunction = streamFn;
    }
  }

  /**
   * Compacts prior conversation messages in agent state by summarizing older messages
   * into a single summary message, keeping the recent tail of messages.
   */
  compactHistory(keepRecent = 4, summaryNote?: string): { beforeCount: number; afterCount: number } {
    const msgs = this.agent.state.messages;
    if (msgs.length <= keepRecent + 1) {
      return { beforeCount: msgs.length, afterCount: msgs.length };
    }
    const beforeCount = msgs.length;
    // The naive `length - keepRecent` boundary can land between an
    // assistant message's tool_use and the toolResult answering it -- the
    // tail would then start with a toolResult whose tool_use is now buried
    // in the summary, which the API rejects on the next turn. Walk the
    // boundary back until the tail starts with something other than a
    // toolResult; since a tool_use's results always sit immediately after
    // it, this also pulls that assistant message itself back into the tail
    // (issue #85).
    let splitIndex = msgs.length - keepRecent;
    while (splitIndex > 0 && msgs[splitIndex]?.role === "toolResult") splitIndex--;
    const toCompact = msgs.slice(0, splitIndex);
    const tail = msgs.slice(splitIndex);

    const summaryLines: string[] = [];
    if (summaryNote) {
      summaryLines.push(summaryNote);
    } else {
      summaryLines.push(`[Compacted conversation history: ${toCompact.length} prior message(s) summarized]`);
    }
    for (const m of toCompact) {
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        summaryLines.push(`- User: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
      } else if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>)?.[0]?.text ?? "";
        if (text) {
          summaryLines.push(`- Assistant: ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
        }
      }
    }

    const summaryMsg: AgentMessage = {
      role: "user",
      content: summaryLines.join("\n"),
      timestamp: Date.now(),
    } as AgentMessage;

    this.compacted = true;
    this.agent.state.messages = [summaryMsg, ...tail];
    const afterCount = this.agent.state.messages.length;
    return { beforeCount, afterCount };
  }
}

function readUsage(message: AssistantMessage): TurnUsage {
  const usage = (message as { usage?: any }).usage;
  if (!usage) return { ...EMPTY_USAGE };
  const cost = usage.cost
    ? {
        input: usage.cost.input ?? 0,
        output: usage.cost.output ?? 0,
        cacheRead: usage.cost.cacheRead ?? 0,
        cacheWrite: usage.cost.cacheWrite ?? 0,
        total: usage.cost.total ?? 0,
      }
    : undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(cost ? { cost } : {}),
  };
}
