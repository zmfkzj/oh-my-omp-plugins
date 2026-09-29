# om-orche

A coordination layer for [OMP](https://omp.sh). It gives the main session two
execution policies and one rule for choosing between them: **Judgment (판단형)**,
where the main analyzes directly, and **Production (제작형)**, where
implementation is delegated by default to workers run through OMP's native `task`
tool. The main chooses per request and per current stage. The primary model stays
fixed. The policies are guidance added to the model's context; the plugin does
not change models, tools or `task` calls, and it adds no review gate or
execution-approval state. Nothing in the policy path calls an external service or
needs a credential.

Compatibility target: **OMP 18.4.1**. The host peer dependency and the OMP
development/model-SDK packages are pinned to 18.4.1.

Generic workers are OMP's native `task` agent; their model comes from your
`@task` role, and that one generic worker serves both policies. The plugin does
not classify, rewrite, alias or re-route task calls, and specialized (`scout`,
`reviewer`, `sonic`, …) and custom agents keep their identity and tool
permissions. This package also provides an explicit `orche_advisor` plan-advice
tool and a passive Verification Auditor. Advice is requested explicitly on an
established plan, never automatically.

Advisor requests require a credential authorized by OMP's model registry. If
the registry returns no credential (including for a disabled provider), the
request fails before contacting the model; the SDK cannot fall back to an
environment key. The host's explicit no-auth sentinel remains supported for
keyless providers.

> **Breaking change (Judgment/Production policy).** Jev/TypeSafe routing,
> DEFAULT/ORCHESTRATE classification, todo-triggered promotion and their
> settings, commands and credential lookup are gone; see
> [Migrating from Jev routing](#migrating-from-jev-routing).

> **Earlier breaking changes.** The single-task cutover (`task-easy`,
> `task-hard`, `task-challenge`) and the advice-only cutover (mandatory review,
> dispatch staging, receipts, spawn permits) are described in
> [Migrating from tier routing](#migrating-from-tier-routing) and
> [Migrating from review gates](#migrating-from-review-gates).

---

## What it does

```text
Every governed main-session turn → exactly ONE provider-context-only policy notice

  current turn has a native workflow-notice     → workflow    (supplement only)
  else a native orchestrate-notice              → orchestrate (replaces it in place)
  else the `task` tool is enabled               → default     (Judgment + Production + how to choose)
  else                                          → no notice

The main reads the notice, then chooses for the current stage:
  Judgment   — the main analyzes directly; workers only for bounded, independent investigations
  Production — implementation goes to workers by default; the main integrates and accepts
```

There is no classifier, keyword matcher, model call, router, subagent call, mode
tool, slash command or stored state for choosing. The main decides from the
request, the actual code and tool results, and progress so far.

## Execution policies

The `default` notice is about 7.9K characters with the full tool set (about 7.4K
without `write`); the workflow supplement is about 2.9K. It reads in this order:
the header and precedence line, the rule for choosing, Judgment, Production,
switching, reuse, the task-item contract with the `effort` line, worker-local
checks, verification. Shared guidance is written once; the notice does not hold
two complete execution prompts. It is guidance for the model, not a scheduler or
permission system, and it renders only instructions backed by tools that are
enabled on the turn.

| | Judgment (판단형) | Production (제작형) |
| --- | --- | --- |
| Delivers | an explanation, analysis, judgment, proposal or design | a real change to code, files, features, assets or state |
| Who works | the main: frames the question, reads the key code, logs and docs, forms hypotheses, gathers evidence, runs key experiments, tests counterexamples, decides | workers own investigation, local design, implementation, local checks, failure analysis and re-fixes within their scope; the main owns goal, scope, shared decisions, integration and acceptance |
| Workers | zero is normal; bounded, independent investigations only | one worker end to end for cohesive or sequential work; several only for independent units |
| Changes the product? | never: analysis-only is not permission to change code, config or assets | yes, through workers |

In both policies the main owns the user's intent, scope, global decisions and the
final answer and verdict.

### Choosing a policy

The type is the **current stage's policy**, not a label on the whole request. The
main chooses from the request and from what it learns while working:

1. Ask what the user must receive for the request to be done.
2. Explanation, analysis, judgment, proposal or design alone → Judgment.
3. A real change to code, files, features, assets or state → Production.
4. Both → start in Judgment and switch to Production once cause, scope and
   contract are settled enough to implement. A **mixed request is a Judgment →
   Production transition, not a third mode.** If the user already asked for both,
   the main switches without asking for approval again.
5. Analysis or proposal only → the main does not move into Production just because
   the fix has become clear. If permission to change the product is unclear, it
   gives the result and the decision needed.
6. During Production, if a key premise or contract breaks, the main returns to
   Judgment only for the affected part, re-decides, then resumes Production;
   unaffected work stands.
7. Boundaries: saving findings as a Markdown file, or writing a throwaway
   repro/experiment script, does not make a stage Production. A change confined to
   one file, or strictly sequential work, does not make a stage Judgment: the main
   must not implement it itself for that reason.

Switching policy happens in the same main session with the user's model: no model
change and no new session. Only the changed goal or contract and the affected work
are updated, and affected workers are told the changed premises and the
re-verification scope. (Checks on a contract change are under
[Verification](#verification).)

### Judgment (판단형)

- The main is the responsible analyst, not a relay: it frames the question and
  criteria, reads the key code, logs and docs itself, forms hypotheses, gathers
  evidence, runs key experiments, tests counterexamples and decides.
- Workers are for bounded, independent investigations (a code path or subsystem,
  reproducing or refuting one hypothesis, change impact and consumers, one
  invariant, a bounded feasibility check of an alternative). They analyze within
  their question; the main owns the overall judgment.
- Zero workers is normal for small or well-evidenced questions: no worker, todo
  list, task contract or advice call is required. One worker for one cohesive
  extra investigation; several only for independently worthwhile scopes; no
  mandatory analyst/critic/judge roles. The main does not redo a worker's
  investigation wholesale but verifies itself the key evidence its conclusion
  rests on.
- The main never fixes the conclusion first and then sends workers for support,
  and never passes an unverified hypothesis as fact in a task item.
- Results are reported as fits the task: confirmed facts with evidence;
  inferences and hypotheses; important counterexamples and possibilities not yet
  excluded; the conclusion and its scope; what still needs verification.
  Simulation or impact results are labeled thought experiment, static analysis or
  actually executed, and nothing unexecuted is called verified.
- **Judgment is not permission to change the product.** Under an analysis-only
  request no product code, config or assets change; reproductions and experiments
  stay non-destructive and isolated within existing permissions.

**Judgment is not OMP plan mode.** The plugin never toggles plan mode and the
model cannot enter it (only the user's `/plan` does). In plan mode the plugin adds
no notice; plan mode and read-only limits come first.

### Production (제작형)

- The main owns goal, scope, non-goals, constraints and acceptance; global
  decisions and shared interfaces; ownership and dependencies; conflict
  resolution and contract changes; integration and final acceptance.
- Workers own, within their scope: needed investigation, local design,
  implementation, conflict-free local checks, failure analysis and re-fixes, and
  results with evidence. The main does not work out the whole implementation and
  have a worker type it in.
- The main may read code, check diffs, run verification and talk to workers; it
  never duplicates a worker's implementation or overwrites in-progress changes.
- A blocked worker is not a takeover signal; see [Verification](#verification)
  for how the main classifies and routes it.

#### Whether to delegate, and whether to parallelize

These are two separate decisions.

- **Delegation.** Cohesive or strongly sequential work goes to **one worker end
  to end**; "it can't be parallelized" never moves it to the main. A single worker
  is a normal path, not a fallback.
- **Parallelism.** Only for units that are independent under verified
  prerequisites, not by file count or volume; no artificial splitting. Ready
  independent units start together (one host batch or async dispatch); order only
  for a real dependency, ownership or resource conflict.

#### The main's direct edits: a narrow exception

The main edits source directly only for a small integration finish when **all
five** hold:

1. the cause and the fix are settled;
2. no new investigation, design or substantial debugging is needed;
3. contract and scope are unchanged;
4. there is no conflict with another writer's ownership or in-progress writes;
5. the edit is clearly smaller than delegating it.

Otherwise the owning worker continues; a run of exceptions must not make the main
the implementer.

#### Game assets are Production, not a separate organization

Assets (game art, conversion, packing, engine integration) follow Production plus
whatever generation tools are available. The notice asks the main to:

- settle style, spec, use and in-game conditions first;
- make a few representative samples and check them against those criteria (asking
  the user only if they requested an approval step or a direction choice is
  open), then produce the rest, variants and packing;
- confirm in-game rendering and usability.

A reasoning model is not an image, 3D or audio generator: the notice says never to
assume a worker has generation tools, and to state what code can produce and what
it cannot. Acceptance names size, format, transparency, pivot, frames, packing,
visual consistency and in-game use. A created file or a text report is not visual
verification; image observation, format checks and engine runs are reported
separately.

### Reusing a worker for follow-ups

Follow-ups of the same work (further investigation, a verification failure, a fix
request, an extra boundary case) go preferably to the worker that did it. This
guidance is rendered only when `write` is enabled, because in OMP 18.4.1
`write agent://<id>` is the only way to continue a worker; the `task` tool cannot
resume one. Without `write`, the notice says no follow-up channel exists this
turn and directs follow-ups to a new worker with the contract, the changes and
artifact references.

The notice tells the main to continue a worker with `write agent://<id>` unless
its task result says it "ran isolated … cannot be resumed" or "was aborted".
What the host may report:

| host report | meaning |
| --- | --- |
| "`<id>` is now idle — message it via `write agent://<id>` to follow up" | resumable; informative only. It appears only in the first result delivered asynchronously, and is absent with `async.enabled=false` and after follow-up turns |
| "was stopped but is still resumable" | resumable |
| "ran isolated and cannot be resumed or messaged" | not reusable |
| "was aborted" | hard abort, not messageable |

A missing hint does not mean the worker cannot be continued. Before reusing, the
main checks the worker's context and ownership fit and that there is no
conflicting run state or writes, and states the changed premises. A running
worker is steered immediately; an idle or parked one wakes with its full prior
context, and its new result returns as a task result (host behavior).
The main uses a **new worker** when
delivery fails, the environment is gone, or the topic or premises changed
materially, giving it the contract, evidence and artifact references. A new
worker with the same name is not the old context; the main does not spawn a new
worker every user turn and never claims a reuse that did not happen. There is no
standing project-wide worker or session manager, and the plugin cannot resume or
message a worker itself.

### Verification

A worker's success report is not acceptance: the main checks the integrated
result and the evidence it needs, without redoing every step.

On a contract change or a conflict, the main checks running, pending and
completed work, holds overlapping writes, checks host-visible writer status,
stops writers only through host controls, and leaves unrelated work running. It
classifies a failure or blocked worker first (defect, contract, environment,
integration conflict or a needed global decision) and routes it, usually back to
the same worker, never as a takeover.

It never repeats an unchanged failure without new input and reports the exact
blocker when no step remains. It never reports an unrun check as passed, does not
present partial success as completion, reconciles every requested outcome with
end-to-end and boundary project checks, and backs runtime claims with text
evidence read afterwards. There is no automatic model escalation and no reviewer
loop.

### Precedence over host defaults

The notice states that the policies are the user's configured execution policy.
Where generic defaults in the system prompt or tool descriptions differ, it tells
the model to follow the policy, in both directions:

- Judgment keeps core analysis with the main despite host lines such as "Map
  unknown code via task" or "Multi-round search MUST use Task + scout".
- Production puts implementation with workers despite "Inline first / NEVER
  delegate one slice" or "No subagents unless … explicitly requests".
- Worker-local checks are expected despite the task tool's "tasks skip
  build/lint/tests mid-flight".

That override is **guidance only**: host limits (enabled tools, concurrency,
isolation, permissions, plan mode, read-only) still bind, and the notice grants no
capability.

## Policy guidance vs runtime guarantees

| | |
| --- | --- |
| **The plugin enforces** | which notice is selected and where it is placed; the skip gates (below); at most one policy notice per request; that the primary model, `@task`/`@default` roles, custom/specialist agents, tool permissions and task inputs are never changed; that no tool is removed from the main agent (`write` stays available); local telemetry |
| **The plugin only instructs** | which policy the main picks for a stage, whether it delegates, reuses an existing worker or parallelizes, whether it stays within an analysis-only request, how it limits its own direct edits, and that it verifies before accepting |

There is no guarantee that the model follows the instructions, chooses the
intended policy, or that a particular model handles either policy well. The plugin
has no scheduler, dispatcher, reuse manager, classifier or approval mechanism, and
it does not block any tool call.

### Modes and skip conditions

| mode | selected when | notice |
| --- | --- | --- |
| `workflow` | the current turn carries a native `workflow-notice` | supplement only: the task-item contract, the `effort` line, worker-local checks and the pause-and-report rule, result labels, the analysis-only boundary, and verification. The native workflow alone chooses execution method, agents, fan-out and reuse; the supplement adds no dispatch, parallelism or reuse instruction and no "the main analyzes directly" instruction. |
| `orchestrate` | no `workflow-notice`, but a native `orchestrate-notice` is present | with `task`: the `default` notice plus one line right after its header. The line says the user explicitly asked for orchestration, so within the current goal the main leans further toward delegation (production work and independent investigations go to workers); it does not turn an analysis-only request into permission to change the product. The notice replaces the native one in place, so the two never appear together. Without `task`: a short notice (about 0.8K characters) that orchestration was requested but `task` is not enabled this turn; judgment work is done directly, production is implemented directly within permissions or the limitation is stated precisely, delegation is never claimed or simulated, and an analysis-only request stays analysis and changes no product code, config or assets; plus the verification lines. |
| `default` | neither native notice, and `task` is enabled | both policies and the rule for choosing |
| — | none of the above (no `task`, no native notice) | no notice |

The notice lives only in provider context: it is never persisted and never
mutates history, earlier turns, the user's text or other extensions' messages.

**Turn continuity.** The policy of the last governed user turn stays in force for
autonomous continuations until the next user prompt. In OMP 18.4.1, async task
results, re-yields of a messaged worker and worker messages that arrive while the
main is idle start a turn without `before_agent_start` (agent-attributed
`async-result` / `irc:incoming` messages), and the same notice is re-applied to
them. A synthetic prompt continues the ongoing turn; it neither starts nor clears
one: a `<system-…` prompt, and any prompt whose delivered message is not
turn-starting, such as OMP's auto-continue after compaction, the plan-approved and
guided-goal kickoffs, the `.`/`c` continue shortcut and hidden agent-attributed
prompts (`before_agent_start` carries only the text, so the plugin looks at the
message delivered for that text in the first request: an agent-attributed
`developer` or `custom` message is synthetic, and text that matches no delivered
message is a user request). So an explicit `orchestrate`/`workflow` turn survives
compaction and its auto-continue, and after plan approval or a goal kickoff no
policy applies until the next user prompt. A user-invoked `/skill:` prompt and a
collab peer's prompt (user-attributed `custom` messages) start a turn like typed
input. A gated user prompt (plugin disabled, plan mode, empty)
clears the turn, as does a session switch (`/new`, resume, fork). Every request
re-checks the gate, so enabling plan mode or disabling the plugin later withholds
the notice.

**Placement.** A notice the plugin adds goes before the last turn-starting message
(a user message, a user-invoked skill prompt or a collab prompt; agent-attributed
deliveries do not count), or at the end of context if compaction removed that
message. Native keyword notices OMP queues before a skill prompt
(`/skill:x orchestrate`) belong to its turn and are replaced like those before a
user message. A replaced native orchestrate notice keeps its
position. Content and timestamp are identical across the requests of one turn.

The policy is skipped (no notice) when the plugin is disabled (`enabled=false`,
so OMP's native behavior is untouched), in a subagent session (subagents never
re-enter), for an empty prompt or a synthetic `<system-…`
prompt with no turn in progress, and in plan mode. In `default` mode without the
`task` tool there is also no notice. OMP's magic-keyword settings only decide
whether a native notice appears.

The orche-advisor guidance is attached once to the plugin's `orchestrate` or
`workflow` notice, or to the current turn's native orchestrate notice when the
plugin's policy is inactive; it is never attached to the `default` notice, and
no advisor call is ever automatic.

### Task body contract

The plugin defines no separate `solutionSpace` or contract field and does not
replace the task tool. Host versions may expose their own additional metadata;
that stays under host validation. The notice asks the main to write each `task`
item (or workflow item prompt) as plain text with these sections, used instead of
the task tool's generic Target/Change/Acceptance headings:

```text
# Goal
# Scope and non-goals
# Decided and open              fixed decisions with reasons and user constraints; judgments left to the worker
# Inputs and dependencies       artifacts by reference; unverified hypotheses marked
# Acceptance and verification   by type (below)
# Return                        results, new facts, wrong premises, evidence location, open issues, decisions needed
```

The notice asks for each item to be self-contained.

- Acceptance depends on the type: a Judgment worker's is evidence answering its
  question, not whether code changed; a Production worker's is the change plus
  verification.
- Workers do not inherit the conversation: pass what they need, never the whole
  conversation, earlier reports or large logs.
- `effort`: see [Task `effort`](#task-effort).
- Worker-local checks on owned files are expected; global checks, formatters and
  shared runtimes stay with a named owner (normally the main) and never run
  concurrently.
- A worker that finds a broken fixed decision, an ownership conflict or an invalid
  prerequisite pauses that change and reports evidence and partial work; it does
  not redesign, widen scope or overwrite others' edits.

The layout is guidance, not a runtime schema: free-form task calls are never
rejected for missing sections. OMP validates and executes the native task input.
The plugin neither stages nor hashes task calls for approval. The plugin does not
rewrite task arguments or change model roles.

These are model instructions, not automatic cancellation, scheduling or approval
mechanisms.

### Plan advice and Verification Auditor

`orche_advisor` gives advice on an already-established plan, not source-code
approval. It is primary-only and uses `modelRoles.orche-advisor` without falling
back to the primary model. It accepts a `checkpoint` and the seven snapshot
fields shown in `examples/initial-plan.json`; there is no `dispatch` argument.

The role `modelRoles.orche-advisor` is required: if it is unset, the tool returns
an error rather than falling back. The [OMP setup](#omp-setup) fills it once with
`@slow`, your Thinking model. If `slow` is unset, OMP resolves `@slow` to your
default model, so the advisor then runs on the same model as the main session.

- Advice is optional in every policy mode. Lifecycle
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
  This also removes the old DEFAULT multi-worker fan-out gate and eval/workpool
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

The ledger covers what the model's context still holds. `/clear` writes a
`reset_boundary` that OMP's context rebuild starts after, and the ledger starts
after the latest one too: earlier findings, and evidence from before it, are no
longer listed or citable (the history itself is untouched). A tool result OMP has
pruned (`prunedAt`) or its tool flagged as uneventful cannot be cited for a new
resolution. A resolution recorded earlier stays in force when its cited output
is pruned later, and is listed with `(output later pruned from context)` in
place of OMP's placeholder. Any message the user typed counts, including one
that starts with `/` (a path, an unknown command name): commands never become
messages.

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
  Double quotes are paired left to right, so `the "x" claim and then "y"` holds
  two short quotes, not one quotation spanning the words between them.
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
advisors are enabled (OMP's `advisor.enabled`, default `false`). Its model is
`@verification-auditor`, a custom role. The [OMP setup](#omp-setup) turns
`advisor.enabled` on and fills that role with `@smol` once, if they are unset. If
`smol` is unset, OMP resolves `@smol` to your default model. The auditor is a
per-turn review, so enabling it costs a model call each turn. It does not use or
change `modelRoles.advisor` (ADVISOR); set its role independently to choose a
different model. A same-named `WATCHDOG.yml` entry overrides the bundled
auditor. Its evidence-backed concern/blocker notes feed the next checkpoint
review, not unrelated watchdog notes.

When no WATCHDOG roster is configured, the Verification Auditor is the only
advisor; the plugin removes OMP's synthesized default advisor. Explicit
`WATCHDOG.yml` entries are retained, including a general advisor if desired.

With `enabled=false` the plugin installs no auditor and rewrites no advisor notes,
so OMP's native advisor roster and cards are untouched (the manual `orche_advisor`
and `review_findings` tools remain available). The setting is read at session
start: an auditor installed earlier in the same session stays in OMP's live roster
until the next session start, though its notes are no longer rewritten.

`/advisor configure` replaces OMP's live advisor roster with the saved
`WATCHDOG.yml` entries and gives extensions no hook for it, which drops the bundled
auditor. The plugin notices at the next prompt (the live roster no longer names the
Verification Auditor) and installs it again; a `WATCHDOG.yml` entry of the same
name, even a disabled one, is never overridden. Until you send that prompt the
auditor is not in the roster.

Advice text returned to the model has terminal escapes, control characters and
zero-width/bidirectional characters removed and is capped at 8000 characters. The
reply must open with one verdict line (`VERDICT: KEEP`, `ADJUST`, `REPLAN` or
`ESCALATE`, alone or followed by ` - rationale`; bold markers are tolerated) and
then the `ISSUES:`, `ORCHESTRATION CHANGES:` and `AVOID:` headings once each, in
order. Trailing spaces and inline content after a heading (`ISSUES: None`) are
accepted; the template echoed back (`KEEP | ADJUST | ...`), `KEEP-ish`, repeated
or reordered headings are not, and count as an invalid-structure error. A review
cancelled or timed out after an attempt already reached the provider still records
that attempt's usage.

The standalone `orche-advisor` CLI remains available from this package:
`bun bin/orche-advisor.ts examples/initial-plan.json --check` validates the
input and model selection without requesting a review. The CLI uses
`modelRoles.orche-advisor` unless `--model` is supplied. A missing or unresolvable
credential, a directory given as input, and an `--agent-dir` that does not exist
(nothing is created there) are configuration/input errors: exit 2.

### Native `task` worker

The plugin installs no `tool_call` or `before_subagent_spawn` enforcement hook.
It never revises task input or changes `agent`, so a restricted session whose
spawn-policy default is `sonic` keeps that default. Explicit specialists,
custom agents and tagged model pseudonyms run as requested. OMP owns task
execution, spawn policy, concurrency, async results, cancellation, tool
permissions, isolation, worker messaging and workpool. Native workflow mode
keeps its own execution method. There is no automatic model escalation.

One generic `@task` worker serves both policies: switching between Judgment and
Production in a session changes only the guidance the main follows, not a model or
a worker type. Task execution needs no external routing call or credential.

## Model roles and presets

The plugin never switches your models and never writes a concrete model ID. Models
come from your OMP config: `modelRoles.default` selects the main model and
`modelRoles.task` the generic worker. The one-time [OMP setup](#omp-setup) only
fills two role aliases, `verification-auditor: "@smol"` and
`orche-advisor: "@slow"`, and only when they are unset. Switching between
Judgment and Production inside a session needs no model change.

```yaml
modelRoles:
  default: <your primary model>              # never changed by this plugin
  task: <capable worker>                    # optional; unset = workers use the main session's active model
  smol: <lightweight model>                 # OMP's lightweight baseline (sonic)
  advisor: <general advisor model>          # only if declared in WATCHDOG.yml
  verification-auditor: "@smol"            # filled by the OMP setup if unset; distinct from ADVISOR
  orche-advisor: "@slow"                   # filled by the OMP setup if unset
```

Child sessions never fill roles. `@task` is never written: `modelRoles.task` is
optional, and if it does not resolve, `/om-orche status` says task workers use the
main session's active model. No other role (such as `@slow`) is substituted for
it.

### Starting presets

Two starting choices you can set yourself. They are not automatic routing, and
they were not measured to be better than other choices.

```yaml
# Judgment-centric start
modelRoles:
  default: openai-codex/gpt-6-astra:high
  task: openai-codex/gpt-6-sol
```

```yaml
# Production-centric start
modelRoles:
  default: anthropic/claude-opus-5-5:medium
  task: openai-codex/gpt-6-sol
```

- All three model ids are present in the bundled OMP 18.4.1 model catalog.
  Whether your account can use them depends on your providers.
- `high` and `medium` are in each main model's supported efforts
  (`low`, `medium`, `high`, `xhigh`, `max`). A `:level` suffix is parsed by OMP; an
  unsupported level is clamped down to the nearest supported one, not rejected.
- `task: openai-codex/gpt-6-sol` has no suffix, so the worker uses the inherited
  default thinking level (for example `auto`) unless a task item sets `effort`.
- The same worker model serves both policies.

Keeping one primary model avoids full-context provider switches; it does not
guarantee prompt-cache hits or prevent OMP/user fallback.

### Task `effort`

A `task` item can carry `effort: lo | med | hi`.

- The field exists only when the host setting `task.enableEffort` is `true`
  (default `false`); otherwise OMP strips it, and the notice's `effort` line is
  moot.
- The values are positions in the worker model's own supported range, not effort
  names: `lo` is the lowest level, `hi` the highest, `med` a middle level (the
  lower middle). On a `low … max` model, `lo` = low, `med` = high, `hi` = max. The
  result is capped by `task.maxEffort` (default `max`). Models without reasoning
  ignore it.
- Precedence, highest first: an explicit per-item `effort`; a `:level` suffix on
  the `task` role; the agent definition's thinking level; the inherited default
  thinking level (for example `auto`, whose ceiling is
  `providers.autoThinkingMaxEffort`). Omitting `effort` keeps your role and
  default settings.
- Nothing in the host changes the main session's model or thinking level because
  of a task's effort.

The notice's wording, when the schema has `effort`: `lo` for fixed mechanical
work, `med` for bounded investigation or implementation, `hi` for a substantial
unresolved cause, design or correctness question; keep any effort the user
specified; do not send analysis at `hi` by default. The host maps it onto the
worker model's own range, not by name, and an explicit effort overrides the task
role's level and `auto`: omit it to keep those. This is guidance, not
enforcement.

## Install

```bash
omp plugin install om-orche
```

From a checkout:

```bash
omp plugin link /path/to/om-orche
```

Nothing else is required: no `AGENTS.md` edit, no agent files, no `models.yml`
surgery, no routing prompt, no separate SDK install, no OMP patch, and no
Jev/TypeSafe account or credential. The package ships no agent definitions.
Installing or linking also configures the OMP settings om-orche uses; see the
next section.

### OMP setup

OMP has no install hook, so the setup runs at the first main-session start after
the plugin is installed or linked (that is, when OMP first starts a main session
with om-orche loaded). It never runs in a subagent session, and not while
om-orche is disabled (`enabled=false`).

"Main session" means any top-level session, including each ACP session (which the
host registers as `acp:<sessionId>` rather than `Main`); spawned subagents and
`/tan` clones are never main.

It is **fill-only and runs once per installation**. Each item is handled by where
its value currently comes from:

- unset in every config layer → the setup writes the value to your global config;
- set in your global or project config → kept untouched, whatever the value;
- set only for this session (CLI flag, `--config`, protocol pin) → nothing is
  written and that item stays pending, so a later session start tries again.

The four items:

| OMP key | value | why |
| --- | --- | --- |
| `advisor.enabled` | `true` | starts the bundled Verification Auditor. This is OMP's own advisor switch (default `false`), so it also applies to any advisors you declare in `WATCHDOG.yml` |
| `modelRoles.verification-auditor` | `"@smol"` | the auditor's model. With `smol` unset, OMP resolves `@smol` to your default model |
| `modelRoles.orche-advisor` | `"@slow"` | the plan advisor uses your Thinking model. With `slow` unset, OMP resolves `@slow` to your default model, so the advisor runs on the main model |
| `task.maxRecursionDepth` | `1` | om-orche's main session owns all worker distribution, so workers must not spawn sub-workers. At depth `1` the main session (depth 0) can still delegate through `task`, while a worker (depth 1) runs its task directly. OMP's default is `2`. Do not set `0`: it removes `task` from the main session and disables Production delegation |

**Cost.** With the auditor on, every turn adds a model call on
`@verification-auditor`. In OMP 18.4.x, writing `advisor.enabled` during startup
does not switch an already running session on by itself, so when the setup wrote
that value it also switches the running session's advisor on through OMP's public
session API; the auditor then runs in that same first session. To opt out or
change it, set explicit values yourself: `omp config set advisor.enabled false`
(the `omp config` CLI supports `list`, `get`, `set` and `reset`), or edit
`~/.omp/agent/config.yml`. Individual `modelRoles` entries cannot be set with
`omp config set`; edit them in `config.yml`. Values you set before the first
start are kept; values you change afterwards stick, because the setup never
re-enables or rewrites anything once it has finished. To allow deeper delegation
again, set `omp config set task.maxRecursionDepth 2` (or any other value); a value
in your global or project config is never overwritten.

**Not set, on purpose:**

- `modelRoles.task` is not needed: task workers use the main session's active
  model unless you assign one.
- `task.enableEffort` is optional; opt in with
  `omp config set task.enableEffort true` (see [Task `effort`](#task-effort)).
- No other OMP setting or role is touched, and OMP's own `advisor` role is never
  written.

**Once, and how it is recorded.** When every item is resolved (written or kept),
om-orche stores an internal marker, `hostSetupVersion: 2`, in its plugin settings.
It is not one of the [three settings](#configuration) and does not appear in
`omp plugin config list`. With the marker present the setup does nothing, even if
you later delete one of those OMP keys. If a write fails, the setup logs a
warning and tries again at the next start, and writes no marker:

```text
om-orche OMP setup failed and will be retried at the next session start: <error>
```

**What you see.** Only when the setup wrote something, and only in the
interactive UI, a notification lists just the keys it wrote:

```text
om-orche configured OMP once, filling only what was unset (existing values were kept):
  advisor.enabled: true
  modelRoles.verification-auditor: "@smol"
  modelRoles.orche-advisor: "@slow"
  task.maxRecursionDepth: 1
The Verification Auditor now reviews each turn with @verification-auditor.
Edit roles in ~/.omp/agent/config.yml; `advisor.enabled` can also be changed with `omp config set advisor.enabled <true|false>`.
The main session delegates through `task`; workers run their task directly. Allow deeper delegation with `omp config set task.maxRecursionDepth 2`.
```

The middle lines vary with what was written: the auditor line appears only when the
auditor now runs; the roles line is ``Edit roles in ~/.omp/agent/config.yml.`` when
only roles were written, and ``Change it with `omp config set advisor.enabled
<true|false>`.`` when only `advisor.enabled` was written; the last line appears
only when `task.maxRecursionDepth` was written. In every mode an info line goes to
the OMP log, again listing only what was written:

```text
om-orche OMP setup wrote advisor.enabled=true, modelRoles.verification-auditor="@smol", modelRoles.orche-advisor="@slow", task.maxRecursionDepth=1
```

**Re-running.** Remove the marker, then start a new main session; the setup runs
again and is still fill-only. Any of these removes it: reinstalling the plugin
(`omp plugin uninstall om-orche` first), `/om-orche reset`, or
`omp plugin config delete om-orche hostSetupVersion`.

**Existing installs.** If om-orche is already installed without the marker, the
setup runs once at the next main-session start after you upgrade (fill-only).

**Upgrading from setup v1.** Each item carries the setup version that introduced
it, and a run applies only items newer than the stored marker. An install with
`hostSetupVersion: 1` therefore gets only `task.maxRecursionDepth` at its next
main-session start (fill-only, so an existing value is kept), and the marker
becomes `2`. `advisor.enabled` and the two roles are not touched again, so keys
you deleted after the first setup stay deleted. Until that start, `/om-orche
status` shows the setup as pending.

## Commands

| Command | Effect |
| --- | --- |
| `/om-orche status` | Whether the plugin is enabled; execution policy (`judgment/production (om-orche-policy-notice)`, or `native (plugin disabled)`); primary model unchanged; native `task` worker and `@task` role; the `OMP setup` row: `applied (v2)` (the stored version, shown even when the plugin is disabled), `pending — applies at the next main session start` (also for an older stored version, such as `v1`), or `skipped — plugin disabled`; retired settings and leftover tier roles still present. |
| `/om-orche stats` | Live-epoch task-worker usage, plus the read-only Jev-routing-era and tier-era history. It re-reads `telemetry.json` first, read-only, so counts other OMP processes have written are in it, and telemetry just turned on over an older file has migrated it. |
| `/om-orche reset` | Clear plugin-owned telemetry files and the plugin's stored settings in OMP's plugin store. A project's `plugin-overrides.json` is never edited: keys it still sets are named and stay in effect. |

`status` reports no credential, model or gate rows and no last decision: the
plugin makes none. If `@task` does not resolve, status says `@task does not
resolve in this session; task workers use the main session's active model.`; the
plugin does not route around it. Retired
settings still stored for the plugin (see
[Migrating from Jev routing](#migrating-from-jev-routing)) and leftover
`@task_easy`/`@task_hard`/`@task_challenge` roles are listed as unused and left
in place. Unknown subcommands get a warning.

## Privacy and security

The policy path performs no network I/O and sends nothing anywhere: the notice
is built locally from fixed text and the tools enabled on the turn, and lives
only in provider context. It is not written to the transcript, and no prompt
text is copied to telemetry.

The plan advisor receives the submitted seven-field snapshot plus bounded
findings and explicitly cited finding-resolution evidence. It never receives
the whole transcript or execution-approval metadata. Inspect evidence IDs
before citing outputs containing sensitive data.

Credentials never touch the repository, the project directory or the plugin
source tree. The plugin reads no credential of its own; the advisor and auditor
use whatever OMP's model registry authorizes for their configured roles.

## Telemetry

Local data only — no prompt text, no task text, no source, no transcript — under
`<omp agent dir>/jev-router/`, cleared by `/om-orche reset`. With
`telemetryEnabled=false` nothing is written (existing data is shown read-only).
The data directory deliberately keeps its historical name (`jev-router`) so
telemetry history is neither discarded nor silently relocated.

`telemetry.json` (v6) holds a **live epoch** and two read-only historical
sections, `jevRouting` and `historical`. Live and historical numbers are never
added together.

- **Live epoch (`workers.task`):** observed task workers only; the plugin no
  longer routes, so there are no routing counters. Fields: `startedObserved`,
  `followUpTurns`, `completed` / `failed` / `aborted` (counted per settled turn),
  `usageSamples`, `usageSamplesCompleted`, `usageUnknown`, `tokens`, `costUsd`
  and `durationMs`. Workers are identified from OMP's subagent lifecycle and
  progress frames; the invocation path is not separated (task tool, eval
  `agent()` and workpool all count). Worker identity is the session (its event
  bus), `parentToolCallId` and worker id: OMP allocates worker ids per session,
  so two sessions of one process (an ACP host runs several) can both run a
  worker `reviewers-0`, and each is counted as a worker of its own. Within one
  session an id is never allocated twice, so a repeated id on one bus is the
  same worker. A worker counts once as started; each later turn of the same
  worker (a message sent with `write agent://<id>`, a task-tool live follow-up,
  eval `agent()` or workpool reuse) is a follow-up turn, settled and measured on
  its own. OMP restarts progress counters at 0 each turn, so per-turn usage is
  summed. `completed` means the worker run finished, not that its result was
  accepted. `stats` prints `cost per completed` as all measured spend — failed
  and cancelled turns included — divided by the measured turns that completed
  (`costUsd` ÷ `usageSamplesCompleted`), so failed work raises it.
- **`jevRouting` (read-only):** the v5 live epoch: its routing counters and
  per-worker rows (without follow-up turns).
- **`historical` (read-only):** the tier-era history carried unchanged from v5.
- **Limitations:** turns of a worker that OMP revives from disk after a restart
  are not observed, because the host reports them under the worker's id instead
  of `task`; they are counted neither as new workers nor as usage. A worker
  evicted from the 4,096-entry tracking map, or cleared by `reset`, counts as
  newly observed if it runs again.
- **Several OMP processes and subagents:** processes may share the state
  directory. A process writes only the counts it recorded itself since its last
  write, added to the file as it is at that moment while it holds
  `telemetry.lock` (a short-lived file, present only during a write, a
  migration or a reset), so no process overwrites another's counts. A write
  that cannot get the lock within a second keeps its counts for the next flush;
  a lock older than five seconds belongs to a process that died and is broken.
  `/om-orche reset` takes the same lock before deleting. A process that then
  finds the file it last wrote gone starts a new epoch (new id and start time)
  with its next write and writes the counts it had not yet written into it, so a
  reset in one process is not undone by another. Worker tracking is per process,
  so a worker already running elsewhere settles into the new epoch without a
  start of its own. Only the main session decides whether telemetry records and
  loads or migrates the file: a subagent, whose working directory can differ
  (an isolated worktree has no project override), never switches the setting.
  `/om-orche stats` re-reads the file first: it shows what the other processes
  have written with this process's own unwritten counts on top; what another
  process has not flushed yet (up to about two seconds) is not in it. The
  re-read takes no lock and writes nothing.
- **A file replaced while a process runs:** every write, and every `/om-orche
  stats`, reads the file again, so a file another process replaced with a newer,
  an older or an unreadable one is left untouched and recording is suspended, as
  at start-up; only a start-up converts an older file.

`/om-orche stats` shows the live epoch plus the read-only Jev-routing and tier
eras. `decisions.jsonl` is no longer written; an existing file stays on disk
untouched and is deleted only by `/om-orche reset`.

Worker usage is read from OMP's `task:subagent:progress` and
`task:subagent:lifecycle` frames on the session event bus, which fire for sync
and background (`async.enabled`) spawns alike. The host's `aborted` status is
shown as cancelled.

### Upgrading to v6

Migration is automatic, idempotent and non-destructive:

- **v5 → v6:** the original v5 bytes are first preserved as
  `telemetry-history/v5-<sha256>.json` (never overwritten), then the v6 file
  replaces `telemetry.json`. The v5 live epoch moves into the read-only
  `jevRouting` section; the v5 file's tier-era `historical` section is carried
  over unchanged; a new empty live epoch starts.
- **Older files** (before v5) keep the tier-era conversion.
- **`telemetryEnabled=false`:** the old file is shown as a read-only deferred
  view and is migrated once telemetry is enabled: at the next main session
  start, or by `/om-orche stats`, which migrates before it shows anything.
- **Newer than this plugin:** the file is left untouched and recording is
  suspended until `/om-orche reset`.
- A failed backup or write leaves the original active and suspends recording.
- **Several processes migrating at once:** the backup and the conversion both
  run under the same lock, on the file as it is once the lock is held; a
  process that gets there second takes the first one's v6 file.

`reset` deletes only plugin-owned files (`telemetry.json`, `decisions.jsonl`,
migration temporaries, `telemetry.v<N>.json` backups and `telemetry-history/`
snapshots) while holding the lock, and reports any it could not remove.

### Rolling back

An older (v5) plugin that finds a v6 `telemetry.json` suspends itself under the
newer-version rule and does not read or overwrite it. To roll back: stop all
OMP processes, keep a copy of the v6 `telemetry.json`, restore the preserved
`telemetry-history/v5-<sha256>.json` as `telemetry.json`, then install the older
package. Data recorded in the v6 live epoch after the upgrade is not in the
restored file.

## Configuration

Stored in OMP's own per-plugin settings map and removed by `omp plugin
uninstall`:

```bash
omp plugin config list om-orche
omp plugin config set om-orche debugLogging true
omp plugin config get om-orche enabled
```

These three are the only settings:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for the execution policy and automatic guidance; with `false`, OMP's native behavior is untouched and the [OMP setup](#omp-setup) is skipped. Manual advice/finding tools remain available |
| `telemetryEnabled` | `true` | local aggregate task-worker counters |
| `debugLogging` | `false` | one metrics-only line per turn and mode in the OMP log: `om-orche.policy mode=<default\|orchestrate\|workflow>` or `om-orche.policy skip=<reason>`; never prompt text |

There is no setting to choose a policy mode or to turn delegation on or off.
The one-time setup keeps an internal marker, `hostSetupVersion`, in the same
settings map; it is not a setting, is not listed by `omp plugin config list`, and
is described under [Re-running](#omp-setup). `examples/config.yml` shows the
model roles you can customize in your OMP config.

`/om-orche reset` clears the plugin's stored settings from OMP's plugin store,
the setup marker included. A project's `plugin-overrides.json` belongs to the
project and OMP has no API to edit it, so the plugin never does: if it still
sets keys, the reset names them and says they stay in effect in that project.

## Migrating from Jev routing

Finish or cancel running work, then stop every OMP process that still runs the
previous plugin version before starting one with this version. A process that
loaded the old extension keeps its hooks and keeps writing a v5
`telemetry.json`, which would overwrite the upgraded v6 file.

**What changed.** The plugin no longer calls Jev/TypeSafe or any other service,
and no longer classifies requests as DEFAULT or ORCHESTRATE. Confidence/margin
gates, the todo-triggered reconsideration and promotion, and the per-decision
timeout are gone. Every governed turn gets one deterministic policy notice
carrying the Judgment and Production policies (see
[What it does](#what-it-does)). Nothing in the default path does network I/O.

**Retired settings.** These are removed; stored values are never read or
rewritten, and `/om-orche status` lists any that remain:

`jevModel`, `orchestrationRoutingEnabled`, `orchestrationMinConfidence`,
`orchestrationMinMargin`, `routingTimeoutMs`, `maxRoutingInputChars`, plus the
earlier tier-routing keys (see [Migrating from tier routing](#migrating-from-tier-routing)).

Delete each leftover key with:

```bash
omp plugin config delete om-orche <key>
```

**`orchestrationRoutingEnabled=false` has no equivalent.** The only way to
switch the plugin's guidance off is `enabled=false`, which restores OMP's native
behavior (and also stops the plugin from composing advisor guidance). Every
other setting either has no counterpart or is unnecessary because there is no
router.

**Commands.** `/om-orche setup` and `/om-orche test` are removed; there is no
credential to configure and no classifier to probe. `/om-orche status`, `stats`
and `reset` remain.

**Credential.** Any `typesafe` credential in OMP's credential store is left
untouched and is no longer read. Remove it yourself through OMP if you no longer
want it. The plugin no longer depends on the `@typesafe-ai/sdk` package.

**State directory.** The runtime state directory is still
`<omp agent dir>/jev-router/`, for data continuity.

**Telemetry.** The file is upgraded to v6 on first load; the v5 original is
preserved under `telemetry-history/`. See [Upgrading to v6](#upgrading-to-v6)
and [Rolling back](#rolling-back).

**Unchanged.** Orche-Advisor, the Verification Auditor and the findings ledger
behave as before and are never invoked automatically. Native workflow mode keeps
its execution method. Primary model, `@task`, agents and tool permissions are
never changed.

### Migrating the plugin name

The package, settings namespace, display label and slash command are
`om-orche`. There is no old-name command or settings fallback. The advisor tool
`orche_advisor`, its `orche-advisor` model role and standalone CLI are unchanged.

Before removing an old installation, record its desired settings with
`omp plugin config list omp-jev-router`. Finish active work, remove the old
`omp-jev-router` installation/link, then install or link `om-orche` and reapply
the settings that still exist (only `enabled`, `telemetryEnabled` and
`debugLogging`) with `omp plugin config set om-orche <key> <value>`. Do not load
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
  required to continue work. The finding ledger and evidence history remain.

### Migrating from tier routing

Finish or cancel running workers and start a new session after upgrading; do
not cut over with live workers.

- **Removed:** `task-easy`, `task-hard`, `task-challenge` agents; per-task
  classification; the `taskRoutingEnabled`, `taskMinConfidence`,
  `taskMinMargin`, `easyTaskRole`, `hardTaskRole`, `challengeTaskRole` settings;
  the `gen:agents` build step. Calls naming a removed alias are not silently
  turned into `task`; dispatch `task` (or a specialist) instead.
- **Stored retired settings** are ignored and never rewritten by the plugin.
  `/om-orche status` lists any that remain; delete them with
  `omp plugin config delete om-orche <key>`.
- **Model roles** `task_easy`, `task_hard` and `task_challenge` are yours and
  are left untouched; status marks them unused. Worker model choice is your
  `@task` role. Set it before upgrading if you relied on a tier's model.
- **Task contract:** put goal, scope, fixed/open decisions, inputs, acceptance
  and return format in the `task` text (see [Task body contract](#task-body-contract)).
  The plugin does not introduce or classify a `solutionSpace` field.
- **Advice:** historical approvals have no effect; optional plan advice does
  not authorize execution.
- **Telemetry:** the v4 tier-era counters were kept as historical data and are
  carried unchanged into v6.

Earlier releases' `mainModelRoutingEnabled`, `mainNormalRole`, `mainDeepRole`,
`normalTaskRole`, `deepTaskRole` and `task-deep`/`task-normal` agents are also
unused. Uninstall leaves role assignments and credentials intact.

## Troubleshooting

Turn on `debugLogging` and read the OMP log. Each governed turn logs
`om-orche.policy mode=<default|orchestrate|workflow>`; a skipped turn logs
`om-orche.policy skip=<reason>` with a reason from `disabled`, `not-main-session`,
`empty-prompt`, `synthetic-notice`, `plan-mode` and
`task-tool-unavailable`.

| symptom | cause |
| --- | --- |
| no policy notice on a turn | one of the skip reasons above: the plugin is disabled, a subagent session, an empty prompt, a synthetic `<system-…` prompt with no turn in progress, plan mode (the plugin never toggles plan mode; only the user's `/plan` enters it), or `default` mode without the `task` tool |
| the model did not delegate, reuse a worker, parallelize, or picked the other policy | the policies are guidance, not enforcement; the model decides per stage. Check that `task` (and `write` for reuse) are enabled on the turn |
| both a native notice and the plugin's seem missing | with `enabled=false` OMP's native behavior is untouched and the plugin adds nothing |
| a native `orchestrate` request shows only one notice | expected: the plugin's `orchestrate` notice replaces the native one in place |
| a worker cannot be messaged | the host reported it isolated or hard-aborted, or delivery failed; a new worker with the contract, changes and artifact references is the correct path. A missing "now idle" hint alone does not mean it cannot be continued |
| `OMP setup` is not `applied (v2)` in status | `skipped — plugin disabled`: om-orche is disabled (`enabled=false`). `pending — applies at the next main session start`: no main session has started since install or since upgrading from setup v1; an item is set only for the current session (CLI flag, `--config`, protocol pin; RPC and ACP sessions pin `task.maxRecursionDepth` themselves), which leaves it pending until a session start without it; or a write failed, in which case the OMP log has the `om-orche OMP setup failed and will be retried at the next session start` warning and the next start retries |
| the Verification Auditor does not run | `advisor.enabled` is off (the setup only fills it once; if you turned it off, it stays off), or `modelRoles.verification-auditor` is unset, or the plugin is disabled |
| workers can spawn sub-workers, or `task` is missing in the main session | `task.maxRecursionDepth` is not `1`. The setup fills it once with `1`; a value you had set (`2` or more lets workers delegate, `0` removes `task` from the main session) is kept. Set `omp config set task.maxRecursionDepth 1` to restore the intended setup |
| `orche_advisor` returns an error about a missing role | `modelRoles.orche-advisor` is unset. The setup fills it once with `@slow`; if the role was removed since, set it again under `modelRoles` in `~/.omp/agent/config.yml` |
| `@task does not resolve in this session` in status | expected when `modelRoles.task` is unset: task workers use the main session's active model. Assign `modelRoles.task` in `config.yml` only if you want a different worker model |
| `Retired settings still stored` in status | delete the listed keys with `omp plugin config delete om-orche <key>`; they have no effect |
| telemetry suspended | the file was written by a newer plugin version, or a migration backup/write failed; `/om-orche reset` clears it |

## Uninstall

```bash
omp plugin uninstall om-orche
```

Removes the package, the plan-advice tool, the bundled auditor and the plugin's
guidance; OMP's native `task` behavior and orchestrate notice return unchanged.
The OMP settings the [OMP setup](#omp-setup) wrote stay in your config:
`advisor.enabled: true`, `modelRoles.verification-auditor: "@smol"` and
`modelRoles.orche-advisor: "@slow"`. Remove or change them yourself (for example
`omp config set advisor.enabled false`). Other OMP model-role assignments
(including any leftover `task_easy`/`task_hard`/`task_challenge`) also remain
until removed explicitly, as do any `typesafe` credential in OMP's store and the
`<omp agent dir>/jev-router/` telemetry files; use `/om-orche reset` before
uninstalling if those files should be cleared. The plugin's stored settings,
including the setup marker, are removed with the plugin.

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

Tests that construct the plugin runtime or fire `session_start` must disable or
stub telemetry, and run with `PI_CODING_AGENT_DIR` pointing at a temporary
directory, so they never touch the real agent directory.

`bun test` covers notice selection, placement and turn continuity, skip gates,
advice verdicts and real error handling, absence of plugin execution gates
(including old persisted approval records), finding evidence/lifecycle, settings
and retired settings, telemetry migration and worker accounting, and status
rendering. The policy text is checked as content only; those checks are not
evidence of how a model behaves.

### Verification record

OMP 18.4.1 is the compatibility target.

**Static and unit checks.** `bun run check` clean; `bun run lint` 0 errors (2
existing `no-control-regex` warnings); `bun test` 174 pass, 0 fail across 13
files. The policy text is checked only as content: those checks show what the
model is told, not what it does.

**Mechanism checks** (pinned OMP 18.4.1 CLI, isolated agent directory,
deterministic local fake model, no paid requests). They cover notice injection
and placement, explicit `orchestrate` replacement, `enabled=false`, plan mode,
zero TypeSafe requests, reuse telemetry counts and the v5 → v6 migration; the
notice mechanism was not changed in the Judgment/Production cutover.

- One identical policy notice in every main request (positioned before the user
  prompt) and none in worker requests; an explicit `orchestrate` request replaced
  the native notice in place with the advisor supplement attached once;
  `enabled=false` left the native notice byte-identical and added nothing; plan
  mode added no notice; a TypeSafe recorder received zero requests, also with a
  TypeSafe key set.
- A follow-up sent with `write agent://<id>` reached the same worker with its
  prior context, and telemetry recorded 1 started worker, 1 follow-up turn and 2
  completed turns, with tokens equal to the sum of that worker's two turns (a
  single run: 1 / 0 / 1).
- A copy of a real v5 telemetry file migrated to v6 with a byte-exact
  `telemetry-history/v5-<sha256>.json` backup, its live epoch moved to
  `jevRouting`, the tier era carried over, an empty live epoch, and an idempotent
  reload.

**OMP setup (2026-09-29).** `bun run check` clean; `bun run lint` 0 errors (2
existing `no-control-regex` warnings); `bun test` 240 pass, 0 fail across 15
files. The full suite also passes with a temporary HOME and the real config roots
sandbox-denied. Host scenarios, on the real OMP 18.4.3 CLI (and the pinned 18.4.1
CLI for the fresh case), with an isolated HOME and agent directory,
`omp plugin link`, print-mode sessions, a local fake model and no paid calls:

- Fresh install, first session: `config.yml` received the three items, the plugin
  lock received `hostSetupVersion: 1`, the info line reached the OMP log, and the
  Verification Auditor ran in that same first session (one auditor model request
  after the main turn).
- Explicit user values (`advisor.enabled: false`, a concrete `orche-advisor`)
  were kept; only the missing auditor role was filled, and no auditor ran.
- With the marker present, keys the user deleted afterwards were not re-added.
- After `omp plugin config delete om-orche hostSetupVersion`, the next session
  re-applied the missing items (fill-only) and the auditor ran in that session.
- With the plugin disabled (project override `enabled: false`), nothing was
  written and no marker was set.
- `omp plugin uninstall om-orche` removed the plugin's settings including the
  marker; the written OMP keys stayed in `config.yml`.

Not verified on a live host: the interactive notification display (print mode has
no UI; the log line is verified); the `/om-orche status` row (unit-tested only);
`omp plugin install` from npm (only `link` was exercised; OMP's install path calls
no plugin code either way); and the pending path for session-scoped values such
as RPC/ACP protocol pins (unit-tested only).

**Real-model smoke.** Setup: the OMP 18.4.2 CLI with the user's model roles (main
`anthropic/claude-opus-5-5`, `task` worker `anthropic/claude-sonnet-5-5:medium`);
five runs in a throwaway repository with a planted rounding bug; a probe
extension recorded the provider context.

- The same 7,922-character notice (identical hash) was in every main request,
  before the current user message, and in no worker request. In a continued
  session it preceded the new user message, with no copy at the earlier turn.
- Analysis-only "find the cause": the main investigated itself (grep, read, a
  non-destructive `bun -e` reproduction). No worker and no file changes. The
  answer separated execution-confirmed facts from code-based inference and said it
  changed nothing because only analysis was asked.
- Proposal-only and impact-analysis requests: no worker and no file changes. The
  impact analysis labeled executed checks separately from inference.
- "Find the cause and fix it with a regression test": the main read the code,
  then delegated to one worker (six-section task item, `effort: lo`). The worker
  edited, ran the tests and showed the new tests fail on the old code. The main
  only verified (`git diff`, `bun test`). The main wrote the one-line fix into the
  task item itself, so this run does not test the "do not dictate the
  implementation" boundary on a non-trivial change.
- A related follow-up in the same session, after a process restart, went to that
  same worker via `write agent://<id>`. The worker continued with its prior
  context, and the main verified (8 tests pass).

Not exercised with a real model: parallel fan-out, blocked-worker classification,
returning to Judgment after a broken premise, contract-change propagation across
workers, asset work, explicit `orchestrate` or workflow requests and plan mode in
a live session (unit-tested and mechanism-checked only), other model lineages
(for example the GPT-6 Astra judgment preset), and interactive idle wake turns. A
five-run sample on one model family is not a guarantee of behavior.

Host smoke runs verify the exercised host/tool paths, not model reasoning quality
or every provider/settings combination. Earlier smoke results in
`docs/plans/self-orchestration.md` are historical, not the current support
target.

### Known API constraints

Recorded rather than worked around:

- **`@oh-my-pi/pi-tui` subpaths do not resolve at runtime from an extension**
  (only the package root does, and it does not re-export `containsOrchestrate`).
  Native notices are therefore recognized in the `context` hook; turn state is
  prepared at `before_agent_start`, and the last governed turn's notice is
  re-applied to autonomous continuations that do not pass through that hook.
  Thinking-level types are imported only as erased types.
- **Cost per completed task is not acceptance rate**: `completed` is the
  worker's own settlement.
- **Spawns that settle after the process exits** are not in `stats`: usage is
  read from in-process subagent frames.
- **Reuse depends on the host.** Whether a worker can be continued is reported by
  OMP 18.4.1; the plugin cannot resume, message or verify delivery to a worker
  itself.
