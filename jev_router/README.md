# omp-jev-router

Two bounded decision calls for [OMP](https://omp.sh), made by TypeSafe's
[Jev](https://typesafe.ai) System One model:

1. **Orchestration** — choose DEFAULT or OMP's native ORCHESTRATE contract.
   An independent review-risk question runs in the same call. The primary model stays fixed.
2. **TASK tier** — route generic `task` workers through `@task_easy`,
   `@task_hard`, or `@task_challenge`.

OMP's own SMOL/TASK decision and explicit agent choices are preserved. This package
also provides an explicit `orche_advisor` checkpoint-review tool and a passive
Verification Auditor. Actual review execution is separate from Jev classification.

---

## What it does

```text
USER → Jev (bounded dialogue + committed plan)
  DEFAULT     → keep current primary model; ordinary delegation remains available
  ORCHESTRATE → keep current primary model + native orchestration/review guidance
  uncertain   → DEFAULT, no model switch

Successful todo init/append → reconsider changed plan → optionally promote to ORCHESTRATE
Independent review REQUIRED → scope-bound gate → successful review or explicit user waiver
Multiple implementation workers → pre-dispatch gate even when route is DEFAULT

Primary → OMP's native SMOL/TASK choice
  SMOL → untouched
  TASK → Jev EASY / HARD / CHALLENGE → derived tier worker
```

## Architecture

### Orchestration (`before_agent_start` + `tool_result` + `context`)

Initial classification runs at `before_agent_start`. Policy-preparation retries
reuse the decision. Jev sees the current request, recent visible user/assistant
messages, the earliest user goal still on the active branch, and the latest
committed todo plan. It never receives hidden thinking or raw tool-result bodies.

- **DEFAULT** permits direct work or ordinary delegation; it does not mean review is optional.
- **ORCHESTRATE** injects OMP's hidden, user-attributed `orchestrate-notice`.
- In the **same Jev request**, an independent REQUIRED/OPTIONAL question assesses
  review risk: release gates, persistent data, compensation/payment/security,
  material redesign or scope expansion, and repeated failures. Ambiguous/missing
  review answers and unavailable classification require review before execution.
  Neither decision changes the primary model.

When recent work scopes exist, the same request also links the new message to
one of up to six branch-local work IDs, or NEW. Progress checks and execution of
an unchanged reviewed plan retain identity even when risk remains REQUIRED.
Unrelated work or a material new contract gets a new ID. Missing, ambiguous or
out-of-list linkage is conservative: it cannot reuse another task's receipt.
An explicitly resumed listed task restores its own prior obligation/dispatch,
not the most recently active task's state.

A successful `todo init` or `todo append` reconsiders a changed committed plan.
Already-orchestrated turns renew the review requirement without another routing
call. A newly completed phase renews review for required-review turns, including
DEFAULT; ordinary task completion does not. Failed writes, views, identical
plans and late prior-turn results do not trigger spurious transitions.

Initial notices stay before the current user message. A todo-triggered notice is
anchored after that result's contiguous tool-result group, preserving the earlier prefix.
The advisor hook then adds required review guidance on the same provider request.
The mandatory review gate independently blocks unreviewed implementation and
dispatch, including a worker batch submitted alongside todo. It cannot undo an
operation already started before a new requirement existed.

Existing native keyword notices are not duplicated. Injected notices live only
in provider context, not in the transcript. Subagents, plan mode, slash commands,
synthetic notices and the master disable switch skip classification.
Disabling orchestration, its keyword or the task tool suppresses the parallel
route only: inline work still receives the independent review assessment.
There is no primary model switch or end-of-turn model restoration path.

### Checkpoint reviewer and Verification Auditor

`orche_advisor` reviews orchestration, not source code. It is primary-only and
uses `modelRoles.orche-advisor` without falling back to the primary's model.
Native orchestrate checkpoints and independent risk decisions require it.
Otherwise routine work can still use an optional review.

### Review before execution

- A batch with two or more implementation workers requires a review before any
  of those workers starts. Named `scout`/`librarian` read-only discovery is exempt.
- A required-review scope blocks inline mutation and arbitrary execution too:
  edit/write/bash/eval and unknown tools are blocked. Native read/search, todo,
  ask, finding management and the reviewer remain available for scoping.
- The shared `before_subagent_spawn` hook checks actual task and eval
  `agent()`/workpool dispatches before child execution. Every native worker,
  including one in an approved required-review batch, needs a single-use permit
  from an accepted `task` preflight. Parent-only approval is not a spawn permit.
  Permits bind the current scope, worker type and requested name; host collision
  suffixes are accepted. Unnamed workers consume a scope/type-bound allowance
  because the host generates their handle after preflight. Reload loses permits:
  resubmit the exact task input, reusing its review if the scope is unchanged.
- Programmatic implementation spawns require review. The eval hook binds the
  caller's recorded eval arguments, spawn identity and model patterns; the host
  event does not expose its expanded assignment or mutable kernel state. Use
  stable names on retries, and prefer native `task` when exact assignment-level
  scope binding is required. This is a coordination policy, not a sandbox.
- Two matching execution errors within the current request require a
  repeated-failure review, once per problem rather than on every failed retry.

To avoid a blocked staging attempt, pass an optional top-level `dispatch` to
`orche_advisor` containing the exact planned task input (`context`/`tasks`, or
a flat `task`). The tool binds and separately summarizes that scope, reviews it,
then the caller submits the unchanged task input. Otherwise the first task
attempt is blocked before execution and stages its scope for review. One review
can cover initial planning and fan-out; do not review every worker completion.

Native batches retain one summary per worker, not a single truncated batch
string. The review prompt counts all contracts, marks shortened excerpts, and
reports omitted workers with a bounded identity list when the prompt budget is
exhausted. Full task inputs remain bound into the scope hash.

Dispatch has three explicit states:

| `dispatch` input | Meaning |
| --- | --- |
| Omitted | Retain the currently staged contracts. |
| Non-empty task input | Replace staged contracts with this exact batch. |
| `null` | Withdraw all staged contracts and review parent-only work. |

For completed or abandoned worker plans, call `orche_advisor` with
`checkpoint: "replan"`, the current seven-field snapshot, and `dispatch: null`.
Do not send `tasks: []` or invent a dummy worker. Withdrawal clears the review's
dispatch summary, not running workers or their results. It creates a new
generation, invalidating old parent/worker receipts without granting permission.
Even a rejected batch can therefore be withdrawn and the remaining parent work
reviewed. Execution stays blocked until that new review succeeds. Repeating null
when nothing is staged is idempotent: it cannot clear a parent-plan rejection.
Re-submitting a withdrawn worker batch requires a fresh review.
The complete snapshot is validated before any replacement or withdrawal is
persisted. Invalid input, including an oversized combined snapshot, leaves the
existing dispatch and approval untouched.

For a rejected parent plan, change the semantic committed todo plan (or staged
contract) before re-review. Editing snapshot prose alone does not change the
scope and cannot evade a rejection.

Receipts persist on the active branch and bind a work ID, semantic todo plan,
blockers/abandonments, review generation, exact native dispatch and finding revision.
Scope identity is finalized at assessment, before any review, waiver or execution.
Execution may reveal the required notice but never changes the approved key.
There is no late pending-risk generation to invalidate a just-issued waiver or
to be erased by cached-review reuse. An old review completing after a task switch
cannot change the new task's requirement.

Initial assessments do not proactively demand review for conversational turns.
New work has separate state; a continuation keeps its receipt unless plan,
dispatch, phase or evidence changes. The global finding revision deliberately
continues to invalidate execution permission, never ordinary read-only access.
Reload and branch rewind reconstruct only records on the active branch.

Status questions and read-only diagnostic follow-ups do not proactively request
another review merely because the project is risky. Jev receives a bounded excerpt
of the latest successful review and assesses the new action, not historical risk.
New findings alone do not proactively call for another review, including after
a successful review in the same turn. They remain unresolved and gate the next
mutation. Outstanding requirements are not erased by conversational follow-ups.
Known observation-only Studio devices (discovery, state, logs, instance/
script/tree inspection) bypass the mutation gate despite using the `write` transport.
Arbitrary Luau, shell/eval execution and unknown devices remain gated.
Receipt format v4 does not accept earlier receipts, so existing sessions need a
fresh review before subsequent required-review execution. Legacy aggregate
dispatch summaries may already have lost worker text: restage the exact task
input, or use `dispatch: null` to withdraw them. They cannot be reviewed as if
complete. Neither recovery path requires a user waiver.

Failure is not permission, but an unavailable reviewer is not a rejected plan:

- A provider completion error gets one automatic retry with the configured model
  and reasoning settings. Truncation instead retries without reasoning. A call
  makes at most two completion attempts total; cancellation is not retried.
- Provider/runtime, configuration and malformed-output failures keep execution
  blocked but leave the same scope reviewable. Diagnose the error and review
  again after recovery; neither `/review-retry` nor a waiver is required, and
  recovery does not rotate the scope key. Do not loop on an unchanged outage.
  Historical untyped failure records also remain reviewable after reload.
- Approval is committed only after review usage bookkeeping succeeds. A storage
  failure after `KEEP` leaves execution blocked and the same scope retryable.
  If the reviewer actually rejected the plan, bookkeeping failure preserves
  that rejection rather than converting it into a retryable provider outage.
- `REPLAN` and `ESCALATE` are substantive rejections, not approval. Address the
  verdict and revise the committed plan before re-review; an unchanged rejected
  scope cannot make another paid review automatically. `KEEP`/`ADJUST` permit
  the reviewed scope, with material plan changes still requiring fresh review.
- `/review-retry <scope-key> <reason>` authorizes an unchanged rejected scope's
  new attempt. `/review-waive <scope-key> <reason>` explicitly waives review.
  `/review-status` shows the full key and unavailable/rejected state.
  These commands are user-only. Waivers never resolve findings or claim that
  verification passed. A lasting reviewer outage cannot authorize execution.

### Durable finding ledger

`review_findings` exposes `list`, `resolve`, `waive`, and `reopen`. Each finding
has a stable ID, original advisor entry, timestamp, current status, and the
actual user message identifying its scope. Only the owned auditor's concern and
blocker notes are admitted; repeated equivalent notes in the same scope merge.
Neither age nor a successful review resolves or deletes a finding.

- `resolve` needs a reason and IDs of later successful tool results or actual
  user messages on this branch. Assistant claims, failed results, review verdicts
  and ledger listings cannot serve as resolution evidence.
- Resolutions are explicitly **orchestrator-reported**, not proof. The original
  note and bounded evidence excerpts stay visible to the reviewer.
- `waive` requires explicit user confirmation. `reopen` records a renewed concern.
  A renewed auditor objection after a reported resolution opens a new finding.
- New findings and valid lifecycle changes invalidate receipts/cache reuse.
  Exact repeated notes, unrelated messages and nits do not.

The reviewer receives up to five unresolved findings in detail, reserving space
for the two newest, plus up to three recent resolutions/waivers with evidence.
Older or excess findings remain in the ledger and are represented by omission
counts and bounded ID lists, not silently treated as resolved. Use `list` with
`findingId` to inspect any omitted item. An auditor's account of a user
instruction is not itself a direct user instruction; scope and evidence must be
weighed before superseding restrictions.

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

### Why worker tiers need alias agents

OMP's task wire schema deletes unknown keys (`"+": "delete"`), and the only
invocation-local model override (`runSubprocess`'s `modelOverride`) is reachable
from the eval bridge, not from a tool-call input revision. Changing the model for
one spawn therefore has to go through the `agent` field.

The plugin **derives** `task-easy`, `task-hard`, and `task-challenge` at runtime
from OMP's bundled `task` definition: same prompt, `spawns`, thinking level and
tool policy; only the model role differs. Files live under `<plugin>/agents/`
and are updated when the bundled prompt or configuration changes.
Per-agent `task.agentPrewalk.task`, `task.agentAdvisor.task`, and `task.prewalk`
choices are mirrored onto all three aliases. Stale/unwritable aliases and agents
not advertised by the live spawn policy are not targeted.

The plugin never mutates `task.agentModelOverrides` per spawn: that is global
state and concurrent spawns would race on it.

## Why OMP's native SMOL/TASK routing is preserved

Explicit `sonic`, `scout`, reviewer, and custom-agent choices remain untouched.
Jev only refines an already-selected generic `task` into the least expensive tier
likely to finish correctly. It does not expand a task into more workers.

## Recommended model topology

```yaml
modelRoles:
  default: <chosen session primary>         # never changed by this plugin
  task: <capable worker>                    # OMP's generic task baseline
  smol: <lightweight model>                 # OMP's lightweight baseline
  slow: <strong reasoning model>            # optional role used by challenge default
  task_easy: "@smol"                        # mechanical, low-risk work
  task_hard: "@task"                        # substantive implementation
  task_challenge: "@slow"                   # high-risk or unresolved reasoning
  advisor: <general advisor model>          # only if declared in WATCHDOG.yml
  verification-auditor: "@smol"            # distinct from ADVISOR
  orche-advisor: <checkpoint reviewer>      # explicitly configured
```

No vendor/model name is hard-coded. Missing tier roles are registered on primary
session startup as `@smol`, `@task`, and `@slow` respectively; existing assignments
are preserved. `verification-auditor` defaults to `@smol`. Child sessions never
register roles. If you configure custom role names, those names receive the same
missing-role defaults.

Assign distinct authenticated models in OMP's model selector or `config.yml`.
`/jev-router status` reports missing roles and tier roles resolving to the same
model. Keeping one primary model avoids router-induced full-context provider
switches; it does not guarantee provider cache hits or prevent OMP/user fallback.

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
| `/jev-router status` | Fixed-primary policy, resolved worker roles, aliases and last decisions. |
| `/jev-router test` | Live DEFAULT/ORCHESTRATE and three-tier classification probes. |
| `/jev-router stats` | Aggregated counts, latencies, distributions, worker cost. |
| `/jev-router reset` | Clear telemetry and stored configuration. |
| `/review-status` | Current required-review scope, receipt and failure state. |
| `/review-retry <key> <reason>` | User-authorized new attempt for an unchanged rejected plan; not needed for infrastructure recovery. |
| `/review-waive <key> <reason>` | Explicit user waiver for exactly that scope. |

`status` output:

```text
Jev Router             enabled
Credential             configured (OMP credential store)

Orchestration routing  enabled
Primary model          unchanged — no model switching
Model                  jev-latest (default)
Gate                   confidence ≥ 0.6, margin ≥ 0.2

TASK tier routing      enabled
TASK_EASY              @task_easy → provider/lightweight
TASK_HARD              @task_hard → provider/coding
TASK_CHALLENGE         @task_challenge → provider/reasoning
Gate                   confidence ≥ 0.75, margin ≥ 0.2
Easy tier agent        task-easy — discoverable and spawnable
Hard tier agent        task-hard — discoverable and spawnable
Challenge tier agent   task-challenge — discoverable and spawnable

Last orchestration     DEFAULT 0.91
Last TASK route        TASK_HARD 0.87
```

No secret is ever printed: the credential is reported by provenance only.

## Routing thresholds

A decision is accepted only when **both** hold, with `confidence =
max(probabilities)` and `margin = p(top1) - p(top2)`:

| | confidence | margin |
| --- | --- | --- |
| orchestration (2 labels) | `≥ 0.60` | `≥ 0.20` |
| TASK tier (3 labels) | `≥ 0.75` | `≥ 0.20` |

These gates are configurable, not measured guarantees of classifier accuracy.
Use `/jev-router test` for live probes; only records with stored probabilities
can be replayed offline. Historical aggregate counters cannot reconstruct
unlogged decisions.

## DEFAULT / ORCHESTRATE

- **DEFAULT** — one coherent or sequential body of work, including difficult
  reasoning, routine delegation, or a single bounded worker.
- **ORCHESTRATE** — genuinely independent workstreams with enough context locality
  and benefit to justify coordination and duplicated context.

The classifier evaluates the conversation and plan, not just the latest terse
follow-up. Difficulty, file count, or merely having a todo list do not mandate
orchestration. Neither branch selects a different primary model.

## TASK_EASY / TASK_HARD / TASK_CHALLENGE

- **TASK_EASY** — exact procedure, settled design, local mechanical edits or
  collection; low correctness risk and easily detected errors.
- **TASK_HARD** — substantive feature implementation, normal debugging,
  regression coverage and integration within clear boundaries.
- **TASK_CHALLENGE** — unresolved root cause/design, ambiguity, concurrency,
  security/authorization, data integrity or migration semantics, distributed
  behavior, or a retry after a capable worker failed.

When a valid EASY or HARD answer misses the confidence/margin gate, the router
selects HARD. A CHALLENGE-leading answer remains CHALLENGE even below the gate.
Missing answers, credentials, or provider failures still select CHALLENGE when
its alias is available. Explicit non-generic agents are never rewritten.

When the host supplies a task's `solutionSpace`, it is sent as `solution_space`
alongside the task instruction. It describes settled versus unresolved decisions;
it is evidence, not permission to override classification rules. The installed
OMP 18.3.1 task schemas remove unknown fields before `tool_call`, including
`solutionSpace`. On that host, this separate field requires an upstream schema
change; callers must put settled/unresolved decisions in supported `task` text
for them to reach the classifier. Optional-field support here alone does not
enable the field in the host task tool.

## Failure behavior

| failure | front door | TASK tier |
| --- | --- | --- |
| credential missing | current model; no automatic orchestration | `@task_challenge` |
| 401 / 403 | current model; no automatic orchestration | `@task_challenge` |
| 429 / 5xx | current model; no automatic orchestration | `@task_challenge` |
| timeout | current model; no automatic orchestration | `@task_challenge` |
| network failure | current model; no automatic orchestration | `@task_challenge` |
| malformed response | current model; no automatic orchestration | `@task_challenge` |
| SDK exception | current model; no automatic orchestration | `@task_challenge` |
| unknown Jev model | current model; no automatic orchestration | `@task_challenge` |
| gate not cleared | DEFAULT; current model | HARD for EASY/HARD-leading answers; otherwise CHALLENGE |

Front-door failure leaves the model and native orchestration behavior unchanged.
Provider/answer failure degrades to the strongest safe worker. Ordinary tier
uncertainty selects HARD rather than treating uncertainty itself as high risk.

Every decision runs under a hard `routingTimeoutMs` budget with retries
disabled: a router that retries costs more than the routing saves.

## Privacy and security

Sent to Jev: the current request, up to eight recent visible dialogue messages
plus the earliest retained user goal, latest committed todo plan, and up to 1200
characters of the latest successful review as historical context, not authorization.
Scope linkage also receives up to six work-goal summaries, bounded together
within the same text budget (at most 1200 characters for these goals).
Dialogue entries are clipped to 700 characters (the retained goal to 1600);
plan text is clipped to 3200. The engine applies a combined
`maxRoutingInputChars` text budget, default 12000, excluding JSON framing and
fixed classifier instructions. Task classification also includes the batch's
shared context and bounded branch/plan context; one third of the text budget is
reserved for shared context, the rest split across tasks. Each task reserves up
to one third of its budget for `solutionSpace` when supplied, with the remaining
budget used by its instruction. The combined text limit is unchanged.

The router does not read source files or send raw tool results, images, hidden
thinking, or complete transcripts. Visible dialogue/plan text can itself contain
user-provided sensitive material; expanded context is sent to TypeSafe.
It is not copied to telemetry. No scout/summarizer agent is launched for routing.

The checkpoint reviewer additionally receives plugin-owned execution-scope
metadata and bounded excerpts from explicitly cited finding-resolution evidence.
It never receives the whole transcript. Inspect evidence IDs before citing
outputs containing sensitive data.

Credentials never touch the repository, the project directory, the plugin source
tree, or any log. Debug lines carry route labels and numbers only; error text is
scrubbed of any tracked credential and of key-shaped tokens before it is written.

## Telemetry

Local data only — no prompt text, no task text, no source, no transcript — under
`<omp agent dir>/jev-router/`, deleted by `/jev-router reset` and disabled by
`telemetryEnabled=false`.

`telemetry.json` holds aggregate counters:

- orchestration decisions (including todo rechecks); DEFAULT / ORCHESTRATE
- TASK batches; EASY / HARD / CHALLENGE counts; CHALLENGE gate fallbacks
- Jev errors and timeouts; average routing latency
- confidence and margin distributions (10 buckets each, one entry per decision)
- per-tier-agent spawns, settled and completed spawns, tokens, cost and
  **cost per completed task**

`decisions.jsonl` has one line per Jev decision: `kind`, applied `route`, the
pre-gate `top` label, per-label `probabilities`, `confidence`, `margin`,
`confident`, latency, and TASK batch size. Orchestration rows also carry
`reviewRequired` and the independent `review` distribution. Errors log
`route: "ERROR"` and `timedOut`; no primary model action is emitted. For decisions with probabilities,
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

Telemetry v4 retains retired orchestration labels as `legacyDecisions`, and old
task decisions/fallbacks as historical totals rather than relabeling them as
new tiers. Historical worker names and decision-log rows remain unchanged.
Already-lost counters cannot be recovered. v2 split token fields fold into
`tokens`; a snapshot from a newer plugin is moved to `telemetry.v<N>.json`.

## Configuration

Stored in OMP's own per-plugin settings map and removed by `omp plugin
uninstall`:

```bash
omp plugin config list omp-jev-router
omp plugin config set omp-jev-router taskMinConfidence 0.85
omp plugin config get omp-jev-router challengeTaskRole
```

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for both routers |
| `jevModel` | `""` | TypeSafe model id; empty = `jev-latest` |
| `orchestrationRoutingEnabled` | `true` | enable native orchestration notices when allowed |
| `orchestrationMinConfidence` | `0.60` | confidence gate; below it keep DEFAULT |
| `orchestrationMinMargin` | `0.20` | top1 - top2 gate; below it keep DEFAULT |
| `taskRoutingEnabled` | `true` | TASK tier routing |
| `taskMinConfidence` | `0.75` | `max(probabilities)` gate |
| `taskMinMargin` | `0.20` | `top1 - top2` gate |
| `easyTaskRole` | `task_easy` | role for TASK_EASY |
| `hardTaskRole` | `task_hard` | role for TASK_HARD |
| `challengeTaskRole` | `task_challenge` | role for TASK_CHALLENGE |
| `routingTimeoutMs` | `4000` | hard per-decision budget |
| `maxRoutingInputChars` | `12000` | combined text budget; see privacy section |
| `telemetryEnabled` | `true` | local aggregate counters |
| `debugLogging` | `false` | one metrics-only line per decision |

### Migrating from the two-tier/main-switching version

`mainModelRoutingEnabled`, `mainNormalRole`, `mainDeepRole`, `normalTaskRole`,
and `deepTaskRole` are removed and no longer consulted. Re-enter any customized
worker role choices using the three new tier keys. Old `task-deep`/`task-normal`
agent definitions are retired; update explicit callers to a supported tier or,
preferably, dispatch generic `task` and let Jev select it.

Existing `modelRoles.task_hard` is preserved; it is now the middle tier.
Choose `modelRoles.task_challenge` separately for the strongest worker.
Reload the plugin (`/reload-plugins`) or start a new session after updating.
Uninstall leaves role assignments and credentials intact.

## Troubleshooting

Turn on `debugLogging` and read the OMP log:

```text
jev.orchestration route=ORCHESTRATE confidence=0.91 margin=0.82 latency=300ms
jev.task route=TASK_EASY confidence=1.00 margin=1.00 latency=250ms
jev.task route=TASK_CHALLENGE confidence=0.99 margin=0.98 latency=250ms
jev.orchestration route=SKIP reason=not-main-session
```

| symptom | cause |
| --- | --- |
| `route=SKIP reason=credential-missing` | no TypeSafe key; run `/jev-router setup` |
| `route=SKIP reason=not-main-session` | expected — a subagent hit the front door and was rejected |
| `route=SKIP reason=explicit-orchestrate` | native notice is already present; no duplicate injected |
| `route=SKIP reason=orchestrate-keyword-disabled` | keyword is off; automatic orchestration is disabled |
| `route=SKIP reason=plan-mode` | plan mode owns the turn |
| `route=SKIP reason=generic-task-overridden` | an agent named `task` shadows OMP's bundled worker; tier routing stands down so your definition is not replaced |
| `route=SKIP reason=challenge-alias-unspawnable` | challenge alias unavailable or disallowed; generic task stays native |
| `TASK_CHALLENGE` everywhere | check credential availability and gate thresholds |
| `Unresolved role(s)` in status | configure the named role with an authenticated model |

The same check runs once at session start and writes
`jev.router model role(s) @task_challenge do not resolve; …` to the OMP log, so a broken
role mapping surfaces without opening `status`.

## Uninstall

```bash
omp plugin uninstall omp-jev-router
```

Removes the package, its derived tier agents, the checkpoint tool,
and the bundled auditor. OMP model-role assignments (`task_easy`, `task_hard`,
`task_challenge`, `verification-auditor`, `orche-advisor`) remain
until removed explicitly. The `typesafe` credential and
`<omp agent dir>/jev-router/` telemetry files also remain; use
`/jev-router reset` before uninstalling if those should be cleared.

## Development / test

```bash
bun install
bun run gen:agents   # regenerate all three shipped tier aliases
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
  Initial classification happens at `before_agent_start`; `context` handles
  native notices. Thinking-level types are imported only as erased types.
- **No per-invocation model override on the task wire schema.** Unknown keys are
  deleted by the schema, so the tier is expressed through a derived alias agent.
- **`ExtensionUIDialogOptions` has no masked-input mode**, so `/jev-router setup`
  routes you to OMP's native `/login typesafe` for masked entry and labels its
  own paste dialog as unmasked.
- **`task.agentServiceTierOverrides` is keyed by agent name** and has no
  frontmatter equivalent, so an override configured for `task` does not follow
  the derived tier agents. Add entries for each tier alias if you use this setting.
- **Spawns that settle after the process exits** are not in `stats`: usage is
  read from in-process subagent frames.
