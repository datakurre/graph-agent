## Agent Sandbox

```toml agent-sandbox
[network]
allowed_hosts = [
    "*.nixos.org:443",
    "*.github.com:443",
    "*.cachix.org:443",
    "files.pythonhosted.org:443",
    "github.com:22",
    "pypi.org:443",
    "registry.npmjs.org:443",
#
    "models.opencode.ai:443",
    "opencode.ai:443",
]

[ports]
web = 8080

[[network.allowed_routes]]
header = "Authorization"
host = "opencode.ai:443"
method = "POST"
path = "/zen/**"
prefix = "Bearer "
secret = "OPENCODE_API_KEY"
```

## Working in this repo

`make setup && make build` before anything else; `make help` lists every dev
target. `make lint` (typecheck + template lint + `bpmnlint` over
`workflows/`) and `make test` (vitest) are the fast local checks; run them
before committing. `make verify-editor` and `node scripts/screenshot-docs.mjs`
both drive a real Chromium against `graph-agent ui` -- slower, but the
only way anything touching the studio's properties panel or a workflow
diagram is actually exercised.

Every BPMN activity dispatches to a **harness** looked up by
`zeebe:taskDefinition type="..."` in `src/agent/harnesses.ts`
(`createHarnesses()`); see [`docs/harnesses.md`](docs/harnesses.md) for the
full registry. A graph under `workflows/*.bpmn` is the shared library bundled
with the package (`make init` copies it into a user's config directory) --
`workflows/workflows.test.ts` auto-discovers every file there and checks it
against the diagram-level invariants (Camunda 8 FEEL syntax, no stranded
gateway, every gateway variable actually produced, and so on), so a new graph
gets those checks for free. Author semantics by hand and regenerate the
`<bpmndi:>` layout with `make layout` (`scripts/bpmn-tools.mjs`) rather than
hand-writing coordinates.

`make lint`'s bpmnlint pass forbids an implicit merge (bpmnlint's `fake-join`
rule, an error): a plain activity or event with more than one incoming
`<bpmn:sequenceFlow>` looks like a BPMN join but is not one -- this engine
re-triggers it once per arriving token instead of waiting for all of them.
Route two converging paths into an `<bpmn:exclusiveGateway>` with a single
outgoing flow to the shared target instead; every `gw_*_entry` gateway in
`workflows/*.bpmn` is that pattern.

`docs/` is a small Jekyll site (`.github/workflows/docs.yml` builds and
deploys it to GitHub Pages on push to `main`). Its screenshots
(`docs/screenshots/*.png`) come from `scripts/screenshot-docs.mjs`, which
drives the real CLI and studio the same way `scripts/verify-editor.mjs`
does -- regenerate them with that script rather than editing the PNGs by
hand, and after any change to the studio's pages.

`npm install` rewrites `package-lock.json` under some npm versions (the
`integrity` key moves within each entry) without changing a single resolved
version. That churn is noise -- `git checkout -- package-lock.json` before
committing unless a dependency actually changed. `scripts/screenshot-docs.mjs`
likewise rewrites all four PNGs on every run; keep them only when the studio
changed.

## Running against a real model

`--dry-run` covers most of what you need: it walks a graph with a scripted
provider, so no credential and no egress. Reach for a real model when the thing
under test is the model call itself, or anything on the tool path (see below).

### Credentials

Credentials come from Pi's `ModelRuntime`; `graph-agent` adds no store of its
own. Export the provider's key (`ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) or use `pi` + `/login`.

**Always pass `--model provider/model`.** The default resolver reads the
credentialed subset now, but naming the model still saves a wrong guess.
One OpenCode key covers two separate catalogues: `opencode` (Zen) and
`opencode-go` (Go).

**An identity-linked `sk-ant-api03-...` key needs a header, and no environment
variable supplies it.** Anthropic issues two shapes of key. The ordinary one
works from `ANTHROPIC_API_KEY` alone. The identity-linked one additionally
requires `anthropic-workspace-id` on every request and fails the first turn
with:

```
400 ... "anthropic-workspace-id is required when authenticating with an
identity-linked API key; send the id of the workspace this request acts in."
```

