/**
 * The plugin's view of OMP's native `task` input.
 *
 * Review scopes hash the exact contract a worker call executes, and that
 * contract is whatever OMP's own validator produces from the live `task`
 * schema: the session's spawn-policy default fills an omitted `agent`, and
 * field handling follows the active flat or batch shape. Nothing here copies
 * that schema or its defaults, so a settings change (default agent, batch,
 * isolation, effort, eval tools) changes the contract instead of silently
 * diverging from it.
 */
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** The bundled generic worker agent. Anything else is a deliberate agent choice. */
export const GENERIC_TASK_AGENT = "task";

/** OMP's native task tool. */
const TASK_TOOL = "task";

/** Top-level intent argument the agent loop strips before validating a call. */
const INTENT_FIELD = "i";

export interface NormalizedCall {
	/**
	 * The whole call. Shared fields beside `tasks` are part of the contract:
	 * the host keeps undeclared top-level batch fields, and a top-level
	 * `isolated` still applies to every item that sets none itself.
	 */
	input: Record<string, unknown>;
	/** One entry per worker: the batch `tasks`, or the flat call itself. */
	items: Record<string, unknown>[];
}

/** Split a `task` tool input into its item list without losing any field. */
export function normalizeCall(input: Record<string, unknown>): NormalizedCall | undefined {
	const tasks = input.tasks;
	if (Array.isArray(tasks)) {
		const items = tasks.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
		if (items.length === 0 || items.length !== tasks.length) return undefined;
		return { input, items };
	}
	if (typeof input.task === "string") return { input, items: [input] };
	return undefined;
}

/**
 * Normalize a task input the way OMP's agent loop does before `tool_call`
 * fires: strip the top-level intent, then validate a copy against the live
 * `task` parameters with the host's shared validator. A predeclared dispatch
 * and an executed call's effective arguments therefore reduce to one contract.
 *
 * Throws when the task tool is unavailable, the input fails validation, or it
 * holds no worker; callers must treat that as "no contract", never as a
 * default.
 */
export function prepareDispatch(pi: ExtensionAPI, input: Record<string, unknown>): NormalizedCall {
	const tool = pi.getAllTools().find(candidate => candidate.name === TASK_TOOL);
	if (!tool) throw new Error("OMP's task tool is not available in this session.");
	const args = structuredClone(input);
	delete args[INTENT_FIELD];
	const validated = validateToolArguments(tool, { type: "toolCall", id: "jev-task-contract", name: TASK_TOOL, arguments: args });
	const call = normalizeCall(validated);
	if (!call) throw new Error("Task input needs a task or a non-empty tasks array.");
	return call;
}
