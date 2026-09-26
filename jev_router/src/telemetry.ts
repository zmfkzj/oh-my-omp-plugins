/**
 * Aggregate routing telemetry plus a per-decision log.
 *
 * No prompt text, no task text, no source, no transcript, no credential. Both
 * files live outside the repository and outside the plugin source tree, under
 * OMP's agent state directory, and `/jev-router reset` deletes them:
 *
 * - `telemetry.json` — counters and distributions.
 * - `decisions.jsonl` — one line per Jev decision: labels, raw probabilities,
 *   gate outcome, latency. The pre-gate `top` and probabilities let any other
 *   gate be replayed exactly offline; the aggregate histograms cannot.
 *
 * Worker usage is attributed by selected tier agent name and read from OMP's
 * subagent progress/lifecycle frames, which fire for sync and background
 * spawns alike (see `worker-usage.ts`). `ctx.sessionManager.getUsageStatistics()`
 * is a single session-wide total with no per-role breakdown, so it cannot
 * substitute.
 */
import { appendFile, rename } from "node:fs/promises";
import path from "node:path";

export const HISTOGRAM_BUCKETS = 10;
export const TELEMETRY_VERSION = 4;

export interface RouteCounters {
	requests: number;
	errors: number;
	timeouts: number;
	latencySumMs: number;
	latencyCount: number;
	confidence: number[];
	margin: number[];
}

export interface WorkerCounters {
	/** Routing decisions that selected this agent. */
	spawns: number;
	/** Settled spawns (completed, failed, or aborted) whose usage was observed. */
	results: number;
	/** Settled spawns that completed successfully. */
	completed: number;
	/** Input + output + cacheWrite tokens (OMP's `AgentProgress.tokens`; excludes cacheRead). */
	tokens: number;
	/** Provider-reported spend accumulated by OMP for the spawn. */
	costUsd: number;
	durationMs: number;
}

/** One settled spawn's final usage. */
export interface WorkerSettlement {
	tokens: number;
	costUsd: number;
	durationMs: number;
	completed: boolean;
}

export interface TelemetrySnapshot {
	version: typeof TELEMETRY_VERSION;
	updatedAt: number;
	orchestration: RouteCounters & {
		DEFAULT: number;
		ORCHESTRATE: number;
		/** Retired DIRECT/SLOW/UNCERTAIN labels, retained only as historical totals. */
		legacyDecisions: number;
	};
	task: RouteCounters & { batches: number; TASK_EASY: number; TASK_HARD: number; TASK_CHALLENGE: number; fallbackChallenge: number; legacyDecisions: number; legacyFallbacks: number };
	workers: Record<string, WorkerCounters>;
}

interface GateFields {
	/** Pre-gate highest-probability label. */
	top: string;
	probabilities: Readonly<Record<string, number>>;
	confidence: number;
	margin: number;
	confident: boolean;
}

/** One line of `decisions.jsonl`, minus the timestamp added on append. */
export type DecisionRecord =
	| (GateFields & { kind: "orchestration"; route: string; latencyMs: number })
	| (GateFields & { kind: "task"; route: string; latencyMs: number; batchSize: number })
	| { kind: "orchestration" | "task"; route: "ERROR"; timedOut: boolean; items?: number };

function emptyRouteCounters(): RouteCounters {
	return {
		requests: 0,
		errors: 0,
		timeouts: 0,
		latencySumMs: 0,
		latencyCount: 0,
		confidence: Array.from({ length: HISTOGRAM_BUCKETS }, () => 0),
		margin: Array.from({ length: HISTOGRAM_BUCKETS }, () => 0),
	};
}

export function emptyWorkerCounters(): WorkerCounters {
	return { spawns: 0, results: 0, completed: 0, tokens: 0, costUsd: 0, durationMs: 0 };
}

export function emptySnapshot(): TelemetrySnapshot {
	return {
		version: TELEMETRY_VERSION,
		updatedAt: 0,
		orchestration: { ...emptyRouteCounters(), DEFAULT: 0, ORCHESTRATE: 0, legacyDecisions: 0 },
		task: { ...emptyRouteCounters(), batches: 0, TASK_EASY: 0, TASK_HARD: 0, TASK_CHALLENGE: 0, fallbackChallenge: 0, legacyDecisions: 0, legacyFallbacks: 0 },
		workers: {},
	};
}

