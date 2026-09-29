/**
 * Plugin-owned execution policy: Judgment (판단형) and Production (제작형), chosen by
 * the main model per request and per current stage. OMP's own prompt is never
 * reused as policy, and nothing here classifies, routes or calls a model.
 *
 * Exactly one policy notice guides a governed turn's execution method:
 *   - `default`: both policies, the per-stage selection rule and the shared
 *     guidance (transitions, reuse, task bodies, verification).
 *   - `orchestrate`: an explicit native `orchestrate` request. With `task` it is the
 *     `default` body plus a line naming the request; without `task` an honest
 *     direct-execution notice that never claims delegation.
 *   - `workflow`: supplement only. A native `workflowz` notice keeps choosing the
 *     execution method, agents, fan-out and reuse; this adds the task-body
 *     contract, the analysis-only boundary and verification duties without any
 *     dispatch, parallel, reuse or "analyze directly" instruction.
 * The notice only renders instructions backed by tools enabled on the turn; it
 * never changes tools, models or permissions.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** This plugin's notice; distinct from OMP's so neither is mistaken for the other. */
export const POLICY_NOTICE_TYPE = "om-orche-policy-notice";
/** OMP's explicit `orchestrate` keyword notice. */
export const NATIVE_ORCHESTRATE_NOTICE_TYPE = "orchestrate-notice";
/** OMP's explicit `workflowz` keyword notice. */
export const NATIVE_WORKFLOW_NOTICE_TYPE = "workflow-notice";

export type PolicyMode = "default" | "orchestrate" | "workflow";

export interface PolicyNoticeDetails {
	mode: PolicyMode;
}

const MODES: readonly PolicyMode[] = ["default", "orchestrate", "workflow"];

/** The policy mode of one of this plugin's notices, otherwise `undefined`. */
export function policyModeOf(message: AgentMessage | undefined): PolicyMode | undefined {
	if (message?.role !== "custom" || message.customType !== POLICY_NOTICE_TYPE) return undefined;
	const mode = (message.details as Partial<PolicyNoticeDetails> | undefined)?.mode;
	return MODES.find(candidate => candidate === mode);
}

/** Agent steering continues the current request; only user input starts another turn. */
export function isTurnUserMessage(message: AgentMessage | undefined): boolean {
	return message?.role === "user" && !(message.steering === true && message.attribution === "agent");
}

/**
 * First index of the current user's turn: keyword notices are queued as custom
 * messages immediately before that user message. `-1` when no user message exists.
 */
export function currentTurnStart(messages: readonly AgentMessage[]): number {
	let index = messages.length - 1;
	while (index >= 0 && !isTurnUserMessage(messages[index])) index--;
	if (index < 0) return -1;
	while (index > 0 && messages[index - 1]?.role === "custom") index--;
	return index;
}

/** Indexes of `customType` notices that belong to the current user's keyword prefix. */
export function currentTurnNotices(messages: readonly AgentMessage[], customType: string): number[] {
	const start = currentTurnStart(messages);
	const found: number[] = [];
	if (start < 0) return found;
	for (let index = start; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "custom") break;
		if (message.customType === customType) found.push(index);
	}
	return found;
}

const ADVISOR_TOOL = "orche_advisor";

type VerificationKind = "main" | "workflow" | "direct";

const HEADER = "om-orche execution policy: Judgment (판단형) and Production (제작형), chosen by you per request and stage. Guidance, not a scheduler or permission system; host limits (tools, concurrency, permissions, plan mode, read-only) bind; no capability granted. Over generic defaults: Judgment keeps core analysis with you despite \"Map unknown code via task\" / \"Multi-round search MUST use Task + scout\"; Production gives implementation to workers despite \"Inline first / NEVER delegate one slice\" / \"No subagents unless explicitly requested\"; workers run local checks despite \"tasks skip build/lint/tests mid-flight\". In both you own intent, scope, global decisions, final answer.";

