# om-orche

A coordination layer for [OMP](https://omp.sh). One bounded decision call per
request, made by TypeSafe's [Jev](https://typesafe.ai) System One model, chooses
DEFAULT or ORCHESTRATE. The primary model stays fixed. The plugin supplies its
own execution guidance while every worker runs through OMP's native `task` tool
unchanged. There is no plugin review gate or execution-approval state.

Compatibility target: **OMP 18.4.1**. The host peer dependency and the OMP
development/model-SDK packages are pinned to 18.4.1.

Advisor requests require a credential authorized by OMP's model registry.
If the registry returns no credential (including for a disabled provider), the
request fails before contacting the model; the SDK cannot fall back to an
environment key. The host's explicit no-auth sentinel remains supported for
keyless providers.

Generic workers are OMP's native `task` agent; their model comes from your
`@task` role. The plugin does not classify, rewrite, alias or re-route task
calls, and specialized (`scout`, `reviewer`, `sonic`, …) and custom agents keep
their identity and tool permissions. This package also provides an explicit
`orche_advisor` plan-advice tool and a passive Verification Auditor.
Advice is requested explicitly on an established plan, not on every turn.

> **Breaking change (single-task cutover).** The `task-easy`, `task-hard` and
> `task-challenge` aliases, per-task Jev tier classification and their settings
> are gone; see [Migrating from tier routing](#migrating-from-tier-routing).

> **Breaking change (advice-only cutover).** Mandatory review, dispatch staging,
> receipts, spawn permits and review waiver/retry commands are removed.
> See [Migrating from review gates](#migrating-from-review-gates).

---

## What it does

```text
USER → Jev (bounded dialogue + committed plan)
  DEFAULT     → plugin DEFAULT guidance: work directly, delegate only when useful
  ORCHESTRATE → plugin ORCHESTRATE guidance: coordinated delegation
  uncertain   → DEFAULT; primary model never changes

Successful todo init/append → reconsider changed plan → optionally promote to ORCHESTRATE
Established plan → optional explicit orche_advisor advice → coordinator decides

Primary → native `task` call (task text carries the work contract)
  → OMP preflight / spawn / async / cancel → worker result → primary verifies acceptance
```

## Architecture

### Orchestration (`before_agent_start` + `tool_result` + `context`)

Initial classification runs at `before_agent_start`, before the input is
persisted. Policy-preparation retries reuse the decision only while the last
committed user entry is unchanged. A new user input is classified again even
when its text matches the previous request. Jev sees the current request,
recent visible user/assistant messages, the earliest user goal still on the
active branch, and the latest committed todo plan. It never receives hidden
thinking or raw tool-result bodies.

- **DEFAULT** injects the plugin's light DEFAULT guidance (when `task` is
  enabled): work directly, delegate one unit only when a separate context helps.
  Review does not block direct work or delegation.
- **ORCHESTRATE** injects the plugin's own coordinated-delegation guidance as a
  hidden, user-attributed `jev-orchestrate-notice`. OMP's native orchestrate
  prompt is not reused as execution policy.
- Jev asks only about the execution route. It does not classify review risk or
  link requests to approval scopes. Missing credentials, uncertain answers and
  classification failures do not create a review requirement.

A successful `todo init` or `todo append` reconsiders a changed committed plan.
An already-orchestrated turn keeps its route without another routing call.
Task and phase completion do not request advice. Failed writes, views,
identical plans and late prior-turn results do not trigger spurious promotions.
Agent-attributed steering does not start a new turn, move policy notices, or
hide the current turn's todo results. Promoted guidance remains behind its
originating tool-result group while that group is retained, including after
agent steering. User-attributed steering refreshes the turn through
`before_agent_start`, even for repeated text; results from the previous turn
remain ineligible.

Initial notices stay before the current user message. A todo-triggered notice is
anchored after that result's contiguous tool-result group, preserving the earlier prefix.
After the result has appeared in provider context, compaction may remove it; the
same notice is then restored before the retained current user message, or at the
end of context if that message was also compacted away. Until the result first
appears, the notice still waits for it.
The advisor hook adds optional plan-advice guidance on the same provider request.
No tool-call or worker-spawn hook requests review or blocks unreviewed execution.

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
suppresses automatic ORCHESTRATE; an explicit native `orchestrate` request is
still handled by the plugin's policy. OMP's magic-keyword settings only decide
whether an explicit native notice appears; they never gate automatic routing.
With `task` disabled, no delegation is advertised. There is no primary model
switch or end-of-turn model restoration path.

### Parallel execution policy

ORCHESTRATE first identifies worthwhile independent implementation units and
establishes the shared contracts needed to run them. When at least two units
are ready, it instructs the primary to launch them together in one `tasks[]`
batch when supported, or dispatch without waiting between independent workers.
Host concurrency limits, ownership boundaries and runtime-resource constraints
still apply. Sequential work must have an actual prerequisite or conflict,
identified in the plan; there is no worker quota or artificial task splitting.

The coordinator concentrates on shared contracts, minimal prerequisite changes,
integration and final verification. Once contracts are stable, independent
consumers belong to workers rather than leaving most implementation on the
coordinator. While workers run, the coordinator advances non-overlapping work;
newly ready units do not wait for unrelated workers or a whole phase to finish.
A shared final test environment does not serialize unrelated implementation.

DEFAULT retains its direct-work-first policy. Routing thresholds are unchanged,
and native workflow mode still controls its own dispatch. These are instructions
to the primary model, not an automatic scheduler or a guarantee of parallelism.

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
OMP validates and executes the native task input. The plugin neither stages nor
hashes task calls for approval.

When the host task schema exposes `effort` (`task.enableEffort=true`), the
guidance states first, before the section list, that each task item requires an
explicit value: `lo` for fixed mechanical work, `med` for bounded implementation
choices, and `hi` for substantial open design or correctness questions.
Selection follows the solution space, not
file count or task length, and preserves explicit user choices. If the host
does not expose the field, it must be omitted. The plugin does not rewrite task
arguments or change model roles; OMP maps the hint to supported thinking levels.

Execution guidance also covers recovery and final acceptance:

- Workers pause affected changes and promptly report evidence, touched files and
  partial work when ownership conflicts, invalid prerequisites or defects in
  fixed decisions appear. They do not silently redesign or expand their scope.
- With `task` enabled, the coordinator holds new overlapping work and checks
  host-visible writer status. Stop requests use only controls the host exposes;
  edits are reconciled or overlapping work assigned only after writers are
  confirmed stopped. Otherwise the overlap stays blocked; user and unrelated
  changes are preserved.
- An upstream contract change requires checking pending, running and completed
  consumers: hold new affected work and check active writers as above. Update
  the plan and worker instructions, verify the revised prerequisite, and
  revalidate affected completed results against it before accepting them.
  Resume affected work only when prerequisites and writer status permit it;
  unrelated work continues.
- Partial failure preserves independently verified results. Only affected work
  is retried or reassigned, after its cause or inputs change and the previous
  writer has stopped; failed units, dependencies and exact blockers stay explicit.
- Completion requires reconciling every requested outcome with the integrated
  result and relevant end-to-end or boundary checks. Partial success and unresolved
  blockers must not be presented as overall completion.
- Runtime claims need text-auditable evidence: an input tool's bare `Success`
  does not show its effect and screenshots reach reviewers only as placeholders,
  so each claim is backed by state, values or logs read after the action, or is
  reported as visual observation only.
- Workers run static checks and their own tests scoped to owned files; task text
  should not forbid them wholesale. The coordinator owns shared runtimes (one
  app/editor/game session, a shared server, global checks). Acceptance names the
  environment failures a change must survive, e.g. unavailable storage must not
  block unrelated core flows.

These are model instructions, not automatic cancellation, scheduling or approval
mechanisms. Workflow mode retains the native workflow's execution-method and
fan-out authority; the supplement adds task-contract, recovery and acceptance
guidance, not dispatch.

### Plan advice and Verification Auditor

`orche_advisor` gives advice on an already-established plan, not source-code
approval. It is primary-only and uses `modelRoles.orche-advisor` without falling
back to the primary model. It accepts a `checkpoint` and the seven snapshot
fields shown in `examples/initial-plan.json`; there is no `dispatch` argument.

- Advice is optional in DEFAULT, ORCHESTRATE and workflow execution. Lifecycle
  hooks do not invoke the model. Do not request advice merely because a new
  turn, phase completion, worker result or auditor note arrived.
- Submit a formed plan when an independent assessment can help. Avoid repeating
  a request for an unchanged plan; each explicit call is a fresh model request.
- `KEEP`, `ADJUST`, `REPLAN` and `ESCALATE` are recommendations. None grants or
  withholds permission. The coordinator evaluates the advice, executes through
  OMP, and remains responsible for tests and acceptance.
- For material suggestions, the coordinator briefly records acceptance, partial
  acceptance or rejection with a reason. Accepted changes are applied to the
  committed plan/todo and affected worker instructions before the changed work
  executes. The coordinator then continues without reapproval; the advisor
  itself never mutates the plan.
- Another opinion on a materially changed plan or new evidence is optional,
  not an automatic replan/review loop. Do not repeat requests to obtain KEEP.
- A finding that contradicts claimed completion must still be identified and
  evaluated. The advisor recommends correction or verification, rather than
  ordering a tool halt. Neither revising the plan nor receiving advice resolves
  a finding or turns an unsupported completion claim into evidence.
- A missing reviewer configuration, provider failure, cancellation or invalid
  output is a real advice-tool error, not an execution prohibition. Provider
  errors retain one bounded retry; truncated output retries without reasoning.
  At most two completion attempts are made, and cancellation is not retried.
- Review scope, receipts, dispatch staging, single-use worker permits, mandatory
  phase reviews and `/review-status`, `/review-retry`, `/review-waive` are gone.
  This also removes the DEFAULT multi-worker fan-out gate and eval/workpool
  approval fingerprinting, not merely the inline edit denial.
- OMP still owns input validation, agent/tool permissions, concurrency,
  cancellation and supported isolation. Those protections do not bind a
  dispatch to advice or prevent divergence from a previously discussed plan.
- Old approval, failure or waiver records and historical gate-denial messages
  are not current authorization requirements. Audit notes are evidence claims,
  not authority to resurrect the removed gate.


### Durable finding ledger

`review_findings` exposes `list`, `resolve`, `waive`, and `reopen`. Each finding
has a stable ID, original advisor entry, receipt timestamp, current status, and
the actual user message in scope when received. OMP does not persist the
auditor's observation boundary in the delivered note, so receipt time must not
be treated as observation time. Only the owned auditor's concern and blocker
notes are admitted; repeated equivalent notes in the same scope merge.
Neither age nor a successful review resolves or deletes a finding.

- `resolve` needs a relevance explanation and IDs of successful tool results or
  actual user messages on this branch. Evidence may precede a delayed notice;
  an already-recorded upload result or user correction need not be repeated just
  to obtain a timestamp after delivery. `list` includes these earlier candidates.
  The coordinator must still check that the evidence answers the specific claim
  and covers the relevant revision: the tool requires a non-empty reason but
  does not validate its semantic relevance. Assistant claims, failed results,
  review verdicts and ledger listings cannot serve as resolution evidence.
- Resolutions are explicitly **orchestrator-reported**, not proof. The original
  note and bounded evidence excerpts stay visible to the reviewer.
- `waive` requires explicit user confirmation. An explicit `reopen` records a
  renewed concern and requires evidence after that reopening for the next
  resolution; repeated notes do not reset this boundary. A renewed auditor
  objection after a reported resolution opens a new finding.
- Findings and lifecycle changes update the evidence available to the next
  explicit advice request. They never block tools, invalidate permission or
  automatically call the advisor. A finding waiver only records accepted risk;
  it is not an execution waiver.

New lifecycle reports use record version 2. Existing version 1 reports retain
their original post-receipt/post-reopening evidence rules during replay; an old
invalid report does not become valid just by upgrading. No transcript entries
are rewritten. Using earlier evidence for an existing finding requires a new,
explicit resolution report under the current rules.

The reviewer receives up to five unresolved findings in detail, reserving space
for the two newest, plus up to three recent resolutions/waivers with evidence.
Older or excess findings remain in the ledger and are represented by omission
counts and bounded ID lists, not silently treated as resolved. Use `list` with
`findingId` to inspect any omitted item. An auditor's account of a user
instruction is not itself a direct user instruction; scope and evidence must be
weighed before superseding restrictions.

The bundled auditor is instructed to stay silent on confirmations, praise,
progress commentary and checks that already passed, and never to emit `nit`
notes. It reports concrete remaining contradictions or evidenced
irreversible-operation risks, not unfinished tasks that have not been called
complete. Updates OMP marks `[in progress — more steps follow]` get no note
except an irreversible-operation risk; claims are judged on the turn's final
state, because OMP holds mid-turn non-blockers and releases them together at the
turn boundary. It never directs the primary's pace or method ("stop", "wrap
up", "answer now"). A `blocker` must quote the completion claim it contradicts.
Screenshots reach the auditor only as placeholders, so a placeholder is not
counter-evidence; a screenshot-only claim should be labeled as visual
observation or backed by extracted state. The bundled entry also sets
`maxNotesPerUpdate: 1` (blockers are exempt in OMP). It must identify the
snapshot or result it actually checked; a growing transcript's last observed
entry is not proof that the session ended. Findings are never automatically
marked resolved. The reviewer likewise assesses evidence against the claim and
revision, not against the note's delivery time.

Instructions alone did not hold on a small watchdog model (one session: 105
`nit` notes and 17 "stop and answer now" blockers), and OMP offers plugins no hook
on the advisor's `advise` call. The plugin therefore enforces the note contract
mechanically on the bundled auditor's notes, in the primary's provider context
and in the findings ledger:

- `nit` notes are withheld.
- A concern or blocker with no quotation (`"…"`, `“…”`, `‘…’`, `「…」`), no
  backticked output/identifier and no `path.ext:line` is withheld as uncited.
- A blocker without a quotation is treated as a concern.

Other advisors' notes and the persisted transcript are untouched; the TUI still
shows every card OMP delivered, and OMP's own delivery (steering, deferred
flushes, idle wake-ups) is unchanged. A card left empty is dropped, except when
it woke an idle primary after its answer: then a one-line withheld notice keeps
the request well formed. Replayed on two recorded sessions, the primary would
have read 12 of 121 and 42 of 160 cards. The rules are string checks, not a
semantic judgment: a process directive that happens to cite a backticked value
still arrives, as a concern, and a well-founded concern with no citation is
withheld.

`review_findings` with an unknown `findingId` fails with the current ids
(unresolved first, bounded) so a guessed id is corrected in one step.

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

### Native `task` worker

The plugin installs no `tool_call` or `before_subagent_spawn` enforcement hook.
It never revises task input or changes `agent`, so a restricted session whose
spawn-policy default is `sonic` keeps that default. Explicit specialists,
custom agents and tagged model pseudonyms run as requested. OMP owns task
execution, spawn policy, concurrency, async results, cancellation, tool
permissions, isolation and workpool. There is no automatic model escalation.

Task execution needs no Jev call or credential. Only the front-door decision
uses Jev; failure leaves normal direct execution available.

## Recommended model topology

```yaml
modelRoles:
  default: <choom-orchesion primary>         # never changed by this plugin
  task: <capable worker>                    # OMP's generic task worker
  smol: <lightweight model>                 # OMP's lightweight baseline (sonic)
  advisor: <general advisor model>          # only if declared in WATCHDOG.yml
  verification-auditor: "@smol"            # distinct from ADVISOR
  orche-advisor: <checkpoint reviewer>      # explicitly configured
```

No vendor/model name is hard-coded. `verification-auditor` is registered as
`@smol` on primary-om-orche startup if unset; existing assignments are preserved
and child sessions never register roles. `@task` is never written: if it does
not resolve, `/om-oche status` says so and OMP reports its own spawn error;
no other role (such as `@slow`) is substituted.

Keeping one primary model avoids router-induced full-context provider switches;
it does not guarantee proom-orcheache hits or prevent OMP/user fallback.

## Install

```bash
omp plugin install om-oche
```

From a checkout:

```bash
omp plugin link /path/to/om-oche
```

Nothing else is required. No `AGENTS.md` edit, no agent files, no `models.yml`
surgery, no routing prompt,om-orchearate SDK install, no OMP patch. The TypeSafe
SDK ships as a plugin dependency; the package ships no agent definitions.

#om-orche-run credential setup

Priority order:

1. `TYPESAFE_API_KEY` in the environment — used directly and **never** copied to
   disk.
2. OMP's own credential store for the `typesafe` provider — the same store
   `/login typesafe` writes.
3. Interactive setup via `/om-oche setup`.

```bash
/om-oche setup
```

`setup` offers OMP's native `/login typesafe` first, because that dialog masks
input; the extension dialog API has no masked mode (`ExtensionUIDialogOptions`
exposes no `secret` flag), so the in-plugin paste path says so explicitly. A
pastom-orcheis validated against `GET /v1/models` before anything is stored, and
an iom-orchekey is never stored.
om-orche
The om-orcheowns no credential file. Reusing `AuthStorage` means rotation,
`ompom-orchetypesafe`, and 401 handling all keep working, and uninstalling the
plugin leaves your account credential exactly where you put it.

## Commands

om-orchend | Effect |
| --- | --- |
| `/om-oche setup` | Configure or remove the TypeSafe credential. |
| `/om-oche status` | Fixed-primary policy, native `task` worker and `@task` role, last decision, retired leftovers. |
| `/om-oche test` | Live DEFAULT/ORCHESTRATE probes (front door only; no task classification exists). |
| `/om-oche stats` | Live-epoch decisions and observed task-worker usage, kept apart from pre-v5 history. |
| `/om-oche reset` | Clear plugin-owned telemetry files and stored configuration. |

`status` output:

```text
om-oche                enabled
Credential             configured (OMP credential store)

Orchestration routing  enabled
Primary model          unchanged — no model switching
Model                  jev-latest (default)
Gate                   confidence ≥ 0.6, margin ≥ 0.2
Coordination guidance  plugin-owned (jev-orchestrate-notice)

Task worker            native `task` agent
  @task role           provider/coding

Last orchestration     DEFAULT 0.91
```

If `@task` does not resolve, status says so; the plugin does not route around
it. Retired tier settings still stored for the plugin, and leftover
`@task_easy`/`@task_hard`/`@task_challenge` roles, are listed as unused and
left in place.

No secret is ever printed: the credential is reported by provenance only.
om-orche
## Routing thresholds

A decision is accepted only when **both** hold, with `confidence =
max(probabilities)` and `margin = p(top1) - p(top2)`:

| | confidence | margin |
| --- | --- | --- |
| orchestration (2 labels) | `≥ 0.60` | `≥ 0.20` |

These gates are configurable, not measured guarantees of classifier accuracy.
Use `/om-oche test` for live probes; only records with stored probabilities
can be replayed offline. Historical aggregate counters cannot reconstruct
unlogged decisions.

## DEFAULT / ORCHESTRATE

- **DEFAULT** — answering a question, one focused feature/change/fix, a
  single-thread review or investigation, or work that is strictly sequential in
  the same files or one shared component.
- **ORCHESTRATE** — multi-part implementation whose deliverables or plan items
  touch different files, screens, subsystems or layers and can proceed in
  parallel once shared contracts are fixed, or several independent
  investigations useful on their own.

The classifier evaluates the whole work implied by the conversation and plan,
not just the latest terse follow-up. ORCHESTRATE only adds coordinated-delegation
guidance, which itself keeps small or sequential parts direct, so a plan with
several items across layers is routed there. Neither branch selects a different
primary model.

The criteria were rebalanced after a replay of real routing points: the earlier
wording gave `P(ORCHESTRATE) ≤ 0.18` even to plans the primary then fanned out to
parallel workers, and no live decision had ever routed ORCHESTRATE. On the same
20 labeled points the current wording routes 19 as labeled (the miss is a
request whose todo plan is then promoted), and it routed 1 of 43 prompts from
other projects to ORCHESTRATE.

## Failure behavior

| failure | front door |
| --- | --- |
| credential missing | current model; no automatic orchestration; no execution block |
| 401 / 403 | current model; no automatic orchestration; no execution block |
| 429 / 5xx | current model; no automatic orchestration; no execution block |
| timeout | current model; no automatic orchestration; no execution block |
| network failure | current model; no automatic orchestration; no execution block |
| malformed response | current model; no automatic orchestration; no execution block |
| SDK exception | current model; no automatic orchestration; no execution block |
| unknown Jev model | current model; no automatic orchestration; no execution block |
| gate not cleared | DEFAULT; current model |

Front-door failure never changes the model or requires advisor permission.
Task workers never depend on Jev.

Every decision runs under a hard `routingTimeoutMs` budget with retries
disabled: a router that retries costs more than the routing saves.

## Privacy and security

Sent to Jev: the current request, up to eight recent visible dialogue messages
plus the earliest retained user goal, and the latest committed todo plan.
Review results and historical approval/work-scope records are not classifier input.
Dialogue entries are clipped to 700 characters (the retained goal to 1600);
plan text is clipped to 3200. The engine applies a combined
`maxRoutingInputChars` text budget, default 12000, excluding JSON framing and
fixed classifier instructions. Task bodies are never sent to Jev.

The router does not read source files or send raw tool results, images, hidden
thinking, or complete transcripts. Visible dialogue/plan text can itself contain
user-provided sensitive material; expanded context is sent to TypeSafe.
It is not copied to telemetry. No scout/summarizer agent is launched for routing.

The plan advisor receives the submitted seven-field snapshot plus bounded
findings and explicitly cited finding-resoluom-orcheidence. It never receives
the whole transcript or execution-approval metadata. Inspect evidence IDs
before citing outputs containing sensitive data.

Credentials never touch the repository, the project directory, the plugin source
tree, or any log. Debug lines carry route labels and numbers only; error text is
scrubbed of any tracked credential and of key-shaped tokens before it is written.

## Telemetry

Local data only — no prompt text, no task text, no source, no transcript — under
`<omp agent dir>/jev-router/`, cleared by `/om-oche reset`. With
`telemetryEnabled=false` nothing is written (existing data is shown read-only).
The data directory deliberately keeps its existing name so the package rename
does not discard or silently relocate telemetry history.

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
`confident`, latency, and the decision `policy` and live `epoch`. Errors log
`route: "ERROR"` and `timedOut`. No review-risk or task-tier fields are written;
earlier rows are never rewritten.
For decisions with probabilities, a different confidence/margin gate can be
replayed exactly offline. The log records what was routed, not whether the
route was right.

Worker uom-orche read from OMP's `task:subagent:progress` and
`task:subagent:lifecycle` frames on the session event bus, which fire for sync
and background (`async.enabled`) spawns alike. A settlement is counted once
even when it arrives on several buses; a late measured frame upgrades an
unknown sample once. The host's `aborted` status is shown as cancelled.

Upgrading from v4 is automatic, idempotent and non-destructive: the original
file is first copied to `telemetry-history/v<version>-<sha256>.json` (exclusive
create, never overwritten), then the v5 file replaces it atomically. A failed
backup or write leaves the original active and suspends recording. A file
written by a newer plugin version is left untouched and recording is suspended
until `/om-oche reset`. `reset` deletes only plugin-owned files
(`telemetry.json`, `decisions.jsonl`, migration temporaries, `telemetry.v<N>.json`
backups and `telemetry-history/` snapshots) and reports any it could not remove.

Rollback to a tier-routing release: stop all OMP processes, preserve the v5
`telemetry.json` and `decisions.jsonl` as copies in `telemetry-history/`
(`v5-<sha256>.json`, `dom-orches-<sha256>.jsonl`), restore the desired v4 snapshot
as `telemetry.json`, tom-orchert the old package. Do not let an old release read
a v5 file directly. Reom-orcheing starts a fresh live epoch; overlapping periods
are never merged.

## Configuration

Stored in OMP's own per-plugin settings map and removed by `omp plugin
uninstall`:

```bash
omp plugin config list om-oche
omp plugin config set om-oche orchestrationMinConfidence 0.7
omp plugin config get om-oche orchestrationRoutingEnabled
```

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for classification and automatic guidance; manual advice/finding tools remain available |
| `jevModel` | `""` | TypeSafe model id; empty = `jev-latest` |
|om-orchestrationRoutingEnabled` | `true` | allow automatic ORCHESTRATE; explicit requests still use plugin policy |
| `orchestrationMinConfidence` | `0.60` | confidence gate; below it keep DEFAULT |
| `orchestrationMinMargin` | `0.20` | top1 - top2 gate; below it keep DEFAULT |
| `routingTimeoutMs` | `4000` | hard per-decision budget |
| `maxRoutingInputChars` | `12000` | combined text budget; see privacy section |
| `telemetryEnabled` | `true` | local aggregate counters |om-orche
| `debugLogging` | `false` | one metrics-onom-orche per decision |

### Migrating the plugin name

The package, settings namespace, display label and slash command are now
`om-oche`. There is no old-name command or settings fallback. The advisor tool
`orche_advisor`, its `orche-advisor` model role and standalone CLI are unchanged.

Before removing an old installation, record its desired settings with
`omp plugin config list omp-jev-router`. Finish active work, remove the old
`omp-jev-router` installation/link, then install or link `om-oche` and reapply
those settings with `omp plugin config set om-oche <key> <value>`. Do not load
both installations at once. Start a new session on OMP 18.4.1.

The rename does not modify global configuration, credentials or model roles.
Telemetry retains the existing `<omp agent dir>/jev-router/` directory.


### Migrating from review gates

Finish or cancel active work and start a new session after upgrading so the old
extension's hooks are no longer installed. Do not rely on mutating a running
gate in place.

- Removed: review-risk and work-scope classification, review enforcement and
  approval state, dispatch declaration/withdrawal, worker permits and review
  status/retry/waiver commands. Remove `dispatch` from advisor calls.
- The advisor accepts the existing checkpoint/snapshot input and gives advice.
  All four valid verdicts are successful results (CLI exit 0); actual model or
  output failures use exit 1, configuration/input failures use exit 2.
- Historical approval records and old decision-log fields remain untouched but
  have no execution effect. No migration, user waiver or fresh approval is
  required to continue work. The finding ledger andom-orcheidence history remain.


### Migrating from tier routing
om-orche
Finish or cancel running worom-orched start a new session after upgrading; do
not cut over with live workers.

- **Removed:** `task-easy`, `task-hard`, `task-challenge` agents; per-task Jev
  classification; the `taskRoutingEnabled`, `taskMinConfidence`,
  `taskMinMargin`, `easyTaskRole`, `hardTaskRole`, `challengeTaskRole` settings;
  the `gen:agents` build step; the tier probe in `/om-oche test`. Calls
  naming a removed alias are not silently turned into `task`; dispatch `task`
  (or a specialist) instead.
- **Stored retired settings** are ignored and never rewritten by the plugin.
  `/om-oche status` lists any that remain; delete them with
  `omp plugin config delete om-oche <key>`.
- **Model roles** `task_easy`, `task_hard` and `task_challenge` are yours and
  are left untouched; status marks them unused. Worker model choice is now your
  `@task` role. Set it before upgrading if you relied on a tier's model.
- **Task contract:** put goal, scope, fixed/open decisions, inputs, acceptance
  and return format in the `task` text (see [Task body contract](#task-body-contract)).
  The plugin does not introduce or classify a `solutionSpace` field.
- **Notice:** coordination guidance is the plugin's `jev-orchestrate-notice`;
  OMP's native orchestrate notice is replaced for the current turn only.
- **Advice:** historical approvals have no effect; optional plan advice does not authorize execution.
- **Telemetry:** v4 counters become the `historical` block; the live epoch
  starts empty. See [Telemetry](#telemetry) for rollback.

Earlier releases' `mainModelRoutingEnabled`, `mainNormalRole`, `mainDeepRole`,
`normalTaskRole`, `deepTaskRole` and `task-deep`/`task-normal` agents are also
unused. Uninstall leaves role assignments and credentials intact.

## Troubleshootingom-orche

Turn on `debugLogging` and read the OMP log:

```text
jev.orchestration route=ORCHESTRATE confidence=0.91 margin=0.82 latency=300ms
jev.orchestration route=SKIP reason=not-main-session
```

| symptom | cause |
| --- | --- |
| `route=SKIP reason=om-orcheial-missing` | no TypeSafe key; run `/om-oche setup` |
| `route=SKIP reason=not-main-session` | expected — a subagent hit the front door and was rejected |
| `route=SKIP reason=explicit-orchestrate` | a native orchestrate notice is present; it is replaced by the plugin's notice, not duplicated |
| `route=SKIP reason=plan-mode` | plan mode owns the turn |
| routing reason `orchestration-routing-disabled` / `task-tool-unavailable` | automatic ORCHESTRATE suppressed; no review requirement |
| `@task role unresolved` in status | assign `modelRoles.task`; OMP reports the spawn error and nothing is substituted |
| `Retired settings still stored` in status | delete the listed keys; they have no effect |

## Uninstall
om-orche
```bash
omp plugin uninstall om-oche
```

Removes the package, the plan-advice tool, the bundled auditor and the plugin's
guidance; OMP's native `task` behavior and orchestrate notice return unchanged.
OMP model-role assignments (including `verification-auditor`,
`orche-advisor`, and any leftover `task_easy`/`task_hard`/`task_challenge`)
remain until removed explicitly. The `typesafe` credential and
`<omp agent dir>/jev-router/` telemetry files also remain; use
`/om-oche reset` before uninstalling if those should be cleared.

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

`bun test` covers route confidence thresholds, input clipping, fronom-orche
guards/fallbacks, notice precedence, advice verdicts and real error handling,
absence of plugin executionom-orche (including old persisted approval records),
finding evidence/lifecycle, credential priority, telemetry and status rendering.

The OMP 18.4.1 upgrade passed `bun run build`: 143 tests across 14 files,
with no type errors and two existing `no-control-regex` lint warnings.
The credential-boundary regressions reject absent/empty registry credentials
and exercise an explicit keyless credential through the real SDK.
A separate real-registry smoke confirmed that a disabled provider made zero
requests even with an environment key present; the actual extension loader
registered both tools without errors. No paid model requests were made.

Historical verification: the earlier rename was checked against OMP 18.3.5
with 133 tests across 14 files passing.

During the advice-only cutover, a disposable local OpenAI-compatible server
exercised the actual advice CLI: KEEP, REPLAN and ESCALATE each returned exit 0
with `isError: false`. The subsequent rename/version smoke linked `om-oche`
using the actual OMP 18.3.5 plugin manager, wrote/read its settings under the
new name, and dispatched `/om-oche status` without a model request. Print mode
does not display that command's UI notification.

A separate smoke launched OMP 18.3.5 with the extension, an isolated agent
directory and a deterministic local model provider. Direct and explicit
`orchestrate` requests each ran a native two-worker batch without advisor
approval; the workers wrote four expected files. Native tool approval was
auto-approved only for this isolated smoke. Temporary state was removed.

These runs verify the exercised host/tool paths, not model reasoning quality
or every provider/settings combination. OMP 18.4.1 is the compatibility target;
the 18.3.5 runs above and earlier smoke results in
`docs/plans/self-orchestration.md` are historical, not the current support target.

### Known API constraints

Recorded rather than worked around:

- **`@oh-my-pi/pi-tui` subpaths do not resolve at runtime from an extension**
  (only the package root does, and it does not re-export `containsOrchestrate`).
  Initial classification happens at `before_agent_start`; `context` handles
  native notices. Thinking-level types are imported only as erased types.
- **`ExtensionUIDialogOptions` has no masked-input mode**, so `/om-oche setup`
  routes you to OMP's native `/login typesafe` for masked entry and labels its
  own paste dialog as unmasked.
- **Cost per completed task is not acceptance rate**: `completed` is the
  worker's own settlement.
- **Spawns that settle after the process exits** are not in `stats`: usage is
  read from in-process subagent frames.
