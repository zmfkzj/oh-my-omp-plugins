/**
 * Plugin-owned execution policy: Judgment (판단형) and Production (제작형), chosen by
 * the main model per request and per current stage. OMP's own prompt is never
 * reused as policy, and nothing here classifies, routes or calls a model.
 *
 * Three texts, each with its own place:
 *   - the policy itself: both policies, the per-stage selection rule and the shared
 *     guidance (reuse, task bodies, verification). It is one element of the main session's
 *     system prompt, so it sits in the provider's cached request prefix and never enters
 *     the transcript.
 *   - `orchestrate`: stands in, in what the provider reads of the transcript, for a native
 *     `orchestrate` keyword notice. With `task` it names the request and leaves the rest to
 *     the policy; without `task` it is an honest direct-execution notice that never claims
 *     delegation.
 *   - `workflow`: a supplement placed right after a native `workflowz` notice. That notice
 *     keeps choosing the execution method, agents, fan-out and reuse; the supplement adds no
 *     dispatch, parallel, reuse or "analyze directly" instruction. With the policy in the
 *     system prompt it only points at the policy's shared duties; without it, it carries them.
 * The texts only render instructions backed by the tools and settings in force when they
 * are rendered; they never change tools, models or permissions.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type CustomMessage, isUserTurnInitiator } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

/**
 * Custom message type of the keyword stand-ins below. Earlier builds also persisted the
 * policy itself under it (mode `default`); such messages are dropped from what the provider reads.
 */
export const POLICY_NOTICE_TYPE = "om-orche-policy-notice";
/** OMP's explicit `orchestrate` keyword notice. */
export const NATIVE_ORCHESTRATE_NOTICE_TYPE = "orchestrate-notice";
/** OMP's explicit `workflowz` keyword notice. */
export const NATIVE_WORKFLOW_NOTICE_TYPE = "workflow-notice";

/** Tag that opens and closes the policy element of the system prompt, and identifies it there. */
const POLICY_TAG = "om-orche-policy";

export type PolicyMode = "default" | "orchestrate" | "workflow";
/** The modes that stand in for one of OMP's keyword notices. */
export type KeywordMode = Exclude<PolicyMode, "default">;

export interface PolicyNoticeDetails {
	mode: PolicyMode;
}

/** What the rendered texts depend on. */
export interface PolicyContext {
	/** Tool names enabled when the text is rendered. */
	tools: readonly string[];
	/** The `task` schema carries `effort` (`task.enableEffort`). */
	effort: boolean;
}

const MODES: readonly PolicyMode[] = ["default", "orchestrate", "workflow"];

/** The policy mode of one of this plugin's messages, otherwise `undefined`. */
export function policyModeOf(message: AgentMessage | undefined): PolicyMode | undefined {
	if (message?.role !== "custom" || message.customType !== POLICY_NOTICE_TYPE) return undefined;
	const mode = (message.details as Partial<PolicyNoticeDetails> | undefined)?.mode;
	return MODES.find(candidate => candidate === mode);
}

/** Whether one element of a system prompt is this plugin's policy. */
export function isPolicySection(part: string): boolean {
	return part.startsWith(`<${POLICY_TAG}>`);
}

/**
 * Agent steering continues the current request; user input starts another turn. A user-invoked
 * `/skill:` prompt or a writable-collab peer's prompt reaches the model as a user-attributed
 * `custom` message and starts a turn like one, so the host's own predicate decides it.
 */
export function isTurnUserMessage(message: AgentMessage | undefined): boolean {
	if (message?.role === "custom") return isUserTurnInitiator(message);
	return message?.role === "user" && !(message.steering === true && message.attribution === "agent");
}

/**
 * The same test for a persisted branch entry: a `/skill:` prompt is stored as a `custom_message`
 * entry, not a `message` entry.
 */
export function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") return isTurnUserMessage(entry.message);
	return entry.type === "custom_message" && isUserTurnInitiator({
		role: "custom",
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details,
		attribution: entry.attribution,
		timestamp: 0,
	});
}

