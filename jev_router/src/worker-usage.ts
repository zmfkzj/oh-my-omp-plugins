/**
 * Per-tier worker usage from OMP's subagent frames.
 *
 * The `task` tool result is not a usable source: with `async.enabled` a spawn
 * returns immediately with an empty `results` array, and its usage never
 * reaches another `tool_result`. OMP instead publishes every spawn's cumulative
 * `AgentProgress` (tokens, cost, duration) on the session event bus, sync and
 * background alike, and a lifecycle frame when it settles. The last progress
 * frame before a settled lifecycle frame is the spawn's final usage.
 *
 * Channel names mirror `@oh-my-pi/pi-tui/overlays/session-observer-registry`;
 * pi-tui subpaths do not resolve at runtime from an extension, so they are
 * repeated here. Frames are read structurally so a shape change degrades to
 * "no sample" instead of a thrown listener.
 */
import type { Telemetry } from "./telemetry.ts";

export const SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
export const SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

interface LatestProgress {
	tokens: number;
	costUsd: number;
	durationMs: number;
}

/** Spawns still running whose latest progress is retained; bounded against leaks. */
const MAX_TRACKED_SPAWNS = 1024;

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Subscribe `telemetry` to tier-agent settlements on `events`. `tierAgents`
 * limits counting to the agents the router chooses between.
 */
export function trackWorkerUsage(events: EventBusLike, telemetry: Telemetry, tierAgents: ReadonlySet<string>): () => void {
	const latest = new Map<string, LatestProgress>();

	const offProgress = events.on(SUBAGENT_PROGRESS_CHANNEL, data => {
		if (typeof data !== "object" || data === null) return;
		const payload = data as Record<string, unknown>;
		const progress = payload.progress;
		if (typeof progress !== "object" || progress === null) return;
		const record = progress as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.agent !== "string" || !tierAgents.has(record.agent)) return;
		const key = `${String(payload.parentToolCallId ?? "")}:${record.id}`;
		latest.delete(key);
		latest.set(key, {
			tokens: numberOr0(record.tokens),
			costUsd: numberOr0(record.cost),
			durationMs: numberOr0(record.durationMs),
		});
		if (latest.size > MAX_TRACKED_SPAWNS) {
			const oldest = latest.keys().next();
			if (!oldest.done) latest.delete(oldest.value);
		}
	});

	const offLifecycle = events.on(SUBAGENT_LIFECYCLE_CHANNEL, data => {
		if (typeof data !== "object" || data === null) return;
		const payload = data as Record<string, unknown>;
		const status = payload.status;
		if (status !== "completed" && status !== "failed" && status !== "aborted") return;
		if (typeof payload.id !== "string" || typeof payload.agent !== "string" || !tierAgents.has(payload.agent)) return;
		const key = `${String(payload.parentToolCallId ?? "")}:${payload.id}`;
		const usage = latest.get(key);
		// OMP flushes a final progress frame synchronously before settling; with
		// none observed the usage is unknown, and a zero sample would skew cost.
		if (!usage) return;
		latest.delete(key);
		telemetry.recordWorkerSettled(key, payload.agent, { ...usage, completed: status === "completed" });
	});

	return () => {
		offProgress();
		offLifecycle();
	};
}
