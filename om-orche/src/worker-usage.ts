/**
 * Live usage of OMP's generic `task` workers, from subagent frames.
 *
 * The `task` tool result is not a usable source: with `async.enabled` a spawn
 * returns immediately with an empty `results` array, and its usage never
 * reaches another `tool_result`. OMP instead publishes each worker turn's
 * lifecycle (`started`, then `completed`, `failed`, or `aborted`) and its
 * cumulative `AgentProgress` (tokens, cost, duration) on the session event bus,
 * sync and background alike. The final progress frame is flushed before the
 * settled lifecycle frame, so the latest progress at settlement is that turn's
 * usage.
 *
 * A worker OMP keeps alive runs more than one turn: a message to an idle worker
 * (`write agent://<id>`), a workpool item routed to a reused worker, or a
 * resume of a parked one. Each such turn re-emits `started` with the same
 * `id`, then progress that restarts from zero (every turn builds a new run
 * monitor), then its own terminal frame. Telemetry therefore counts turns: one
 * distinct worker, however many turns it ran, each settled and measured from
 * its own final progress and summed — cumulative progress is never added twice.
 *
 * A worker's FIRST turn is the exception in frame order, observed on OMP 18.4.1
 * in both sync and async spawns: a progress frame that has measured nothing yet
 * (`requests: 0`, `tokens: 0`) is published before `started`, because the host
 * publishes progress while the session is still being set up — the task label
 * landing (`executor.ts` label side call), an advisor attaching
 * (`publishAdvisorState` in `setActiveSession`) — and emits `started` only
 * afterwards. Follow-up turns emit `started` synchronously, before any progress.
 * `Telemetry.observeWorker` therefore pairs such early progress with the
 * `started` that follows it on the same bus, so a first turn is never taken for
 * two turns.
 *
 * A worker's identity is `<parentToolCallId>:<id>`. The live reviver hands a
 * follow-up turn the original spawn's `parentToolCallId`, and eval `agent()`
 * and `workpool()` spawns never have one, so every in-process path keeps the
 * same key across a worker's turns. An absent `parentToolCallId` is not a
 * follow-up marker.
 *
 * Workers are counted by agent name, not by caller: the frames carry no
 * invocation kind, so `task` workers from the task tool, eval `agent()`, and
 * workpool are reported together. Specialist and custom agents are not counted
 * live. Limits: a worker OMP revives from disk after a restart is reported
 * under its worker id instead of `task` (the host builds its agent definition
 * from the registry ref, `persisted-revive.ts`), so its later turns are not
 * counted; and a worker's turn that overlaps another on the same id — the host
 * backs off when an IRC wake owns the session — is not told apart from it.
 *
 * Channel names mirror `@oh-my-pi/pi-tui/overlays/session-observer-registry`;
 * pi-tui subpaths do not resolve at runtime from an extension, so they are
 * repeated here. Frames are read structurally so a shape change degrades to
 * "no sample" instead of a thrown listener.
 */
import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent";
import type { Telemetry, WorkerSource } from "./telemetry.ts";

const GENERIC_TASK_AGENT = "task";

export const SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
export const SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

interface EventBusLike {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One worker's identity, the same on every bus that carries its frames and across its turns. */
function workerKey(parentToolCallId: unknown, id: string): string {
	return `${typeof parentToolCallId === "string" ? parentToolCallId : ""}:${id}`;
}

/**
 * Subscribe `telemetry` to the `task` worker frames on `events`; returns the
 * unsubscriber. Telemetry tells buses apart by subscription, so several buses —
 * the host publishes each frame on the session bus and on the tree-wide
 * observability bus — may feed one `Telemetry` and each frame counts once.
 */
export function trackWorkerUsage(events: EventBusLike, telemetry: Telemetry): () => void {
	const source: WorkerSource = Symbol("task-worker-frames");

	const offProgress = events.on(SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as Partial<SubagentProgressPayload> | null | undefined;
		const progress = payload?.progress;
		if (typeof progress?.id !== "string" || progress.agent !== GENERIC_TASK_AGENT) return;
		telemetry.observeWorker(source, workerKey(payload?.parentToolCallId, progress.id), GENERIC_TASK_AGENT, {
			kind: "progress",
			usage: {
				tokens: numberOr0(progress.tokens),
				costUsd: numberOr0(progress.cost),
				durationMs: numberOr0(progress.durationMs),
			},
		});
	});

	const offLifecycle = events.on(SUBAGENT_LIFECYCLE_CHANNEL, data => {
		const payload = data as Partial<SubagentLifecyclePayload> | null | undefined;
		if (typeof payload?.id !== "string" || payload.agent !== GENERIC_TASK_AGENT) return;
		const key = workerKey(payload.parentToolCallId, payload.id);
		const status: unknown = payload.status;
		if (status === "started") {
			telemetry.observeWorker(source, key, GENERIC_TASK_AGENT, { kind: "started" });
		} else if (status === "completed" || status === "failed" || status === "aborted") {
			// OMP's own terminal statuses; any other value is not assumed to be one.
			telemetry.observeWorker(source, key, GENERIC_TASK_AGENT, { kind: "settled", status });
		}
	});

	return () => {
		offProgress();
		offLifecycle();
	};
}
