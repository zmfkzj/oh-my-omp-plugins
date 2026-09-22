# omp-jev-router

Two bounded routing decisions for [OMP](https://omp.sh), made by TypeSafe's
[Jev](https://typesafe.ai) System One model:

1. **Front door** — should OMP's *native* orchestration contract be activated for
   this user request, or should the primary agent just execute it?
2. **TASK tier** — once OMP has already chosen its generic `task` worker, should
   that spawn resolve through `@task` or through `@task_hard`?

Everything else OMP does is untouched. In particular the plugin never revisits
OMP's own SMOL vs TASK decision, never rewrites a specialized or explicitly
named agent, and never implements an orchestration engine of its own.

---

## What it does

```text
                         USER
                           │
                           ▼
                ┌───────────────────┐
                │ Jev Orchestration │
                │      Router       │
                └─────────┬─────────┘
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
          DIRECT      ORCHESTRATE   UNCERTAIN
             │        native OMP    one hidden
             │        orchestrate   hint line
             └────────────┬─────────────┘
                          ▼
                   Primary @default
                          │
                 OMP native decision
                          │
                 ┌────────┴────────┐
                 ▼                 ▼
               SMOL               TASK
                 │                 │
                 ▼                 ▼
              @smol         Jev Task Router
              (untouched)          │
                           ┌───────┴───────┐
                           ▼               ▼
                      TASK_NORMAL       TASK_DEEP
                           │               │
                           ▼               ▼
                        @task            @task_hard
```

## Architecture

### Front door (`before_agent_start` + `context`)

`before_agent_start` scopes the turn and captures the request text. It performs
no network work, so OMP's policy-preparation retries cost nothing.

`context` makes the decision once per turn and applies it to the messages
actually about to be sent:

- **ORCHESTRATE** injects the exact notice OMP's `orchestrate` magic keyword
  injects — `renderOrchestrateNotice(...)` under `customType:
"orchestrate-notice"`, hidden, user-attributed. No new prompt, no new engine.
- **UNCERTAIN** injects one short hidden line asking the primary to weigh
  delegation while scoping. There is no second routing call and no extra
  planning round-trip.
- **DIRECT** injects nothing at all. It does **not** say "never delegate": the
  primary agent can still dispatch subagents through OMP's normal mechanisms if
  evidence turns up mid-turn. DIRECT only means *the plugin did not switch
  automatic orchestration on*.

Deciding at `context` is what lets the router ask OMP whether the keyword
already fired — a native notice sits in the hidden companion run immediately
before the turn's user message — instead of re-implementing OMP's prose matcher.
It also means the injected notice lives only in the provider context for that
turn and is never written to the transcript, so an automatically orchestrated
turn leaves nothing behind for the next one.

The router is skipped entirely for: subagent/child sessions, plan mode,
sessions without the `task` tool, prompts OMP left as an unexpanded slash
command, agent-authored `<system-…>` notices, a turn where the user already
typed `orchestrate`, and any session where `magicKeywords.orchestrate` is off.

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
  default: <strongest primary>       # understands, plans, integrates
  task: <cheaper capable worker>     # ordinary delegated coding
  task_hard: <deep task model>       # independent deep delegated reasoning
  slow: <general reasoning model>   # other OMP high-reasoning work
  smol: <inexpensive lightweight>    # OMP's own lightweight tier
```

No vendor or model name is hard-coded anywhere in the plugin; it resolves
whatever `modelRoles` says. Configure `modelRoles.task_hard` separately from
`modelRoles.slow`. The `slow` role remains available for reviewer, planning and
anything else that already uses it; deep TASK no longer shares it by default.

`@task` and `@task_hard` resolving to the same model is not an error. `/jev-router
status` reports it:

```text
TASK_NORMAL and TASK_DEEP currently resolve to the same model.
Tier routing is active but provides no model-cost differentiation.
```

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
| `/jev-router status` | Routing state, resolved tier models, last decisions. |
| `/jev-router test` | Live probe of both decision paths with known-answer inputs. |
| `/jev-router stats` | Aggregated counts, latencies, distributions, worker cost. |
| `/jev-router reset` | Clear telemetry and stored configuration. |

`status` output:

```text
Jev Router             enabled
Credential             configured (OMP credential store)

Orchestration routing  enabled
Model                  jev-latest (default)
Gate                   confidence ≥ 0.8, margin ≥ 0.25

TASK tier routing      enabled
TASK_NORMAL            @task → openai/gpt-5.4
TASK_DEEP              @task_hard → anthropic/claude-opus-5
Gate                   confidence ≥ 0.75, margin ≥ 0.2
Tier agent             task-deep — discoverable and spawnable

Last orchestration     DIRECT 0.91
Last TASK route        TASK_NORMAL 0.87
```

No secret is ever printed: the credential is reported by provenance only.

## Routing thresholds

A decision is accepted only when **both** hold, with `confidence =
max(probabilities)` and `margin = p(top1) - p(top2)`:

| | confidence | margin |
| --- | --- | --- |
| orchestration | `≥ 0.80` | `≥ 0.25` |
| TASK tier | `≥ 0.75` | `≥ 0.20` |

Measured behavior of the defaults against `jev-latest`:

| request | outcome |
| --- | --- |
| localized fix in one file | `DIRECT` p=1.00 |
| single well-scoped feature | `DIRECT` p=1.00 |
| sequential extract-and-reuse refactor | `DIRECT` p=1.00 |
| three disjoint subsystem migrations | `ORCHESTRATE` p=0.84 |
| independent investigation across three owners | `ORCHESTRATE` p=0.88 |
| audit-then-fix over 12 packages | `UNCERTAIN` p=0.66 |

| subtask | outcome |
| --- | --- |
| add a `--json` flag matching existing fields | `TASK_NORMAL` p=1.00 |
| add four CRUD endpoints following a sibling controller | `TASK_NORMAL` p=1.00 |
| root-cause stale balances across ledger and cache | `TASK_DEEP` p=1.00 |
| redesign a public plugin API with compatibility trade-offs | `TASK_DEEP` p=1.00 |

## DIRECT / ORCHESTRATE

The question Jev answers is:

> Would splitting this request across independent parallel subagents materially
> improve the outcome, compared with letting a single strong primary agent
> execute it directly?

decided on `orchestration benefit > coordination cost + duplicated context cost`.

**DIRECT**: one coherent code path, strong sequential dependencies, localized bug
fix, single feature, localized refactor, or subtasks that would each re-read the
same files.

**ORCHESTRATE**: two or more genuinely independent workstreams that can run at
the same time, each with good context locality in a different area; independent
investigation or verification that is useful on its own.

Explicitly *not* reasons to orchestrate: the work is hard; there are many files;
subagents exist; the primary model is expensive; parallelism sounds good.

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
| credential missing | no automatic orchestration | `@task_hard` |
| 401 / 403 | no automatic orchestration | `@task_hard` |
| 429 / 5xx | no automatic orchestration | `@task_hard` |
| timeout | no automatic orchestration | `@task_hard` |
| network failure | no automatic orchestration | `@task_hard` |
| malformed response | no automatic orchestration | `@task_hard` |
| SDK exception | no automatic orchestration | `@task_hard` |
| unknown model | no automatic orchestration | `@task_hard` |
| gate not cleared | UNCERTAIN hint | `@task_hard` |

Orchestration failure degrades to exactly what OMP would have done without the
plugin. Tier failure degrades to the strongest safe worker, because a wrong
cheap worker costs a retry that is more expensive than one stronger run.

Every decision runs under a hard `routingTimeoutMs` budget with retries
disabled: a router that retries costs more than the routing saves.

## Privacy and security

Sent to Jev: the current user request (front door), or the subtask instructions
plus the batch's shared `context` (tier router) — each clipped to
`maxRoutingInputChars`. Never sent: the conversation, the repository tree, source
files, task transcripts, or prior agent results.

No separate scout or summarizer agent is ever spawned to help the router decide;
when Jev cannot tell from the request alone, that is what UNCERTAIN is for.

Credentials never touch the repository, the project directory, the plugin source
tree, or any log. Debug lines carry route labels and numbers only; error text is
scrubbed of any tracked credential and of key-shaped tokens before it is written.

## Telemetry

Local aggregate counters only — no prompt text, no task text, no source, no
transcript — in `<omp agent dir>/jev-router/telemetry.json`, cleared by
`/jev-router reset` and disabled by `telemetryEnabled=false`:

- routed user turns; DIRECT / ORCHESTRATE / UNCERTAIN counts
- TASK batches; TASK_NORMAL / TASK_DEEP counts; gate fallbacks
- Jev errors and timeouts; average routing latency
- confidence and margin distributions (10 buckets each)
- per-tier-agent spawns, results, tokens, cost and **cost per completed task**

Worker usage is attributed by agent name, which is exactly the tier the router
selected. OMP reports a spawn's usage in the `task` tool result, so totals cover
every spawn whose result the parent session observed; background spawns that
settle after the session exits are not counted.
`ctx.sessionManager.getUsageStatistics()` is a single session-wide total with no
per-role breakdown, so it cannot substitute.

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
| `orchestrationRoutingEnabled` | `true` | front-door routing |
| `orchestrationMinConfidence` | `0.80` | `max(probabilities)` gate |
| `orchestrationMinMargin` | `0.25` | `top1 - top2` gate |
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
`modelRoles.task_hard` by default); it never copies or overwrites model roles.

To migrate an installation with an explicitly stored `deepTaskRole: slow`, run:

```sh
omp plugin config set omp-jev-router deepTaskRole task_hard
```

Set `modelRoles.task_hard` to your chosen model in OMP's `config.yml`, then start
a new session. Explicit role overrides remain honored. The agent name stays
`task-deep`; `task_hard` is its independent model role, not a new agent.

## Troubleshooting

Turn on `debugLogging` and read the OMP log:

```text
jev.orchestration route=DIRECT confidence=1.00 margin=1.00 latency=578ms
jev.task route=TASK_NORMAL confidence=1.00 margin=1.00 latency=288ms
jev.task route=TASK_DEEP confidence=0.99 margin=0.98 latency=247ms
jev.orchestration route=SKIP reason=not-main-session
```

| symptom | cause |
| --- | --- |
| `route=SKIP reason=credential-missing` | no TypeSafe key; run `/jev-router setup` |
| `route=SKIP reason=not-main-session` | expected — a subagent hit the front door and was rejected |
| `route=SKIP reason=explicit-orchestrate` | you typed `orchestrate`; your choice wins |
| `route=SKIP reason=orchestrate-keyword-disabled` | `magicKeywords.orchestrate` is off |
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

Removes the package, the derived `agents/task-deep.md`, and the plugin settings
map. OMP's agent list, the `task` tool description and the command list return to
their bundled state; verified in the test suite and by a real uninstall run. The
`typesafe` credential in OMP's own store and
`<omp agent dir>/jev-router/telemetry.json` are intentionally left alone — remove
them with `/jev-router reset` (before uninstalling) and `omp token`/`/login` if
you want them gone too.

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

- **`@oh-my-pi/pi-tui` subpaths do not resolve from an extension** in the
  compiled binary (only the package root does, and it does not re-export
  `containsOrchestrate`). The front door therefore detects OMP's own injected
  notice instead of re-implementing the prose matcher — which is also why the
  decision happens at `context`.
- **No per-invocation model override on the task wire schema.** Unknown keys are
  deleted by the schema, so the tier is expressed through a derived alias agent.
- **`ExtensionUIDialogOptions` has no masked-input mode**, so `/jev-router setup`
  routes you to OMP's native `/login typesafe` for masked entry and labels its
  own paste dialog as unmasked.
- **`task.agentServiceTierOverrides` is keyed by agent name** and has no
  frontmatter equivalent, so an override configured for `task` does not follow a
  spawn routed to `task-deep`. Add a `task-deep` entry if you use per-agent
  service tiers.
- **Background spawn usage** is only counted when its result reaches the parent
  session; a job that settles after the session exits is not in `stats`.
