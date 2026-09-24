# omp-jev-router

Two bounded routing decisions for [OMP](https://omp.sh), made by TypeSafe's
[Jev](https://typesafe.ai) System One model:

1. **Front door** — choose DEFAULT, SLOW, or OMP's native ORCHESTRATE
   contract for each user request, before the primary agent's first model call.
2. **TASK tier** — once OMP has already chosen its generic `task` worker, should
   that spawn resolve through `@task` or through `@task_hard`?

OMP's own SMOL/TASK decision and explicit agent choices are preserved. This package
also provides an explicit `orche_advisor` checkpoint-review tool and a passive
Verification Auditor; neither is a third routing decision.

---

## What it does

```text
USER → Jev front door
  DEFAULT     → primary on @default
  SLOW        → primary on @slow for this turn, then restore
  ORCHESTRATE → primary on @default + OMP's native orchestrate notice
  UNCERTAIN   → primary on @slow + one hidden delegation hint

Primary → OMP's native SMOL/TASK choice
  SMOL → @smol (untouched)
  TASK → Jev TASK_NORMAL (@task) or TASK_DEEP (@task_hard)
```

## Architecture

### Front door (`before_agent_start` + `context`)

`before_agent_start` calls Jev once per prompt and awaits the decision before
dispatch; OMP captures the request model before `context`, so switching in
`context` would miss the first request. Policy-preparation retries reuse the
same decision. Jev sees the current request and at most two prior user requests
(each clipped to 500 characters) to interpret short follow-ups.

- **DEFAULT** keeps the main model and adds no notice. It does not prohibit
  ordinary delegation if evidence warrants it later.
- **SLOW** temporarily switches the main session from `mainNormalRole` to
  `mainDeepRole`, including its configured thinking level, then restores both
  when the turn settles. A user's explicit `/model`, `/switch`, or `--model`
  choice takes precedence; if another actor changes the model during the turn,
  the router does not overwrite it on settlement.
- **ORCHESTRATE** keeps the default main model and injects OMP's own hidden,
  user-attributed `orchestrate-notice` at `context`.
- **UNCERTAIN** uses the SLOW model and adds one short hidden hint to weigh
  delegation during scoping; no second Jev call.

At `context`, the router detects an existing native notice from the user's
explicit `orchestrate` keyword and does not duplicate it. That keyword cannot
be detected before dispatch: Jev still decides once and may switch the model.
Injected notices live only in provider context, not in the transcript.

Subagent sessions, plan mode, slash commands, and agent-authored `<system-…>`
notices skip routing. Disabling orchestration, the `task` tool, or OMP's
orchestrate keyword suppresses only the orchestration notice while main-model
routing remains enabled; set both routing flags to false to disable the front door.

### Checkpoint reviewer and Verification Auditor

The primary may call `orche_advisor` for a bounded orchestration review. Native
`orchestrate` notices require initial-plan and verified phase-boundary reviews;
ordinary requests keep them optional. Reviews are tool-less, use only seven
snapshot fields plus automatically attached Verification Auditor findings, and
are charged to `modelRoles.orche-advisor`. Configure that role explicitly; there
is no fallback to DEFAULT or SLOW. Repeating a snapshot without new findings
reuses the earlier review.

The bundled Verification Auditor runs through OMP's WATCHDOG roster only while
advisors are enabled. Its model is `@verification-auditor`, a custom role
registered as `@smol` on primary-session startup if unset. It does not use or
change `modelRoles.advisor` (ADVISOR); set its role independently to choose a
different model. A same-named `WATCHDOG.yml` entry overrides the bundled
auditor. Its evidence-backed concern/blocker notes feed the next checkpoint
review, not unrelated watchdog notes.

When no WATCHDOG roster is configured, the Verification Auditor is the only
advisor; the plugin removes OMP's synthesized default advisor. Explicit
`WATCHDOG.yml` entries are retained, including a general advisor if desired.

The standalone `orche-advisor` CLI remains available from this package:
`bun bin/orche-advisor.ts examples/initial-plan.json --check` validates the
input and model selection without requesting a review. The CLI uses
`modelRoles.orche-advisor` unless `--model` is supplied.

### TASK tier (`tool_call`)

The `tool_call` hook fires from the agent loop's prepare phase with **validated**
arguments, and OMP's task schema declares `agent: "string = '<spawn-policy
default>'"`. So `input.agent` is always the session's authoritative effective
agent. The router acts only on items whose `agent` is exactly `task`; anything
else — `sonic`, `scout`, `reviewer`, `security-reviewer`, project/user/plugin
agents, `^`-tagged model pseudonyms — passes through untouched. A restricted
session whose default agent is `sonic` therefore never looks like a generic task
spawn.

A `task.batch` call is classified in **one** Jev request carrying one question
per item, and only the `agent` field is ever changed: `name`, `task`, `context`,
`effort`, `isolated`, `tools`, `outputSchema` and `schemaMode` survive verbatim.

### Why `@task` → `@task_hard` needs an alias agent

OMP's task wire schema deletes unknown keys (`"+": "delete"`), and the only
invocation-local model override (`runSubprocess`'s `modelOverride`) is reachable
from the eval bridge, not from a tool-call input revision. Changing the model for
one spawn therefore has to go through the `agent` field.

Rather than hand-copying OMP's worker prompt, the plugin **derives** the alias at
runtime from the host's own bundled `task` definition (`getBundledAgent("task")`):
same system prompt, same `spawns`, same thinking level, same tool policy — only
the model role differs. It is written to `<plugin>/agents/task-deep.md`, is
rewritten whenever OMP's bundled prompt or your configuration changes, and
disappears with `omp plugin uninstall`. Per-agent settings OMP keys by *name*
(`task.agentPrewalk.task`, `task.agentAdvisor.task`, `task.prewalk`) are mirrored
onto the alias so routing does not silently reset them.

The plugin never mutates `task.agentModelOverrides` per spawn: that is global
state and concurrent spawns would race on it.

## Why OMP's native SMOL/TASK routing is preserved

`@smol` is what OMP picks when it judged the work lightweight in the first place;
`@task` is a capable delegated coding worker. They answer different questions, so
`smol ≠ task-normal` and the plugin never compares them. Jev is asked exactly one
thing about an already-chosen TASK: *would a markedly stronger reasoning model
materially reduce the chance of a wrong call, rework, or a retry?*

## Recommended model topology

```yaml
modelRoles:
  default: <capable standard primary>       # normal user turns
  task: <cheaper capable worker>            # ordinary delegated coding
  task_hard: <deep task model>              # independent deep delegated reasoning
  slow: <stronger reasoning model>          # SLOW/UNCERTAIN user turns
  smol: <inexpensive lightweight>           # OMP's own lightweight tier
  advisor: <general advisor model>          # only if declared in WATCHDOG.yml
  verification-auditor: "@smol"            # distinct from ADVISOR
  orche-advisor: <checkpoint reviewer>      # explicitly configured
```

No vendor or model name is hard-coded in the routing or auditor defaults;
roles resolve through `modelRoles`. On the first main-session start, missing
`task_hard` (when used) is registered as `@slow`; `verification-auditor` is
registered as `@smol`. This makes both custom roles visible in OMP's model selector
without choosing a vendor or model. Existing assignments and project overrides
are preserved; subagent sessions never register either role.

`@task` and `@task_hard` resolving to the same model is not an error. `/jev-router
status` reports it:

```text
TASK_NORMAL and TASK_DEEP currently resolve to the same model.
Tier routing is active but provides no model-cost differentiation.
```

Likewise, `@default` and `@slow` must resolve to distinct authenticated models
for main-model routing to change cost. Missing `@default` disables switching;
an explicit model selection is never replaced.

## Install

```bash
omp plugin install omp-jev-router
```

From a checkout:

```bash
omp plugin link /path/to/jev_router
```

Nothing else is required. No `AGENTS.md` edit, no agent files to copy, no
`models.yml` surgery, no routing prompt, no separate SDK install, no OMP patch.
The TypeSafe SDK ships as a plugin dependency.

## First-run credential setup

Priority order:

1. `TYPESAFE_API_KEY` in the environment — used directly and **never** copied to
   disk.
2. OMP's own credential store for the `typesafe` provider — the same store
   `/login typesafe` writes.
3. Interactive setup via `/jev-router setup`.

```bash
/jev-router setup
```

`setup` offers OMP's native `/login typesafe` first, because that dialog masks
input; the extension dialog API has no masked mode (`ExtensionUIDialogOptions`
exposes no `secret` flag), so the in-plugin paste path says so explicitly. A
pasted key is validated against `GET /v1/models` before anything is stored, and
an invalid key is never stored.

The plugin owns no credential file. Reusing `AuthStorage` means rotation,
`omp token typesafe`, and 401 handling all keep working, and uninstalling the
plugin leaves your account credential exactly where you put it.

## Commands

| Command | Effect |
| --- | --- |
| `/jev-router setup` | Configure or remove the TypeSafe credential. |
| `/jev-router status` | Routing state, resolved main/TASK roles, last decisions and model action. |
| `/jev-router test` | Live probes of DEFAULT, SLOW, and both TASK tiers. |
| `/jev-router stats` | Aggregated counts, latencies, distributions, worker cost. |
| `/jev-router reset` | Clear telemetry and stored configuration. |

`status` output:

```text
Jev Router             enabled
Credential             configured (OMP credential store)

Orchestration routing  enabled
Main model routing     enabled
MAIN_DEFAULT           @default → openai/gpt-5.4
MAIN_SLOW              @slow → openai/gpt-5.4-deep
Model                  jev-latest (default)
Gate                   confidence ≥ 0.6, margin ≥ 0.2

TASK tier routing      enabled
TASK_NORMAL            @task → openai/gpt-5.4
TASK_DEEP              @task_hard → anthropic/claude-opus-5
Gate                   confidence ≥ 0.75, margin ≥ 0.2
Tier agent             task-deep — discoverable and spawnable

Last orchestration     SLOW 0.91 model=@slow
Last TASK route        TASK_NORMAL 0.87
```

No secret is ever printed: the credential is reported by provenance only.

## Routing thresholds

A decision is accepted only when **both** hold, with `confidence =
max(probabilities)` and `margin = p(top1) - p(top2)`:

| | confidence | margin |
| --- | --- | --- |
| front door (3 labels) | `≥ 0.60` | `≥ 0.20` |
| TASK tier | `≥ 0.75` | `≥ 0.20` |

The `/jev-router test` probes observed with `jev-latest`:

| request | outcome |
| --- | --- |
| rename a field and its two call sites | `DEFAULT` p=1.00 |
| root-cause stale balances across ledger and cache | `SLOW` p=1.00 |

The TASK probes selected `TASK_NORMAL` for a specified CLI flag and
`TASK_DEEP` for ledger/cache consistency reasoning.

## DEFAULT / SLOW / ORCHESTRATE

Jev chooses the lowest expected total cost and risk for the primary:

- **DEFAULT** — the standard model suffices for a clear, coherent task,
  localized fix, mechanical change, or settled follow-up.
- **SLOW** — stronger reasoning materially reduces the chance of a wrong
  judgment or retry in one sequential body of work: root-cause debugging,
  ambiguous design trade-offs, concurrency, state consistency, security,
  migration reasoning, or public API redesign.
- **ORCHESTRATE** — independent workstreams can run in parallel with separate
  context locality and benefit enough to pay coordination and duplicated
  context costs.

Difficulty, file count, available subagents, and a general preference for
parallelism do not justify ORCHESTRATE; request length alone does not justify
SLOW.

## TASK_NORMAL / TASK_DEEP

**TASK_NORMAL** — a capable coding worker suffices and expensive high-level
reasoning is unlikely to reduce rework: implementing a design the primary already
settled, a clear specification, a well-scoped feature, a localized modification,
an adapter, a clear test addition, an integration whose API usage is decided,
ordinary refactoring, boilerplate, mechanical migration, clear CRUD, a
well-defined TODO.

**TASK_DEEP** — a stronger model materially lowers the risk of a wrong call:
root-cause debugging, architecture or design decisions, ambiguous requirements,
trade-offs between plausible solutions, cross-module semantic reasoning,
concurrency, race conditions, security-sensitive changes, authn/authz, state
consistency, complex distributed behavior, data-migration reasoning, public API
redesign, large ambiguous refactors, complex integration failures, work whose
success condition must itself be interpreted, or a retry of something a normal
worker already failed.

## Failure behavior

| failure | front door | TASK tier |
| --- | --- | --- |
| credential missing | current model; no automatic orchestration | `@task_hard` |
| 401 / 403 | current model; no automatic orchestration | `@task_hard` |
| 429 / 5xx | current model; no automatic orchestration | `@task_hard` |
| timeout | current model; no automatic orchestration | `@task_hard` |
| network failure | current model; no automatic orchestration | `@task_hard` |
| malformed response | current model; no automatic orchestration | `@task_hard` |
| SDK exception | current model; no automatic orchestration | `@task_hard` |
| unknown Jev model | current model; no automatic orchestration | `@task_hard` |
| gate not cleared | SLOW + UNCERTAIN hint | `@task_hard` |

Front-door failure leaves the model and native orchestration behavior unchanged.
Tier failure degrades to the strongest safe worker, because a wrong
cheap worker costs a retry that is more expensive than one stronger run.

Every decision runs under a hard `routingTimeoutMs` budget with retries
disabled: a router that retries costs more than the routing saves.

## Privacy and security

Sent to Jev: the current user request plus at most two previous user requests
(oldest first, each clipped to 500 characters) for the front door, or subtask
instructions plus the batch's shared `context` for the tier router. Current
request and task text are clipped to `maxRoutingInputChars`. Never sent: the
full conversation, repository tree, source files, task transcripts, or agent
results. No scout or summarizer agent is spawned for a routing decision.

Credentials never touch the repository, the project directory, the plugin source
tree, or any log. Debug lines carry route labels and numbers only; error text is
scrubbed of any tracked credential and of key-shaped tokens before it is written.

## Telemetry

Local data only — no prompt text, no task text, no source, no transcript — under
`<omp agent dir>/jev-router/`, deleted by `/jev-router reset` and disabled by
`telemetryEnabled=false`.

`telemetry.json` holds aggregate counters:

- routed user turns; DEFAULT / SLOW / ORCHESTRATE / UNCERTAIN counts
- TASK batches; TASK_NORMAL / TASK_DEEP counts; gate fallbacks
- Jev errors and timeouts; average routing latency
- confidence and margin distributions (10 buckets each, one entry per decision)
- per-tier-agent spawns, settled and completed spawns, tokens, cost and
  **cost per completed task**

`decisions.jsonl` has one line per Jev decision: `kind`, applied `route`, the
pre-gate `top` label, per-label `probabilities`, `confidence`, `margin`,
`confident`, latency, and the main-model action or TASK batch size (errors log
only `route: "ERROR"` and `timedOut`). For decisions that carry probabilities,
the pre-gate label and distribution let a different confidence/margin gate be
replayed exactly offline — the buckets cannot resolve a threshold inside a
bucket. Errors and missing answers carry no distribution. The log records what
was routed, not whether the route was right.

Worker usage is attributed by agent name, which is exactly the tier the router
selected. It is read from OMP's `task:subagent:progress` and
`task:subagent:lifecycle` frames on the session event bus, which fire for sync
and background (`async.enabled`) spawns alike; the `task` tool result of a
background spawn carries no usage. Each spawn is counted once when it settles.
`ctx.sessionManager.getUsageStatistics()` is a single session-wide total with no
per-role breakdown, so it cannot substitute.

Snapshots are versioned. Older snapshots are migrated on load — v1 `DIRECT`
counts appear as `DIRECT (v1, migrated)` in `stats`, v2 split token fields are
folded into `tokens` — and a snapshot written by a newer plugin is moved to
`telemetry.v<N>.json` instead of being overwritten.

## Configuration

Stored in OMP's own per-plugin settings map and removed by `omp plugin
uninstall`:

```bash
omp plugin config list omp-jev-router
omp plugin config set omp-jev-router taskMinConfidence 0.85
omp plugin config get omp-jev-router deepTaskRole
```

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for both routers |
| `jevModel` | `""` | TypeSafe model id; empty = `jev-latest` |
| `orchestrationRoutingEnabled` | `true` | enable native orchestration notices when allowed |
| `mainModelRoutingEnabled` | `true` | route eligible main-session turns between two model roles |
| `mainNormalRole` | `default` | baseline model role; explicit user selections win |
| `mainDeepRole` | `slow` | temporary SLOW/UNCERTAIN model role |
| `orchestrationMinConfidence` | `0.60` | `max(probabilities)` gate; below it use SLOW |
| `orchestrationMinMargin` | `0.20` | `top1 - top2` gate; below it use SLOW |
| `taskRoutingEnabled` | `true` | TASK tier routing |
| `taskMinConfidence` | `0.75` | `max(probabilities)` gate |
| `taskMinMargin` | `0.20` | `top1 - top2` gate |
| `normalTaskRole` | `task` | role for TASK_NORMAL |
| `deepTaskRole` | `task_hard` | role for TASK_DEEP |
| `routingTimeoutMs` | `4000` | hard per-decision budget |
| `maxRoutingInputChars` | `4000` | upper bound on text sent to Jev |
| `telemetryEnabled` | `true` | local aggregate counters |
| `debugLogging` | `false` | one metrics-only line per decision |

`normalTaskRole: task` (the default) means TASK_NORMAL spawns are left
completely untouched — OMP's bundled agent runs exactly as it always did. Set it
to another role only if you want a second alias agent materialized.

The plugin resolves the configured tier roles (`modelRoles.task` and
`modelRoles.task_hard` by default). Its automatic model-role writes register
missing `task_hard` as `@slow` and missing `verification-auditor` as `@smol`
on main-session startup; existing assignments, including ADVISOR, are never overwritten.

To migrate an installation with an explicitly stored `deepTaskRole: slow`, run:

```sh
omp plugin config set omp-jev-router deepTaskRole task_hard
```

Start a new session to register the missing `task_hard` role automatically,
then choose its model in OMP's model selector or `config.yml`. Until changed,
it follows `@slow`. Explicit role overrides remain honored. The agent name
stays `task-deep`; `task_hard` is its model role, not a new agent. Uninstalling
the plugin leaves this user-configurable model-role assignment intact.

## Troubleshooting

Turn on `debugLogging` and read the OMP log:

```text
jev.orchestration route=SLOW confidence=0.91 margin=0.82 latency=578ms model=@slow
jev.task route=TASK_NORMAL confidence=1.00 margin=1.00 latency=288ms
jev.task route=TASK_DEEP confidence=0.99 margin=0.98 latency=247ms
jev.orchestration route=SKIP reason=not-main-session
```

| symptom | cause |
| --- | --- |
| `route=SKIP reason=credential-missing` | no TypeSafe key; run `/jev-router setup` |
| `route=SKIP reason=not-main-session` | expected — a subagent hit the front door and was rejected |
| `route=SKIP reason=explicit-orchestrate` | OMP's own notice is already present; Jev still decided before dispatch and may have switched the model |
| `model=skip:explicit-model` | a user-selected model, including `--model`, takes precedence |
| `model=skip:default-role-unresolved` | configure `modelRoles.default` to enable model switching |
| `model=skip:deep-role-unresolved` | configure `modelRoles.slow` or `mainDeepRole` |
| `route=SKIP reason=orchestrate-keyword-disabled` | keyword is off and model routing is also disabled |
| `route=SKIP reason=plan-mode` | plan mode owns the turn |
| `route=SKIP reason=generic-task-overridden` | an agent named `task` shadows OMP's bundled worker; tier routing stands down so your definition is not replaced |
| `route=SKIP reason=deep-alias-unspawnable` | `task-deep` is not advertised by the task tool (spawn policy or `task.disabledAgents`) |
| `TASK_DEEP` everywhere | check `/jev-router status` for a credential or gate problem |
| `Unresolved role(s): @task_hard` in status | `modelRoles.task_hard` does not resolve; OMP falls back to the parent model, so configure the independent role |

The same check runs once at session start and writes
`jev.router model role(s) @slow do not resolve; …` to the OMP log, so a broken
role mapping surfaces without opening `status`.

## Uninstall

```bash
omp plugin uninstall omp-jev-router
```

Removes the package, its derived `agents/task-deep.md`, the checkpoint tool,
and the bundled auditor. OMP model-role assignments (`task_hard`,
`verification-auditor`, `orche-advisor`) are user configuration and remain
until removed explicitly. The `typesafe` credential and
`<omp agent dir>/jev-router/` telemetry files also remain; use
`/jev-router reset` before uninstalling if those should be cleared.

## Development / test

```bash
bun install
bun run gen:agents   # regenerate the shipped tier alias from the pinned OMP
bun run check        # tsc --noEmit
bun run lint         # oxlint
bun test             # unit + integration suite
bun run build        # all of the above
```

If `bun test` fails to load the native addon (`Failed to load pi_natives native
addon`), your package manager skipped the platform package's install step; copy
it into place once:

```bash
cp node_modules/@oh-my-pi/pi-natives-linux-x64/*.node node_modules/@oh-my-pi/pi-natives/native/
```

`bun test` covers the gate arithmetic, input clipping, both routers' guards and
fallbacks, batch classification, field preservation, deduplication, alias
derivation round-tripped through OMP's own frontmatter parser, credential
priority, secret redaction, telemetry persistence, and status rendering.

Live verification against a real OMP binary (`omp plugin link`, print-mode runs)
is what proves the seams: extension load, agent discovery, command registration,
front-door and tier decisions in a real session, the subagent recursion guard,
and uninstall restoration.

### Known API constraints

Recorded rather than worked around:

- **`@oh-my-pi/pi-tui` subpaths do not resolve at runtime from an extension**
  (only the package root does, and it does not re-export `containsOrchestrate`).
  The decision and temporary model switch happen at `before_agent_start`;
  `context` checks for OMP's native notice before injecting an automatic one.
  Type-only imports of thinking-level definitions are erased at runtime.
- **No per-invocation model override on the task wire schema.** Unknown keys are
  deleted by the schema, so the tier is expressed through a derived alias agent.
- **`ExtensionUIDialogOptions` has no masked-input mode**, so `/jev-router setup`
  routes you to OMP's native `/login typesafe` for masked entry and labels its
  own paste dialog as unmasked.
- **`task.agentServiceTierOverrides` is keyed by agent name** and has no
  frontmatter equivalent, so an override configured for `task` does not follow a
  spawn routed to `task-deep`. Add a `task-deep` entry if you use per-agent
  service tiers.
- **Spawns that settle after the process exits** are not in `stats`: usage is
  read from in-process subagent frames.
