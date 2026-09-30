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
tool and a plugin-run Verification Auditor that checks completed primary runs. The primary must explicitly request a
review once planning ends, before executing or delegating the formed plan.

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

> **Behavior change (policy in the system prompt).** The execution policy is now one
> element of the main session's system prompt, instead of a message in the transcript
> or a copy added to every request, so it sits in the provider's cached prefix and
> costs its tokens once. See [Modes and skip conditions](#modes-and-skip-conditions).

---

## What it does

```text
The execution policy is ONE element of the main session's system prompt, plus a
counterpart for each of OMP's keyword notices

  `task` tool enabled                            → policy appended to the system prompt
                                                   (Judgment + Production + how to choose)
  a native orchestrate-notice in the transcript  → replaced in place by a short notice
  a native workflow-notice in the transcript     → kept; a supplement follows it
  `task` tool not enabled                        → no policy in the system prompt

The main reads the policy, then chooses for the current stage:
  Judgment   — the main analyzes directly; workers only for bounded, independent investigations
  Production — implementation goes to workers by default; the main integrates and accepts
```

There is no classifier, keyword matcher, model call, router, subagent call, mode
tool or slash command for choosing, and the plugin keeps no state about it. The
main decides from the request, the actual code and tool results, and progress so
far. The policy is part of the system prompt, which opens every request, so each
request extends the previous one byte for byte and the provider's prompt cache
stays warm (see [Modes and skip conditions](#modes-and-skip-conditions)).

## Execution policies

The policy reads in this order: the header and precedence line, the rule for
choosing (with switching), Judgment, Production, Decomposition, assets, reuse,
the task-item contract with worker-local checks (and the `effort` line when enabled), and
verification. Shared guidance is written once; the policy does not hold two
complete execution prompts. It is guidance for the model, not a scheduler or
permission system, and it renders only instructions backed by the tools enabled
and settings in force when rendered. A relevant change updates the system prompt
from the next prompt.

| | Judgment (판단형) | Production (제작형) |
| --- | --- | --- |
| Delivers | an explanation, analysis, judgment, proposal or design | a real change to code, files, features, assets or state |
| Who works | the main: frames the question, reads the key code, logs and docs, forms hypotheses, gathers evidence, runs key experiments, tests counterexamples, decides | workers own investigation, local design, implementation, local checks, failure analysis and re-fixes within their scope; the main owns goal, scope, shared decisions, integration and acceptance |
| Workers | zero is normal; independent unknown areas or hypotheses go to parallel bounded investigations, while the main owns judgment | one worker end to end for a cohesive or strictly sequential unit; disjoint write sets, settled interfaces and separate acceptance define independent units, whose ready workers start together; explain bundling or serialization in the plan |
| Changes the product? | never: analysis-only is not permission to change code, config or assets | yes, through workers |

In both policies the main owns the user's intent, scope, global decisions and the
final answer and verdict.

### Choosing a policy

The type is the **current stage's policy**, not a label on the whole request. The
main chooses from the request and from what it learns while working:

1. Ask what the user must receive for the request to be done.
2. Explanation, analysis, judgment, proposal or design alone → Judgment.
3. A real change to code, files, features, assets or state → Production.
4. Both → start in Judgment and switch to Production once **change authorization,
   scope/non-goals, expected behavior and acceptance criteria** are settled. The
   main need not solve the root cause first: a worker owns local investigation and
   design within that contract. Unconfirmed causes remain hypotheses, not
   mandatory code changes. A **mixed request is a Judgment → Production
   transition, not a third mode.** If the user already asked for both, the main
   switches without asking for approval again.
   An authorized repair/implementation continues from diagnosis through worker
   implementation and acceptance in the same request unless a real scope,
   permission or environment blocker remains. An initially unknown cause alone is
   not a reason to end at analysis or ask for redundant approval.
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
  list or task contract is required. A formed plan still requires advisor review.
  One worker for one cohesive extra investigation; several only for independently
  worthwhile scopes; no
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
nothing to the system prompt and withholds its own messages from the provider; plan
mode and read-only limits come first.

### Production (제작형)

- The main owns goal, scope, non-goals, constraints and acceptance; global
  decisions and shared interfaces; ownership and dependencies; conflict
  resolution and contract changes; integration and final acceptance.
- Workers own, within their scope: needed investigation, local design,
  implementation, conflict-free local checks, failure analysis and re-fixes, and
  results with evidence. The main does not work out the whole implementation and
  have a worker type it in.
- The **first persistent product, config or asset mutation** belongs to an
  assigned worker, even one config value, a trivial edit or a single asset call.
- If worker evidence refutes a symptom, cause or supposedly fixed decision, stop
  **only that change** and return the evidence. Calling a premise "confirmed" in
  the task does not override contrary evidence; do not implement "just in case"
  to satisfy a false premise. Unrelated work continues.
- The main may read code, check diffs, run verification and talk to workers; it
  never duplicates a worker's implementation or overwrites in-progress changes.
- A blocked worker is not a takeover signal; see [Verification](#verification)
  for how the main classifies and routes it.

#### Whether to delegate, and whether to parallelize

These are two separate decisions.

- **Delegation.** A cohesive or strictly sequential unit goes to **one worker
  end to end**; "it can't be parallelized" never moves it to the main. Shared
  write sets, an unsettled shared decision or a single acceptance check define
  one cohesive unit. A single worker is a normal path, not a fallback.
- **Decomposition.** Before dispatching, list each unit's write set (the files,
  modules and assets it changes), interfaces provided or consumed, prerequisites
  and acceptance check. Disjoint write sets, settled interfaces and separate
  acceptance define independent units. Split for independent acceptance and
  context isolation, not file count or volume.
- **Parallelism.** Start every ready independent unit together in one dispatch:
  one `task` batch or parallel calls in one response, not one after another.
  When producer and consumer share only an interface, settle its names, shapes,
  errors and owner first, then dispatch both sides together. Order only for a
  real dependency, ownership or resource conflict, and only for the files it
  touches. If part of a unit waits on a running baseline, shared runtime or
  upstream result, start the rest now and hold just the affected files. Release
  those files by messaging the running worker when free (when `write` is
  available), or assign them as a later unit; never hold ready work behind them.
  A global check is no reason to serialize workers: parallel workers run scoped
  checks on their files, and the named owner runs the global suite once after
  integration. When bundling independent units into one worker or serializing
  them, state the reason in the plan. Orche-Advisor also reviews whether a whole
  unit was held back when only some of its files depended on a prerequisite.
  In Judgment, independent unknown areas or hypotheses likewise go to parallel
  bounded investigations; the main keeps the judgment.

#### The main's direct edits: a narrow exception

The main edits source directly only to integrate **already-completed worker
work** in a small finish when **all five** hold. This never permits initial
implementation:

1. the cause and the fix are settled;
2. no new investigation, design or substantial debugging is needed;
3. contract and scope are unchanged;
4. there is no conflict with another writer's ownership or in-progress writes;
5. the edit is clearly smaller than delegating it.

Integration uses fully read relevant content, never truncated or unseen content.
If it opens new investigation or design, the owning worker continues. A run of
exceptions must not make the main the implementer.
Isolated Judgment experiments and the main's designated shared-runtime
verification remain permitted; neither is a takeover of worker implementation.

#### Game assets are Production, not a separate organization

Assets (game art, conversion, packing, engine integration) follow Production:
procedural or one-shot generation of **requested deliverables is authoring, not
verification**. A worker with actual generation capability owns cohesive
creation; a generation tool being available to the main is not an integration
exception. The policy requires:

- settle style, spec, use and in-game conditions first;
- for a multi-item set, put **sample → check → remainder** into delegated
  acceptance criteria: create and check a representative sample **smaller than
  the whole set** before creating the remainder, variants and packing; small
  batches are not exempt;
- before accepting that set, read original intermediate sample evidence **and**
  final all-item coverage. The responsible worker may check the sample without
  an added Main approval gate;
- for one item, create and check that item without an artificial sample split;
- ask the user only if they requested approval or a direction choice is open;
- confirm in-game rendering and usability.

The main can own shared-runtime/engine verification, but creating deliverable
assets during a check is authoring. Non-destructive isolated diagnostic artifacts
under an analysis-only request remain Judgment, not requested asset delivery.

A reasoning model is not an image, 3D or audio generator: the policy says never to
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
resume one. Without `write`, the policy says no follow-up channel exists this
turn and directs follow-ups to a new worker with the contract, the changes and
artifact references.

The policy tells the main to continue a worker with `write agent://<id>` unless
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

A worker's success report is not acceptance. Each return ties key acceptance
criteria to the command and environment, expected versus observed result,
**original tool-output/artifact/entry references**, and unverified items. The main
checks the integrated result and reads the key original evidence before accepting,
re-running only missing checks rather than every worker step. Tests do not
substitute for actual host or engine behavior. These duties also apply to
workflow results and direct execution when delegation is unavailable.

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

The policy states that the policies are the user's configured execution policy.
Where generic defaults in the system prompt or tool descriptions differ, it tells
the model to follow the policy, in both directions:

- Judgment keeps core analysis with the main despite host lines such as "Map
  unknown code via task" or "Multi-round search MUST use Task + scout".
- Production puts implementation with workers despite "Inline first / NEVER
  delegate one slice" or "No subagents unless … explicitly requests".
- Worker-local checks are expected despite the task tool's "tasks skip
  build/lint/tests mid-flight".

That override is **guidance only**: host limits (enabled tools, concurrency,
isolation, permissions, plan mode, read-only) still bind, and the policy grants no
capability.

## Policy guidance vs runtime guarantees

| | |
| --- | --- |
| **The plugin enforces** | which text goes where: the policy once, in the system prompt, identical for every prompt of a governed session, and a counterpart in place of each of OMP's keyword notices; the skip gates (below); that the primary model, `@task`/`@default` roles, custom/specialist agents, tool permissions and task inputs are never changed; that no tool is removed from the main agent (`write` stays available); local telemetry; best-effort non-message policy observations (not delivery receipts) |
| **The plugin only instructs** | which policy the main picks for a stage, whether it delegates, reuses an existing worker or parallelizes, whether it stays within an analysis-only request, how it limits its own direct edits, and that it verifies before accepting |

There is no guarantee that the model follows the instructions, chooses the
intended policy, or that a particular model handles either policy well. The plugin
has no scheduler, dispatcher, reuse manager, classifier or approval mechanism, and
it does not block any tool call.

### Modes and skip conditions

The policy is one element of the system prompt. OMP's keyword notices get a counterpart in the transcript:

| text | when | what the model reads |
| --- | --- | --- |
| `default` (the policy) | the `task` tool is enabled | both policies and the rule for choosing, as an element of the system prompt (the advice guidance, when active, follows it). |
| `orchestrate` | a native `orchestrate-notice` is in the transcript | the native notice is replaced in place by a short notice: the user explicitly asked for orchestration, so within the current goal the main leans further toward delegation under the policy (production work and independent investigations go to workers); it does not turn an analysis-only request into permission to change the product. The two never appear together. Without `task`, a notice says orchestration was requested but `task` is not enabled for this request: judgment work is done directly, production is implemented directly within permissions or the limitation is stated precisely, delegation is never claimed or simulated, and an analysis-only request stays analysis and changes no product code, config or assets; plus the verification lines. With a native `workflow-notice` in the same keyword prefix the native `orchestrate-notice` is dropped and only the workflow supplement is added. |
| `workflow` | a native `workflow-notice` is in the transcript | the native notice stays and a supplement follows it. For that request the native workflow alone chooses execution method, agents, fan-out and reuse, overriding the policy's stage selection and delegation guidance; the supplement adds no dispatch, parallelism or reuse instruction and no "the main analyzes directly" instruction. With the policy in the system prompt it only says that the policy's task-item contract, worker-local checks, result labels, analysis-only boundary and verification apply to workflow item prompts and results, with failures routed through the workflow. Without the policy in it, it carries those duties itself. |

**System prompt.** `before_agent_start` appends the policy to the main session's
system prompt as an element of its own (tagged `<om-orche-policy>`), after
everything OMP rendered, memory recall included. The system prompt opens every
request, so the policy belongs to the provider's cached prefix: it costs its tokens
once and later requests reuse them. Session facts alone decide it (the plugin is
enabled, the session is the main one, plan mode is off, `task` is enabled), plus
the tools and the setting its text names (`todo`, `write`, `bash`, the advice tool
and `task.enableEffort`); the prompt's text never does. A user prompt, steering and
every synthetic prompt (auto-continue after compaction, the plan-approved and
guided-goal kickoffs, the `.`/`c` continue shortcut, hidden agent-attributed
prompts, retries) get the same system prompt, because a system prompt that flips
between turns breaks the cache of everything after it. Nothing is written to the
transcript. If another copy of the plugin (installed and also passed with `-e`)
already added the policy, it is not added again.

**Continuations and limits.** OMP applies the returned prompt as a per-turn
override and leaves it on the agent when the turn ends, so a turn that starts
without `before_agent_start` (an async task result, a re-yield of a messaged
worker, a worker message reaching an idle main) runs with the same system prompt.
Known limit: a rebuild of OMP's base prompt between turns (a tool-roster or skill
change) resets the agent to the plain base until the next prompt applies the
policy again, so an autonomous turn in between runs without it; that rebuild moves
the request prefix anyway. The system prompt of a turn is fixed when the turn
starts: a change of tools, of `task.enableEffort` or of plan mode during a turn
reaches the policy from the next prompt.

**Keyword notices.** OMP builds its `orchestrate-notice` and `workflow-notice`
from the prompt and persists them itself, before the user message.
`before_agent_start` sees neither them nor who wrote the prompt (a synthetic
prompt gets no keyword notices), and OMP's keyword matcher cannot be imported by
an extension, so the counterparts are derived in the `context` hook from each
native notice alone, in every request that carries it and for every such notice
in the transcript, not only the current turn's. Each is a function of that notice
and of the system prompt sent with the request, so it is identical in every later
request with the same system prompt, and a keyword turn does not disturb the
prefix after it. The workflow supplement follows the system prompt actually sent:
it only points at the policy while the policy is in it, and carries the duties
itself otherwise. Native keyword notices OMP queues before a skill prompt
(`/skill:x orchestrate`) belong to that prompt's turn and are handled the same
way. OMP's magic-keyword settings only decide whether a native notice appears.

**Earlier builds.** A policy notice an earlier build persisted (type
`om-orche-policy-notice`, mode `default`) is dropped from what the provider reads,
at every request and whether or not the plugin governs. Dropping one from the
middle of an old session moves its prefix once, at the first request after the
upgrade; the drop is the same every time.

**Skip conditions.** The plugin adds nothing to the system prompt when it is
disabled (`enabled=false`, so OMP's native behavior is untouched), in a subagent
session (subagents never re-enter), in plan mode, and without the `task` tool. It
withholds its own messages from the provider under the same conditions, except
that without `task` an orchestrate request still gets its honest counterpart: a
disabled plugin or plan mode withholds every one and leaves OMP's native notices
exactly as OMP built them, and a session that is not the main one (a subagent, or
a background clone that inherited the transcript) never sees them. A stored
`enabled` change applies from the next prompt; entering plan mode withholds the
counterparts from the next request and the policy from the next prompt. Each of
these toggles moves the request prefix once, where the system prompt gains or
loses the policy.

**Advice guidance.** The orche-advisor guidance is a stable further element of the
system prompt, appended after the policy whenever the advice tool is active,
including default turns, and never twice. It is not repeated in notices or messages,
preserving prompt-cache stability. Hooks never invoke the review model themselves.

### Durable policy observations

When enabled in a main session, the orchestration `context` hook appends a
non-message session entry of type `om-orche-policy-exposure` when its observed
policy view changes. It uses OMP's `sessionManager.appendCustomEntry`, not
`custom_message`, `sendMessage`, or a context message. It changes neither the
model-visible messages nor the system prompt, so it adds no cache-prefix text.
This is separate from aggregate telemetry and needs no new setting.

The bounded record contains schema version `1`, policy identity/revision
`judgment-production-2026-09-30-r4`, phase `orchestration-context-view`, the current
governance gate (`governed`, `plan-mode`, or `task-tool-unavailable`), and three
section digests (`system`, `orchestrate`, `workflow`). Each is SHA-256 over that
location's ordered UTF-8 text sections, each prefixed by its UTF-8 byte length and
`:`; `null` means no section was present. Only `<om-orche-policy>` system elements
and this plugin's keyword counterparts in this hook's output are hashed. Many
historical keyword notices still produce only one digest per mode.

Presence and governance are distinct: for example, an already installed system
policy can remain present after entering plan mode or losing `task`, until the
next prompt rebuild. The hook observes tool loops and autonomous continuations
that do not run `before_agent_start`, including an absent policy after a base
prompt rebuild. Preparation alone writes no observation. **This is not proof of
provider delivery**: subsequent extensions/transforms may change the view, and a
request may be cancelled or retried. It neither infers nor records the model's
selected Judgment/Production stage.

Unchanged observations deduplicate against the latest applicable record on the
active branch. Resume and forks retain an inherited baseline; a branch without
one, a `reset_boundary` (such as `/clear`), or a changed observation gets a new
record. OMP supplies the entry ID, parent linkage and timestamp; a copied record
is historical evidence, not a claim that a new provider request occurred.

No policy text, base prompt, task content, paths, tool names, credentials or raw
sessions are retained in these records. The hashes identify rendered guidance,
not user input. The master switch's native-behavior promise takes precedence:
disabled and subagent sessions make **no automatic metadata writes**, including
no "disabled" marker. Missing records therefore cannot distinguish opt-out,
subagents, an unobserved/cancelled request, an older plugin, or persistence failure.
Observation/persistence exceptions are isolated from the user turn; durability
and flushing are owned by OMP, not guaranteed by this hook.

### Task body contract

The plugin defines no separate `solutionSpace` or contract field and does not
replace the task tool. Host versions may expose their own additional metadata;
that stays under host validation. The policy asks the main to write each `task`
item (or workflow item prompt) as plain text with these sections, used instead of
the task tool's generic Target/Change/Acceptance headings:

```text
# Goal
# Scope and non-goals
# Decided and open              fixed decisions with reasons and user constraints; judgments left to the worker
# Inputs and dependencies       artifacts by reference; unverified hypotheses marked
# Acceptance and verification   by type (below)
# Return                        results, wrong premises, decisions/open issues; key criteria → command/environment, expected vs observed, original evidence references, unverified items
```

The policy asks for each item to be self-contained.

- Acceptance depends on the type: a Judgment worker's is evidence answering its
  question, not whether code changed; a Production worker's is the change plus
  verification.
- Workers do not inherit the main-session policy or conversation: relay
  applicable constraints and required execution order, not just final artifact
  specifications. Pass what they need without copying the whole policy,
  conversation, earlier reports or large logs.
- `effort`: see [Task `effort`](#task-effort).
- Worker-local checks on owned files are expected; global checks, formatters and
  shared runtimes stay with a named owner (normally the main) and never run
  concurrently.
- A worker that refutes a symptom, cause or fixed decision stops only that change
  and reports evidence, even if the task called the premise confirmed. Ownership
  conflicts and invalid prerequisites likewise pause affected changes only;
  unrelated work continues. It does not redesign the shared contract, widen
  scope, overwrite others' edits, or implement "just in case".

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

- The primary **must call `orche_advisor` once planning ends**, before executing or
  delegating the formed plan, in default, orchestrate and workflow turns alike.
  Planning ends when the goal, scope and next actions are settled enough to execute
  or delegate. The required call requests review; its verdict remains advisory,
  not an execution gate, and no approval or KEEP verdict is needed to proceed.
- Do not call for pure status answers or trivial read-only Q&A with no plan, merely
  because a turn, phase completion, worker result or auditor note arrived, or again
  on an unchanged plan. Lifecycle hooks provide guidance but do not invoke the model.
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
  errors retain one bounded retry. Truncated output retries once without
  reasoning, but only when the first attempt could have reasoned; with thinking
  off, or a model without reasoning, the identical request is not resent and the
  review fails as truncated. At most two completion attempts are made, and
  cancellation is not retried.
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

- `resolve` needs a relevance explanation and IDs of successful tool results
  (with text output) or actual user messages on this branch. Evidence may precede a delayed notice;
  an already-recorded upload result or user correction need not be repeated just
  to obtain a timestamp after delivery. `list` shows the newest ten of these
  earlier candidates; when more exist it says how to page (`list` with
  `offset=10` skips that many newest candidates, and combines with `findingId`).
  The coordinator must still check that the evidence answers the specific claim
  and covers the relevant revision: the tool requires a non-empty reason but
  does not validate its semantic relevance. Assistant claims, failed results,
  review verdicts and ledger listings cannot serve as resolution evidence.
- Resolutions are explicitly **orchestrator-reported**, not proof. The original
  note and bounded evidence excerpts stay visible to the reviewer.
- `waive` requires explicit user confirmation. An explicit `reopen` records a
  renewed concern and requires evidence after that reopening for the next
  resolution; repeated notes do not reset this boundary. A renewed auditor
  objection after a reported resolution opens a new finding. That is allowed (a
  delayed note written before the resolution is legitimately answered by the same
  evidence), but the new finding records which resolved finding it re-raises and,
  once resolved, which cited entries the earlier resolution had already cited;
  `list` and the reviewer's findings show both, e.g. "re-raises F1 after its
  reported resolution; resolved again citing evidence the re-raised finding's
  resolution already cited". Nothing is blocked; the reviewer weighs it.
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
pruned (`prunedAt`), its tool flagged as uneventful, or that carries no text
(an image-only capture, empty output) cannot be cited for a new resolution:
evidence must be auditable as text. A resolution recorded earlier stays in force
when its cited output is pruned later or holds no text, and is listed with
`(output later pruned from context)` or `(no text output)` in place of OMP's
placeholder. Any prompt the user gave counts, including one that starts with `/`
(a path, an unknown command name): commands never become messages. So does a
user-invoked `/skill:` prompt or a writable-collab peer's prompt, which OMP
persists as a user-attributed `custom_message` (the host's `isUserTurnInitiator`,
applied through the same turn-start test as the keyword notices): it starts a new
scope, and its visible text is citable as a user message. Agent-attributed
skill injections and other custom messages are neither.

The bundled auditor is instructed to stay silent on confirmations, praise,
progress commentary and checks that already passed, and never to emit `nit`
notes. It reports concrete remaining contradictions or evidenced
irreversible-operation risks, not unfinished tasks that have not been called
complete. Claims are judged against the finished run's final state, not against
individual mid-run updates. It never directs the primary's pace or method
("stop", "wrap up", "answer now"). A `blocker` quotes the completion claim it contradicts.
Screenshots reach the auditor only as placeholders, so a placeholder is not
counter-evidence; a screenshot-only claim should be labeled as visual
observation or backed by extracted state. Findings are never automatically marked
resolved. The reviewer likewise assesses evidence against the claim and revision,
not against the note's delivery time.

The plugin enforces the evidence admission contract before showing or persisting
new notes, and applies the same contract when reading older cards in the ledger:

- `nit` notes are withheld.
- A concern or blocker with no quotation (`"…"`, `“…”`, `‘…’`, `「…」`), no
  backticked output/identifier and no `path.ext:line` is withheld as uncited.
  Double quotes are paired left to right, so `the "x" claim and then "y"` holds
  two short quotes, not one quotation spanning the words between them.
- A blocker without a quotation is treated as a concern.

Other advisors' notes and old persisted cards are untouched. New withheld notes
are never delivered. These are string checks, not a semantic judgment: a process
directive that happens to cite a backticked value can still arrive as a concern,
and a well-founded concern with no citation is withheld.

`review_findings` with an unknown `findingId` fails with the current ids
(unresolved first, bounded) so a guessed id is corrected in one step.

The plugin-run Verification Auditor audits **once per completed primary run**, after
the final answer, including text-only answers. Mid-run turns and tool batches do
not trigger audits. Workers, disabled-plugin runs, and aborted/error runs without
a final answer are excluded. Auditing runs in the background: a new primary run
aborts an in-flight audit and discards its stale result.

Its model is the `verification-auditor` role, resolved through OMP's model registry
without a plugin DEFAULT fallback. The [OMP setup](#omp-setup) fills
`modelRoles.verification-auditor=@smol` only when unset. Tools are read-only
`read`, `grep` (literal search), and `glob`, confined to the session cwd including
symlink targets. The input contains the request, a bounded primary transcript
(tool calls/results included), and the final answer.

Admitted concern and blocker notes are shown in the transcript and persisted in
the finding ledger for `review_findings` and `orche_advisor`. Both severities
automatically start one primary follow-up carrying the notes. That follow-up is
also audited, but its findings never start another automatic follow-up: at most
one consecutive automatic follow-up. A new user request resets the cap. No admitted
notes means silence and no follow-up. Provider/model errors or invalid output
produce one visible `Verification audit failed: ...` line, never a clean audit;
there is at most one provider retry.

OMP's native advisor runtime is **not used, installed, enabled, or reconfigured**
by the plugin. Disable the native advisor separately to avoid unrelated native
per-turn audits. Plugin `enabled=false` disables automatic audits; manual
`orche_advisor` and `review_findings` remain available. Old native auditor cards
remain readable by the finding ledger.


Advice text returned to the model has terminal escapes, control characters and
invisible format characters (zero-width, bidirectional, soft hyphen, word joiner,
the Unicode tag block used to smuggle hidden text; every `\p{Cf}` character)
removed and is capped at 8000 characters. The
reply must open with one verdict line (`VERDICT: KEEP`, `ADJUST`, `REPLAN` or
`ESCALATE`, alone or followed by a rationale after ` - `, `:`, `,`, `;` or `.`,
or a bare trailing period; bold markers around the heading, the colon or the token
are tolerated) and
then the `ISSUES:`, `ORCHESTRATION CHANGES:` and `AVOID:` headings once each, in
order (bold headings such as `**ISSUES**:` or `**ISSUES:**` are accepted). Trailing
spaces and inline content after a heading (`ISSUES: None`) are
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
  (default `false`); otherwise OMP strips it, and the policy leaves its `effort`
  paragraph out.
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

The policy's `effort` paragraph, rendered only while that setting is on: `lo` for
fixed mechanical work, `med` for bounded investigation or implementation, `hi` for
a substantial unresolved cause, design or correctness question; keep any effort
the user specified; do not send analysis at `hi` by default. The host maps it onto
the worker model's own range, not by name, and an explicit effort overrides the
task role's level and `auto`: omit it to keep those. This is guidance, not
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

The three items:

| OMP key | value | why |
| --- | --- | --- |
| `modelRoles.verification-auditor` | `"@smol"` | the auditor's model. With `smol` unset, OMP resolves `@smol` to your default model |
| `modelRoles.orche-advisor` | `"@slow"` | the plan advisor uses your Thinking model. With `slow` unset, OMP resolves `@slow` to your default model, so the advisor runs on the main model |
| `task.maxRecursionDepth` | `1` | om-orche's main session owns all worker distribution, so workers must not spawn sub-workers. At depth `1` the main session (depth 0) can still delegate through `task`, while a worker (depth 1) runs its task directly. OMP's default is `2`. Do not set `0`: it removes `task` from the main session and disables Production delegation |

**Cost.** Each completed primary run starts an audit on `@verification-auditor`;
tool investigation and the single allowed provider retry may add model calls.
An admitted finding can start one automatic primary follow-up and its audit.
To disable automatic auditing, disable the plugin with
`omp plugin config set om-orche enabled false`. Individual `modelRoles` entries
are edited in `~/.omp/agent/config.yml`, not with `omp config set`.
Values set before the first start are kept; changes afterwards stick because
setup never rewrites resolved items. To allow deeper delegation again, set
`omp config set task.maxRecursionDepth 2`; user-owned values are never overwritten.

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
you later delete one of those OMP keys. Concurrent main sessions share one setup
attempt in a process; across processes, setup holds the state directory's
`setup.lock` and re-reads the marker before changing anything, so only the winner
applies and reports it. The lock uses the same directory-token protocol as
telemetry's lock, but a separate path so telemetry does not block setup. A lock
wait is bounded to one second. If acquisition or a write fails, the setup logs a
warning and tries again at the next start, and writes no marker:

```text
om-orche OMP setup failed and will be retried at the next session start: <error>
```

**What you see.** Only when the setup wrote something, and only in the
interactive UI, a notification lists just the keys it wrote:

```text
om-orche configured OMP once, filling only what was unset (existing values were kept):
  modelRoles.verification-auditor: "@smol"
  modelRoles.orche-advisor: "@slow"
  task.maxRecursionDepth: 1
Edit roles in ~/.omp/agent/config.yml.
The main session delegates through `task`; workers run their task directly. Allow deeper delegation with `omp config set task.maxRecursionDepth 2`.
```

The roles line appears only when roles were written; the delegation line appears
only when `task.maxRecursionDepth` was written. In every mode an info line goes
to the OMP log, listing only what was written:

```text
om-orche OMP setup wrote modelRoles.verification-auditor="@smol", modelRoles.orche-advisor="@slow", task.maxRecursionDepth=1
```

**Re-running.** Remove the marker, then start a new main session; the setup runs
again and is still fill-only. Either of these removes it: reinstalling the plugin
(`omp plugin uninstall om-orche` first), or
`omp plugin config delete om-orche hostSetupVersion`. `/om-orche reset` keeps it:
a reset that dropped the marker would run the setup again and fill in keys you
deliberately deleted.

**Existing installs.** If om-orche is already installed without the marker, the
setup runs once at the next main-session start after you upgrade (fill-only).

**Upgrading from setup v1.** Each item carries the setup version that introduced
it, and a run applies only items newer than the stored marker. An install with
`hostSetupVersion: 1` therefore gets only `task.maxRecursionDepth` at its next
main-session start (fill-only, so an existing value is kept), and the marker
becomes `2`. The two roles are not touched again, so keys
you deleted after the first setup stay deleted. Until that start, `/om-orche
status` shows the setup as pending.

## Commands

| Command | Effect |
| --- | --- |
| `/om-orche status` | Whether the plugin is enabled; execution policy (`judgment/production (system prompt)`, or `native (plugin disabled)`); primary model unchanged; native `task` worker and `@task` role; the `OMP setup` row: `applied (v2)` (the stored version, shown even when the plugin is disabled), `pending — applies at the next main session start` (also for an older stored version, such as `v1`), or `skipped — plugin disabled`; retired settings and leftover tier roles still present; when OMP's plugin settings could not be read, the failure and the settings still in effect; and, when the main session runs the Verification Auditor, its tokens (input, output, cache read and write), cache hit ratio and cost from OMP's own advisor statistics (`getAdvisorStats`: the token counts follow the advisor's current transcript, the cost is cumulative). |
| `/om-orche stats` | Live-epoch usage: the main session's provider usage (requests, uncached input, cache read and write, output, cost) with its cache hit ratio, then the task workers' counters, each with its own cache hit ratio; plus the read-only Jev-routing-era and tier-era history. It re-reads `telemetry.json` first, read-only, so counts other OMP processes have written are in it, and telemetry just turned on over an older file has migrated it. When the last write of the counts to disk failed (and none has succeeded since), the first line says why. |
| `/om-orche reset` | Clear plugin-owned telemetry files and the plugin's stored settings in OMP's plugin store, except the one-time [setup](#omp-setup) marker, which stays. A project's `plugin-overrides.json` is never edited: keys it still sets are named and stay in effect. |

`status` reports no credential, model or gate rows and no last decision: the
plugin makes none. If `@task` does not resolve, status says `@task does not
resolve in this session; task workers use the main session's active model.`; the
plugin does not route around it. Retired
settings still stored for the plugin (see
[Migrating from Jev routing](#migrating-from-jev-routing)) and leftover
`@task_easy`/`@task_hard`/`@task_challenge` roles are listed as unused and left
in place. Unknown subcommands get a warning.

## Privacy and security

The policy path performs no network I/O and sends nothing anywhere: the policy
is built locally from fixed text, the names of the enabled tools and one host
setting, and joins the system prompt sent with the conversation. It is not
written to the transcript, and no prompt text is copied to telemetry.

The durable policy observations contain bounded guidance hashes and lifecycle
facts, not policy or task text; their opt-out and observability limits are
described under [Durable policy observations](#durable-policy-observations).

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
A running main session reads the setting again before each user turn, so
`omp plugin config set om-orche telemetryEnabled false` (or `true`) takes effect
from its next turn, without a restart.
The data directory deliberately keeps its historical name (`jev-router`) so
telemetry history is neither discarded nor silently relocated.

`telemetry.json` (v7) holds a **live epoch** and two read-only historical
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
- **Provider usage and the cache hit ratio (`mainSession`, and the provider
  fields of `workers.task`):** what the provider reported for each finished
  assistant message, taken from the host's `message_end` event of the session
  the message belongs to: the main session's own goes into `mainSession`
  (`requests`, `inputTokens` — uncached input —, `cacheReadTokens`,
  `cacheWriteTokens`, `outputTokens`, `costUsd`), a generic `task` worker
  session's into its `workers.task` row (the same fields, without the cost).
  A message that reported no tokens, such as a request that failed before the
  provider answered, is not a request. Only these numbers are kept, never a
  word of the message. `stats` prints the **cache hit ratio** as `cacheRead ÷
  (input + cacheRead + cacheWrite)`: the share of prompt tokens the provider
  served from its cache, so a change that helps caching shows as a higher
  ratio. The workers' figures come from each worker session's own messages, not
  from the progress frames: a frame folds input, output and cache writes into
  `tokens` and carries no cache reads. Not counted: subagents other than the
  generic `task` worker, `/tan` clones, and requests outside a session's turns
  (compaction summaries, titles, the advisors' own requests — the Verification
  Auditor's usage is in `/om-orche status`). Like every counter these follow
  the telemetry choice of the session's top-level session, accumulate per
  epoch, and start again at zero after a `reset`.
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
  `telemetry.lock` (a directory, present only during a write, a migration or a
  reset), so no process overwrites another's counts. The lock holds up against
  stopped and dead holders, not only live ones. A holder takes it by renaming a
  staged directory that already contains its token file onto `telemetry.lock`,
  which succeeds only while the lock is free, and it publishes by renaming that
  token file over `telemetry.json`. The token leaves the lock in the same step,
  so publishing succeeds only for a holder that has held the lock without a
  break since it took it. A lock untouched for five seconds belongs to a process
  that died, or was stopped for that long, and any waiting process breaks it by
  removing that token. A process whose lock was broken publishes nothing and
  keeps its counts for its next write, so a broken lock costs a retry, never
  counts. A write that cannot get the lock within a second keeps its counts for
  a later attempt too. A lock file left by an older plugin version under the same
  name is waited for while fresh and broken when stale. `/om-orche reset` takes
  the same lock before deleting. A process that then finds the file it last
  wrote gone starts a new epoch (new id and start time) with its next write and
  writes the counts it had not yet written into it, so a reset in one process is
  not undone by another. Worker tracking is per process, so a worker already
  running elsewhere settles into the new epoch without a start of its own.
  Every session of a process shares one writer, but not one choice: a main
  session's own `telemetryEnabled` (its global setting plus its project's
  override) decides whether the workers of its session tree are recorded,
  whichever main session read its settings last, so an ACP host that runs one
  project with telemetry off and another with it on keeps both choices. A
  subagent, whose working directory can differ (an isolated worktree has no
  project override), follows the main session above it and never switches
  anyone's setting. Only a main session loads or migrates the file, and the
  writer writes and migrates while any main session wants telemetry.
  `/om-orche stats` re-reads the file first: it shows what the other processes
  have written with this process's own unwritten counts on top; what another
  process has not flushed yet (up to about two seconds) is not in it. The
  re-read takes no lock and writes nothing.
- **A file replaced while a process runs:** every write, and every `/om-orche
  stats`, reads the file again, so a file another process replaced with a newer,
  an older or an unreadable one is left untouched and recording is suspended, as
  at start-up; only a start-up converts an older file.
- **A write that fails:** no permission on the state directory, a full disk, a
  lock held for too long. The counts stay in memory, `/om-orche stats` starts
  with the reason and how many attempts have failed, the OMP log gets one
  warning per distinct failure (`om-orche telemetry could not be written to
  <file>: <reason>; …`), and the write is retried after 2 s, then 4 s, 8 s and so
  on up to 32 s, without waiting for a new frame, until one succeeds. Then the
  note goes away, and a later failure warns again. A process that ends with
  counts unwritten tries once more as it shuts down.

`/om-orche stats` shows the live epoch (the main session's provider usage, then the task workers) plus the read-only Jev-routing and tier
eras. `decisions.jsonl` is no longer written; an existing file stays on disk
untouched and is deleted only by `/om-orche reset`.

Worker usage is read from OMP's `task:subagent:progress` and
`task:subagent:lifecycle` frames on the session event bus, which fire for sync
and background (`async.enabled`) spawns alike. The host's `aborted` status is
shown as cancelled.

### Upgrading to v7

Migration is automatic, idempotent and non-destructive:

- **v6 → v7:** v7 only adds the provider-usage counters, so the file keeps
  everything. The original v6 bytes are first preserved as
  `telemetry-history/v6-<sha256>.json` (never overwritten), then the v7 file
  replaces `telemetry.json` with the v6 live epoch — its id, start time and
  every counter — and both read-only sections carried over unchanged. The new
  counters start at zero: they cover the epoch from the upgrade on.
- **v5 → v7:** the original v5 bytes are first preserved as
  `telemetry-history/v5-<sha256>.json` (never overwritten), then the v7 file
  replaces `telemetry.json`. The v5 live epoch moves into the read-only
  `jevRouting` section; the v5 file's tier-era `historical` section is carried
  over unchanged; a new empty live epoch starts.
- **Older files** (before v5) keep the tier-era conversion.
- **`telemetryEnabled=false`:** the old file is shown as a read-only deferred
  view (a v6 file with its live counters, an older one as its read-only eras)
  and is migrated once telemetry is enabled: at the next main session
  start, or by `/om-orche stats`, which migrates before it shows anything.
- **Newer than this plugin:** the file is left untouched and recording is
  suspended until `/om-orche reset`. This is also what keeps an older plugin
  process from stripping the counters it does not know: it suspends itself on a
  v7 file instead of rewriting it.
- A failed backup or write leaves the original active and suspends recording.
- **Several processes migrating at once:** the backup and the conversion both
  run under the same lock, on the file as it is once the lock is held; a
  process that gets there second takes the first one's converted file.

`reset` deletes only plugin-owned files (`telemetry.json`, `decisions.jsonl`,
migration temporaries, `telemetry.v<N>.json` backups, `telemetry-history/`
snapshots, and lock staging directories an acquisition that died left behind)
while holding the lock, and reports any it could not remove.

### Rolling back

An older plugin (v5 or v6) that finds a v7 `telemetry.json` suspends itself under the
newer-version rule and does not read or overwrite it. To roll back: stop all
OMP processes, keep a copy of the v7 `telemetry.json`, restore the preserved
`telemetry-history/v5-<sha256>.json` (or `v6-<sha256>.json`) as `telemetry.json`,
then install the older package. Data recorded in the v7 live epoch after the
upgrade is not in the restored file.

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
| `debugLogging` | `false` | one metrics-only line per prompt and per keyword notice in the OMP log: `om-orche.policy mode=<default\|orchestrate\|workflow>` or `om-orche.policy skip=<reason>`; never prompt text |

A change made with `omp plugin config set` (or in a project's
`plugin-overrides.json`) reaches a running session: a main session reads the
stored settings again before each user turn, so the new value applies from the
next turn without a restart. A subagent keeps what it read when it started. If
OMP's plugin settings cannot be read (a corrupt or unreadable
`omp-plugins.lock.json`), the settings already in effect stay, one warning goes
to the OMP log and `/om-orche status` shows the failure; at session start,
with nothing read yet, the defaults apply. A store that does not exist simply
means defaults.

There is no setting to choose a policy mode or to turn delegation on or off.
The one-time setup keeps an internal marker, `hostSetupVersion`, in the same
settings map; it is not a setting, is not listed by `omp plugin config list`, and
is described under [Re-running](#omp-setup). `examples/config.yml` shows the
model roles you can customize in your OMP config.

`/om-orche reset` clears the plugin's stored settings from OMP's plugin store,
but keeps the setup marker: dropping it would run the setup again and fill in
keys you deliberately deleted. A project's `plugin-overrides.json` belongs to the
project and OMP has no API to edit it, so the plugin never does: if it still
sets keys, the reset names them and says they stay in effect in that project.

## Migrating from Jev routing

Finish or cancel running work, then stop every OMP process that still runs the
previous plugin version before starting one with this version. A process that
loaded the old extension keeps its hooks and keeps writing a v5
`telemetry.json`, which would overwrite the upgraded file.

**What changed.** The plugin no longer calls Jev/TypeSafe or any other service,
and no longer classifies requests as DEFAULT or ORCHESTRATE. Confidence/margin
gates, the todo-triggered reconsideration and promotion, and the per-decision
timeout are gone. Every governed prompt gets one deterministic execution policy,
in the system prompt, carrying the Judgment and Production policies (see
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

**Telemetry.** The file is upgraded (to v7) on first load; the v5 original is
preserved under `telemetry-history/`. See [Upgrading to v7](#upgrading-to-v7)
and [Rolling back](#rolling-back).

**Independent policies.** Mandatory post-planning Orche-Advisor review does not
change the Verification Auditor or findings ledger. Hooks never request plan
advice automatically. Native workflow mode keeps its execution method. Primary
model, `@task`, agents and tool permissions are never changed.

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
- **Advice:** historical approvals have no effect; required post-planning review
  is advisory and does not authorize or block execution.
- **Telemetry:** the v4 tier-era counters were kept as historical data and are
  carried unchanged into v6.

Earlier releases' `mainModelRoutingEnabled`, `mainNormalRole`, `mainDeepRole`,
`normalTaskRole`, `deepTaskRole` and `task-deep`/`task-normal` agents are also
unused. Uninstall leaves role assignments and credentials intact.

## Troubleshooting

Turn on `debugLogging` and read the OMP log. Each prompt of a governed session
logs `om-orche.policy mode=default` (the policy is in its system prompt), and each
native keyword notice logs `om-orche.policy mode=<orchestrate|workflow>` once; a
prompt the plugin stays out of logs `om-orche.policy skip=<reason>` with a reason
from `disabled`, `not-main-session`, `plan-mode` and `task-tool-unavailable`. The
prompt's text never decides, so an empty or synthetic prompt logs the same line as
a user's.

| symptom | cause |
| --- | --- |
| no policy in a request's system prompt | one of the skip reasons above: the plugin is disabled, a subagent session, plan mode (the plugin never toggles plan mode; only the user's `/plan` enters it), or no `task` tool. A turn OMP starts without a prompt (an async task result, a worker message) keeps the system prompt of the last prompt, unless OMP rebuilt its base prompt in between |
| the model did not delegate, reuse a worker, parallelize, or picked the other policy | the policies are guidance, not enforcement; the model decides per stage. Check that `task` (and `write` for reuse) are enabled on the turn |
| both a native notice and the plugin's seem missing | with `enabled=false` OMP's native behavior is untouched and the plugin adds nothing |
| a native `orchestrate` request shows only one notice | expected: the plugin's short `orchestrate` notice replaces the native one in place |
| the request prefix moved once | expected when the plugin was toggled or plan mode entered or left (the system prompt gains or loses the policy), when a tool the policy names (`todo`, `write`, `bash`, the advice tool) or `task.enableEffort` changed, or at the first request after upgrading a session an earlier build had persisted a notice into |
| a worker cannot be messaged | the host reported it isolated or hard-aborted, or delivery failed; a new worker with the contract, changes and artifact references is the correct path. A missing "now idle" hint alone does not mean it cannot be continued |
| `OMP setup` is not `applied (v2)` in status | `skipped — plugin disabled`: om-orche is disabled (`enabled=false`). `pending — applies at the next main session start`: no main session has started since install or since upgrading from setup v1; an item is set only for the current session (CLI flag, `--config`, protocol pin; RPC and ACP sessions pin `task.maxRecursionDepth` themselves), which leaves it pending until a session start without it; or a write failed, in which case the OMP log has the `om-orche OMP setup failed and will be retried at the next session start` warning and the next start retries |
| the Verification Auditor does not run | the primary has not produced a final answer, `modelRoles.verification-auditor` is missing/unresolvable, or the plugin is disabled. Errors appear as `Verification audit failed: ...`; silence otherwise means no admitted notes |
| workers can spawn sub-workers, or `task` is missing in the main session | `task.maxRecursionDepth` is not `1`. The setup fills it once with `1`; a value you had set (`2` or more lets workers delegate, `0` removes `task` from the main session) is kept. Set `omp config set task.maxRecursionDepth 1` to restore the intended setup |
| `orche_advisor` returns an error about a missing role | `modelRoles.orche-advisor` is unset. The setup fills it once with `@slow`; if the role was removed since, set it again under `modelRoles` in `~/.omp/agent/config.yml` |
| `@task does not resolve in this session` in status | expected when `modelRoles.task` is unset: task workers use the main session's active model. Assign `modelRoles.task` in `config.yml` only if you want a different worker model |
| `Retired settings still stored` in status | delete the listed keys with `omp plugin config delete om-orche <key>`; they have no effect |
| telemetry suspended | the file was written by a newer plugin version, or a migration backup/write failed; `/om-orche reset` clears it |
| `Telemetry cannot be written to …` at the top of `/om-orche stats` | the last write of the counts failed: the state directory is not writable, the disk is full, or another process has held `telemetry.lock` for too long (a lock left by a process that died is broken after five seconds). The counts are kept in memory and the write is retried on its own, after 2 s, 4 s, … up to 32 s; the note goes away with the first write that succeeds. The reason is also in the OMP log as `om-orche telemetry could not be written to …` |
| `The stored settings could not be read` in status | OMP's `omp-plugins.lock.json` is corrupt or unreadable. The settings read last stay in effect (the defaults, when none was read yet), and the OMP log has the `om-orche could not read the stored settings` warning. Repair or restore the file; the next turn picks it up |

## Uninstall

```bash
omp plugin uninstall om-orche
```

Removes the package, the plan-advice tool, the bundled auditor and the plugin's
guidance; OMP's native `task` behavior and orchestrate notice return unchanged.
Notices an earlier build persisted stay in those sessions' transcripts as hidden
messages: while the plugin is installed they are withheld from the provider, but
once it is uninstalled nothing withholds them, so a resumed session keeps sending
them until a compaction summarizes them away. The current policy persists no notices;
auditor findings and lifecycle records remain in session history.
The OMP settings the [OMP setup](#omp-setup) wrote stay in your config:
`modelRoles.verification-auditor: "@smol"`, `modelRoles.orche-advisor: "@slow"`,
and `task.maxRecursionDepth: 1`. Remove or change them yourself. Older releases
also enabled OMP's native advisor; this release never manages that switch.
Other OMP model-role assignments
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

`bun test` covers the policy in the system prompt (identical across user,
steering and synthetic prompts, absent where the plugin does not govern), the
stability of the request prefix across turns, the counterparts of OMP's keyword
notices and their dependence on the system prompt, dropping notices an earlier
build persisted, advice verdicts and real error handling, absence of plugin
execution gates (including old persisted approval records), finding
evidence/lifecycle, settings and retired settings, telemetry migration and worker
accounting, status rendering, and durable policy observation gates, hashes,
branch baselines, privacy and context isolation. These deterministic tests do
not establish how a model behaves; policy prose is not snapshot-tested.

### Opt-in multi-step policy evaluation

The development-only evaluator runs real model conversations over inert fixtures
with a main/worker tool adapter. It exercises analysis-only boundaries,
delegation with an unresolved cause, refuted premises, viable/unavailable worker
reuse, evidence acceptance (complete/missing/failed), assets, shared-runtime
ownership with publishing preflight, ready independent units dispatched together,
and cohesive units kept with one worker. Scoring uses event-backed invariants,
not prose matching or an LLM judge.
Reports declare their scoring version/notes. Events cannot establish private
reasoning or cause attribution: the unknown-cause case accepts a worker's fresh
pre-mutation fixture inspection or failing reproduction, with its own actual
post-repair check; failing-before is recorded, not a universal requirement.
For settled asset specifications, the responsible worker or main may check a
fresh sample's format/state before batching—no extra user/Main approval gate is
imposed. Final asset acceptance may combine genuine per-file format/spec rows
from asset, runtime and preflight checks, but all requested files must be covered
by fresh hashes/versions before acceptance and match captured current bytes.
Sample proof still precedes the remainder, authoring remains worker-owned, and
the absence of engine/visual verification must be explicit. The unrelated-label
goal may be proven by a real Main read of current valid JSON with `label: new`,
not only a named fixture check; summaries, citations, wrong, stale or late reads
and stopping the unrelated owner do not count.

```bash
bun run eval:policy -- --help
bun run eval:policy -- --list
bun run eval:policy -- --case analysis-only --model provider/model:low --check

# Paid model calls: opt in explicitly; choose an existing authorized model.
bun run eval:policy -- --case unknown-cause,refuted-premise \
  --model provider/model:low --output /tmp/orche-policy-run-new

# Paired fresh fixtures: current policy vs a single component omission.
bun run eval:policy -- --case evidence-acceptance \
  --model provider/model:low --omit-component evidence
```

`--case` is repeatable or comma-separated; without selection all cases run. IDs
are `analysis-only`, `unknown-cause`, `refuted-premise`, `reuse-viable`,
`reuse-unavailable`, `evidence-acceptance`, `evidence-missing`, `evidence-failed`,
`assets`, `shared-runtime-publishing`, `independent-units`, `partial-dependency`,
and `cohesive-units`.
Without `--model`, only the configured `modelRoles.default` is used, with no
fallback. `--agent-dir` selects an existing
OMP agent directory. `--check` validates selection/configuration without model
calls. Importing the runner or running `bun test test/policy-behavior.test.ts`
does not perform paid calls.

Default per-case bounds shared across main and workers are `--max-calls 48`
(SDK completion invocations), `--max-tools 160`, and `--timeout-seconds 300`.
`--max-tokens 1536` bounds each SDK completion, not the whole case. Internal
transport retries are not counted as separate model calls; the wall-time bound
still applies. Override these limits explicitly if needed. `--omit-component`
accepts `selection`, `production`, `reuse`, `evidence`, `assets`, or
`decomposition`; omission compares one component at a time on fresh equivalent
fixtures and does not presume that removal degrades behavior.

`--output` must name a nonexistent directory; otherwise a fresh retained
OS-temp directory is used. `report.json` aggregates pass/fail/incomplete results,
event-backed criteria, model/effort, policy hashes, call/usage data and unexercised
cases. Per-case `trace.jsonl`, `state.json`, `policy.txt`, and `result.json` retain
the trace, final inert-file state/raw evidence, actual policy and result. The
mutable fixture sandbox is removed. Reports contain synthetic fixture/model
content, not real user sessions; review them before sharing.

Aggregate and per-case results declare `schemaVersion: 6`, adapter revision
`safe-fixture-tool-chat-v5`, and `scoringVersion: 5`. Aggregate reports
list supported `decisionLimitCodes`. The evaluator's `decision.limits` accepts unique
machine-readable codes `no-engine-visual-verification` and
`no-external-publishing`, not free-form prose.
An empty array is valid when neither adapter limit applies. Human explanations
remain in original tool evidence and the trace; the codes keep declaration and
scoring on the same explicit contract.

`partial-dependency` requests a recorded baseline zero-check before product
changes, a zero-acceptance repair preserving positive counts, and three SVG
tiles, without a parallelism hint. It fails when the first assets task attempt
(including rejected paths) comes in a later Main response than baseline
completion, or the first product write precedes the baseline evidence. It also
requires current raw zero and all-tile acceptance evidence and sample-first
asset checks, as in `independent-units`. Response IDs measure dispatch intent,
not actual concurrent execution in this synchronous tool-chat adapter.

The three paired pilots on `anthropic/claude-opus-5-5` retained at
`/tmp/orche-pd-{1,2,3}` all completed: current and decomposition-omitted variants
each failed only the ready-assets criterion. Trace inspection found baseline
completion in Main response 1 and the first valid assets task in response 2,
with no rejected calls; baseline-before-write and acceptance evidence passed.
The case is retained because current policy still exhibits the gap, not because
these runs demonstrate a causal improvement from the decomposition line.
Those pilot reports carry scoring version 4; version 5 marks the retained
partial-dependency scoring contract.


`decision.status` is the **final outcome of the current user request**, not a
Judgment/Production choice or an intermediate-stage marker:

- `analysis`: an explanation/analysis/design-only request is fulfilled, with no
  requested implementation;
- `accept`: all authorized requested work is satisfied;
- `blocked`: some requested change cannot be fulfilled because of a refuted
  premise, scope, permission or a real blocker, even if independent work completed.

Reports expose `decisionOutcomeMeanings` from the same canonical interface
definitions. `trace.phase` indexes user requests, not the model's selected mode.
The adapter neither automatically relabels decisions nor parses prose to infer
outcomes; scoring remains evidence-based.

Structured worker reports expose `kind`, `status`, `summary` and
`declaredEvidence`. A normally stopped worker returning visible text instead of
`worker_return` is delivered as `kind: unvalidated-text`, `status: unvalidated`,
with `declaredEvidence: []`, not inferred success or refutation. Its text is
credential-redacted before transfer/truncation, capped at 2,000 code units, with
bounded actual worker/provider/model/call/response/history provenance and
truncation flags. Separate `observedCheckArtifacts` contains the newest 16 actual
current-run `{path, eventId}` check references plus `observedCheckArtifactCount`;
these are observations, not worker claims.

Text delivery triggers no automatic retry, extra model call, decision or
deliverable mutation. Normal diagnostic context records are still saved, and the
original SDK response remains in the same resumable worker history. Main must
inspect evidence before deciding. Main text-only termination remains
incomplete, and errors, length limits, aborts, empty or malformed responses are
not accepted. Text alone never satisfies scoring gates that require explicit
structured success or refutation. Requested deliverables and unrelated product
files remain product state despite sandboxing; only evidence/context artifacts
are diagnostic.
The task's capability description comes from the actual worker tool roster and
generator/check descriptors, not assumptions about unavailable tools or added
delegation/sample instructions. Descriptor absence as a behavioral cause is
unverified.

**Limits:** this adapter performs real provider/worker conversations and actual
JSON/SVG file operations, but is not OMP's native `task` runtime, a real UI/engine
run, or visual verification. It exposes no arbitrary code, shell, network or
host-filesystem access to the model. Publishing is preflight-only; the external
operation is blocked. A passing score therefore cannot substitute for production
host/engine verification, and a bounded/incomplete run is not a pass.

### Verification record

OMP 18.4.1 is the compatibility target.

**Current follow-up (2026-09-30, policy r4, adapter v5/scoring v3).**
`bun run check && bun run lint && bun test`: TypeScript clean, lint 0 errors with
exactly 2 pre-existing `no-control-regex` warnings, and 418 tests passing, 0
failing, across 20 files (1,697 assertions).

One fresh CLI run (`EHqZF1`) completed with exit 0 and both selected cases
passing: assets 11 model calls/11 tool calls; refuted-premise 12/12:

```bash
bun run eval:policy -- --case assets,refuted-premise --model @smol:low \
  --max-calls 48 --max-tools 160 --timeout-seconds 300
```

The unchanged model resolved to `openai-codex/gpt-6-luna:low`; schema version 5,
adapter `safe-fixture-tool-chat-v5`, scoring version 3, policy revision
`judgment-production-2026-09-30-r4`, and evaluator policy hash
`7cc1858e4f250c379555cd60ad3d212265b7e5134b5e0c959ee845d40879e0eb`.
Original task/events/state were inspected: the asset contract passed sample →
check → remainder to the worker, all generation was worker-owned, and Main read
original sample and final evidence before accepting. The refuted case inspected
the actual counterexample, left the product unchanged, verified completed
independent work, and reported the unsupported requested remedy as `blocked`.

Only these two cases were freshly rerun on this revision—not all ten, a
statistical compliance rate or a general guarantee. Diagnostic regrading is not
counted as a new model run; all older failure reports remain preserved. These
adapter results do not establish native OMP task behavior or real engine/visual
verification.

**Recorded integration (2026-09-30, policy revision
`judgment-production-2026-09-30-r2`, before the r3 asset clarification).** `bun run check && bun run lint && bun test`:
TypeScript clean, lint 0 errors with exactly 2 pre-existing `no-control-regex`
warnings, and 387 tests passing, 0 failing, across 20 files (1,563 assertions).
A real isolated OMP SessionManager smoke confirmed durable non-message policy
records, unchanged context, inherited fork baseline and fresh reset-boundary
baseline. Those records remain context-view observations, not provider-delivery
receipts.

The opt-in live evaluator used `@smol:low`, resolving to
`openai-codex/gpt-6-luna:low`, with evaluator policy hash
`b4ce2f4d42d7f7e3800838c0d15f7872b484c2273f0e302c6cfe8fcc335a196b`.
Latest per-case observations across the initial full-ten run (`YT1qer`) and
corrective affected-six run (`5mMu90`) were **8 pass, 1 fail, 1 incomplete**—not
one clean run or a statistical compliance rate. The first run had provider
connection interruptions and a decision-limit schema mismatch; the second used
the corrected schema and reran affected cases after connectivity recovered.
The assets case still failed: the main generated all three assets directly and
skipped sample-first sequencing. The refuted-premise case remained incomplete
because a worker returned plain text instead of the adapter's required
`worker_return` under the pre-v3 adapter; this is not evidence of a native OMP
policy failure. Original
failure reports are preserved for comparison, not replaced by prompting or
scoring until green. The adapter still does not establish native OMP task
behavior, engine/visual verification or real publishing.

The older checks below are **historical records of the source versions tested
at the time**, not current suite counts or claims that later features were
exercised.

**Historical static and unit checks (before durable policy observations).**
`bun run check` clean; `bun run lint` 0 errors (2 existing `no-control-regex`
warnings); `bun test` 174 pass, 0 fail across 13 files. These deterministic checks
were not evidence of model behavior; incidental policy-prose tests have since
been removed in favor of mechanism invariants and opt-in behavioral evaluation.

**Mechanism checks** (pinned OMP 18.4.1 CLI, isolated agent directory,
deterministic local fake model, no paid requests). They cover policy placement,
explicit `orchestrate` replacement, `enabled=false`, plan mode, zero TypeSafe
requests, reuse telemetry counts and the v5 → v6 migration. The first bullet was
recorded when the policy was still a message added to every request; the second
bullet checks the system-prompt design.

- One identical policy notice in every main request (positioned before the user
  prompt) and none in worker requests; an explicit `orchestrate` request replaced
  the native notice in place with the advisor supplement attached once;
  `enabled=false` left the native notice byte-identical and added nothing; plan
  mode added no notice; a TypeSafe recorder received zero requests, also with a
  TypeSafe key set.
- **Policy in the system prompt (2026-09-29)**, same CLI and a local fake provider,
  `--no-extensions -e src/index.ts`. Four requests (two processes on one session
  with `-c`, then two prompts in one process) carried the same system prompt (same
  sha-256), with the policy and the advice guidance as its last two elements, and
  messages that were each an exact prefix of the next; that version, before
  durable policy observations, wrote no session entry. The previous release had
  moved its notice in front of the new user
  message (common prefix 0). A `custom_message` written by hand as an earlier
  build persisted it, placed on the active branch, never reached the provider. An
  explicit `orchestrate` prompt sent the short counterpart and never the native
  notice, with the same system prompt as a plain prompt. A project override
  `enabled=false` gave the plain base prompt from the next prompt, and removing it
  restored the identical system prompt. `task.enableEffort: true` in the config
  added the `effort` paragraph to it.
- A follow-up sent with `write agent://<id>` reached the same worker with its
  prior context, and telemetry recorded 1 started worker, 1 follow-up turn and 2
  completed turns, with tokens equal to the sum of that worker's two turns (a
  single run: 1 / 0 / 1).
- A copy of a real v5 telemetry file migrated to v6 with a byte-exact
  `telemetry-history/v5-<sha256>.json` backup, its live epoch moved to
  `jevRouting`, the tier era carried over, an empty live epoch, and an idempotent
  reload.

**Plugin-run Verification Auditor (2026-09-30).** `bun run check` passed;
`bun test` passed with 451 tests, 0 failures across 20 files. A throwaway
fake-model smoke exercised the pi-ai tool loop with a real read of `package.json`:
two model calls (read request, then structured response), one admitted cited
concern, and one uncited note withheld. Terminal-run triggering, disabled/worker
exclusion, both-severity follow-ups and their cap, stale-result cancellation,
failure warnings, and cwd/symlink confinement have behavioral coverage. Interactive
host delivery is a separate smoke check; these local checks do not prove that UI.


**Real-model smoke.** Setup: the OMP 18.4.2 CLI with the user's model roles (main
`anthropic/claude-opus-5-5`, `task` worker `anthropic/claude-sonnet-5-5:medium`);
five runs in a throwaway repository with a planted rounding bug; a probe
extension recorded the provider context.

- (Recorded with the release that added the notice to every request.) The same
  7,922-character notice (identical hash) was in every main request, before the
  current user message, and in no worker request. In a continued session it
  preceded the new user message, with no copy at the earlier turn.
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
  Native keyword notices are therefore recognized in the `context` hook by their
  message type; `before_agent_start` cannot see them, so the policy in the system
  prompt does not depend on them (see
  [Modes and skip conditions](#modes-and-skip-conditions)). Thinking-level types
  are imported only as erased types.
- **Cost per completed task is not acceptance rate**: `completed` is the
  worker's own settlement.
- **Spawns that settle after the process exits** are not in `stats`: usage is
  read from in-process subagent frames.
- **Reuse depends on the host.** Whether a worker can be continued is reported by
  OMP 18.4.1; the plugin cannot resume, message or verify delivery to a worker
  itself.
