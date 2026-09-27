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
		"A worker that finds a defect in a fixed decision returns evidence instead of redesigning it.",
	].join("\n");
}

function verification(tools: ReadonlySet<string>): string {
	const checks = tools.has("bash") ? "project checks" : "available checks";
	return [
		"A worker finishing or reporting success is not acceptance. You integrate and verify acceptance yourself.",
		`Never run global ${checks} or formatters concurrently in a shared checkout; isolated, conflict-free local smoke runs by workers are fine.`,
		"Classify a failure first: implementation defect, ambiguous contract, missing environment or permission, integration conflict, or unresolved design.",
		"Fix small obvious gaps directly. Never repeat an unchanged failure without new input or a new hypothesis; with no executable next step, report the exact blocker.",
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
		"Choose per unit: direct work for cohesive, sequential, or small changes; one `task` for a sufficient unit that benefits from separate context; parallel `task` items only for units that need none of each other's unfinished output and whose ownership, interfaces and runtime resources do not collide.",
		"File count or prompt length is not evidence of independence. Submit dependent work only after its prerequisite contract is verified.",
		"Concurrency limits come from the host's task settings; there is no required worker count. Start an independent follow-up once its own prerequisites are verified, without waiting for unrelated workers.",
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
