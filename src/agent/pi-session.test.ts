// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PiSession } from "./pi-session.ts";

/** A scripted provider, so none of this needs a network or an API key. */
function scripted(responses: unknown[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  faux.setResponses(responses as never);
  return faux;
}

function session(responses: unknown[], sessionId = "s1") {
  const faux = scripted(responses);
  const model = faux.getModel();
  return {
    faux,
    pi: new PiSession({
      model,
      systemPrompt: "You are a test agent.",
      // Permissive schemas: these tests exercise PiSession's own parking and
      // turn-orchestration behaviour, scripting arbitrary tool-call arguments
      // that are not meant to satisfy a real tool's schema.
      tools: [
        { name: "read", description: "Read a file.", parameters: { type: "object", additionalProperties: true } },
        { name: "bash", description: "Run a bash command.", parameters: { type: "object", additionalProperties: true } },
      ],
      streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
      sessionId,
    }),
  };
}

describe("PiSession", () => {
  it("returns as soon as the assistant has spoken, before its tools run", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxText("Reading it."), fauxToolCall("read", { path: "a.ts" })]),
    ]);

    const turn = await pi.beginTurn("look at a.ts");

    expect(turn.text).toBe("Reading it.");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe("read");
    // the tool is parked, waiting for the graph -- Pi has not run it
    expect(pi.pendingToolCalls).toEqual([turn.toolCalls[0]?.id]);
  });

  it("writes the graph's tool result into Pi's own transcript", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
    ]);

    const turn = await pi.beginTurn("look at a.ts");
    pi.resolveTool(turn.toolCalls[0]!.id, { content: "file contents here" });
    const end = await pi.endTurn();

    expect(end.toolResults).toBe(1);
    const results = pi.messages.filter((m) => (m as { role: string }).role === "toolResult");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain("file contents here");
  });

  it("terminates only when the whole batch asks to, as Pi does", async () => {
    const two = () => fauxAssistantMessage([fauxToolCall("read", { a: 1 }), fauxToolCall("bash", { b: 2 })]);

    const mixed = session([two()]).pi;
    let turn = await mixed.beginTurn("go");
    mixed.resolveTool(turn.toolCalls[0]!.id, { content: "ok", terminate: true });
    mixed.resolveTool(turn.toolCalls[1]!.id, { content: "ok" });
    expect((await mixed.endTurn()).terminate).toBe(false);

    const all = session([two()], "s2").pi;
    turn = await all.beginTurn("go");
    all.resolveTool(turn.toolCalls[0]!.id, { content: "ok", terminate: true });
    all.resolveTool(turn.toolCalls[1]!.id, { content: "ok", terminate: true });
    expect((await all.endTurn()).terminate).toBe(true);
  });

  it("fails a tool call the graph never answered rather than hanging", async () => {
    const { pi } = session([fauxAssistantMessage([fauxToolCall("read", {})])]);
    await pi.beginTurn("go");
    const end = await pi.endTurn();
    expect(end.toolResults).toBe(1);
    expect(JSON.stringify(pi.messages)).toContain("never executed by the graph");
  });

  it("continues the same transcript across graph-coordinated turns", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    const first = await pi.beginTurn("look at a.ts");
    pi.resolveTool(first.toolCalls[0]!.id, { content: "contents" });
    await pi.endTurn();

    // No prompt: the graph decided to take another turn on the same transcript.
    const second = await pi.beginTurn();
    await pi.endTurn();

    expect(second.text).toBe("Done.");
    const roles = pi.messages.map((m) => (m as { role: string }).role);
    expect(roles).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
  });

  it("keeps the prompt cache warm across turns, which is the whole point", async () => {
    // The faux provider models prompt caching the way a real one does: it keys
    // on sessionId and credits the shared prefix. A second turn on the same
    // transcript must therefore read from cache rather than pay full price.
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    const first = await pi.beginTurn("look at a.ts and tell me what it does");
    pi.resolveTool(first.toolCalls[0]!.id, { content: "export const answer = 42;" });
    await pi.endTurn();

    const second = await pi.beginTurn();
    await pi.endTurn();

    expect(first.usage.cacheRead).toBe(0);
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  });

  it("refuses to start a turn while one is in flight", async () => {
    const { pi } = session([fauxAssistantMessage([fauxToolCall("read", {})])]);
    await pi.beginTurn("go");
    await expect(pi.beginTurn("again")).rejects.toThrow(/already in flight/);
  });

  it("extracts cost, reasoning, and totalTokens from message usage", async () => {
    const customMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello with usage" }],
      stopReason: "stop",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 200,
        cacheWrite: 30,
        reasoning: 25,
        totalTokens: 350,
        cost: {
          input: 0.0001,
          output: 0.0002,
          cacheRead: 0.00005,
          cacheWrite: 0.00003,
          total: 0.00038,
        },
      },
    };

    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "You are a test agent.",
      tools: [],
      streamFn: () => {
        async function* gen() {
          yield {
            type: "start",
            partial: { role: "assistant", content: [], stopReason: "pending" },
          } as never;
          yield {
            type: "text_start",
            contentIndex: 0,
            partial: { role: "assistant", content: [{ type: "text", text: "Hello with usage" }] },
          } as never;
          yield {
            type: "text_end",
            contentIndex: 0,
            content: "Hello with usage",
            partial: { role: "assistant", content: [{ type: "text", text: "Hello with usage" }] },
          } as never;
          yield {
            type: "done",
            reason: "stop",
            message: customMessage,
          } as never;
        }
        return Object.assign(gen(), {
          result: async () => customMessage,
        }) as never;
      },
    });

    const outcome = await pi.beginTurn("test usage");
    await pi.endTurn();

    expect(outcome.usage.input).toBe(100);
    expect(outcome.usage.output).toBe(50);
    expect(outcome.usage.cacheRead).toBe(200);
    expect(outcome.usage.cacheWrite).toBe(30);
    expect(outcome.usage.reasoning).toBe(25);
    expect(outcome.usage.totalTokens).toBe(350);
    expect(outcome.usage.cost?.total).toBe(0.00038);
    expect(outcome.usage.cost?.input).toBe(0.0001);
  });

  it("switches model dynamically via setModel", () => {
    const { pi } = session([]);
    const faux2 = fauxProvider({ provider: "faux2", models: [{ id: "model-2", name: "Model 2" }] });
    const newModel = faux2.getModel();
    pi.setModel(newModel);
    expect(pi.agent.state.model).toBe(newModel);
  });

  it("compacts conversation history with compactHistory", async () => {
    const { pi } = session([
      fauxAssistantMessage([fauxText("Resp 1")]),
      fauxAssistantMessage([fauxText("Resp 2")]),
      fauxAssistantMessage([fauxText("Resp 3")]),
      fauxAssistantMessage([fauxText("Resp 4")]),
    ]);

    await pi.beginTurn("Turn 1");
    await pi.endTurn();
    await pi.beginTurn("Turn 2");
    await pi.endTurn();
    await pi.beginTurn("Turn 3");
    await pi.endTurn();
    await pi.beginTurn("Turn 4");
    await pi.endTurn();

    const system = pi.messages[0];
    expect(system?.role).toBe("system");
    const before = pi.messages.length - 1;
    expect(before).toBeGreaterThan(4);

    const res = pi.compactHistory(2);
    expect(res.beforeCount).toBe(before);
    expect(res.afterCount).toBeLessThan(before);
    // The system prompt + tool declarations survive; the summary follows them.
    expect(pi.messages[0]).toBe(system);
    expect(pi.agent.state.systemPrompt).toBe("You are a test agent.");
    expect(pi.messages[1]?.role).toBe("user");
    expect(String((pi.messages[1] as { content?: string })?.content)).toContain("Compacted conversation history");
  });

  it("still declares its tools to the model after compaction", async () => {
    const faux = scripted([
      fauxAssistantMessage([fauxText("1")]),
      fauxAssistantMessage([fauxText("2")]),
      fauxAssistantMessage([fauxText("3")]),
      fauxAssistantMessage([fauxText("4")]),
    ]);
    const seen: Array<{ tools: string[] }> = [];
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "You are a test agent.",
      tools: [{ name: "read", description: "Read.", parameters: { type: "object", additionalProperties: true } }],
      streamFn: (m, context, options) => {
        const c = context as unknown as { tools?: Array<{ name: string }>; messages: Array<{ role: string; toolsAdded?: Array<{ name: string }> }> };
        const declared = [
          ...(c.tools ?? []).map((t) => t.name),
          ...c.messages.flatMap((msg) => (msg.role === "system" ? (msg.toolsAdded ?? []).map((t) => t.name) : [])),
        ];
        seen.push({ tools: declared });
        return faux.provider.streamSimple(m, context, options);
      },
    });
    for (const p of ["a", "b", "c"]) {
      await pi.beginTurn(p);
      await pi.endTurn();
    }
    pi.compactHistory(2);
    await pi.beginTurn("d");
    await pi.endTurn();
    expect(seen.at(-1)?.tools).toContain("read");
  });

  it("never leaves a toolResult as the first message after compaction (issue #85)", async () => {
    // Three tool-calling turns followed by one text turn, all on the same
    // transcript (beginTurn() with no prompt, the same as a graph driving
    // turn after turn without a fresh user message each time) -- the default
    // keepRecent (4) lands the naive `length - keepRecent` split right on a
    // toolResult, orphaning it from the tool_use the compacted-away summary
    // now hides. Any API expecting valid Anthropic-shaped transcripts rejects
    // that with a 400 on the very next turn.
    const { pi } = session([
      fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
      fauxAssistantMessage([fauxToolCall("read", { path: "b.ts" })]),
      fauxAssistantMessage([fauxToolCall("read", { path: "c.ts" })]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);

    let turn = await pi.beginTurn("look at a.ts");
    for (const path of ["a.ts", "b.ts", "c.ts"]) {
      pi.resolveTool(turn.toolCalls[0]!.id, { content: `contents of ${path}` });
      await pi.endTurn();
      turn = await pi.beginTurn();
    }
    await pi.endTurn();

    const roles = pi.messages.map((m) => (m as { role: string }).role);
    expect(roles).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);

    pi.compactHistory();

    expect(pi.messages[0]?.role).toBe("system");
    expect(pi.messages[1]?.role).toBe("user");
    expect(pi.messages[2]?.role).not.toBe("toolResult");
    // Every remaining toolResult still has its tool_use in the same (tail)
    // half of the transcript -- not buried inside the summary message.
    const toolUseIds = new Set(
      pi.messages
        .filter((m) => (m as { role: string }).role === "assistant")
        .flatMap((m) => (m as { content: Array<{ type: string; id?: string }> }).content)
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id),
    );
    for (const m of pi.messages) {
      if ((m as { role: string }).role === "toolResult") {
        expect(toolUseIds.has((m as { toolCallId: string }).toolCallId)).toBe(true);
      }
    }
  });
});