/**
 * Whether a message of `customType` shares the keyword prefix of the one at `index`: the run of
 * consecutive custom messages around it that start no turn, which is where OMP queues its keyword
 * notices ahead of the message that starts the request.
 */
export function prefixHas(messages: readonly AgentMessage[], index: number, customType: string): boolean {
	for (const step of [-1, 1]) {
		for (let at = index + step; at >= 0 && at < messages.length; at += step) {
			const message = messages[at];
			if (message?.role !== "custom" || isTurnUserMessage(message)) break;
			if (message.customType === customType) return true;
		}
	}
	return false;
}

const ADVISOR_TOOL = "orche_advisor";

type VerificationKind = "main" | "workflow" | "direct";

const HEADER = "Execution policy: Judgment (판단형) and Production (제작형), chosen by you per request and stage. Guidance, not a scheduler or permission system; host limits (tools, concurrency, permissions, plan mode, read-only) bind; no capability granted. Over generic defaults: Judgment keeps core analysis with you despite \"Map unknown code via task\" / \"Multi-round search MUST use Task + scout\"; Production gives implementation to workers despite \"Inline first / NEVER delegate one slice\" / \"No subagents unless explicitly requested\"; workers run local checks despite \"tasks skip build/lint/tests mid-flight\". In both you own intent, scope, global decisions, final answer.";

const SELECTION = "Choose per stage yourself, from the request, code/tool results and progress; never call a model, router or subagent to classify. Type = current stage, not request label. Ask what the user must receive to be done. Explanation, analysis, judgment, proposal or design alone → Judgment. Real change to code, files, features, assets or state → Production. Both → Judgment first, Production once cause, scope and contract are settled enough to implement (no new approval if both were asked). Analysis/proposal only → never Production just because a fix became clear, and no product code, config or assets change (reproductions non-destructive, isolated); unclear permission to change the product → give the result and the decision needed. Premise or contract breaks in Production → Judgment for the affected part only, then resume; unaffected work stands. Findings saved as Markdown or a throwaway repro script stay Judgment; a one-file or strictly sequential change is not Judgment (never implement it yourself for that). Switching keeps the same session and your model; update only the changed goal/contract and affected work; tell affected workers the changed premises and re-verification scope.";

const JUDGMENT_RESULTS = "Report: confirmed facts with evidence; inferences; counterexamples and open possibilities; conclusion and scope; what needs verification. Label thought experiment, static analysis or actually executed; nothing unexecuted is verified.";

const ANALYSIS_ONLY = "Analysis-only is not permission to change the product: no product code, config or assets change; reproductions non-destructive, isolated, within permissions; plan mode and read-only limits come first.";

const PRODUCTION = "Production: you own goal, non-goals, constraints, acceptance, interfaces, ownership, dependencies, conflicts, contract changes, integration, final acceptance. Workers own, within scope: investigation, local design, implementation, local checks, failure analysis, re-fixes, evidence; never solve the implementation yourself and have a worker type it. Cohesive or strongly sequential work → one worker end to end; \"can't be parallelized\" never moves it to you. Parallelize only independent units under verified prerequisites (not by file count or volume), no artificial splits; order only for real dependency, ownership or resource conflict; delegation and parallelism are separate decisions. You may read code, check diffs, verify, talk to workers; never duplicate worker implementation or overwrite in-progress changes. Edit source yourself only for a small integration finish when ALL hold: cause and fix settled; no new investigation, design or substantial debugging; contract and scope unchanged; no conflict with another writer's ownership or writes; clearly smaller than delegating. Else the owning worker continues; a run of exceptions must not make you the implementer.";

const ASSETS = "Assets (game art, conversion, packing, engine integration): settle style, spec, use and in-game conditions; check a few samples against them (ask the user only if approval was requested or a direction is open); then the rest, variants, packing; confirm in-game rendering. A reasoning model is no image/3D/audio generator: never assume workers have generation tools; state what code can and cannot produce. Acceptance names size, format, transparency, pivot, frames, packing, consistency, in-game use; a created file or text report is not visual verification: report image observation, format checks, engine runs separately.";