This is a property of the key, not a defect in the graph -- do not go looking
for one. Diagnose it in a single call before running anything:

```
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

To use such a key you need the workspace id, which only its owner can give you
(the Admin API that lists workspaces refuses an identity-linked key). Put it in
Pi's provider config at `~/.pi/agent/models.json` -- `$PI_CODING_AGENT_DIR`
overrides the directory -- and `graph-agent` inherits it:

```json
{"providers": {"anthropic": {"headers": {"anthropic-workspace-id": "wrkspc_..."}}}}
```

Verified: with the header present the error changes from *"...is required..."*
to *"...must be a valid workspace ID."*, which is how you tell a missing header
apart from a wrong id. If you have the key but not the id, **ask** -- there is
nothing to work around.

### Egress

A real run needs outbound HTTPS to the provider's host: `api.anthropic.com:443`
for Anthropic, `opencode.ai:443` for either OpenCode catalogue. The
`agent-sandbox` block above declares those, but it only governs the agent
sandbox -- a CI runner or hosted session enforces its own policy. Confirm
reachability (`curl -sS -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models`;
a 401 means reachable, a 000/403 means blocked at the proxy) before concluding
the code is at fault.

### The tool path

`--dry-run` does not cover it. Its scripted provider answers once and stops, so
the tool batch, `agent:collect-tools`, `agent:prepare-next-turn` and the
loop-back never run. Three real defects lived there behind a green `make test`
(#25 prompt re-sent every iteration, 110 billed turns; #26 tool schemas hidden
from the model; #27 a two-call batch running the first call twice) -- all fixed
now, and `runner.test.ts` covers a two-call batch and a multi-turn tool run.
The lesson stands: verify anything touching this path against a real model, and
do it in a **throwaway workspace** -- `createPiToolExecutor` (Pi's coding-agent tools) gives the model
real `read`/`write`/`edit`/`bash` rooted at the cwd, so never run it in this
checkout.

Scripting tool calls with the faux provider: `fauxToolCall(name, args)` takes
**two** arguments, not an id first. Getting that wrong parks nothing and the
run hangs rather than failing, which reads like a deadlock in the engine.

### The bundled graphs

All six run. `session-default` (the default `run` uses when `--graph` is
omitted) is a callActivity into `pi-default-loop`, so OOTB behaviour matches
plain Pi ([#47](https://github.com/datakurre/graph-agent/issues/47)) --
`graph-agent run --dry-run` with no `--graph` prints `graph
session-default` but otherwise the same transcript as running
`pi-default-loop` directly. `pi-default-loop` and `shell-demo` drive tool
calls, parallel ones included. `craft-graph` drafts a small ops list
(`GraphOp[]`, not a whole document) and splices the elements it describes into
the live session, `session-skeleton` calls it after a `resume --answer`
gate, and `session-craft` goes straight from a prompt into `craft-graph` and
runs whatever it builds in the same invocation. The whole self-extension path
is verified end to end against real Haiku: draft -> lint (merges the ops into
a real document) -> layout -> approval gate -> `graph:extend spliced in 2
element(s)`, with `show` reporting two graph revisions. #21, #22, #30, #31,
#34, #36 and #37 are all closed and re-verified on a clean clone.

**What `graph:lint` rejects, and why each rule is there.** `checkSplice`
(`graph.ts`) is the whole contract behind "an approved splice is wired
correctly or it is rejected with a redraftable reason". Every rule below was
added because a real drafted fragment got through without it:

- **Additive only.** A removed or renamed element cannot be recovered --
  `bpmn-engine` replays child state by element id.
- **A registered job type** (#40). Haiku used to write `type="shell:exec"`
  (the registry has `shell`) and get away with it; `checkSplice` takes a
  `knownJobTypes` set, and the drafting model is given the same vocabulary up
  front (`jobTypesBlock`).
- **I/O bindings that match the harness** (#65). #40's own repro -- `command`
  passed through `zeebe:ioMapping` when the `shell` harness reads
  `zeebe:taskHeaders`, and `exitCode` read back instead of `exit_code` -- is
  rejected by the exact wrong spelling used, checked against `HARNESS_IO`
  (`harnessIOContract()` in `harnesses.ts`, threaded through as an optional
  parameter so `graph.ts` never depends on the harness registry).
- **A supported element type and event definition**
  (`supported-bpmn-elements.ts`) -- the same allowlist the editor's palette
  is restricted to.
- **The session's own process** (#86, #94). Recovery cannot replay a
  `callActivity`'s linked process once its definition changed underneath it,
  so a splice targeting one leaves the session permanently stuck.
  `applyGraphOps` attaches into whichever container the target already lives
  in, and the splice is rejected if that is a linked process.
- **No flow crossing a container** (#100). The same malformation one level
  down, at a `bpmn:SubProcess` boundary -- `pi-default-loop`'s `tool_batch`
  is a real one a splice can target.
- **A usable XML id** (#109) for every id the fragment introduces -- element
  ids, `insertShape`'s `flowId`, `connect`'s optional id, `createProcess`'s
  process id. A space serialized fine and then parked the token forever.
- **This project's own bpmnlint ruleset** (#104), minus the rules that need a
  laid-out document (`SEMANTIC_CONFIG` in `bpmn-lint.ts`). `fake-join` is the
  sharp one: bpmn-elements re-triggers a plain activity with two incoming
  flows once per token instead of joining, silently double-running a billed
  `agent:turn`.

Because the vocabulary is additive-only, a merge or fork/join can only be
built by `insertShape`-ing the gateway into the flow that already reaches the
shared target -- `appendShape`-ing one and connecting existing sources into it
cannot work (#107). The recipes and worked examples live in
`AGENT_ROLES.graph_architect`; keep them in step with any change to the ops.

### Re-verifying a closed issue

Two traps have each produced a false "still broken" here, so check both before
reopening anything:

- **A stale graph library** (#35). Plain `init` auto-upgrades a library copy
  the self-hash proves you never edited, but leaves a copy you *have* edited
  alone and only reports it as stale -- so an edited copy can predate the
  fix. Diff it against `workflows/` first, or `init --refresh`. This is why #22 looked open when it was not, and
  why the default graph once ran without the fix that stopped it billing 110
  turns.
- **Testing a path the CLI cannot take.** A regression test that drives
  `runSession`'s `onWait` in-process does not cover `run` -> park -> persist ->
  `resume --answer`. That gap hid two separate bugs (#31, #34) behind a green
  suite. When a fix is for CLI behaviour, drive the CLI.

### TUI feedback loop

The TUI has a deterministic, credential-free development loop. Use it for UI
layout and interaction work instead of a real model:

```sh
make test-tui
make showcase-tui
make screenshot-tui
```

`src/tui/recording-terminal.ts` implements the Pi `Terminal` seam with a fixed
in-memory screen, ANSI recording, resize support and queued input. It is not a
full terminal emulator, but it handles the cursor, erase and style control
sequences emitted by `TuiMainScreen` well enough to inspect the visible screen.

`src/tui/scenario.ts` runs the real `startTui()` against that terminal. Prefer
scenario actions that wait for visible text over fixed sleeps. Use
`editor.onSubmit` when testing application behavior directly, and terminal
input actions when testing editor key decoding.

`make showcase-tui` runs the deterministic faux-provider scenario and prints
the reconstructed terminal screen. `TUI_COLUMNS` and `TUI_ROWS` select its
dimensions. `make screenshot-tui` writes the same screen and raw ANSI to
`docs/tui/` and captures `docs/tui/showcase.png` with Chromium. These generated
artifacts are for visual review; do not use them as the sole regression oracle.

When changing TUI layout, inspect all three sizes before considering it done:

```sh
TUI_COLUMNS=120 TUI_ROWS=32 make showcase-tui
TUI_COLUMNS=80 TUI_ROWS=24 make showcase-tui
TUI_COLUMNS=40 TUI_ROWS=16 make showcase-tui
```

The current screenshot renderer intentionally shows the reconstructed visible
text in a browser-styled terminal viewport. It is useful for spacing, wrapping
and density review. Raw terminal lifecycle behavior such as real cursor
restoration, Ctrl-C and alternate-screen handling still requires a real PTY;
do not claim those are covered by the recording terminal.
