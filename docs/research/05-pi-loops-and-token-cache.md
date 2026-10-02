# Pi's loops, as a graph, without throwing away the token cache

Checked against Pi at commit `4e49492` (`@earendil-works/pi-*` 0.84.3).

Two questions, and they turn out to be the same question:

1. What do Pi's loops actually do, and how does that become a graph?
2. If the graph coordinates each step, how does the agent still benefit from
   prompt caching instead of paying full price for every turn?

## 1. What Pi's loop does

`packages/agent/src/agent-loop.ts:runLoop()` is two nested loops.

The **inner loop** is the turn loop. Each pass:

1. drains the steering queue (`getSteeringMessages`) and appends those messages;
2. streams one assistant response;
3. if `stopReason` is `error` or `aborted`, emits `agent_end` and returns;
4. collects tool calls from the response. If `stopReason` is `length` the
   response was cut off by the output token limit, so **every** tool call in it
   may have truncated arguments — none are executed, all are failed with an error
   result so the model can re-issue them;
5. otherwise executes the batch, in parallel by default (`toolExecution`), or
   sequentially if any tool declares `executionMode: "sequential"`;
6. terminates early only if **every** finalized result in the batch sets
   `terminate` — an all, not an any;
7. calls `prepareNextTurn`, which may swap context, model or thinking level;
8. asks `shouldStopAfterTurn` (Pi 1.0: `finishTurn`), and exits if it says yes;
9. re-polls the steering queue and goes round again while there are tool calls or
   pending messages.

The **outer loop** runs when the inner one falls out: it asks
`getFollowUpMessages`, and if anything is queued, re-enters the inner loop with
it. Otherwise the run ends.

Every one of those steps is a callback on `AgentLoopConfig`, and `Agent`
(`packages/agent/src/agent.ts:173`) exposes them as public, mutable properties.
Which is why the loop can be handed over without forking anything: set
`shouldStopAfterTurn` to `() => true` and Pi's loop degenerates to a single turn.

> Pi 1.0 note: `shouldStopAfterTurn` was removed (0.87); graph-agent now passes `finishTurn: async () => ({ action: "end" })`, which has the same effect.

`Agent.prompt()` starts a run; `Agent.continue()` resumes from the current
transcript. Those two calls are the whole stepper.

`workflows/pi-default-loop.bpmn` is that structure drawn, one BPMN node per
numbered step above.

## 2. The part that decides the design: what the cache actually covers

Pi sets Anthropic cache breakpoints in
`packages/ai/src/api/anthropic-messages.ts`:

| Line | Breakpoint |
| --- | --- |
| 1015–1031 | on the system prompt blocks |
| 1360 | on the **last tool** in the tools array |
| 1296–1312 | on the last message block |

So the cached prefix is, in order:

```
system prompt  →  tools  →  messages
```

A cache hit requires the prefix to match what was sent before, **byte for byte**.
That single fact settles most of the design:

| Between two steps | Effect on the cache |
| --- | --- |
| Append a user message, tool result, assistant turn | prefix intact — full hit |
| **Change the system prompt** | invalidates everything, including tools and all messages |
| **Change the tool list** | invalidates the tools block and every message after it |
| Compact or rewrite history | invalidates from the cut point onward |
| Build a new `Agent` for the step | nothing to hit; every turn pays full price |

`cacheRetention` maps to a `ttl` of `1h` on models that support it
(`getCacheControl`, line 60), otherwise the provider default. `sessionId` is
forwarded as session affinity for backends that route on it — useful, but it is
*not* what produces the hit. The prefix is.

## 3. What that means for a graph-coordinated agent

**One Pi `Agent` per session, for the life of the session.** The BPMN engine owns
*when* a turn happens; Pi owns the transcript it happens in. Each `agent:turn`
activity calls `prompt()` or `continue()` on the same long-lived `Agent`, whose
`state.messages` only ever grows. The prefix is stable by construction, so every
turn after the first reads its history from cache.

The naive alternative — a fresh session per BPMN activity, which is what the
archived Python implementation did by shelling out to `pi --mode json -p` per
service task — cannot hit the cache at all. That is the single biggest reason
this rewrite runs Pi in-process as a library rather than as a subprocess.

### Two habits to unlearn

Earlier design notes in this repo proposed giving each node its own system prompt
(via the `before_agent_start` extension result) and its own tool set (via
`setActiveTools`). Both are **cache-hostile**, and the table above says why: the
system prompt and the tool list sit in front of every message in the prefix, so
changing either at a node boundary throws away the entire conversation's cache,
every time that node runs. In a loop, that is once per iteration.

The cheap way to specialise a node is the one that appends rather than replaces:

- **Node-specific instructions** go in the *message* the node contributes
  (`zeebe:input source="=..." target="prompt"`), not in the system prompt.
