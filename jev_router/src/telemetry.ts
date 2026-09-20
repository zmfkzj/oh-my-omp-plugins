/**
 * Aggregate routing telemetry.
 *
 * Counts and distributions only — no prompt text, no task text, no source, no
 * transcript, no credential. The file lives outside the repository and outside
 * the plugin source tree, under OMP's agent state directory, and
 * `/jev-router reset` deletes it.
 *
 * Worker token usage is attributed by agent name, which is exactly the tier the
 * router selected (`task` = normal, `task-deep` = deep). OMP reports a spawn's
 * `usage` in the `task` tool result; background spawns report it when their job
 * settles, so totals cover every spawn whose result the parent session
 * observed. That is the closest per-tier cost signal the public extension
 * surface exposes: `ctx.sessionManager.getUsageStatistics()` is a single
 * session-wide total with no per-role breakdown (`UsageStatistics` in
 * `src/session/session-entries.ts`).
 */
import path from "node:path";

export const HISTOGRAM_BUCKETS = 10;

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
	spawns: number;
	results: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Provider-reported spend, when OMP attached a cost to the spawn's usage. */
	costUsd: number;
	durationMs: number;
}

/** One spawn's reported usage, as extracted from a `task` tool result. */
export interface WorkerUsageSample {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	costUsd?: number;
}

export interface TelemetrySnapshot {
	version: 1;
	updatedAt: number;
	orchestration: RouteCounters & { DIRECT: number; ORCHESTRATE: number; UNCERTAIN: number };
	task: RouteCounters & { batches: number; TASK_NORMAL: number; TASK_DEEP: number; fallbackDeep: number };
	workers: Record<string, WorkerCounters>;
}

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
	return { spawns: 0, results: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 0 };
}

export function emptySnapshot(): TelemetrySnapshot {
	return {
		version: 1,
		updatedAt: 0,
		orchestration: { ...emptyRouteCounters(), DIRECT: 0, ORCHESTRATE: 0, UNCERTAIN: 0 },
		task: { ...emptyRouteCounters(), batches: 0, TASK_NORMAL: 0, TASK_DEEP: 0, fallbackDeep: 0 },
		workers: {},
	};
}

/** Bucket index for a probability in [0,1]. */
export function bucketOf(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const clamped = Math.min(0.999999, Math.max(0, value));
	return Math.floor(clamped * HISTOGRAM_BUCKETS);
}

function mergeCounters(target: number[], source: unknown): void {
	if (!Array.isArray(source)) return;
	for (let index = 0; index < target.length; index++) {
		const value = source[index];
		if (typeof value === "number" && Number.isFinite(value)) target[index] = value;
	}
}

function reviveRoute<T extends RouteCounters>(target: T, source: unknown): T {
	if (typeof source !== "object" || source === null) return target;
	const record = source as Record<string, unknown>;
	for (const key of Object.keys(target) as (keyof T & string)[]) {
		const value = record[key];
		if (key === "confidence" || key === "margin") {
			mergeCounters(target[key] as unknown as number[], value);
		} else if (typeof value === "number" && Number.isFinite(value)) {
			(target as Record<string, unknown>)[key] = value;
		}
	}
	return target;
}

/** Parse a persisted snapshot, discarding anything malformed. */
export function reviveSnapshot(raw: unknown): TelemetrySnapshot {
	const snapshot = emptySnapshot();
	if (typeof raw !== "object" || raw === null) return snapshot;
	const record = raw as Record<string, unknown>;
	reviveRoute(snapshot.orchestration, record.orchestration);
	reviveRoute(snapshot.task, record.task);
	if (typeof record.updatedAt === "number") snapshot.updatedAt = record.updatedAt;
	if (typeof record.workers === "object" && record.workers !== null) {
		for (const [agent, value] of Object.entries(record.workers as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const counters = emptyWorkerCounters();
			for (const key of Object.keys(counters) as (keyof WorkerCounters)[]) {
				const entry = (value as Record<string, unknown>)[key];
				if (typeof entry === "number" && Number.isFinite(entry)) counters[key] = entry;
			}
			snapshot.workers[agent] = counters;
		}
	}
	return snapshot;
}

const FLUSH_DEBOUNCE_MS = 2000;

/**
 * In-memory counters with a debounced JSON sink.
 *
 * One instance per state directory per process. Every session in an OMP
 * process — the main session and each subagent — builds its own extension
 * runtime (the factory runs per session), and they all target the same file;
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
	#timer: Timer | undefined;
	#enabled = true;
	#loaded: Promise<void> | undefined;
	readonly #file: string;

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "telemetry.json");
	}

	get file(): string {
		return this.#file;
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
			if (await handle.exists()) this.#snapshot = reviveSnapshot(await handle.json());
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

	recordOrchestration(route: "DIRECT" | "ORCHESTRATE" | "UNCERTAIN", confidence: number, margin: number, latencyMs: number): void {
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

	recordTaskDecision(route: "TASK_NORMAL" | "TASK_DEEP", confidence: number, margin: number, confident: boolean): void {
		if (!this.#enabled) return;
		const bucket = this.#snapshot.task;
		bucket[route]++;
		if (!confident) bucket.fallbackDeep++;
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

	recordWorkerUsage(agent: string, usage: WorkerUsageSample, durationMs: number): void {
		if (!this.#enabled) return;
		const counters = this.#worker(agent);
		counters.results++;
		counters.input += usage.input ?? 0;
		counters.output += usage.output ?? 0;
		counters.cacheRead += usage.cacheRead ?? 0;
		counters.cacheWrite += usage.cacheWrite ?? 0;
		counters.costUsd += usage.costUsd ?? 0;
		counters.durationMs += durationMs;
		this.#touch();
	}

	#worker(agent: string): WorkerCounters {
		const existing = this.#snapshot.workers[agent];
		if (existing) return existing;
		const created = emptyWorkerCounters();
		this.#snapshot.workers[agent] = created;
		return created;
	}

	async flush(): Promise<void> {
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
		// The cleared state is authoritative; a later `load()` must not re-read.
		this.#loaded = Promise.resolve();
		try {
			await Bun.file(this.#file).delete();
		} catch {
			// Already absent.
		}
	}
}