const SELECTION = "Choose per stage yourself, from the request, code/tool results and progress; never call a model, router or subagent to classify. Type = current stage, not request label. Ask what the user must receive to be done. Explanation, analysis, judgment, proposal or design alone → Judgment. Real change to code, files, features, assets or state → Production. Both → Judgment first, Production once cause, scope and contract are settled enough to implement (no new approval if both were asked). Analysis/proposal only → never Production just because a fix became clear; unclear permission to change the product → give the result and the decision needed. Premise or contract breaks in Production → Judgment for the affected part only, then resume; unaffected work stands. Findings saved as Markdown or a throwaway repro script stay Judgment; a one-file or strictly sequential change is not Judgment (never implement it yourself for that).";

const JUDGMENT_RESULTS = "Report: confirmed facts with evidence; inferences; counterexamples and open possibilities; conclusion and scope; what needs verification. Label thought experiment, static analysis or actually executed; nothing unexecuted is verified.";

const ANALYSIS_ONLY = "Analysis-only is not permission to change the product: no product code, config or assets change; reproductions non-destructive, isolated, within permissions; plan mode and read-only limits come first.";

const PRODUCTION = "Production: you own goal, scope, non-goals, constraints, acceptance, global decisions, interfaces, ownership, dependencies, conflicts, contract changes, integration, final acceptance. Workers own, within scope: investigation, local design, implementation, local checks, failure analysis, re-fixes, evidence; never solve the implementation yourself and have a worker type it. Cohesive or strongly sequential work → one worker end to end; \"can't be parallelized\" never moves it to you. Parallelize only independent units under verified prerequisites (not by file count or volume), no artificial splits; start ready ones together (host batch/async); order only for real dependency, ownership or resource conflict; delegation and parallelism are separate decisions. You may read code, check diffs, verify, talk to workers; never duplicate worker implementation or overwrite in-progress changes. Edit source yourself only for a small integration finish when ALL hold: cause and fix settled; no new investigation, design or substantial debugging; contract and scope unchanged; no conflict with another writer's ownership or writes; clearly smaller than delegating. Else the owning worker continues; a run of exceptions must not make you the implementer. Assets (game art, conversion, packing, engine integration): settle style, spec, use and in-game conditions; check a few samples against them (ask the user only if approval was requested or a direction is open); then the rest, variants, packing; confirm in-game rendering. A reasoning model is no image/3D/audio generator: never assume workers have generation tools; state what code can and cannot produce. Acceptance names size, format, transparency, pivot, frames, packing, consistency, in-game use; a created file or text report is not visual verification: report image observation, format checks, engine runs separately.";

const TRANSITIONS = "Switching keeps the same session and your model; update only the changed goal/contract and affected work; tell affected workers the changed premises and re-verification scope.";