- **Node-specific tool restriction** is better enforced *after* the model asks:
  keep one tool list, and let the graph refuse a call it does not want by routing
  the `agent:tool` activity to a rejection instead of an execution. The model
  sees a tool result saying no, which costs one cheap turn; swapping the tool
  list costs the whole prefix.
- When a node genuinely must change the system prompt or tools — a sub-agent with
  a different job — that is a deliberate cache write, and it belongs at a
  **sub-process boundary** where it happens once, not inside a loop.

Compaction is the same story from the other end: it necessarily invalidates from
the cut point, which is exactly why it should be a visible `serviceTask` with a
gateway on context usage rather than an invisible `transformContext` side effect.
The graph should show where the run chose to pay that price.

### Making it observable

Because none of this is visible from the outside, `TurnRecord.usage` carries
`input`, `output`, `cacheRead` and `cacheWrite` per turn, and the studio's session
view renders a `cache <n>` chip per turn. A healthy graph-coordinated run shows a
cache write on the first turn and cache reads on every turn after it. A column of
`uncached` chips means something in the prefix is being disturbed between steps —
which, given the table above, is a short list of suspects.

## 4. Where the current graphs stand

`workflows/pi-default-loop.bpmn` now matches `runLoop()` step for step, and
`workflows/workflows.test.ts` pins each branch so a future edit cannot quietly
drop one. Reviewing it against the real loop turned up five defects that had been
sitting in the diagram since it was written:

1. **`gw_tools` could strand the token.** FEEL is total: with `tool_calls` unset,
   `count(tool_calls) > 0` evaluates to `null` and `count(tool_calls) = 0` to
   `false`. Both outgoing flows falsy, no branch taken. Every exclusive gateway in
   every graph now declares a default flow, and a test enforces it.
2. **The tool batch told its instances nothing.** A bare `loopCardinality`
   spawned the right *number* of instances and gave none of them a tool call to
   run. It now loops over the `tool_calls` collection with
   `zeebe:loopCharacteristics`, binding one call per instance.
3. **`batch_terminate` was never produced.** A gateway routed on it and nothing
   wrote it, so the all-terminate branch was dead. A `collect_batch` activity now
   appends the results and computes it. A test checks that every variable a
   gateway reads has a producer.
4. **The prompt never entered the graph.** `llm_turn` had no input mapping.
5. **A dangling `<bpmn:incoming>`** survived an edit, referring to a flow that no
   longer arrived. bpmnlint does not catch this; a reference-integrity test now
   does.

## 5. How it is actually wired

`src/agent/pi-session.ts` holds one `Agent` for the life of the session, with
`shouldStopAfterTurn: () => true`. The awkward part is tool execution: the graph
wants to run the tools, Pi wants to run them itself and record the results. Both
get their way by registering every tool as a **parked** tool — Pi calls it, the
call suspends, an `agent:tool` activity does the real work, and Pi finalises the
result into its own transcript exactly as it would have anyway. The transcript
therefore has the shape a plain Pi run would produce, which is what the cache
needs.

That makes `agent:turn` return early by design: it resolves when the assistant
has finished speaking, *before* the tools run, because running them is the
graph's job. `agent:collect-tools` lets Pi finish the turn afterwards and reports
whether the whole batch asked to terminate.

The claim in §2 is not taken on trust. Pi's faux provider models prompt caching
the way a real one does — keyed on session, crediting the shared prefix — so
`src/agent/pi-session.test.ts` and `src/agent/runner.test.ts` both assert that a
second turn on the same transcript reads from cache while the first does not. A
future change that rebuilt the agent per activity, or swapped the system prompt
between nodes, would fail them.

`TurnRecord.usage` carries the same numbers into the studio, so the property is
visible at runtime and not only in a test.

## 6. Still open

Graph mutation is implemented (`graph:extend`) but the crafting flow that drives
it is not yet exercised end to end: `session-skeleton.bpmn` calls `craft_graph`
through a `callActivity`, and bpmn-elements resolves `calledElement` only within
the same definition, so the crafting graph still has to be spliced into the
session at creation. Until then that call parks waiting for a signal.

## Transcript system messages and mid-session tool changes

Since pi-ai 0.86 the system prompt and tool declarations live in the transcript
as a leading `{ role: "system" }` message. Assigning `agent.state.tools`
between runs makes the agent loop append a later `system` message carrying a
`toolsAdded`/`toolsRemoved` diff instead of rewriting the top of the request.
Models with `supportsMidConvoSystemMessages` receive the change at that point
in the transcript, so the cached prefix survives. Other models get the
transcript collapsed, which costs a one-time cache miss rather than an error.

graph-agent uses this in `drive()`: a session that starts on a graph with no
`agent:tool` declares no tools, and when a splice later adds one, the splice
re-entry calls `PiSession.setTools()` so the model can actually use it (#118).
Splices are additive-only, so tools are only ever added.