describe("PiSession restored from a transcript with unanswered tool calls (issue #115)", () => {
  function restored(answeredIds: string[] = [], recover?: (id: string) => { content: string } | undefined) {
    const faux = scripted([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const messages: any[] = [
      { role: "user", content: "go", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
      ...answeredIds.map((id) => ({
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        content: [{ type: "text", text: "earlier" }],
        isError: false,
        timestamp: 3,
      })),
    ];
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "sys",
      tools: [
        { name: "read", description: "r", parameters: { type: "object", additionalProperties: true } },
        { name: "bash", description: "b", parameters: { type: "object", additionalProperties: true } },
      ],
      streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
      messages,
      ...(recover ? { recoverToolResult: recover } : {}),
    });
    return pi;
  }

  it("lists dangling ids, answers both, and continues", async () => {
    const pi = restored();
    expect(pi.pendingToolCalls.sort()).toEqual(["c1", "c2"]);
    pi.resolveTool("c1", { content: "A" });
    pi.resolveTool("c2", { content: "B", isError: true });
    expect(pi.pendingToolCalls).toEqual([]);
    const end = await pi.endTurn();
    expect(end.toolResults).toBe(2);
    expect(pi.messages.filter((m) => m.role === "toolResult")).toHaveLength(2);
    const turn = await pi.beginTurn();
    expect(turn.text).toBe("done");
    await pi.endTurn();
  });

  it("fails a never-answered dangling call and only lists the unanswered one", async () => {
    const pi = restored(["c1"]);
    expect(pi.pendingToolCalls).toEqual(["c2"]);
    const end = await pi.endTurn();
    expect(end.toolResults).toBe(1);
    const last = pi.messages.at(-1) as any;
    expect(last.isError).toBe(true);
    expect(last.content[0].text).toContain("never executed");
  });
});

describe("PiSession recovery of a call that ran before a crash (parallel batch)", () => {
  it("answers a dangling call from the recorded outcome, not 'never executed'", async () => {
    const faux = scripted([]);
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "sys",
      tools: [{ name: "write", description: "w", parameters: { type: "object", additionalProperties: true } }],
      streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
      messages: [
        { role: "user", content: "go", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "A", name: "write", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 2,
        },
      ] as never,
      recoverToolResult: (id) => (id === "A" ? { content: "wrote it" } : undefined),
    });
    await pi.endTurn();
    const last = pi.messages.at(-1) as any;
    expect(last.content[0].text).toBe("wrote it");
    expect(last.isError).toBe(false);
  });
});

