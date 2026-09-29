/**
 * `task:subagent:*` frames recorded from the real OMP 18.4.1 CLI (print mode)
 * driving a scripted fake model: the main agent spawns one generic `task`
 * worker and, in the second scenario, follows up with `write agent://<id>`.
 * An events probe logged every frame the extension bus received; only the order
 * and the fields the host sets are kept (times and text are dropped).
 *
 * What they show (the synthetic frames of the other tests follow the same order):
 * - a worker's FIRST turn publishes a progress frame that has measured nothing
 *   yet (`requests: 0`, `tokens: 0`) BEFORE its `started` frame, in sync and
 *   async spawns alike;
 * - the follow-up turn starts with `started` (same `id` and `parentToolCallId`),
 *   then progress that restarts from zero, then its own terminal frame;
 * - a turn's last progress frame carries the terminal status and precedes the
 *   terminal lifecycle frame.
 */
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { SUBAGENT_LIFECYCLE_CHANNEL, SUBAGENT_PROGRESS_CHANNEL } from "../src/worker-usage.ts";
import { publish } from "./worker-frames.ts";

export type RecordedFrame =
	| readonly ["lifecycle", status: "started" | "completed", detached: boolean]
	| readonly ["progress", status: "running" | "completed", requests: number, tokens: number, durationMs: number];

/** Scenario S1, async: one `task` worker runs one turn. */
export const ONE_TURN_ASYNC: readonly RecordedFrame[] = [
	["progress", "running", 0, 0, 17],
	["lifecycle", "started", true],
	["progress", "running", 1, 3203, 94],
	["progress", "running", 1, 3203, 96],
	["progress", "running", 1, 3203, 98],
	["progress", "completed", 1, 3203, 100],
	["lifecycle", "completed", true],
];

/** Scenario S2, async: the worker runs a turn, then one follow-up turn. */
export const FOLLOW_UP_ASYNC: readonly RecordedFrame[] = [
	["progress", "running", 0, 0, 9],
	["lifecycle", "started", true],
	["progress", "running", 1, 3203, 114],
	["progress", "running", 1, 3203, 116],
	["progress", "running", 1, 3203, 119],
	["progress", "completed", 1, 3203, 122],
	["lifecycle", "completed", true],
	["lifecycle", "started", true],
	["progress", "running", 0, 0, 1],
	["progress", "running", 1, 3315, 6],
	["progress", "running", 1, 3315, 7],
	["progress", "running", 1, 3315, 8],
	["progress", "completed", 1, 3315, 10],
	["lifecycle", "completed", true],
];

/** Scenario S2, sync: the first turn blocks the caller (`detached: false`), the follow-up is detached. */
export const FOLLOW_UP_SYNC: readonly RecordedFrame[] = [
	["progress", "running", 0, 0, 6],
	["lifecycle", "started", false],
	["progress", "running", 1, 3205, 58],
	["progress", "running", 1, 3205, 61],
	["progress", "running", 1, 3205, 65],
	["progress", "completed", 1, 3205, 66],
	["lifecycle", "completed", false],
	["lifecycle", "started", true],
	["progress", "running", 0, 0, 1],
	["progress", "running", 1, 3317, 6],
	["progress", "running", 1, 3317, 7],
	["progress", "running", 1, 3317, 8],
	["progress", "completed", 1, 3317, 11],
	["lifecycle", "completed", true],
];

const RECORDED_OWNER = { agent: "task", parentToolCallId: "call_smoke_1_0" };

/** Publish `frames` on every bus, a fresh payload object per frame, in the recorded order. */
export function replay(buses: readonly EventBus[], frames: readonly RecordedFrame[], id = "smoke-worker"): void {
	for (const frame of frames) {
		if (frame[0] === "lifecycle") {
			publish(buses, SUBAGENT_LIFECYCLE_CHANNEL, { id, ...RECORDED_OWNER, status: frame[1], index: 0, detached: frame[2] });
		} else {
			publish(buses, SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				...RECORDED_OWNER,
				task: "work",
				progress: { id, agent: "task", status: frame[1], requests: frame[2], tokens: frame[3], cost: 0, durationMs: frame[4] },
			});
		}
	}
}
