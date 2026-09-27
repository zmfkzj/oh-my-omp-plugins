# omp-jev-router

A coordination layer for [OMP](https://omp.sh). One bounded decision call per
request, made by TypeSafe's [Jev](https://typesafe.ai) System One model, chooses
DEFAULT or ORCHESTRATE and independently assesses review risk. The primary model
stays fixed. The plugin then supplies its **own** execution guidance and
enforces checkpoint review, while every worker runs through OMP's native `task`
tool unchanged.

Generic workers are OMP's native `task` agent; their model comes from your
`@task` role. The plugin does not classify, rewrite, alias or re-route task
calls, and specialized (`scout`, `reviewer`, `sonic`, …) and custom agents keep
their identity and tool permissions. This package also provides an explicit
`orche_advisor` checkpoint-review tool and a passive Verification Auditor.
Actual review execution is separate from Jev classification.

> **Breaking change (single-task cutover).** The `task-easy`, `task-hard` and
> `task-challenge` aliases, per-task Jev tier classification and their settings
> are gone; see [Migrating from tier routing](#migrating-from-tier-routing).

---

## What it does

```text
USER → Jev (bounded dialogue + committed plan)
  DEFAULT     → plugin DEFAULT guidance: work directly, delegate only when useful
  ORCHESTRATE → plugin ORCHESTRATE guidance: coordinated delegation
  uncertain   → DEFAULT; primary model never changes

Successful todo init/append → reconsider changed plan → optionally promote to ORCHESTRATE
Independent review REQUIRED → scope-bound gate → successful review or explicit user waiver
Multiple implementation workers → pre-dispatch gate even when route is DEFAULT

Primary → native `task` call (task text carries the work contract)
  → review gate (live native schema, exact dispatch hash, single-use spawn permits)
  → OMP preflight / spawn / async / cancel → worker result → primary verifies acceptance
```

## Architecture

### Orchestration (`before_agent_start` + `tool_result` + `context`)

Initial classification runs at `before_agent_start`. Policy-preparation retries
reuse the decision. Jev sees the current request, recent visible user/assistant
messages, the earliest user goal still on the active branch, and the latest
committed todo plan. It never receives hidden thinking or raw tool-result bodies.

- **DEFAULT** injects the plugin's light DEFAULT guidance (when `task` is
  enabled): work directly, delegate one unit only when a separate context helps.
  It does not mean review is optional.
- **ORCHESTRATE** injects the plugin's own coordinated-delegation guidance as a
  hidden, user-attributed `jev-orchestrate-notice`. OMP's native orchestrate
  prompt is not reused as execution policy.
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

Execution guidance precedence for the current turn is: native `workflow-notice`
(`workflowz`) > native explicit `orchestrate-notice` > automatic ORCHESTRATE >
DEFAULT. A current-turn native `orchestrate-notice` is replaced in place by the
plugin's ORCHESTRATE notice, so native and plugin execution guidance never both
appear. A current-turn `workflow-notice` is kept verbatim; the plugin adds only
an auxiliary notice with the task-body contract and verification rules, never
its own dispatch or fan-out instruction. Earlier turns, the user's text and
other extensions' messages are never changed. Injected notices live only in
provider context, not in the transcript. The Orche-Advisor review guidance is
attached once to the plugin's orchestrate/workflow notice.

Subagents, plan mode, slash commands, synthetic notices and the master disable
switch skip classification and guidance; with `enabled=false` OMP's native
behavior is untouched. Disabling `orchestrationRoutingEnabled` or the task tool
suppresses automatic ORCHESTRATE only: inline work still receives the
independent review assessment, and an explicit native `orchestrate` request is
still handled by the plugin's policy. OMP's magic-keyword settings only decide
whether an explicit native notice appears; they never gate automatic routing.
With `task` disabled, no delegation is advertised. There is no primary model
switch or end-of-turn model restoration path.

### Task body contract

The plugin defines no separate `solutionSpace` or contract field and does not
replace the task tool. Host versions may expose their own additional metadata;
that stays under host validation. The guidance asks the primary to write each
`task` item (or workflow item prompt) as plain text with these sections:

```text
# Goal                          observable outcome
# Scope and non-goals           owned files, interfaces, areas not to touch
# Decided and open              fixed decisions / judgments left to the worker
# Inputs and dependencies       referenced files/artifacts, verified upstream contracts
# Acceptance and verification   success/error/boundary behavior, worker vs coordinator checks
# Return                        done/blocked, actual changes, checks run, remaining issues
```

Shared `context` carries only constraints common to every item; `outputSchema`
is used only when a structured result is needed. The layout is guidance, not a
runtime schema: free-form task calls are never rejected for missing sections.
Because the whole `task`/`context` text is inside the review hash, design
decisions written into the body are covered by the approval.

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
- Task declarations are normalized through the **live** native `task` schema
  (`pi.getAllTools()` parameters) and the host's own `validateToolArguments`:
  the session's effective default agent and unknown-field handling come from
  that schema, not from a copy. The intent field `i` is excluded, as the host
  does. If `task` is missing or its schema cannot be validated, declarations are
  refused rather than guessed; invalid shapes get no staging or permit.
- The shared `before_subagent_spawn` hook checks actual task and eval
  `agent()`/workpool dispatches before child execution. Every native worker,
  including one in an approved required-review batch, needs a single-use permit
  issued for the actual `task` tool call. Parent-only approval is not a spawn
  permit. The spawn event exposes only the agent and a `spawnKey`, so permits
  are matched against the worker identities OMP derives from the approved
  arguments (a requested `name`, its `-2`/`-3` collision suffixes, or
  `<toolCallId>:<index>` for unnamed synchronous items). When OMP's async mode
  preallocates random IDs, implementation items must carry a unique `name`;
  overlapping or ambiguous identities are refused before execution instead of
  guessed. Permits are discarded on error/blocked results, after synchronous
  completion, and on session switch/branch/tree navigation or shutdown; a normal
  async return keeps pending permits for its queued workers. Reload loses
  permits: resubmit the exact task input, reusing its review if the scope is
  unchanged.
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
The single-task cutover bumped the review receipt/dispatch format: earlier
receipts (including ones approving tier-alias dispatches) are never reused, so
resumed sessions need a fresh review before subsequent required-review
execution. Legacy aggregate dispatch summaries may already have lost worker
text: restage the exact task input, or use `dispatch: null` to withdraw them.
They cannot be reviewed as if complete. Neither recovery path requires a user
waiver.

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

### Native `task` worker (`tool_call`)

The `tool_call` hook only enforces review; it never returns a revised task
input. `agent` is never changed, so a restricted session whose spawn-policy
default is `sonic` keeps that default, and explicit `sonic`, `scout`,
`reviewer`, `security-reviewer`, project/user/plugin agents and `^`-tagged model
pseudonyms run exactly as requested. OMP keeps owning task execution, spawn
policy, concurrency, async results, cancellation, tool permissions, isolation
and workpool. There is no automatic model escalation after a failure.

Task execution needs no Jev call or credential. Only the front-door decision
uses Jev; its failures follow the conservative review policy below.

## Recommended model topology

```yaml
modelRoles:
  default: <chosen session primary>         # never changed by this plugin
  task: <capable worker>                    # OMP's generic task worker
  smol: <lightweight model>                 # OMP's lightweight baseline (sonic)
  advisor: <general advisor model>          # only if declared in WATCHDOG.yml
  verification-auditor: "@smol"            # distinct from ADVISOR
  orche-advisor: <checkpoint reviewer>      # explicitly configured
```

No vendor/model name is hard-coded. `verification-auditor` is registered as
`@smol` on primary-session startup if unset; existing assignments are preserved
and child sessions never register roles. `@task` is never written: if it does
not resolve, `/jev-router status` says so and OMP reports its own spawn error;
no other role (such as `@slow`) is substituted.

Keeping one primary model avoids router-induced full-context provider switches;
it does not guarantee provider cache hits or prevent OMP/user fallback.

## Install

```bash
omp plugin install omp-jev-router
```

From a checkout:

```bash
omp plugin link /path/to/jev_router
```

Nothing else is required. No `AGENTS.md` edit, no agent files, no `models.yml`
surgery, no routing prompt, no separate SDK install, no OMP patch. The TypeSafe
SDK ships as a plugin dependency; the package ships no agent definitions.

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
| `/jev-router status` | Fixed-primary policy, native `task` worker and `@task` role, last decision, retired leftovers. |
| `/jev-router test` | Live DEFAULT/ORCHESTRATE probes (front door only; no task classification exists). |
| `/jev-router stats` | Live-epoch decisions and observed task-worker usage, kept apart from pre-v5 history. |
| `/jev-router reset` | Clear plugin-owned telemetry files and stored configuration. |
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
Coordination guidance  plugin-owned (jev-orchestrate-notice)

Task worker            native `task` agent
  @task role           provider/coding

Last orchestration     DEFAULT 0.91
Review assessment      optional
```

If `@task` does not resolve, status says so; the plugin does not route around
it. Retired tier settings still stored for the plugin, and leftover
`@task_easy`/`@task_hard`/`@task_challenge` roles, are listed as unused and
left in place.

No secret is ever printed: the credential is reported by provenance only.

## Routing thresholds

A decision is accepted only when **both** hold, with `confidence =
max(probabilities)` and `margin = p(top1) - p(top2)`:

| | confidence | margin |
| --- | --- | --- |
| orchestration (2 labels) | `≥ 0.60` | `≥ 0.20` |

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

## Failure behavior

| failure | front door |
| --- | --- |
| credential missing | current model; no automatic orchestration; review required |
| 401 / 403 | current model; no automatic orchestration; review required |
| 429 / 5xx | current model; no automatic orchestration; review required |
| timeout | current model; no automatic orchestration; review required |
| network failure | current model; no automatic orchestration; review required |
| malformed response | current model; no automatic orchestration; review required |
| SDK exception | current model; no automatic orchestration; review required |
| unknown Jev model | current model; no automatic orchestration; review required |
| gate not cleared | DEFAULT; current model |

Front-door failure never changes the model. Missing or failed assessments keep
the conservative review requirement. Task workers are unaffected: they never
depend on Jev.

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
fixed classifier instructions. Task bodies are never sent to Jev.

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
`<omp agent dir>/jev-router/`, cleared by `/jev-router reset`. With
`telemetryEnabled=false` nothing is written (existing data is shown read-only).

`telemetry.json` (v5) holds a **live epoch** and, after an upgrade, a separate
**historical** block. Live and historical numbers are never added together.

- live orchestration decisions (including todo rechecks); DEFAULT / ORCHESTRATE;
  Jev errors, timeouts, average latency; confidence and margin distributions
- live task workers — **invocation path not separated**: any worker named
  `task` counts, whether it came from the task tool, eval `agent()` or workpool.
  Observed starts, completed/failed/cancelled settlements, measured usage
  samples and settlements whose usage was never observed (`usageUnknown`,
  never zero-filled). Tokens, cost and duration are summed over measured
  samples only; cost per completed uses measured completions as denominator,
  with sample coverage shown. `completed` means the worker run finished, not
  that its result was accepted.
- historical (pre-v5): front-door counters, the retired task-tier counters
  (`historical.taskRouting`), and every old per-agent worker row
  (`historical.workers`, including the old `task` row). Old `spawns` were
  routing selections, not observed starts.

`decisions.jsonl` has one line per Jev decision: `kind`, applied `route`, the
pre-gate `top` label, per-label `probabilities`, `confidence`, `margin`,
`confident`, latency, `reviewRequired`, the independent `review` distribution,
and the decision `policy` and live `epoch`. Errors log `route: "ERROR"` and
`timedOut`. No task-tier rows are written; earlier rows are never rewritten.
For decisions with probabilities, a different confidence/margin gate can be
replayed exactly offline. The log records what was routed, not whether the
route was right.

Worker usage is read from OMP's `task:subagent:progress` and
`task:subagent:lifecycle` frames on the session event bus, which fire for sync
and background (`async.enabled`) spawns alike. A settlement is counted once
even when it arrives on several buses; a late measured frame upgrades an
unknown sample once. The host's `aborted` status is shown as cancelled.

Upgrading from v4 is automatic, idempotent and non-destructive: the original
file is first copied to `telemetry-history/v<version>-<sha256>.json` (exclusive
create, never overwritten), then the v5 file replaces it atomically. A failed
backup or write leaves the original active and suspends recording. A file
written by a newer plugin version is left untouched and recording is suspended
until `/jev-router reset`. `reset` deletes only plugin-owned files
(`telemetry.json`, `decisions.jsonl`, migration temporaries, `telemetry.v<N>.json`
backups and `telemetry-history/` snapshots) and reports any it could not remove.

Rollback to a tier-routing release: stop all OMP processes, preserve the v5
`telemetry.json` and `decisions.jsonl` as copies in `telemetry-history/`
(`v5-<sha256>.json`, `decisions-<sha256>.jsonl`), restore the desired v4 snapshot
as `telemetry.json`, then start the old package. Do not let an old release read
a v5 file directly. Re-upgrading starts a fresh live epoch; overlapping periods
are never merged.

## Configuration

Stored in OMP's own per-plugin settings map and removed by `omp plugin
uninstall`:

```bash
omp plugin config list omp-jev-router
omp plugin config set omp-jev-router orchestrationMinConfidence 0.7
omp plugin config get omp-jev-router orchestrationRoutingEnabled
```

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for classification, guidance and mandatory review enforcement |
| `jevModel` | `""` | TypeSafe model id; empty = `jev-latest` |
| `orchestrationRoutingEnabled` | `true` | allow automatic ORCHESTRATE; explicit requests still use plugin policy |
| `orchestrationMinConfidence` | `0.60` | confidence gate; below it keep DEFAULT |
| `orchestrationMinMargin` | `0.20` | top1 - top2 gate; below it keep DEFAULT |
| `routingTimeoutMs` | `4000` | hard per-decision budget |
| `maxRoutingInputChars` | `12000` | combined text budget; see privacy section |
| `telemetryEnabled` | `true` | local aggregate counters |
| `debugLogging` | `false` | one metrics-only line per decision |

### Migrating from tier routing

Finish or cancel running workers and start a new session after upgrading; do
not cut over with live workers.

- **Removed:** `task-easy`, `task-hard`, `task-challenge` agents; per-task Jev
  classification; the `taskRoutingEnabled`, `taskMinConfidence`,
  `taskMinMargin`, `easyTaskRole`, `hardTaskRole`, `challengeTaskRole` settings;
  the `gen:agents` build step; the tier probe in `/jev-router test`. Calls
  naming a removed alias are not silently turned into `task`; dispatch `task`
  (or a specialist) instead.
- **Stored retired settings** are ignored and never rewritten by the plugin.
  `/jev-router status` lists any that remain; delete them with
  `omp plugin config delete omp-jev-router <key>`.
- **Model roles** `task_easy`, `task_hard` and `task_challenge` are yours and
  are left untouched; status marks them unused. Worker model choice is now your
  `@task` role. Set it before upgrading if you relied on a tier's model.
- **Task contract:** put goal, scope, fixed/open decisions, inputs, acceptance
  and return format in the `task` text (see [Task body contract](#task-body-contract)).
  The plugin does not introduce or classify a `solutionSpace` field.
- **Notice:** coordination guidance is the plugin's `jev-orchestrate-notice`;
  OMP's native orchestrate notice is replaced for the current turn only.
- **Reviews:** old receipts are not reused; resumed sessions review again.
- **Telemetry:** v4 counters become the `historical` block; the live epoch
  starts empty. See [Telemetry](#telemetry) for rollback.

Earlier releases' `mainModelRoutingEnabled`, `mainNormalRole`, `mainDeepRole`,
`normalTaskRole`, `deepTaskRole` and `task-deep`/`task-normal` agents are also
unused. Uninstall leaves role assignments and credentials intact.

## Troubleshooting

Turn on `debugLogging` and read the OMP log:

```text
jev.orchestration route=ORCHESTRATE confidence=0.91 margin=0.82 latency=300ms
jev.orchestration route=SKIP reason=not-main-session
```

| symptom | cause |
| --- | --- |
| `route=SKIP reason=credential-missing` | no TypeSafe key; run `/jev-router setup` |
| `route=SKIP reason=not-main-session` | expected — a subagent hit the front door and was rejected |
| `route=SKIP reason=explicit-orchestrate` | a native orchestrate notice is present; it is replaced by the plugin's notice, not duplicated |
| `route=SKIP reason=plan-mode` | plan mode owns the turn |
| gate reason `orchestration-routing-disabled` / `task-tool-unavailable` | automatic ORCHESTRATE suppressed; review assessment still runs |
| `@task role unresolved` in status | assign `modelRoles.task`; OMP reports the spawn error and nothing is substituted |
| task call blocked for a missing `name` | async mode needs a unique `name` per implementation item to bind its permit |
| `Retired settings still stored` in status | delete the listed keys; they have no effect |

## Uninstall

```bash
omp plugin uninstall omp-jev-router
```

Removes the package, the checkpoint tool, the bundled auditor and the plugin's
guidance and gates; OMP's native `task` behavior and orchestrate notice return
unchanged. OMP model-role assignments (including `verification-auditor`,
`orche-advisor`, and any leftover `task_easy`/`task_hard`/`task_challenge`)
remain until removed explicitly. The `typesafe` credential and
`<omp agent dir>/jev-router/` telemetry files also remain; use
`/jev-router reset` before uninstalling if those should be cleared.

## Development / test

```bash
bun install
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

`bun test` covers the gate arithmetic, input clipping, front-door guards and
fallbacks, policy notice precedence, task-contract normalization against OMP's
real task schema, review gating and permits, credential priority, secret
redaction, telemetry migration/reset, and status rendering.

Native smoke runs on OMP 18.3.1 (the pinned dependency) and 18.3.4 exercised
task-body delivery to a real `task`/`@task` worker, reviewed asynchronous
dispatch, native queued-job cancellation and same-name retry, workflow notice
precedence, and master-disable restoration. Workers produced and read back
the expected files; the main agent did not substitute for them. The detailed
acceptance matrix is in `docs/plans/self-orchestration.md`.

These runs do not certify every provider/settings combination or a cost
improvement over tier routing. They did not uninstall the user's global plugin
or reset the user's telemetry. New host versions still need their own smoke.

### Known API constraints

Recorded rather than worked around:

- **`@oh-my-pi/pi-tui` subpaths do not resolve at runtime from an extension**
  (only the package root does, and it does not re-export `containsOrchestrate`).
  Initial classification happens at `before_agent_start`; `context` handles
  native notices. Thinking-level types are imported only as erased types.
- **`BeforeSubagentSpawnEvent` carries no parent tool call or task text**, only
  the agent, invocation kind, model patterns and a `spawnKey`, so spawn permits
  are matched by the identity OMP derives from the approved call; ambiguous
  identities are refused.
- **`ExtensionUIDialogOptions` has no masked-input mode**, so `/jev-router setup`
  routes you to OMP's native `/login typesafe` for masked entry and labels its
  own paste dialog as unmasked.
- **Cost per completed task is not acceptance rate**: `completed` is the
  worker's own settlement.
- **Spawns that settle after the process exits** are not in `stats`: usage is
  read from in-process subagent frames.
