---
title: Harness reference
---

[← back](index.html)

# Harness reference

A **harness** is whatever actually performs a BPMN activity: one Pi turn, one
Pi tool call, a graph splice, a shell command. A diagram selects one per
activity with `zeebe:taskDefinition type="..."` (`src/agent/harnesses.ts` is
the registry; `src/agent/harness.ts` defines the five-key result shape every
harness returns: `status`, `summary`, `findings`, `artifacts`, `next_action`).

| Job type | What it does | Notable input / output |
|---|---|---|
| `agent:turn` | Runs exactly one streamed Pi assistant response. | in: `prompt` (only needed on the first turn, or after the transcript is otherwise empty); out: `stop_reason`, `tool_calls`, `usage` |
| `agent:tool` | Runs one tool call the last turn asked for. | in: `tool_call` (a call object, an index into the turn's batch, or omitted for the first unanswered one) |
| `agent:collect-tools` | Lets Pi finish the turn once every tool call in the batch has been answered. | out: `batch_terminate`, `tool_results` |
| `agent:fail-truncated-tools` | Settles a turn whose response was cut off by the output token limit -- Pi has already failed every tool call unexecuted. | out: `batch_terminate`, `tool_results` |
| `agent:steer` | Drains steering messages queued from outside the graph and injects them before the next turn. Queued via `--steer` (before a run starts) or `graph-agent steer <session> <text>` (into a run already in flight; issue #48). | out: `injected` (count) |
| `agent:follow-up` | Drains follow-up messages queued from outside the graph. Queued via `--follow-up` or `graph-agent follow-up <session> <text>` (issue #48). | out: `has_followup` |
| `agent:prepare-next-turn` | Pi's `prepareNextTurn` seam: decides whether the inner loop should stop. Deliberately does not touch the system prompt or tool list -- both sit in front of every message in the prompt cache, so changing them here discards it on every iteration (see `docs/research/05-pi-loops-and-token-cache.md`). | in: `stop_reason`; out: `should_stop` |
| `graph:layout` | Lays out a fragment (or the current session graph) with this project's private `packages/bpmn-auto-layout` engine. Always receives a complete document -- by the time this runs, `graph:lint` has already merged `graph_architect`'s drafted ops into one -- and lays out *every* top-level `bpmn:Process` in it, one `bpmndi:BPMNPlane` each, so a session graph keeps the diagrams of the processes `linkGraph` inlined instead of losing all but the first ([#87](https://github.com/datakurre/graph-agent/issues/87)). `ensureLabelDi` runs with it, so the external labels a gateway or event needs are placed too. | in: `fragment` (optional); out: `fragment` (laid out) |
| `graph:lint` | `graph_architect` drafts a small ops list (`GraphOp[]`, `src/agent/graph.ts`), not a whole document -- `createProcess`/`appendShape`/`insertShape`/`connect`/`setTaskDefinition`/`setDocumentation`/`attachBoundaryEvent`, each mirroring a real bpmn-js `Modeling` method. This harness merges that list into the current session graph headlessly (`applyGraphOps`), then checks that the result is a valid, additive splice, that every new activity's job type names a registered harness with correctly-wired `zeebe:input`/`zeebe:taskHeaders`/`zeebe:output` bindings, and that every new element's type -- and, for a start/end/boundary event, its event definition -- is one this project's runtime actually supports (`src/js/lib/supported-bpmn-elements.ts`'s `SUPPORTED_ELEMENT_TYPES`/`SUPPORTED_EVENT_DEFINITIONS`: a real parallel fork/join via `bpmn:ParallelGateway`, and a timeout (`bpmn:TimerEventDefinition`), a business-error handler (`bpmn:ErrorEventDefinition`) and a cost/condition guard (`bpmn:ConditionalEventDefinition`, see [Session cost, and stopping on it](#session-cost-and-stopping-on-it)) via `attachBoundaryEvent`, are all supported; most other event types are not) -- before anything applies it ([#40](https://github.com/datakurre/graph-agent/issues/40), [#65](https://github.com/datakurre/graph-agent/issues/65); see AGENTS.md's "bundled graphs" section). On success it republishes the merged document back onto `fragment` for `graph:layout`/`graph:extend` to read. | in: `fragment` (an ops list); out: `added`, `attempt`, `fragment` (the merged document) |
| `graph:extend` | The self-mutation primitive: replaces the session graph with the (already merged, already laid out) document `fragment` now holds. Runs the same additive/job-type/element-type checks `graph:lint` does (`checkSplice`) independently, rather than trusting that something upstream already checked -- stricter than a studio edit's `checkMigration` (see below), which only protects elements the token has actually reached. Stable ids only -- `bpmn-engine` replays recovered child state by element id, so a fragment that renames or removes a live element cannot be recovered. Same reason `checkSplice` also confines a splice to the session's own (executable) process: recovery cannot replay a `callActivity`'s linked process once its definition has changed underneath it, so a target inside one is rejected -- `applyGraphOps` attaches into whichever process the target (`after`/`into`/`from`/`attachedTo`) already lives in, and `checkSplice` rejects the result if that is a linked one ([#86](https://github.com/datakurre/graph-agent/issues/86), [#94](https://github.com/datakurre/graph-agent/issues/94)). In practice this means a graph whose own process is a thin `callActivity` wrapper -- `session-default` around `pi-default-loop`, say -- can only gain or lose steps around what it calls, not edit inside it; a graph whose own process carries the interesting structure directly (`session-craft`'s) has more to work with. The running engine is stopped and resumed against the new graph immediately after (bounded to 5 re-entries per run), so an element the splice adds gets a chance to run in the same `run`/`resume` invocation rather than only the next one ([#45](https://github.com/datakurre/graph-agent/issues/45)). | in: `fragment` (a complete document); out: `added` |
| `shell` | A deterministic step: runs a command and reports its exit status. No model call. | headers: `command` (required), `fail_on_error` (default `true`); out: `exit_code`, `stdout`, `stderr` |

### What a splice can and cannot construct

`graph:lint` runs the project's own bpmnlint ruleset against the merged
document (minus the rules that only make sense once `graph:layout` has run --
see `SEMANTIC_CONFIG` in `src/agent/bpmn-lint.ts`), and rejects a splice that
introduces a `fake-join`: a plain task or event with more than one incoming
flow, which `bpmn-elements` re-triggers once per arriving token instead of
joining ([#104](https://github.com/datakurre/graph-agent/issues/104)).

The op vocabulary is additive-only -- `appendShape` always adds a *new* flow
without touching a node's existing one, and `insertShape` is the only op that
redirects an existing flow (the one named `into`, which keeps its own id and
now targets the new shape). That asymmetry rules out the naive way to build a
merge or a fork/join: `appendShape`-ing a gateway and `connect`-ing existing
sources into it leaves each source's old flow in place (an instant implicit
split) and never actually detaches anything from the shared target (still a
fake join). The working pattern is always to `insertShape` the gateway into
whichever flow already reaches the shared target or next step, and reach it
from any other, freshly-created branch with `appendShape`/`connect` instead
([#107](https://github.com/datakurre/graph-agent/issues/107); the exact
recipes and worked examples are in `AGENT_ROLES.graph_architect`,
`src/agent/harnesses.ts`). `insertShape` also accepts an optional `flowId` to
name the flow it auto-creates, so a later op in the same batch can target it
without guessing a generated id -- needed for the second gateway a real
fork/join's join side requires.

Every id a splice introduces -- an element's `id`, `insertShape`'s `flowId`,
`connect`'s optional flow id, `createProcess`'s process id -- must be a valid
XML id (a letter or `_` first, then letters, digits, `_`, `.` or `-`). BPMN
types every id as `xsd:ID`, and an id that is not one serialized happily
while leaving the token parked on the offending node forever, so `applyGraphOps`
rejects the op that introduces it, naming the id
([#109](https://github.com/datakurre/graph-agent/issues/109)).

A splice also cannot reach into a process `linkGraph` inlined via
`calledElement`, and no sequence flow it creates may cross a `bpmn:Process`
or `bpmn:SubProcess` boundary -- see `graph:extend` above and
[#86](https://github.com/datakurre/graph-agent/issues/86)/[#94](https://github.com/datakurre/graph-agent/issues/94)/[#100](https://github.com/datakurre/graph-agent/issues/100).

### Session cost, and stopping on it

Every `agent:turn` reports what it cost. The engine accumulates that across
the whole run and publishes it as a FEEL variable named `_session`, readable
from any gateway condition or event condition in the graph:

| Field | Meaning |
|---|---|
| `total_cost` | Cumulative cost in USD, as the provider reported it |
| `turn_count` | Model turns taken so far |
| `total_tokens` | Tokens across every turn |
| `input_tokens` / `output_tokens` | The same, split |
| `cache_read_tokens` / `cache_write_tokens` | Prompt-cache reads and writes |

Because it is an ordinary FEEL variable, a budget is just a condition:

```xml
<bpmn:boundaryEvent id="cost_limit" attachedToRef="the_expensive_bit" cancelActivity="true">
  <bpmn:conditionalEventDefinition>
    <bpmn:condition xsi:type="bpmn:tFormalExpression">=_session.total_cost &gt;= 0.50</bpmn:condition>
  </bpmn:conditionalEventDefinition>
</bpmn:boundaryEvent>
```

`element_templates/cost_limit_boundary_event.json` is that, as a template you
can drop on any activity from the studio's properties panel. The condition is
re-evaluated as the run advances, so a limit crossed *during* the activity
interrupts it, not only one that was already breached when it started
([#83](https://github.com/datakurre/graph-agent/issues/83)).

The same numbers are what `graph-agent ls`, `show` and `report` print per
session, and what the studio's session view shows.

### Editing a running session's graph

`PUT /api/sessions/:id/graph` (the studio's session page "Edit" button) checks
a human edit with `checkMigration` (`src/agent/graph.ts`), not `checkSplice`:
it may delete or rewire an element the token has never reached, since
`Definition.recover()` only replays state for `meta.visited ∪ meta.tokens` --
deleting or renaming one of *those* is rejected with `409` and the offending
id(s), the same as `graph:extend`'s stricter rule would reject any removal at
all. It still applies `checkSplice`'s job-type contract to any genuinely new
activity, and refuses a changed `<bpmn:definitions id>` outright (issue #46).

`PUT` requires an `If-Match` header naming the revision the client loaded
(the same value `GET` returns as `ETag`) and rejects a stale one with `409`
and the revision actually on disk, so two editors who loaded the same
revision cannot silently overwrite each other -- the second is told to
reload rather than winning quietly (issue #76). The library's own `PUT
/api/graphs/:id` gets the same treatment, keyed by a content hash rather
than a revision count since a library file carries no revision history of
its own; there, a missing `If-Match` is permitted, since a brand-new graph
has nothing yet to conflict with.

An edit accepted while `graph-agent run`/`resume` is actively driving that
same session is not silently discarded (issue #75). `drive()` (`runner.ts`)
never trusts an in-memory copy of the graph: `graph:lint`/`graph:extend`'s own
`getGraph()` always re-reads `SessionStore.currentGraph()` from disk, and the
same stop/resume mechanism `graph:extend` uses to pick up its own splice mid-run
([#45](https://github.com/datakurre/graph-agent/issues/45)) also fires the
moment it notices the on-disk revision count grew for a reason this process
did not cause -- reported as `note: graph revision N applied externally,
resuming`, bounded by the same `MAX_SPLICE_REENTRIES` cap. Concretely: an edit
that lands while an activity is in flight takes effect the next time the
engine would otherwise advance past that activity; if the model's own next
`graph:extend` was drafted against the pre-edit graph and its fragment is now
missing something the edit added, `checkSplice` rejects it as a removal rather
than overwriting the edit. `SessionStore.appendGraph` additionally takes the
revision index a write believed it was extending and rejects a stale one with
`GraphRevisionConflictError`, so a write racing an edit in the narrow window
between validating a splice and committing it fails loudly instead of
clobbering the edit.

### Verifying this table

`--dry-run` stops after one scripted turn, so it never reaches the tool batch,
`agent:collect-tools`, `agent:prepare-next-turn` or the loop-back. Three
defects lived behind that gap while `make test` stayed green, because the suite
scripted tool calls one at a time: the prompt was re-sent every iteration
([#25](https://github.com/datakurre/graph-agent/issues/25)), the model was told
nothing about a tool's arguments
([#26](https://github.com/datakurre/graph-agent/issues/26)), and a two-call
batch ran the first call twice
([#27](https://github.com/datakurre/graph-agent/issues/27)). All three are
fixed and covered by `runner.test.ts`, but changes to these rows still want a
real model behind them, run against a throwaway workspace.

`shell` is configured entirely from `zeebe:taskHeaders` rather than
`zeebe:ioMapping` input, because the command is a fixed part of what the
activity *is* -- a property of the node, not something a previous activity
computes. Route on the result with a gateway and `zeebe:output source="=exit_code"`,
the way `workflows/shell-demo.bpmn` does; see the [element
template](../element_templates/shell_task.json) for the studio's property
panel binding.

Adding a new job type means adding an entry to the `HarnessRegistry` returned
by `createHarnesses()` in `src/agent/harnesses.ts`, **and** an element
template under `element_templates/` -- a test in
`element_templates/element-templates.test.ts` fails the build if a registered
job type has no template, and a second checks every existing template's
`zeebe:input`/`zeebe:output`/`zeebe:taskHeader` bindings against `HARNESS_IO`
(the same file), so a new harness and a new template are expected to land
together and drift between them fails fast rather than only against a real
model (issue #54; issue #49 found the class of bug this closes).

## User tasks

A `zeebe:userTask`'s answered form also has its `zeebe:ioMapping` output
applied -- `session-skeleton.bpmn`'s `await_intent` publishes `intent`,
`context`, and `session_done` this way -- even though a user task has no
harness (`activity.end`'s content carries the signaled answer, which
`engine.ts` maps the same way a harness result would be). A user task has no
job type, so it is never routed through `createHarnesses()`.

`--answer [activity:]key=value` on `run`/`resume` is how a terminal answers
one (see [Getting started](getting-started.html#extending-a-graph-from-inside-a-session)),
and `graph-agent run "..."` refuses rather than silently dropping a prompt on
a graph whose first stop is a user task ([#47](https://github.com/datakurre/graph-agent/issues/47)).
The `element_templates/human_gate_user_task.json` template wires the
`zeebe:userTask` marker and a form id binding for one, though the form's own
fields still need a hand-written (or form-editor-authored)
`zeebe:userTaskForm` elsewhere in the diagram.

The studio can answer one too ([#51](https://github.com/datakurre/graph-agent/issues/51)):
the session page renders every activity in `meta.tokens` that resolves to a
`zeebe:userTaskForm` as a real form-js form, and submitting it
`POST`s to `/api/sessions/:id/answer`, which queues the payload in the
session's own `answers.jsonl` rather than running a model itself. Whichever
process next drives the session (`run`/`resume`) consumes a matching queued
answer from its `onWait(activityId)` seam before falling back to `--answer`,
and deletes it once consumed so it cannot be replayed.

`graph-agent tui` ([#50](https://github.com/datakurre/graph-agent/issues/50))
answers one directly, in the same process: `onWait` renders one prompt per
`zeebe:userTaskForm` field and resolves once every field is answered, so a
gate never needs a second `resume --answer` invocation at all when driven
this way. See [Getting started](getting-started.html#the-tui).

## Variables across a callActivity

`link.ts` splices a called graph (`craft_graph`, called by `session-skeleton.bpmn`'s
`craft`) into the *same* `<bpmn:definitions>` as the session, but bpmn-elements
still runs it as a genuinely separate process instance with its own,
isolated `Environment` -- a `callActivity`'s called process does not inherit
the caller's variables the way one process's own activities share them with
each other. Strict Zeebe semantics would want `zeebe:ioMapping` on the
`callActivity` itself to bridge that; this project takes a simpler path that
matches its own design instead: `link.ts` already treats a linked graph as
part of *one* self-contained session, not a boundary meant to hide
variables, so `engine.ts` maintains its own `sharedOutput` pool -- every
resolved harness or user-task output is written there as well as to
`environment.output`, and every activity's scope reads it back, regardless
of which linked process it runs in. `session-skeleton.bpmn`'s `craft` needs
no `zeebe:ioMapping` of its own for `intent` to reach `draft_fragment` inside
`craft_graph`, or for `approval`/`extend_status` to be visible back in
`session` once it returns.

The tradeoff: variables are session-wide, not scoped per called process, so
two linked graphs sharing a variable name would collide. `sharedOutput`
itself is never persisted (it is rebuilt from the union of every linked
process's own `environment.output` on `resumeGraph`, via
`collectSharedOutput()` in `engine.ts`), so this only ever needs to be
correct within one run.

One more consequence worth knowing: `sharedOutput` only ever gets a variable
from a harness's or user task's own *output* mapping -- a plain seed
variable (`runSession`'s own `prompt`, chiefly) is never in it, since nothing
ever "outputs" it. `engine.ts` also never processes a `callActivity`'s own
`zeebe:input` at all (only a harness-backed activity's does, via
`makeExtension`'s `HarnessService` wrapper), so a `callActivity` cannot
bridge a seed variable back into scope that way either.
`session-craft.bpmn`'s `run_default` fallback found this the hard way
([#66](https://github.com/datakurre/graph-agent/issues/66)): `pi_default_loop`,
called through `run_default` after `craft_graph` had already run a turn, saw
`prompt` as never seeded at all -- it is a seed variable, invisible outside
the top-level process it was seeded into -- so its own `llm_turn` called
Pi's `continue()` instead of a real prompt, against a transcript that still
ended on `craft_graph`'s own unanswered assistant turn. `Cannot continue
from message role: assistant` was the result. `craft-graph.bpmn`'s
`draft_fragment` now republishes its own resolved intent-or-prompt back to
`"prompt"` on every entry for exactly this reason -- a seed variable that
might be read again downstream, across a `callActivity` boundary, needs a
harness to re-publish it as an output first.

A `callActivity`'s own `zeebe:output`, unlike its `zeebe:input`, *is*
processed (the same generic, no-harness path a user task's answered form
uses), which is how a value a called process's own harness published can
reach a gateway condition back in the calling process -- gateway conditions
are evaluated natively by bpmn-elements against the calling process's own
scope only, never against `sharedOutput`. `session-craft.bpmn`'s `craft`
needs exactly this: `gw_crafted` routes on `extend_status`, set deep inside
`craft_graph` by `apply_extension`, so `craft` carries its own
`zeebe:output source="=extend_status"`. Getting the FEEL expression right
took a second real-Haiku repro of its own ([#66](https://github.com/datakurre/graph-agent/issues/66)
again): a `callActivity`'s own signaled output arrives one layer deeper than
a user task's flat answered form does -- bpmn-elements relays a called
process's completion through the same delegate-signal machinery a message
end event uses, wrapped as `{ executionId, output: {...} }` -- so the bare
`extend_status` only becomes visible once `engine.ts`'s
`applyUnharnessedOutput` unwraps that one extra layer for a `bpmn:CallActivity`
specifically; `=output.extend_status` does not work either, since `output`
is itself a reserved root in `feelContext` (`src/agent/expressions.ts`)
pointing at the *caller's own* (empty, at that point) `environment.output`,
not at the called process's. Left unfixed, `gw_crafted`'s condition always
warned "Variable 'extend_status' not found" and silently took its own
default branch (`fallback_default`, into `run_default`) even right after a
successful apply -- and a *second* `graph:extend`-triggered stop/resume
cycle landing on top of that stray, already-running `pi_default_loop`
instance is what actually threw "cannot resume running process
pi_default_loop".

## Retries

`zeebe:taskDefinition retries="n"` sets how many times an activity's harness
call may be attempted before the run fails: no attribute (or `retries="0"`)
is one attempt, `retries="3"` is up to three. This only ever retries a
harness call that **throws or rejects** -- a job failure, in C8 terms. A
harness that *returns* `{ status: "failed", ... }` (via the `failed()`
helper in `src/agent/harness.ts`) is a business error the graph is expected
to route on with a gateway, and is never retried regardless of `retries`.