/** Bucket index for a probability in [0,1]. */
export function bucketOf(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const clamped = Math.min(0.999999, Math.max(0, value));
	return Math.floor(clamped * HISTOGRAM_BUCKETS);
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mergeCounters(target: number[], source: unknown): void {
	if (!Array.isArray(source)) return;
	for (let index = 0; index < target.length; index++) {
		const value = finite(source[index]);
		if (value !== undefined) target[index] = value;
	}
}

function reviveRoute<T extends RouteCounters>(target: T, source: unknown): T {
	if (typeof source !== "object" || source === null) return target;
	const record = source as Record<string, unknown>;
	for (const key of Object.keys(target) as (keyof T & string)[]) {
		const value = record[key];
		if (key === "confidence" || key === "margin") {
			mergeCounters(target[key] as unknown as number[], value);
		} else {
			const number = finite(value);
			if (number !== undefined) (target as Record<string, unknown>)[key] = number;
		}
	}
	return target;
}

function reviveWorker(source: Record<string, unknown>): WorkerCounters {
	const counters = emptyWorkerCounters();
	for (const key of Object.keys(counters) as (keyof WorkerCounters)[]) {
		const value = finite(source[key]);
		if (value !== undefined) counters[key] = value;
	}
	// v1/v2 stored split token fields; fold them into v3's `tokens` definition.
	if (finite(source.tokens) === undefined) {
		counters.tokens = (finite(source.input) ?? 0) + (finite(source.output) ?? 0) + (finite(source.cacheWrite) ?? 0);
	}
	return counters;
}

/**
 * Parse a persisted snapshot, discarding anything malformed.
 *
 * Every label ever written stays accounted for: a renamed route counter is
 * migrated here rather than dropped, so `requests` keeps matching the sum of
 * its route counters.
 */
export function reviveSnapshot(raw: unknown): TelemetrySnapshot {
	const snapshot = emptySnapshot();
	if (typeof raw !== "object" || raw === null) return snapshot;
	const record = raw as Record<string, unknown>;
	reviveRoute(snapshot.orchestration, record.orchestration);
	reviveRoute(snapshot.task, record.task);
	if (typeof record.orchestration === "object" && record.orchestration !== null) {
		const old = record.orchestration as Record<string, unknown>;
		for (const label of ["DIRECT", "legacyDirect", "SLOW", "UNCERTAIN"]) {
			snapshot.orchestration.legacyDecisions += finite(old[label]) ?? 0;
		}
	}
	if (typeof record.task === "object" && record.task !== null) {
		const old = record.task as Record<string, unknown>;
		snapshot.task.legacyDecisions += (finite(old.TASK_NORMAL) ?? 0) + (finite(old.TASK_DEEP) ?? 0);
		snapshot.task.legacyFallbacks += finite(old.fallbackDeep) ?? 0;
	}
	const updatedAt = finite(record.updatedAt);
	if (updatedAt !== undefined) snapshot.updatedAt = updatedAt;
	if (typeof record.workers === "object" && record.workers !== null) {
		for (const [agent, value] of Object.entries(record.workers as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			snapshot.workers[agent] = reviveWorker(value as Record<string, unknown>);
		}
	}
	return snapshot;
}

const FLUSH_DEBOUNCE_MS = 2000;
/** Settled spawn keys remembered for de-duplication across session buses. */
const MAX_SETTLED_KEYS = 4096;

/**
 * In-memory counters with a debounced JSON sink, plus an append-only decision log.
 *
 * One instance per state directory per process. Every session in an OMP
 * process — the main session and each subagent — builds its own extension
 * runtime (the factory runs per session), and they all target the same files;
 * separate instances would race and lose counts, so {@link Telemetry.shared}
 * hands them the same writer.
 */
export class Telemetry {
	static readonly #instances = new Map<string, Telemetry>();

	/** The process's writer for `stateDir`, created on first use. */
	static shared(stateDir: string): Telemetry {
		const existing = Telemetry.#instances.get(stateDir);
		if (existing) return existing;
		const created = new Telemetry(stateDir);
		Telemetry.#instances.set(stateDir, created);
		return created;
	}

	/** Drop the process-level registry. Test-only. */
	static resetSharedForTests(): void {
		Telemetry.#instances.clear();
	}

	#snapshot = emptySnapshot();
	#dirty = false;
	#flushing: Promise<void> | undefined;
	#appending: Promise<void> = Promise.resolve();
	#timer: Timer | undefined;
	#enabled = true;
	#loaded: Promise<void> | undefined;
	readonly #settled = new Set<string>();
	readonly #file: string;
	readonly #decisionsFile: string;

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "telemetry.json");
		this.#decisionsFile = path.join(stateDir, "decisions.jsonl");
	}

	get file(): string {
		return this.#file;
	}

	get decisionsFile(): string {
		return this.#decisionsFile;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	snapshot(): Readonly<TelemetrySnapshot> {
		return this.#snapshot;
	}

	/** Read the persisted counters once; later sessions reuse the loaded state. */
	load(): Promise<void> {
		this.#loaded ??= this.#read();
		return this.#loaded;
	}

	async #read(): Promise<void> {
		try {
			const handle = Bun.file(this.#file);
			if (!(await handle.exists())) return;
			const raw: unknown = await handle.json();
			const version = typeof raw === "object" && raw !== null ? finite((raw as Record<string, unknown>).version) : undefined;
			if (version !== undefined && version > TELEMETRY_VERSION) {
				// Written by a newer plugin: set it aside instead of overwriting it.
				await rename(this.#file, path.join(path.dirname(this.#file), `telemetry.v${version}.json`));
				return;
			}
			this.#snapshot = reviveSnapshot(raw);
			// Persist a migrated snapshot so the upgrade is not repeated on every load.
			if (version !== TELEMETRY_VERSION) this.#touch();
		} catch {
			this.#snapshot = emptySnapshot();
		}
	}

	#touch(): void {
		if (!this.#enabled) return;
		this.#dirty = true;
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, FLUSH_DEBOUNCE_MS);
		this.#timer.unref?.();
	}

	recordOrchestration(route: "DEFAULT" | "ORCHESTRATE", confidence: number, margin: number, latencyMs: number): void {
		if (!this.#enabled) return;
		const bucket = this.#snapshot.orchestration;
		bucket.requests++;
		bucket[route]++;
		bucket.latencySumMs += latencyMs;
		bucket.latencyCount++;
		bucket.confidence[bucketOf(confidence)]!++;
		bucket.margin[bucketOf(margin)]!++;
		this.#touch();
	}

	recordTaskBatch(latencyMs: number): void {
		if (!this.#enabled) return;
		this.#snapshot.task.batches++;
		this.#snapshot.task.requests++;
		this.#snapshot.task.latencySumMs += latencyMs;
		this.#snapshot.task.latencyCount++;
		this.#touch();
	}

	recordTaskDecision(route: "TASK_EASY" | "TASK_HARD" | "TASK_CHALLENGE", confidence: number, margin: number, confident: boolean): void {
		if (!this.#enabled) return;
		const bucket = this.#snapshot.task;
		bucket[route]++;
		if (!confident) bucket.fallbackChallenge++;
		bucket.confidence[bucketOf(confidence)]!++;
		bucket.margin[bucketOf(margin)]!++;
		this.#touch();
	}

	recordFailure(channel: "orchestration" | "task", timedOut: boolean): void {
		if (!this.#enabled) return;
		const bucket = channel === "orchestration" ? this.#snapshot.orchestration : this.#snapshot.task;
		bucket.errors++;
		if (timedOut) bucket.timeouts++;
		this.#touch();
	}

	recordSpawn(agent: string): void {
		if (!this.#enabled) return;
		this.#worker(agent).spawns++;
		this.#touch();
	}

	/**
	 * Count one settled spawn. `key` identifies the spawn process-wide; a spawn
	 * seen on several session buses is counted once.
	 */
	recordWorkerSettled(key: string, agent: string, settlement: WorkerSettlement): void {
		if (!this.#enabled || this.#settled.has(key)) return;
		this.#settled.add(key);
		if (this.#settled.size > MAX_SETTLED_KEYS) {
			const oldest = this.#settled.values().next();
			if (!oldest.done) this.#settled.delete(oldest.value);
		}
		const counters = this.#worker(agent);
		counters.results++;
		if (settlement.completed) counters.completed++;
		counters.tokens += settlement.tokens;
		counters.costUsd += settlement.costUsd;
		counters.durationMs += settlement.durationMs;
		this.#touch();
	}

	/** Append one decision to `decisions.jsonl`. Writes are serialized and never throw. */
	appendDecision(record: DecisionRecord): void {
		if (!this.#enabled) return;
		const line = `${JSON.stringify({ ts: Date.now(), ...record })}\n`;
		this.#appending = this.#appending.then(() =>
			appendFile(this.#decisionsFile, line).catch(() => {
				// A log write must never break a turn; drop the line.
			}),
		);
	}

	#worker(agent: string): WorkerCounters {
		const existing = this.#snapshot.workers[agent];
		if (existing) return existing;
		const created = emptyWorkerCounters();
		this.#snapshot.workers[agent] = created;
		return created;
	}

	async flush(): Promise<void> {
		await this.#appending;
		if (!this.#dirty) return;
		await this.#flushing;
		if (!this.#dirty) return;
		this.#dirty = false;
		this.#snapshot.updatedAt = Date.now();
		this.#flushing = Bun.write(this.#file, JSON.stringify(this.#snapshot)).then(
			() => undefined,
			() => {
				// A telemetry write must never break a turn; drop the sample.
			},
		);
		await this.#flushing;
	}

	async reset(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#snapshot = emptySnapshot();
		this.#dirty = false;
		this.#settled.clear();
		// The cleared state is authoritative; a later `load()` must not re-read.
		this.#loaded = Promise.resolve();
		await this.#appending;
		for (const file of [this.#file, this.#decisionsFile]) {
			try {
				await Bun.file(file).delete();
			} catch {
				// Already absent.
			}
		}
	}
}