describe("PiSession.setTools (issue #118)", () => {
  it("adds tools between turns without touching the leading system message", async () => {
    const faux = scripted([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
    const requests: Array<{ tools: string[]; system: unknown[] }> = [];
    const pi = new PiSession({
      model: faux.getModel(),
      systemPrompt: "sys",
      tools: [],
      streamFn: (m, context, options) => {
        const c = context as unknown as { tools?: Array<{ name: string }>; messages: Array<{ role: string; toolsAdded?: Array<{ name: string }> }> };
        requests.push({
          tools: (c.tools ?? []).map((t) => t.name),
          system: c.messages.filter((x) => x.role === "system"),
        });
        return faux.provider.streamSimple(m, context, options);
      },
    });
    await pi.beginTurn("hi");
    await pi.endTurn();
    const leading = pi.messages[0];
    pi.setTools([{ name: "read", description: "Read.", parameters: { type: "object", additionalProperties: true } }]);
    await pi.beginTurn("again");
    await pi.endTurn();

    expect(pi.messages[0]).toBe(leading);
    const announced = pi.messages.filter(
      (m, i) => i > 0 && m.role === "system" && JSON.stringify(m).includes("read"),
    );
    expect(announced).toHaveLength(1);
    expect(pi.messages.indexOf(announced[0]!)).toBeGreaterThan(pi.messages.findIndex((m) => m.role === "assistant"));
    expect(JSON.stringify(requests[1])).toContain("read");
  });

  it("refuses while tool calls are parked", async () => {
    const { pi } = session([fauxAssistantMessage([fauxToolCall("read", {})])]);
    await pi.beginTurn("go");
    expect(() => pi.setTools([])).toThrow(/waiting for the graph/);
  });
});
