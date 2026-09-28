/**
 * Plugin-owned execution policy. It replaces OMP's orchestrate notice for the
 * turns the router governs; OMP's own prompt is never reused as policy.
 *
 * Exactly one policy notice guides a turn's execution method:
 *   - `default`: direct work, with single or parallel delegation only when useful.
 *   - `orchestrate`: this plugin's delegation policy for an automatic or explicit route.
 *   - `workflow`: auxiliary only. A native `workflowz` notice keeps choosing the
 *     execution method; this adds the task-body contract and verification duties
 *     without any dispatch or fan-out instruction.
 * Tool permissions are unaffected by the mode.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** This plugin's notice; distinct from OMP's so neither is mistaken for the other. */
export const JEV_ORCHESTRATE_NOTICE_TYPE = "jev-orchestrate-notice";
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
	if (message?.role !== "custom" || message.customType !== JEV_ORCHESTRATE_NOTICE_TYPE) return undefined;
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

function taskBodyContract(tools: ReadonlySet<string>, subject: string): string {
	return [
		`Write each ${subject} as self-contained plain text with these sections (there is no separate contract field):`,
		"  # Goal: the observable outcome.",
		"  # Scope and non-goals: owned files and interfaces, areas not to touch.",
		"  # Decided and open: decisions already fixed (do not redesign them) and judgments left to the worker.",
		"  # Inputs and dependencies: referenced files or artifacts and verified upstream contracts.",
		"  # Acceptance and verification: success, error and boundary behavior; worker-local checks; what the coordinator verifies.",
		"  # Return: done or blocked, actual changes, checks run with results, remaining issues.",
		"Keep shared context to constraints common to every item; never copy the conversation or earlier reports." +
			(tools.has("task")
				? " Use the existing outputSchema only when a structured result is needed."
				: ""),
		...(tools.has("task") ? [
			"When the host's task schema exposes `effort`, explicitly set it on each task item: `lo` for a fixed mechanical change, `med` for bounded implementation choices, `hi` for substantial unresolved design or correctness questions. Match the solution space, not file count or task length; preserve explicit user choices. If the field is absent, omit it rather than inventing a parameter.",
		] : []),
		"A worker that finds a defect in a fixed decision, an ownership conflict, or an invalid prerequisite pauses affected changes and reports evidence, touched files and partial work immediately; it does not redesign the contract, expand its scope, or overwrite another owner's edits.",
	].join("\n");
}

function verification(tools: ReadonlySet<string>): string {
	const checks = tools.has("bash") ? "project checks" : "available checks";
	return [
		"A worker finishing or reporting success is not acceptance. You integrate and verify acceptance yourself.",
		...(tools.has("task") ? [
			"On an ownership or shared-resource conflict, hold new overlapping work and check host-visible writer status. Request affected writers to stop only through controls the host actually exposes; do not reconcile their edits or assign overlapping work until they are confirmed stopped. Otherwise keep the overlap blocked; preserve user and unrelated worker changes.",
			"When an upstream contract changes, identify every affected pending, running and completed unit. Hold new affected work and handle active writers as above; update the plan and worker instructions, verify the revised prerequisite, and revalidate affected completed results against it before accepting them. Resume affected work only after its prerequisites and writer status permit it; unaffected work continues.",
			"On partial failure, preserve independently verified results and continue unrelated work. Record the failed unit, dependent units and exact blocker; retry or reassign only the affected scope after its cause or inputs change and any previous writer has stopped.",
		] : []),
		`Never run global ${checks} or formatters concurrently in a shared checkout; isolated, conflict-free local smoke runs by workers are fine.`,
		"Classify a failure first: implementation defect, ambiguous contract, missing environment or permission, integration conflict, or unresolved design.",
		"Fix small obvious gaps directly. Never repeat an unchanged failure without new input or a new hypothesis; with no executable next step, report the exact blocker.",
		"Before declaring completion, reconcile every requested outcome with the integrated result and run the relevant end-to-end or boundary checks. Report actual verification and unresolved blockers explicitly; partial success is not overall completion.",
		"No automatic model escalation, reviewer loops, or out-of-scope reviewer demands.",
	].join("\n");
}

