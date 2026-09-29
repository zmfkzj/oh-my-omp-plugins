/**
 * Subagent frames as OMP 18.4.1 publishes them (`emitSubagentFrame`): one
 * payload object per frame, handed to every bus that carries it.
 *
 * Frame order per turn, as recorded from the real host (see the recordings in
 * `worker-usage.test.ts`):
 * - a worker's FIRST turn: progress that has measured nothing yet, then
 *   `started`, then progress, a final progress, and the terminal frame;
 * - every later turn: `started` first, then progress that restarts from zero,
 *   the same, and the terminal frame.
 */
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { SUBAGENT_LIFECYCLE_CHANNEL, SUBAGENT_PROGRESS_CHANNEL } from "../src/worker-usage.ts";

/** Cumulative usage as a progress frame carries it. */
export interface FrameUsage {
	tokens: number;
	cost: number;
	durationMs: number;
}

/** Who spawned the worker: its agent name and, when it has one, the spawning tool call. */
export interface FrameOwner {
	agent: string;
	parentToolCallId?: string;
}

/** A worker of the `task` tool: it carries the spawning tool call's id. */
export const TASK_TOOL: FrameOwner = { agent: "task", parentToolCallId: "call-1" };
/** A worker of eval `agent()` or `workpool()`: the host passes no `parentToolCallId`. */
export const NO_TOOL_CALL: FrameOwner = { agent: "task" };

/** What a turn's first progress frame reports: nothing measured yet. */
export const NOTHING_YET: FrameUsage = { tokens: 0, cost: 0, durationMs: 1 };

function ownerFields(owner: FrameOwner): { agent: string; parentToolCallId?: string } {
	return owner.parentToolCallId === undefined
		? { agent: owner.agent }
		: { agent: owner.agent, parentToolCallId: owner.parentToolCallId };
}

/** Emit one payload object on every bus, in order, as the host does. */
export function publish(buses: readonly EventBus[], channel: string, payload: unknown): void {
	for (const bus of buses) bus.emit(channel, payload);
}

export function started(buses: readonly EventBus[], id: string, owner: FrameOwner = TASK_TOOL): void {
	publish(buses, SUBAGENT_LIFECYCLE_CHANNEL, { id, ...ownerFields(owner), status: "started", index: 0 });
}

export function progress(buses: readonly EventBus[], id: string, usage: FrameUsage, owner: FrameOwner = TASK_TOOL): void {
	publish(buses, SUBAGENT_PROGRESS_CHANNEL, {
		index: 0,
		...ownerFields(owner),
		task: "work",
		progress: { id, agent: owner.agent, ...usage },
	});
}

export function settled(buses: readonly EventBus[], id: string, status: string, owner: FrameOwner = TASK_TOOL): void {
	publish(buses, SUBAGENT_LIFECYCLE_CHANNEL, { id, ...ownerFields(owner), status, index: 0 });
}

/** Progress on the way to `final`: half of it first, then all of it, as the host flushes it before the terminal frame. */
function progressTo(buses: readonly EventBus[], id: string, final: FrameUsage, owner: FrameOwner): void {
	progress(buses, id, { tokens: final.tokens / 2, cost: final.cost / 2, durationMs: final.durationMs / 2 }, owner);
	progress(buses, id, final, owner);
}

/**
 * A worker's first turn, in the order the host really publishes it: progress
 * that has measured nothing yet comes BEFORE `started`.
 */
export function firstRun(
	buses: readonly EventBus[],
	id: string,
	final: FrameUsage,
	options: { owner?: FrameOwner; status?: string } = {},
): void {
	const owner = options.owner ?? TASK_TOOL;
	progress(buses, id, NOTHING_YET, owner);
	started(buses, id, owner);
	progressTo(buses, id, final, owner);
	settled(buses, id, options.status ?? "completed", owner);
}

/**
 * One turn that opens with `started`, as every follow-up turn does (and a first
 * turn whose label was given up front, as eval `agent()` sets). Without `final`
 * the turn reports no progress at all.
 */
export function turn(
	buses: readonly EventBus[],
	id: string,
	final: FrameUsage | undefined,
	options: { owner?: FrameOwner; status?: string } = {},
): void {
	const owner = options.owner ?? TASK_TOOL;
	started(buses, id, owner);
	if (final) {
		progress(buses, id, NOTHING_YET, owner);
		progressTo(buses, id, final, owner);
	}
	settled(buses, id, options.status ?? "completed", owner);
}
