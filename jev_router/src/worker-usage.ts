/**
 * Live usage of OMP's generic `task` workers, from subagent frames.
 *
 * The `task` tool result is not a usable source: with `async.enabled` a spawn
 * returns immediately with an empty `results` array, and its usage never
 * reaches another `tool_result`. OMP instead publishes each worker's lifecycle
 * (`started`, then `completed`, `failed`, or `aborted`) and its cumulative
 * `AgentProgress` (tokens, cost, duration) on the session event bus, sync and
 * background alike. The final progress frame is flushed before the settled
 * lifecycle frame, so the latest progress at settlement is the worker's usage.
 *
 * Workers are counted by agent name, not by caller: the frames carry no
 * invocation kind, so `task` workers from the task tool, eval `agent()`, and
 * workpool are reported together. Specialist and custom agents are not counted
 * live.
 *
 * Channel names mirror `@oh-my-pi/pi-tui/overlays/session-observer-registry`;
 * pi-tui subpaths do not resolve at runtime from an extension, so they are
 * repeated here. Frames are read structurally so a shape change degrades to
 * "no sample" instead of a thrown listener.
 */
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent";
import { GENERIC_TASK_AGENT } from "./task-contract.ts";
import type { Telemetry } from "./telemetry.ts";

export const SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
export const SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One worker's identity, the same on every bus that carries its frames. */
function workerKey(parentToolCallId: unknown, id: string): string {
	return `${typeof parentToolCallId === "string" ? parentToolCallId : ""}:${id}`;
}

/** Subscribe `telemetry` to the `task` worker frames on `events`; returns the unsubscriber. */
export function trackWorkerUsage(events: EventBusLike, telemetry: Telemetry): () => void {
	const offProgress = events.on(SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as Partial<SubagentProgressPayload> | null | undefined;
		const progress = payload?.progress;
		if (typeof progress?.id !== "string" || progress.agent !== GENERIC_TASK_AGENT) return;
		telemetry.observeWorkerProgress(workerKey(payload?.parentToolCallId, progress.id), GENERIC_TASK_AGENT, {
			tokens: numberOr0(progress.tokens),
			costUsd: numberOr0(progress.cost),
			durationMs: numberOr0(progress.durationMs),
		});
	});

	const offLifecycle = events.on(SUBAGENT_LIFECYCLE_CHANNEL, data => {
		const payload = data as Partial<SubagentLifecyclePayload> | null | undefined;
		if (typeof payload?.id !== "string" || payload.agent !== GENERIC_TASK_AGENT) return;
		const key = workerKey(payload.parentToolCallId, payload.id);
		const status: unknown = payload.status;
		if (status === "started") {
			telemetry.observeWorkerStart(key, GENERIC_TASK_AGENT);
		} else if (status === "completed" || status === "failed" || status === "aborted") {
			// OMP's own terminal statuses; any other value is not assumed to be one.
			telemetry.observeWorkerSettled(key, GENERIC_TASK_AGENT, status);
		}
	});

	return () => {
		offProgress();
		offLifecycle();
	};
}
