/**
 * Running the tools the model asked for.
 *
 * These are Pi's own built-in tools, executed here rather than inside Pi's loop
 * so that the graph decides whether each call happens at all. Pi still records
 * the result: see PiSession, where each tool call parks until this returns.
 */
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type { ToolOutcome, ToolSpec } from "./pi-session.ts";

export interface ToolExecutor {
  /** Tools the model may call, with the schema it should be told about. */
  list(): ToolSpec[];
  run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
  /**
   * Whether re-running `name` after an interrupted attempt is harmless
   * (issue #117). Defaults to membership in `REPLAY_SAFE_TOOLS`.
   */
  replaySafe?(name: string): boolean;
}

/** Tools with no side effect, so an interrupted call may simply run again. */
export const REPLAY_SAFE_TOOLS: ReadonlySet<string> = new Set(["read"]);

interface HarnessToolLike {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate?: undefined,
  ): Promise<{ content?: Array<{ type: string; text?: string }>; terminate?: boolean; isError?: boolean }>;
}

/** Pi's built-in tools against the real filesystem and shell, rooted at `cwd`. */
export function createPiToolExecutor(cwd: string): ToolExecutor {
  const tools = new Map<string, HarnessToolLike>(
    (
      [
        createReadTool(cwd),
        createWriteTool(cwd),
        createEditTool(cwd),
        createBashTool(cwd),
      ] as unknown as HarnessToolLike[]
    ).map((tool) => [tool.name, tool]),
  );

  return {
    list: () => [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    async run(name, args, signal) {
      const tool = tools.get(name);
      if (!tool) {
        return { content: `No tool named '${name}' is available.`, isError: true };
      }
      try {
        const result = await tool.execute(`graph:${name}`, args, signal, undefined);
        return {
          content: (result.content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n"),
          // The coding-agent tools *return* isError for a failed command (bash
          // exiting non-zero) rather than throwing.
          ...(result.isError === true ? { isError: true } : {}),
          ...(result.terminate === true ? { terminate: true } : {}),
        };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

/** An executor that runs nothing, for dry runs and tests. */
export function createNoopToolExecutor(names: string[] = ["read", "bash"]): ToolExecutor {
  return {
    list: () =>
      names.map((name) => ({
        name,
        description: `Deferred to the process graph (mock ${name}).`,
        parameters: { type: "object", additionalProperties: true },
      })),
    run: async (name, args) => ({ content: `[dry run] ${name} ${JSON.stringify(args)}` }),
  };
}
