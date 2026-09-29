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
 * A worker's identity is its session scope, its `parentToolCallId` and its
 * `id`. The live reviver hands a follow-up turn the original spawn's
 * `parentToolCallId`, and eval `agent()` and `workpool()` spawns never have
 * one, so every in-process path keeps the same key across a worker's turns. An
 * absent `parentToolCallId` is not a follow-up marker.
 *
 * The scope is what keeps sessions apart. The host allocates worker ids per
 * session, so two sessions of one process can both run a worker `reviewers-0`
 * (ACP hosts several, each with a bus of its own), and without a scope the
 * second one's frames would be taken for a repeat of the first's and lost.
 * Within one session the host never allocates an id twice, `/new` included, so
 * a repeated id on one bus is the same worker. The frames carry no session
 * marker that could say otherwise: `sessionFile` is absent when a session has
 * no artifacts directory and is not derived the same way on every frame.
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

/** Scopes handed to buses that were not given one; weak, so a session's bus is never kept alive by its scope. */
const busScopes = new WeakMap<object, string>();
let busCount = 0;

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Which session a bus belongs to when the caller does not say: the bus itself, the same for every subscription on it. */
function scopeOfBus(events: object): string {
	let scope = busScopes.get(events);
	if (scope === undefined) {
		scope = `bus-${++busCount}`;
		busScopes.set(events, scope);
	}
	return scope;
}

/** One worker's identity: the same across its turns and on every bus of its session, and never another session's. */
function workerKey(scope: string, parentToolCallId: unknown, id: string): string {
	return JSON.stringify([scope, typeof parentToolCallId === "string" ? parentToolCallId : "", id]);
}

export interface WorkerUsageOptions {
	/**
	 * The session whose frames `events` carries. Workers of different scopes never
	 * share an identity, however their ids and tool call ids read. Defaults to a
	 * scope of the bus itself, one session's as the host builds a bus per session;
	 * buses that carry the same session's frames share a scope, so a frame that
	 * reaches more than one of them counts once.
	 */
	scope?: string;
}

/**
 * Subscribe `telemetry` to the `task` worker frames on `events`, the session
 * bus an extension gets as `pi.events`; returns the unsubscriber. The host also
 * publishes each frame on a tree-wide observability bus, which extensions never
 * receive. Every session in the process, main and subagents, builds its own
 * extension and subscribes its own bus to the process's one `Telemetry`; each
 * bus is a scope of its own unless `options.scope` says otherwise, and
 * `Telemetry` tells subscriptions of one scope apart, so a frame that reaches it
 * through more than one counts once.
 */
export function trackWorkerUsage(events: EventBusLike, telemetry: Telemetry, options: WorkerUsageOptions = {}): () => void {
	const source: WorkerSource = Symbol("task-worker-frames");
	const scope = options.scope ?? scopeOfBus(events);

	const offProgress = events.on(SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as Partial<SubagentProgressPayload> | null | undefined;
		const progress = payload?.progress;
		if (typeof progress?.id !== "string" || progress.agent !== GENERIC_TASK_AGENT) return;
		telemetry.observeWorker(source, workerKey(scope, payload?.parentToolCallId, progress.id), GENERIC_TASK_AGENT, {
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
		const key = workerKey(scope, payload.parentToolCallId, payload.id);
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
