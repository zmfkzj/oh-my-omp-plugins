import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { RoutingContext } from "./jev.ts";

const RECENT_MESSAGE_COUNT = 8;
const RECENT_MESSAGE_CHARS = 700;
const LAUNCH_GOAL_CHARS = 1600;
const PLAN_CHARS = 3200;

export function visibleText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n")
		.trim();
}

function realMessage(entry: SessionEntry): { role: "user" | "assistant"; text: string } | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const { role, content } = message;
	const text = visibleText(content);
	// Hidden native notices, tool results and thinking must never become classifier inputs.
	if (!text || text.startsWith("<system-") || (role === "user" && text.startsWith("/"))) return undefined;
	return { role, text };
}

export function isTodoPlan(value: unknown): value is TodoPhase[] {
	return Array.isArray(value) && value.every(phase =>
		phase !== null && typeof phase === "object" && typeof phase.name === "string" && Array.isArray(phase.tasks) &&
		phase.tasks.every((task: unknown) => {
			if (task === null || typeof task !== "object") return false;
			const item = task as TodoPhase["tasks"][number];
			return typeof item.content === "string" && (
				item.status === "pending" || item.status === "in_progress" || item.status === "completed" ||
				item.status === "abandoned" || item.status === "blocked");
		}));
}

/** The latest durable plan on the active branch, not an in-memory or view-only snapshot. */
export function latestCommittedTodoPlan(branch: readonly SessionEntry[]): TodoPhase[] | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.type === "custom" && entry.customType === "user_todo_edit") {
			const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
			if (isTodoPlan(phases)) return phases;
		} else if (entry.type === "message" && entry.message.role === "toolResult" &&
			entry.message.toolName === "todo" && !entry.message.isError) {
			const details = entry.message.details as { op?: unknown; phases?: unknown } | undefined;
			if (details?.op !== "view" && isTodoPlan(details?.phases)) return details.phases;
		}
	}
	return undefined;
}

/** Only phase/task descriptions are relevant to routing, never tool result content or private notes. */
export function formatTodoPlan(phases: readonly TodoPhase[]): string {
	const lines: string[] = [];
	let remaining = PLAN_CHARS;
	for (const phase of phases) {
		if (remaining <= 0) break;
		const heading = phase.name.slice(0, remaining);
		lines.push(heading);
		remaining -= heading.length + 1;
		for (const task of phase.tasks) {
			if (remaining <= 0) break;
			const line = `- ${task.content} [${task.status}]`.slice(0, remaining);
			lines.push(line);
			remaining -= line.length + 1;
		}
	}
	return lines.join("\n");
}

/** Recent visible dialog plus the launch goal and active committed plan. Jev applies the total input budget. */
export function buildRoutingContext(branch: readonly SessionEntry[], prompt: string): RoutingContext {
	const recentMessages: RoutingContext["recentMessages"] = [];
	let launchGoal: string | undefined;
	let checkedCurrentUser = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry || entry.type !== "message") continue;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") continue;
		if (entry.message.role === "assistant" && recentMessages.length >= RECENT_MESSAGE_COUNT) continue;
		const item = realMessage(entry);
		if (!item) continue;
		if (item.role === "user" && !checkedCurrentUser) {
			checkedCurrentUser = true;
			if (item.text === prompt.trim()) continue;
		}
		if (item.role === "user") launchGoal = item.text;
		if (recentMessages.length < RECENT_MESSAGE_COUNT) {
			recentMessages.push({ role: item.role, text: item.text.slice(0, RECENT_MESSAGE_CHARS) });
		}
	}
	recentMessages.reverse();
	if (launchGoal) {
		const clippedGoal = launchGoal.slice(0, LAUNCH_GOAL_CHARS);
		if (recentMessages[0]?.role === "user" && recentMessages[0].text === launchGoal.slice(0, RECENT_MESSAGE_CHARS)) {
			recentMessages[0] = { role: "user", text: clippedGoal };
		} else {
			recentMessages.unshift({ role: "user", text: clippedGoal });
		}
	}
	const plan = latestCommittedTodoPlan(branch);
	return { recentMessages, ...(plan ? { plan: formatTodoPlan(plan) } : {}) };
}