const EFFORT = "Task `effort`: lo fixed mechanical work; med bounded investigation or implementation; hi substantial unresolved cause, design or correctness. Keep any effort the user specified; do not send analysis at hi by default. The host maps it onto the worker model's own range, not by name, and an explicit effort overrides the task role's level and auto: omit it to keep those.";

const WORKER_LOCAL = "Worker-local checks on owned files are expected; global checks, formatters, shared runtimes stay with a named owner (normally you), never concurrent. A worker finding a broken fixed decision, ownership conflict or invalid prerequisite pauses that change and reports evidence and partial work; it doesn't redesign, widen scope or overwrite others' edits.";

// Not repeated here: reporting the exact blocker, never reporting an unrun check as passed and partial
// success not being completion. OMP's base prompt already carries all three ("state exactly missing and
// tried", "Report only exercised verification", "Done: ... every named acceptance criterion").
const closingRules = (checks: string) => `Never repeat an unchanged failure without new input. Reconcile every requested outcome with end-to-end and boundary ${checks}; back runtime claims with text evidence read afterwards. No automatic model escalation or reviewer loops.`;

function joinOr(items: readonly string[]): string {
	return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

function judgment(tools: ReadonlySet<string>): string {
	const nothing = ["worker", ...(tools.has("todo") ? ["todo list"] : []), "task contract",
		...(tools.has(ADVISOR_TOOL) ? ["advice call"] : [])];
	return `Judgment: you are the responsible analyst, not a relay: frame question and criteria, read key code/logs/docs yourself, hypothesize, gather evidence, run key experiments, test counterexamples, decide. Delegate only bounded independent investigations (a code path, one hypothesis, change impact, one invariant, a feasibility check); workers analyze within their question, you own the judgment. Zero workers is normal for small or well-evidenced questions (no ${joinOr(nothing)} required); one for a cohesive extra investigation; several only for independently worthwhile scopes; no mandatory analyst/critic/judge roles. Never fix the conclusion first and send workers for support, or pass an unverified hypothesis as fact. ${JUDGMENT_RESULTS}`;
}

function workerReuse(tools: ReadonlySet<string>): string {
	if (!tools.has("write")) {
		return "Reuse: no follow-up channel exists this turn; a follow-up of earlier work goes to a new worker with the contract, changes and artifact references.";
	}
	return "Reuse: follow-ups of the same work (more investigation, verification failure, fix, boundary case) go preferably to the worker that did it via `write agent://<id>` (`task` cannot resume). Continue unless its task result says \"ran isolated … cannot be resumed\" or \"was aborted\"; a missing continuation hint proves nothing. Check its context and ownership fit and no conflicting run state or writes; state changed premises. New worker (contract, evidence, artifact references) when delivery fails, its environment is gone or premises changed materially; a same-named new worker is not the old context; no new worker every user turn; never claim a reuse that did not happen.";
}

function taskBodyContract(tools: ReadonlySet<string>, effort: boolean, subject: string): string {
	return [
		`Each ${subject} is self-contained, using these sections instead of the tool's generic Target/Change/Acceptance: # Goal; # Scope and non-goals; # Decided and open (fixed decisions with reasons and user constraints; judgments left to the worker); # Inputs and dependencies (artifacts by reference; unverified hypotheses marked); # Acceptance and verification (Judgment worker: evidence answering its question, not whether code changed; Production worker: the change plus verification); # Return (results, new facts, wrong premises, evidence location, open issues, decisions needed). Pass what workers need, never the whole conversation, earlier reports or large logs.`,
		// The host strips `effort` from the schema unless `task.enableEffort` is on.
		...(effort && tools.has("task") ? [EFFORT] : []),
		WORKER_LOCAL,
	].join("\n");
}

function verification(tools: ReadonlySet<string>, kind: VerificationKind): string {
	const checks = tools.has("bash") ? "project checks" : "available checks";
	const route = kind === "main"
		? "and route it, usually back to the same worker, never as a takeover"
		: "and route it through the workflow";
	return [
		...(kind === "direct" ? [
			`Verification: check the result yourself and run the relevant ${checks} before declaring completion.`,
		] : [
			`Verification: a worker's report, success or finding, is not acceptance; check the integrated result and its key evidence yourself, without redoing every step. On a contract change or conflict: check running, pending and completed work, hold overlapping writes, check host-visible writer status, stop writers only via host controls, leave unrelated work running. Classify a failure or blocked worker first (defect, contract, environment, integration conflict, global decision) ${route}.`,
		]),
		closingRules(checks),
	].join("\n");
}

/** The system prompt element: both policies and the guidance they share. */
export function renderPolicy({ tools, effort }: PolicyContext): string {
	const enabled = new Set(tools);
	return [
		`<${POLICY_TAG}>`,
		HEADER,
		SELECTION,
		judgment(enabled),
		PRODUCTION,
		ASSETS,
		workerReuse(enabled),
		taskBodyContract(enabled, effort, "`task` item"),
		verification(enabled, "main"),
		`</${POLICY_TAG}>`,
	].join("\n");
}

function renderOrchestrate(tools: ReadonlySet<string>, policyInPrompt: boolean): string {
	if (tools.has("task")) {
		return [
			"<system-notice>",
			`om-orche execution policy: the user explicitly asked for orchestration in this request. Within the current goal, lean further toward delegation${policyInPrompt ? " under the Judgment/Production policy" : ""} (production work and independent investigations go to workers); this does not turn an analysis-only request into permission to change the product.`,
			"</system-notice>",
		].join("\n");
	}
	return [
		"<system-notice>",
		"om-orche execution policy: orchestration was requested, but `task` is not enabled for this request. Do judgment work directly; for production, implement directly within permissions or state the limitation precisely. Never claim or simulate delegation. An analysis-only request stays analysis and changes no product code, config or assets.",
		verification(tools, "direct"),
		"</system-notice>",
	].join("\n");
}

function renderWorkflow(tools: ReadonlySet<string>, effort: boolean, policyInPrompt: boolean): string {
	if (policyInPrompt) {
		return [
			"<system-notice>",
			"om-orche supplement to the workflow notice: for this request it alone chooses the execution method, agents and fan-out, overriding the execution policy's stage selection and delegation guidance; this adds none. The rest of the execution policy (task-item contract, worker-local checks, result labels, analysis-only boundary, verification) applies to workflow item prompts and results; route failures through the workflow.",
			"</system-notice>",
		].join("\n");
	}
	return [
		"<system-notice>",
		"om-orche supplement to the workflow notice: it alone chooses the execution method, agents and fan-out; this adds none.",
		taskBodyContract(tools, effort, "workflow item prompt"),
		JUDGMENT_RESULTS,
		ANALYSIS_ONLY,
		verification(tools, "workflow"),
		"</system-notice>",
	].join("\n");
}

/**
 * Render a keyword stand-in for the tools and settings in force now. `policyInPrompt` says whether
 * the policy is in this request's system prompt: it decides whether the text may point at it or
 * has to carry the duties itself.
 */
export function renderKeywordNotice(mode: KeywordMode, { tools, effort }: PolicyContext, policyInPrompt: boolean): string {
	const enabled = new Set(tools);
	return mode === "orchestrate" ? renderOrchestrate(enabled, policyInPrompt) : renderWorkflow(enabled, effort, policyInPrompt);
}

/** The stand-in for `native`, dated and attributed like it, for the provider's view only. */
export function buildKeywordNotice(
	mode: KeywordMode,
	context: PolicyContext,
	policyInPrompt: boolean,
	native: CustomMessage,
): AgentMessage {
	const notice: CustomMessage<PolicyNoticeDetails> = {
		role: "custom",
		customType: POLICY_NOTICE_TYPE,
		content: renderKeywordNotice(mode, context, policyInPrompt),
		display: false,
		details: { mode },
		attribution: native.attribution,
		timestamp: native.timestamp,
	};
	return notice;
}