function joinOr(items: readonly string[]): string {
	return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

function judgment(tools: ReadonlySet<string>): string {
	const nothing = ["worker", ...(tools.has("todo") ? ["todo list"] : []), "task contract",
		...(tools.has(ADVISOR_TOOL) ? ["advice call"] : [])];
	return `Judgment: you are the responsible analyst, not a relay: frame question and criteria, read key code/logs/docs yourself, hypothesize, gather evidence, run key experiments, test counterexamples, decide. Delegate only bounded independent investigations (a code path, one hypothesis, change impact, one invariant, a feasibility check); workers analyze within their question, you own the judgment. Zero workers is normal for small or well-evidenced questions (no ${joinOr(nothing)} required); one for a cohesive extra investigation; several only for independently worthwhile scopes; no mandatory analyst/critic/judge roles. Never redo a worker's investigation wholesale; verify key evidence yourself. Never fix the conclusion first and send workers for support, or pass an unverified hypothesis as fact. ${JUDGMENT_RESULTS} ${ANALYSIS_ONLY}`;
}

function workerReuse(tools: ReadonlySet<string>): string {
	if (!tools.has("write")) {
		return "Reuse: no follow-up channel exists this turn; a follow-up of earlier work goes to a new worker with the contract, changes and artifact references.";
	}
	return "Reuse: follow-ups of the same work (more investigation, verification failure, fix, boundary case) go preferably to the worker that did it via `write agent://<id>` (`task` cannot resume). Continue unless its task result says \"ran isolated … cannot be resumed\" or \"was aborted\"; a missing continuation hint proves nothing. Check its context and ownership fit and no conflicting run state or writes; state changed premises. New worker (contract, evidence, artifact references) when delivery fails, its environment is gone or premises changed materially; a same-named new worker is not the old context; no new worker every user turn; never claim a reuse that did not happen.";
}

function taskBodyContract(tools: ReadonlySet<string>, subject: string): string {
	return [
		`Each ${subject} is self-contained, using these sections instead of the tool's generic Target/Change/Acceptance: # Goal; # Scope and non-goals; # Decided and open (fixed decisions with reasons and user constraints; judgments left to the worker); # Inputs and dependencies (artifacts by reference; unverified hypotheses marked); # Acceptance and verification (Judgment worker: evidence answering its question, not whether code changed; Production worker: the change plus verification); # Return (results, new facts, wrong premises, evidence location, open issues, decisions needed). Workers don't inherit the conversation: pass what they need, never the whole conversation, earlier reports or large logs.`,
		...(tools.has("task") ? [
			"When the schema has `effort`: lo fixed mechanical work; med bounded investigation or implementation; hi substantial unresolved cause, design or correctness. Keep any effort the user specified; do not send analysis at hi by default. The host maps it onto the worker model's own range, not by name, and an explicit effort overrides the task role's level and auto: omit it to keep those.",
		] : []),
		"Worker-local checks on owned files are expected; global checks, formatters, shared runtimes stay with a named owner (normally you), never concurrent. A worker finding a broken fixed decision, ownership conflict or invalid prerequisite pauses that change and reports evidence and partial work; it doesn't redesign, widen scope or overwrite others' edits.",
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
			`Verification: a worker's success report is not acceptance; check the integrated result and evidence without redoing every step. On a contract change or conflict: check running, pending and completed work, hold overlapping writes, check host-visible writer status, stop writers only via host controls, leave unrelated work running. Classify a failure or blocked worker first (defect, contract, environment, integration conflict, global decision) ${route}.`,
		]),
		`Never repeat an unchanged failure without new input; report the exact blocker when no step remains. Never report an unrun check as passed; partial success is not completion; reconcile every requested outcome with end-to-end and boundary ${checks}; back runtime claims with text evidence read afterwards. No automatic model escalation or reviewer loops.`,
	].join("\n");
}

function renderDefault(tools: ReadonlySet<string>, explicit: boolean): string {
	return [
		"<system-notice>",
		HEADER,
		...(explicit
			? ["The user explicitly asked for orchestration: within the current goal, lean further toward delegation (production work and independent investigations go to workers); this does not turn an analysis-only request into permission to change the product."]
			: []),
		SELECTION,
		judgment(tools),
		PRODUCTION,
		TRANSITIONS,
		workerReuse(tools),
		taskBodyContract(tools, "`task` item"),
		verification(tools, "main"),
		"</system-notice>",
	].join("\n");
}

function renderOrchestrate(tools: ReadonlySet<string>): string {
	if (tools.has("task")) return renderDefault(tools, true);
	return [
		"<system-notice>",
		"om-orche execution policy: orchestration was requested, but `task` is not enabled for this turn. Do judgment work directly; for production, implement directly within permissions or state the limitation precisely. Never claim or simulate delegation. An analysis-only request stays analysis and changes no product code, config or assets.",
		verification(tools, "direct"),
		"</system-notice>",
	].join("\n");
}

function renderWorkflow(tools: ReadonlySet<string>): string {
	return [
		"<system-notice>",
		"om-orche supplement to the workflow notice: it alone chooses the execution method, agents and fan-out; this adds none.",
		taskBodyContract(tools, "workflow item prompt"),
		JUDGMENT_RESULTS,
		ANALYSIS_ONLY,
		verification(tools, "workflow"),
		"</system-notice>",
	].join("\n");
}

/** Render one mode for the tools enabled on this turn. */
export function renderPolicy(mode: PolicyMode, tools: readonly string[]): string {
	const enabled = new Set(tools);
	switch (mode) {
		case "default":
			return renderDefault(enabled, false);
		case "orchestrate":
			return renderOrchestrate(enabled);
		case "workflow":
			return renderWorkflow(enabled);
	}
}

/** A provider-context-only notice; never persisted. */
export function buildPolicyNotice(mode: PolicyMode, tools: readonly string[], timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: POLICY_NOTICE_TYPE,
		content: renderPolicy(mode, tools),
		display: false,
		details: { mode } satisfies PolicyNoticeDetails,
		attribution: "user",
		timestamp,
	} as AgentMessage;
}