function renderDefault(tools: ReadonlySet<string>): string {
	return [
		"<system-notice>",
		"Execution policy for this request (om-orche).",
		"Work directly when the task is cohesive, strongly sequential, or cheaper to do than to delegate.",
		"Delegate to `task` only when a separate context or tool scope genuinely helps; a single delegated unit is fine, never invent a second one.",
		"Delegate in parallel only when items run without each other's unfinished output and their file ownership, interfaces and runtime resources do not collide. File count or prompt length is not evidence of independence.",
		taskBodyContract(tools, "delegated task"),
		verification(tools),
		"</system-notice>",
	].join("\n");
}

function renderOrchestrate(tools: ReadonlySet<string>): string {
	if (!tools.has("task")) return [
		"<system-notice>",
		"Execution policy for this request (om-orche): orchestration was requested, but `task` is not enabled for this turn.",
		"Execute directly; do not claim or simulate delegation.",
		verification(tools),
		"</system-notice>",
	].join("\n");
	const planning = tools.has("todo")
		? "Scope the work first and record it as ordered `todo` phases, each listing its independent units and dependencies."
		: "Scope the work first and state the ordered phases, each listing its independent units and dependencies.";
	return [
		"<system-notice>",
		"Execution policy for this request (om-orche): coordinated delegation. You stay responsible for planning, integration, verification and completion.",
		planning,
		"Identify independent, worthwhile implementation units first; establish only the shared contracts and prerequisites needed to make them runnable. Give each unit a clear owner, inputs and acceptance criteria. File count or prompt length alone does not establish independence.",
		"When two or more units are ready and need none of each other's unfinished output, start them together in one `tasks[]` batch when the host supports batching; otherwise dispatch them without waiting for earlier independent workers. Respect the host's concurrency limit and non-overlapping file ownership, interfaces and runtime resources.",
		"Do not serialize ready independent units. Sequence work only for an actual prerequisite or ownership/resource conflict, and name that dependency or conflict in the plan. Verify a prerequisite contract before releasing its dependent units.",
		"Keep the coordinator focused on shared contracts, the minimal shared changes needed to unblock workers, integration and final verification. Once a contract is stable, delegate its independent consumers instead of keeping most implementation on the coordinator. Shared infrastructure or a single final test environment is not a reason to serialize unrelated implementation.",
		"While workers run, advance non-overlapping coordinator work. Release each newly ready unit as soon as its own prerequisites are verified; do not wait for unrelated workers or an entire phase to finish. Wait only when no runnable coordinator work remains.",
		"Do not pad the plan to reach a worker quota or delegate trivial work. Keep cohesive, small or genuinely sequential changes direct; one useful worker is valid when only one independent unit exists. Do not bypass host permissions, required checks or ownership boundaries to increase concurrency.",
		taskBodyContract(tools, "`task` item"),
		verification(tools),
		"</system-notice>",
	].join("\n");
}

function renderWorkflow(tools: ReadonlySet<string>): string {
	return [
		"<system-notice>",
		"om-orche supplement to the workflow notice for this request. The workflow notice alone chooses the execution method, agents and fan-out; this supplement adds no dispatch.",
		taskBodyContract(tools, "workflow item prompt"),
		verification(tools),
		"</system-notice>",
	].join("\n");
}

/** Render one mode for the tools enabled on this turn. */
export function renderPolicy(mode: PolicyMode, tools: readonly string[]): string {
	const enabled = new Set(tools);
	switch (mode) {
		case "default":
			return renderDefault(enabled);
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
		customType: JEV_ORCHESTRATE_NOTICE_TYPE,
		content: renderPolicy(mode, tools),
		display: false,
		details: { mode } satisfies PolicyNoticeDetails,
		attribution: "user",
		timestamp,
	} as AgentMessage;
}
