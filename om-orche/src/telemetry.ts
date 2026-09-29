/**
 * Aggregate telemetry of OMP's generic `task` workers, format v6.
 *
 * No prompt text, no task text, no source, no transcript, no credential. The
 * files live outside the repository and the plugin source tree, in the
 * plugin's state directory under OMP's agent directory:
 *
 * - `telemetry.json` — the live epoch's worker counters, plus the read-only
 *   sections earlier eras were converted into: `jevRouting`, the v5 live epoch
 *   (front-door routing counters and worker rows), and `historical`, the
 *   tier-routing era of pre-v5 files.
 * - `telemetry-history/v<version>-<sha256>.json` — the exact bytes of an older
 *   `telemetry.json`, preserved before migration replaced it.
 * - `decisions.jsonl` — the routing eras' per-decision log. It is no longer
 *   written or read; it stays on disk until a reset removes it.
 * - `telemetry.lock` — a directory that exists only while a process reads and
 *   replaces `telemetry.json`, or a reset deletes the files (`state-lock.ts`).
 *
 * An epoch is one span of measurements under one behavior. Migration moves a
 * v5 file's live epoch into `jevRouting`, carries its tier-routing
 * `historical` section over unchanged (a pre-v5 file's counters are converted
 * into `historical` instead), and starts an empty live epoch; reset starts
 * another. Historical numbers are never added to live ones: they count other
 * things — routing decisions and selections, and (in v5) workers counted once,
 * without their follow-up turns.
 *
 * Several OMP processes may share one state directory. Each keeps only the
 * counts it recorded itself since it last wrote, and a write adds them to the
 * file as it is at that moment: the read, the merge and the publication happen
 * under `telemetry.lock`, so no process overwrites another's counts. The
 * publication is a rename that only succeeds while the writer still holds the
 * lock, so even a writer stopped for so long that its lock was broken publishes
 * nothing and keeps its counts for its next attempt (`state-lock.ts` has the
 * protocol). A reset deletes the files under the same lock. A process that
 * finds the file it last wrote gone, because another process reset, starts a
 * new epoch (new id, new start time) and writes its unwritten counts into it:
 * only what is on disk is ever cleared, so a later write cannot undo a reset.
 * What a process shows of the file is its last view of it, so a reader that
 * wants what the others wrote calls `refresh()`: a plain read, since the file
 * is only ever replaced whole, that takes no lock and writes nothing.
 *
 * Every session of an OMP process shares one writer per state directory, but
 * not one telemetry choice: each main session's configuration decides whether
 * the workers of its own session tree are recorded (`setEnabled`,
 * `recordsFor`), and the writer writes and migrates while any of them wants
 * that. A write that fails (no permission, a full disk, a lock held for too
 * long) keeps its counts pending, shows as `writeError` in the state, is
 * warned about once through the logger, and is retried after a growing delay
 * until it succeeds.
 *
 * Live worker usage comes from OMP's subagent progress/lifecycle frames (see
 * `worker-usage.ts`). `ctx.sessionManager.getUsageStatistics()` is a single
 * session-wide total with no per-agent breakdown, so it cannot substitute.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LOCK_TIMING, isLockStaging, LockLostError, type LockTiming, type StateLock, withStateLock } from "./state-lock.ts";
import type { RouteLogger } from "./logging.ts";

const HISTOGRAM_BUCKETS = 10;
export const TELEMETRY_VERSION = 6;
/** The last format whose live epoch held routing counters; its files convert into `jevRouting`. */
const JEV_ROUTING_VERSION = 5;

const HISTORY_DIR = "telemetry-history";
/** The routing eras' per-decision log: never written any more, still removed by a reset. */
const DECISIONS_FILE = "decisions.jsonl";
/** Temp files (`telemetry.json.<pid>-<n>.tmp`) that plugin versions before the lock directory left behind; nothing writes them now. */
const ACTIVE_TEMP = /^telemetry\.json\.\d+-\d+\.tmp$/;
/** Where plugin versions before v5 set aside a newer version's file. */
const SET_ASIDE = /^telemetry\.v\d+\.json$/;
/** Migration backups, rollback archives, and their temp files. */
const HISTORY_FILE = /^(?:v\d+-[0-9a-f]{64}\.json|decisions-[0-9a-f]{64}\.jsonl)(?:\.\d+-\d+\.tmp)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** How long counts wait before they are written; a failed write is retried after the same, doubled per consecutive failure. */
const FLUSH_DEBOUNCE_MS = 2000;
/** Workers remembered for turn accounting and de-duplication across buses; bounded against leaks. */
const MAX_TRACKED_WORKERS = 4096;
/** Taken while one process reads and replaces `telemetry.json`, or a reset deletes the files: see `state-lock.ts`. */
const LOCK_FILE = "telemetry.lock";
/** The retry delay of a failing write stops doubling at this many times the flush delay. */
const MAX_RETRY_FACTOR = 16;

/** Front-door counters of the routing eras; only ever read back from older files. */
export interface RouteCounters {
	requests: number;
	errors: number;
	timeouts: number;
	latencySumMs: number;
	latencyCount: number;
	confidence: number[];
	margin: number[];
}

export interface OrchestrationCounters extends RouteCounters {
	DEFAULT: number;
	ORCHESTRATE: number;
}

/**
 * One worker agent name's counters for the live epoch. Workers are counted once
 * (`startedObserved`); every turn — the first run and each follow-up — settles
 * and is measured on its own.
 */
export interface LiveWorkerCounters {
	/** Distinct workers whose first observed turn began: a `started` lifecycle frame or a first progress frame. */
	startedObserved: number;
	/** Later turns of a worker already tracked (a message to an idle worker, a resume); not new workers. */
	followUpTurns: number;
	/** Settled turns by outcome: a worker that ran k turns settles k times. */
	completed: number;
	failed: number;
	/** OMP's own `aborted` status, shown to people as cancelled. */
	aborted: number;
	/** Settled turns whose final progress was observed. */
	usageSamples: number;
	/** The usage samples that completed: the denominator of cost per completed, whose numerator is all of `costUsd`. */
	usageSamplesCompleted: number;
	/** Settled turns without any observed progress: usage unknown, never counted as zero. */
	usageUnknown: number;
	/** Input + output + cacheWrite tokens (OMP's `AgentProgress.tokens`; excludes cacheRead), usage samples only. */
	tokens: number;
	/** Provider-reported spend of every usage sample, failed and cancelled turns included. */
	costUsd: number;
	durationMs: number;
}

/** A v5 worker row as v5 recorded it: per worker, without follow-up turns. A frozen shape, not the live one. */
export interface JevRoutingWorkerCounters {
	startedObserved: number;
	completed: number;
	failed: number;
	aborted: number;
	usageSamples: number;
	usageSamplesCompleted: number;
	usageUnknown: number;
	tokens: number;
	costUsd: number;
	durationMs: number;
}

/** The v5 live epoch, moved here by a v5 → v6 migration; read-only, never merged into live counts. */
export interface HistoricalJevRouting {
	/** The preserved original is `telemetry-history/<historySnapshotName(version, sha256)>`. */
	source: { version: number; sha256: string };
	/** The epoch the v5 file was counting in; empty id and zero start when the file recorded none. */
	epoch: TelemetryEpoch;
	updatedAt: number;
	/** Front-door routing decisions of that epoch. */
	orchestration: OrchestrationCounters;
	/** Workers of that epoch by agent name. */
	workers: Record<string, JevRoutingWorkerCounters>;
}

export interface HistoricalOrchestrationCounters extends OrchestrationCounters {
	/** Retired DIRECT/SLOW/UNCERTAIN labels. */
	legacyDecisions: number;
}

export interface HistoricalTaskRoutingCounters extends RouteCounters {
	batches: number;
	TASK_EASY: number;
	TASK_HARD: number;
	TASK_CHALLENGE: number;
	fallbackChallenge: number;
	/** Retired TASK_NORMAL/TASK_DEEP labels. */
	legacyDecisions: number;
	legacyFallbacks: number;
}

/** A tier-routing era worker row, keyed by the agent name the tier router selected. */
export interface HistoricalWorkerCounters {
	/** Routing selections — not observed starts. */
	spawns: number;
	/** Settled spawns whose usage was observed. */
	results: number;
	completed: number;
	tokens: number;
	costUsd: number;
	durationMs: number;
}

/** The tier-routing era: a pre-v5 file's counters; never merged into live ones. */
export interface HistoricalTelemetry {
	/** The preserved original is `telemetry-history/<historySnapshotName(version, sha256)>`. */
	source: { version: number; sha256: string };
	updatedAt: number;
	orchestration: HistoricalOrchestrationCounters;
	taskRouting: HistoricalTaskRoutingCounters;
	workers: Record<string, HistoricalWorkerCounters>;
}

export interface TelemetryEpoch {
	id: string;
	startedAt: number;
}

export interface TelemetrySnapshot {
	version: typeof TELEMETRY_VERSION;
	updatedAt: number;
	epoch: TelemetryEpoch;
	/** Live workers by agent name; only OMP's generic `task` worker is tracked. */
	workers: Record<string, LiveWorkerCounters>;
	/** Present after a v5 → v6 migration; absent on a fresh start, after a pre-v5 migration, or after reset. */
	jevRouting?: HistoricalJevRouting;
	/** Present after a migration of a file that carried, or was, a tier-routing era; absent otherwise. */
	historical?: HistoricalTelemetry;
}

/** Why the last write failed. A write that succeeds clears it. */
export interface TelemetryWriteError {
	/** What the failure was, bounded and free of any prompt or task text. */
	message: string;
	/** When the first failure of this unbroken run of failures happened. */
	since: number;
	/** Consecutive failed attempts, the last one included. */
	attempts: number;
}

/**
 * Whether counts are recorded and persisted. Only `active` writes; `unloaded`
 * records into memory and merges into what the first load finds.
 */
export type TelemetryState =
	| { kind: "unloaded" }
	/** Recording and writing. With `writeError`, nothing reaches the disk right now: counts stay in memory and are retried. */
	| { kind: "active"; writeError?: TelemetryWriteError }
	/** Telemetry is disabled and `telemetry.json` predates v6: shown read-only, migrated once enabled. */
	| { kind: "deferred"; version: number; sha256: string }
	/** Written by a newer plugin: left untouched and nothing is recorded. */
	| { kind: "suspended"; reason: "future-version"; version: number }
	/** `telemetry.json` is left untouched and nothing is recorded. */
	| { kind: "suspended"; reason: "unreadable"; detail: string }
	/** The older file stays active, unmigrated: its version and hash identify the sections read from it. */
	| { kind: "suspended"; reason: "migration-failed"; detail: string; version: number; sha256: string };

/** What telemetry needs of the logger: the rare warning, and a bounded description of an error. */
export type TelemetryLogger = Pick<RouteLogger, "warn" | "describeError">;

export interface TelemetryOptions {
	/** Where a failed write is reported, once per distinct failure. */
	logger?: TelemetryLogger;
	/** How long counts wait before they are written; a failed write is retried after this, doubled per consecutive failure. */
	flushDebounceMs?: number;
	/** How long a write waits for another process's lock, and when a lock counts as left behind by a dead process. */
	lock?: Partial<LockTiming>;
}

/** OMP's terminal worker statuses. */
export type WorkerStatus = "completed" | "failed" | "aborted";

/** Cumulative usage carried by one progress frame; it restarts from zero with every turn. */
export interface WorkerUsage {
	tokens: number;
	costUsd: number;
	durationMs: number;
}

/** One worker frame reduced to what accounting needs — never any text. */
export type WorkerFrame =
	| { kind: "started" }
	| { kind: "progress"; usage: WorkerUsage }
	| { kind: "settled"; status: WorkerStatus };

/** Identifies the bus subscription that delivered a worker frame. */
export type WorkerSource = symbol;

/** What has been counted for one turn of one worker. */
interface TurnRecord {
	/** Its start is counted: a `started` frame or progress was observed. */
	started: boolean;
	/** Its settlement is counted. */
	status?: WorkerStatus;
	/** Its usage sample is recorded. */
	sampled: boolean;
	/** Latest cumulative progress observed for this turn. */
	latest?: WorkerUsage;
}

/**
 * Where one bus subscription stands among one worker's turns. Every bus reports
 * a worker's turns in the same order, but each keeps its own count: that is what
 * lets a bus that lags, or repeats the whole history, be recognized.
 */
interface BusPosition {
	/** Ordinal of the turn the bus is in: 1 for the first turn it follows. */
	turn: number;
	/**
	 * The bus opened this turn with progress that had measured nothing yet. A worker's
	 * first turn publishes such progress before its `started` frame, so a `started`
	 * that follows on this bus belongs to this turn instead of opening the next.
	 */
	awaitingStart: boolean;
}

/** What has been counted for one worker this epoch, whichever bus reported it. */
interface TrackedWorker {
	/** Ordinal of the turn in progress or last seen: 1 for the first run, one more per follow-up; 0 before any frame. */
	turn: number;
	/** Turns whose start was counted: tells a worker's first observed turn from its follow-ups. */
	startedTurns: number;
	current: TurnRecord;
	/** Each bus subscription's position among this worker's turns. */
	positions: Map<WorkerSource, BusPosition>;
}

/** Content-addressed name of a preserved `telemetry.json` inside {@link Telemetry.historyDir}. */
export function historySnapshotName(version: number, sha256: string): string {
	return `v${version}-${sha256}.json`;
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

function emptyOrchestration(): OrchestrationCounters {
	return { ...emptyRouteCounters(), DEFAULT: 0, ORCHESTRATE: 0 };
}

function emptyLiveWorker(): LiveWorkerCounters {
	return {
		startedObserved: 0,
		followUpTurns: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
		usageSamples: 0,
		usageSamplesCompleted: 0,
		usageUnknown: 0,
		tokens: 0,
		costUsd: 0,
		durationMs: 0,
	};
}

function emptyJevRoutingWorker(): JevRoutingWorkerCounters {
	return {
		startedObserved: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
		usageSamples: 0,
		usageSamplesCompleted: 0,
		usageUnknown: 0,
		tokens: 0,
		costUsd: 0,
		durationMs: 0,
	};
}

function emptyTaskRouting(): HistoricalTaskRoutingCounters {
	return {
		...emptyRouteCounters(),
		batches: 0,
		TASK_EASY: 0,
		TASK_HARD: 0,
		TASK_CHALLENGE: 0,
		fallbackChallenge: 0,
		legacyDecisions: 0,
		legacyFallbacks: 0,
	};
}

function emptySnapshot(epoch: TelemetryEpoch = { id: randomUUID(), startedAt: Date.now() }): TelemetrySnapshot {
	return { version: TELEMETRY_VERSION, updatedAt: 0, epoch, workers: {} };
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A persisted object's fields, each still unverified; anything else has none.
 * Files are revived field by field, so one malformed value costs only itself.
 */
function fieldsOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Copy each finite number, histograms included, that `source` holds for a field of `target`. */
function reviveCounters<T extends object>(target: T, source: Record<string, unknown>): T {
	const fields = target as Record<string, unknown>;
	for (const [key, current] of Object.entries(fields)) {
		const value = source[key];
		if (Array.isArray(current)) {
			if (!Array.isArray(value)) continue;
			for (let index = 0; index < current.length; index++) {
				const count = finite(value[index]);
				if (count !== undefined) current[index] = count;
			}
		} else {
			const count = finite(value);
			if (count !== undefined) fields[key] = count;
		}
	}
	return target;
}

/** Revive each object-valued entry of a persisted map; other entries are dropped. */
function reviveMap<T>(source: unknown, revive: (fields: Record<string, unknown>) => T): Record<string, T> {
	const result: Record<string, T> = {};
	for (const [name, value] of Object.entries(fieldsOf(source))) {
		if (typeof value === "object" && value !== null) result[name] = revive(fieldsOf(value));
	}
	return result;
}

function reviveHistoricalWorker(fields: Record<string, unknown>): HistoricalWorkerCounters {
	const counters = reviveCounters({ spawns: 0, results: 0, completed: 0, tokens: 0, costUsd: 0, durationMs: 0 }, fields);
	// v1/v2 stored split token fields; v3 folded them into `tokens`, excluding cacheRead.
	if (finite(fields.tokens) === undefined) {
		counters.tokens = (finite(fields.input) ?? 0) + (finite(fields.output) ?? 0) + (finite(fields.cacheWrite) ?? 0);
	}
	return counters;
}

/** A persisted `source` (`{ version, sha256 }`), or `undefined` when it does not identify a preserved original. */
function sourceOf(value: unknown): HistoricalTelemetry["source"] | undefined {
	const { version, sha256 } = fieldsOf(value);
	return isVersion(version) && typeof sha256 === "string" && SHA256_HEX.test(sha256) ? { version, sha256 } : undefined;
}

/**
 * The tier-routing era's counters from any pre-v5 file. Every label ever
 * written stays accounted for: retired labels move to `legacy*` totals instead
 * of being dropped.
 */
function historicalFrom(raw: Record<string, unknown>, source: HistoricalTelemetry["source"]): HistoricalTelemetry {
	const oldOrchestration = fieldsOf(raw.orchestration);
	const orchestration = reviveCounters({ ...emptyOrchestration(), legacyDecisions: 0 }, oldOrchestration);
	for (const label of ["DIRECT", "legacyDirect", "SLOW", "UNCERTAIN"]) {
		orchestration.legacyDecisions += finite(oldOrchestration[label]) ?? 0;
	}
	const oldTask = fieldsOf(raw.task);
	const taskRouting = reviveCounters(emptyTaskRouting(), oldTask);
	taskRouting.legacyDecisions += (finite(oldTask.TASK_NORMAL) ?? 0) + (finite(oldTask.TASK_DEEP) ?? 0);
	taskRouting.legacyFallbacks += finite(oldTask.fallbackDeep) ?? 0;
	return {
		source,
		updatedAt: finite(raw.updatedAt) ?? 0,
		orchestration,
		taskRouting,
		workers: reviveMap(raw.workers, reviveHistoricalWorker),
	};
}

/** A file's `historical` section; dropped when its source is not identifiable. */
function reviveHistorical(value: unknown): HistoricalTelemetry | undefined {
	const fields = fieldsOf(value);
	const source = sourceOf(fields.source);
	if (!source) return undefined;
	return {
		source,
		updatedAt: finite(fields.updatedAt) ?? 0,
		orchestration: reviveCounters({ ...emptyOrchestration(), legacyDecisions: 0 }, fieldsOf(fields.orchestration)),
		taskRouting: reviveCounters(emptyTaskRouting(), fieldsOf(fields.taskRouting)),
		workers: reviveMap(fields.workers, reviveHistoricalWorker),
	};
}

/**
 * The Jev-routing era from `fields`: a v5 file itself — its live epoch is the
 * era — or a v6 file's `jevRouting` section, which keeps the same field names.
 */
function jevRoutingFrom(fields: Record<string, unknown>, source: HistoricalJevRouting["source"]): HistoricalJevRouting {
	const epoch = fieldsOf(fields.epoch);
	return {
		source,
		epoch: { id: typeof epoch.id === "string" ? epoch.id : "", startedAt: finite(epoch.startedAt) ?? 0 },
		updatedAt: finite(fields.updatedAt) ?? 0,
		orchestration: reviveCounters(emptyOrchestration(), fieldsOf(fields.orchestration)),
		workers: reviveMap(fields.workers, worker => reviveCounters(emptyJevRoutingWorker(), worker)),
	};
}

/** A v6 file's `jevRouting` section; dropped when its source is not identifiable. */
function reviveJevRouting(value: unknown): HistoricalJevRouting | undefined {
	const fields = fieldsOf(value);
	const source = sourceOf(fields.source);
	return source ? jevRoutingFrom(fields, source) : undefined;
}

/** Parse a v6 file, discarding anything malformed field by field. */
function reviveSnapshot(raw: Record<string, unknown>): TelemetrySnapshot {
	const epoch = fieldsOf(raw.epoch);
	const snapshot = emptySnapshot(
		typeof epoch.id === "string" && epoch.id !== "" ? { id: epoch.id, startedAt: finite(epoch.startedAt) ?? 0 } : undefined,
	);
	snapshot.updatedAt = finite(raw.updatedAt) ?? 0;
	snapshot.workers = reviveMap(raw.workers, fields => reviveCounters(emptyLiveWorker(), fields));
	const jevRouting = reviveJevRouting(raw.jevRouting);
	if (jevRouting) snapshot.jevRouting = jevRouting;
	const historical = reviveHistorical(raw.historical);
	if (historical) snapshot.historical = historical;
	return snapshot;
}

/**
 * `left` plus `right`, agent by agent, as fresh records. Both may hold
 * increments, and an increment can be negative (a turn's unknown usage measured
 * after the count of its unknown was already written); a sum is never brought
 * below `floor`.
 */
function sumWorkers(
	left: Record<string, LiveWorkerCounters>,
	right: Record<string, LiveWorkerCounters>,
	floor = Number.NEGATIVE_INFINITY,
): Record<string, LiveWorkerCounters> {
	const sum: Record<string, LiveWorkerCounters> = {};
	for (const [agent, counters] of Object.entries(left)) sum[agent] = { ...counters };
	for (const [agent, counters] of Object.entries(right)) {
		const row = (sum[agent] ??= emptyLiveWorker());
		for (const key of Object.keys(counters) as (keyof LiveWorkerCounters)[]) {
			row[key] = Math.max(floor, row[key] + counters[key]);
		}
	}
	return sum;
}

/** Cumulative within a turn, so a late or repeated frame never lowers what was seen. */
function latestOf(previous: WorkerUsage | undefined, next: WorkerUsage): WorkerUsage {
	if (!previous) return next;
	return {
		tokens: Math.max(previous.tokens, next.tokens),
		costUsd: Math.max(previous.costUsd, next.costUsd),
		durationMs: Math.max(previous.durationMs, next.durationMs),
	};
}

/** The parsed top-level object, or `undefined` when the bytes are not a JSON object. */
function parseObject(bytes: Buffer): Record<string, unknown> | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString("utf8"));
	} catch {
		return undefined;
	}
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

let tempCounter = 0;

function tempPath(file: string): string {
	return `${file}.${process.pid}-${++tempCounter}.tmp`;
}

/** Create `file` exclusively and make its content durable. */
async function writeNew(file: string, data: string | Uint8Array): Promise<void> {
	const handle = await open(file, "wx");
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Publish `bytes` as `dir/name` without ever replacing an existing file. A
 * complete temp file is hard-linked into place, so the name never holds a
 * partial copy; an existing file is accepted only if it holds the same bytes.
 */
async function preserve(dir: string, name: string, bytes: Buffer): Promise<void> {
	await mkdir(dir, { recursive: true });
	const target = path.join(dir, name);
	const temp = tempPath(target);
	try {
		await writeNew(temp, bytes);
		try {
			await link(temp, target);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			if (!(await readFile(target)).equals(bytes)) {
				throw new Error(`${HISTORY_DIR}/${name} exists with different content; left untouched`);
			}
		}
	} finally {
		await unlink(temp).catch(() => {});
	}
}

async function listNames(dir: string, failed: string[]): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOENT" && code !== "ENOTDIR") failed.push(`${dir} (${messageOf(error)})`);
		return [];
	}
}

/** A file in a format before v6, exactly as read: its bytes identify the original a migration preserves. */
interface OlderFile {
	kind: "older";
	bytes: Buffer;
	raw: Record<string, unknown>;
	source: HistoricalTelemetry["source"];
}

/** What `telemetry.json` holds at the moment it is read. */
type DiskFile =
	| { kind: "absent" }
	| { kind: "current"; snapshot: TelemetrySnapshot }
	| OlderFile
	/** Written by a newer plugin, or not a telemetry file: left untouched. */
	| { kind: "unusable"; state: TelemetryState };

/** Read and classify `file`. Rejects when it exists but cannot be read. */
async function readDisk(file: string): Promise<DiskFile> {
	let bytes: Buffer;
	try {
		bytes = await readFile(file);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "absent" };
		throw error;
	}
	const raw = parseObject(bytes);
	const version = raw?.version ?? 0;
	if (!raw || !isVersion(version)) {
		const detail = raw ? `unrecognized version ${JSON.stringify(raw.version)}` : "not a JSON object";
		return { kind: "unusable", state: { kind: "suspended", reason: "unreadable", detail } };
	}
	if (version > TELEMETRY_VERSION) {
		return { kind: "unusable", state: { kind: "suspended", reason: "future-version", version } };
	}
	if (version === TELEMETRY_VERSION) return { kind: "current", snapshot: reviveSnapshot(raw) };
	return { kind: "older", bytes, raw, source: { version, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

/**
 * Worker counters with a debounced, merging JSON sink.
 *
 * One instance per state directory per process. Every session in an OMP
 * process — the main session and each subagent — builds its own extension
 * runtime (the factory runs per session), and they all target the same files;
 * separate instances would race, so {@link Telemetry.shared} hands them the
 * same writer. Their telemetry choices stay their own, see
 * {@link Telemetry.setEnabled}. Disabled telemetry never changes a file on
 * disk except through an explicit {@link Telemetry.reset}.
 *
 * Other OMP processes write the same file, so an instance never writes totals
 * of its own. It holds the file as it last saw it (`#base`) and the counts it
 * recorded itself since (`#pending`), and a write adds the second to the file
 * as it is at that moment, under the state directory's lock. `refresh()` brings
 * the view up to date without writing.
 */
export class Telemetry {
	static readonly #instances = new Map<string, Telemetry>();

	/** The process's writer for `stateDir`, created on first use; a later caller's logger fills in only when the writer has none. */
	static shared(stateDir: string, options: TelemetryOptions = {}): Telemetry {
		const existing = Telemetry.#instances.get(stateDir);
		if (existing) {
			existing.#logger ??= options.logger;
			return existing;
		}
		const created = new Telemetry(stateDir, options);
		Telemetry.#instances.set(stateDir, created);
		return created;
	}

	/** Drop the process-level registry. Test-only. */
	static resetSharedForTests(): void {
		Telemetry.#instances.clear();
	}

	/** The file as this process last read or wrote it: everything but the counts still `#pending`. */
	#base = emptySnapshot();
	/** The file existed, or this process wrote it, when this process last looked: finding it gone later means a reset elsewhere. */
	#persisted = false;
	/** Counts recorded since the last write began: increments over `#base`, not totals; a decrement can be among them. */
	#pending: Record<string, LiveWorkerCounters> = {};
	/** The increments a write in progress carries; they return to `#pending` if it fails. */
	#inflight: Record<string, LiveWorkerCounters> = {};
	#state: TelemetryState = { kind: "unloaded" };
	/** Each session's own choice, by the id of its top-level session: see {@link Telemetry.setEnabled}. */
	readonly #choices = new Map<string, boolean>();
	#dirty = false;
	#timer: Timer | undefined;
	/** Consecutive failed writes: the retry delay grows with it. */
	#failures = 0;
	#writeError: TelemetryWriteError | undefined;
	/** The failures warned about since a write last succeeded: each distinct one is warned about once. */
	readonly #warned = new Set<string>();
	#logger: TelemetryLogger | undefined;
	#loaded: Promise<void> | undefined;
	/** Incremented by every reset; a load or write that started earlier must not apply its result. */
	#resets = 0;
	/** Serializes snapshot writes and reset deletions in call order. */
	#io: Promise<void> = Promise.resolve();
	readonly #tracked = new Map<string, TrackedWorker>();
	readonly #file: string;
	readonly #lockFile: string;
	readonly #historyDir: string;
	readonly #debounceMs: number;
	readonly #lockTiming: LockTiming;

	constructor(stateDir: string, options: TelemetryOptions = {}) {
		this.#file = path.join(stateDir, "telemetry.json");
		this.#lockFile = path.join(stateDir, LOCK_FILE);
		this.#historyDir = path.join(stateDir, HISTORY_DIR);
		this.#logger = options.logger;
		this.#debounceMs = options.flushDebounceMs ?? FLUSH_DEBOUNCE_MS;
		this.#lockTiming = { ...DEFAULT_LOCK_TIMING, ...options.lock };
	}

	get file(): string {
		return this.#file;
	}

	/** Preserved originals, named by {@link historySnapshotName}. */
	get historyDir(): string {
		return this.#historyDir;
	}

	/** Whether any session wants telemetry; before one has chosen, it is on. */
	get #enabled(): boolean {
		if (this.#choices.size === 0) return true;
		for (const enabled of this.#choices.values()) if (enabled) return true;
		return false;
	}

	state(): Readonly<TelemetryState> {
		return this.#state.kind === "active" && this.#writeError ? { kind: "active", writeError: this.#writeError } : this.#state;
	}

	/**
	 * Record the telemetry choice of `session`, the id of the top-level session whose configuration made it (the
	 * default suits a caller with a single choice). Every session of the process shares this writer, so one
	 * session's choice never replaces another's: the writer records, writes and migrates while any session wants
	 * telemetry, and {@link Telemetry.recordsFor} tells whether one session's own frames are recorded.
	 */
	setEnabled(enabled: boolean, session = ""): void {
		this.#choices.set(session, enabled);
		if (this.#enabled && this.#state.kind === "deferred") {
			// The older file was only read. Its view is dropped so it can never be written
			// without a preserved original; the next load migrates the file first.
			this.#state = { kind: "unloaded" };
			this.#loaded = undefined;
			delete this.#base.historical;
			delete this.#base.jevRouting;
		}
	}

	/** Whether the frames of `session`'s tree are recorded: its own choice, or what the process's sessions together want when it has made none. */
	recordsFor(session: string | undefined): boolean {
		return (session === undefined ? undefined : this.#choices.get(session)) ?? this.#enabled;
	}

	/** What the file held when this process last looked, plus every count this process has recorded since. */
	snapshot(): Readonly<TelemetrySnapshot> {
		return { ...this.#base, workers: sumWorkers(this.#base.workers, sumWorkers(this.#inflight, this.#pending), 0) };
	}

	/** Read the persisted counters once, migrating an older file; later sessions reuse the result. Never rejects. */
	load(): Promise<void> {
		this.#loaded ??= this.#read().catch(error => {
			this.#state = { kind: "suspended", reason: "unreadable", detail: messageOf(error) };
		});
		return this.#loaded;
	}

	/**
	 * Re-read `telemetry.json` so `snapshot()` shows what other processes have
	 * written since this process last looked. It waits for the first load, so
	 * telemetry just turned on over an older file has migrated it by the time this
	 * returns. Read-only: nothing is written and no lock is taken, because the file
	 * is only ever replaced whole. A suspended process stays as it is; a file this
	 * version must not touch suspends recording, as the next write would. Never
	 * rejects.
	 */
	async refresh(): Promise<void> {
		await this.load();
		this.#enqueue(() => this.#refresh());
		await this.#io;
	}

	async #read(): Promise<void> {
		const resets = this.#resets;
		let disk: DiskFile;
		try {
			disk = await readDisk(this.#file);
		} catch (error) {
			if (resets === this.#resets) this.#state = { kind: "suspended", reason: "unreadable", detail: messageOf(error) };
			return;
		}
		if (resets !== this.#resets) return;
		if (disk.kind !== "older") {
			this.#adopt(disk);
			return;
		}
		this.#adoptEarlierEras(disk.raw, disk.source);
		if (!this.#enabled) {
			this.#state = { kind: "deferred", ...disk.source };
			return;
		}
		try {
			await this.#migrate();
		} catch (error) {
			if (resets === this.#resets) {
				this.#state = { kind: "suspended", reason: "migration-failed", detail: messageOf(error), ...disk.source };
			}
		}
	}

	/**
	 * Take the file as this process's view of it; counts recorded before this stay
	 * pending on top. An older file is never adopted: a load converts it, and one
	 * that appears under a process that has loaded already suspends its recording.
	 */
	#adopt(disk: DiskFile): void {
		switch (disk.kind) {
			case "absent":
				// A file this process last saw or wrote that is gone was cleared by a reset elsewhere: its epoch is over.
				this.#base = emptySnapshot(this.#persisted ? undefined : this.#base.epoch);
				this.#persisted = false;
				this.#state = { kind: "active" };
				return;
			case "current":
				this.#base = disk.snapshot;
				this.#persisted = true;
				this.#state = { kind: "active" };
				return;
			case "older":
				this.#state = {
					kind: "suspended",
					reason: "unreadable",
					detail: `rewritten in the older v${disk.source.version} format by another process`,
				};
				return;
			case "unusable":
				this.#state = disk.state;
				return;
		}
	}

	/** The read-only part of {@link Telemetry.refresh}, queued behind writes and resets so it never sees half of either. */
	async #refresh(): Promise<void> {
		// A suspended process left the file alone on purpose; an unloaded one has no view to correct.
		if (this.#state.kind !== "active" && this.#state.kind !== "deferred") return;
		const resets = this.#resets;
		let disk: DiskFile;
		try {
			disk = await readDisk(this.#file);
		} catch {
			// A file that cannot be read now leaves the view as it was.
			return;
		}
		if (resets !== this.#resets) return;
		if (disk.kind === "older" && this.#state.kind === "deferred") {
			// Still, or again, an older file: shown read-only, as a load that found telemetry off shows it.
			this.#adoptEarlierEras(disk.raw, disk.source);
			this.#state = { kind: "deferred", ...disk.source };
			return;
		}
		this.#adopt(disk);
	}

	/**
	 * Set the read-only sections an older file converts into; the live epoch stays
	 * empty. A v5 file becomes the Jev-routing era and hands over the tier-routing
	 * era it carried; a pre-v5 file is the tier-routing era itself.
	 */
	#adoptEarlierEras(raw: Record<string, unknown>, source: HistoricalTelemetry["source"]): void {
		delete this.#base.jevRouting;
		delete this.#base.historical;
		if (source.version === JEV_ROUTING_VERSION) {
			this.#base.jevRouting = jevRoutingFrom(raw, source);
			const carried = reviveHistorical(raw.historical);
			if (carried) this.#base.historical = carried;
		} else {
			this.#base.historical = historicalFrom(raw, source);
		}
	}

	/**
	 * Replace an older `telemetry.json` with its v6 conversion, under the lock, on
	 * the file as it is once the lock is held. The original is preserved first
	 * under a content-addressed name that is never overwritten; the conversion
	 * then replaces the active file by atomic rename. If another process migrated
	 * the file meanwhile (or a reset cleared it), what it left is taken instead.
	 * Any failure leaves the original active file in place, and a later load
	 * resumes with the same backup and the same conversion.
	 */
	async #migrate(): Promise<void> {
		const resets = this.#resets;
		await withStateLock(this.#lockFile, async lock => {
			const now = await readDisk(this.#file);
			if (resets !== this.#resets) return;
			if (now.kind !== "older") {
				this.#adopt(now);
				return;
			}
			this.#adoptEarlierEras(now.raw, now.source);
			if (!this.#enabled) {
				// Turned off while this waited for the lock: shown read-only, as a load that found it off shows it.
				this.#state = { kind: "deferred", ...now.source };
				return;
			}
			await preserve(this.#historyDir, historySnapshotName(now.source.version, now.source.sha256), now.bytes);
			// Writers are expected to be stopped; still, never replace a file that changed since it was read.
			if (!(await readFile(this.#file)).equals(now.bytes)) throw new Error("telemetry.json changed during migration");
			await this.#persist(lock);
			if (resets === this.#resets) this.#state = { kind: "active" };
		}, this.#lockTiming);
	}

	/** Before the first load, counts are kept in memory and merged into what the load finds. */
	#recording(): boolean {
		return this.#enabled && (this.#state.kind === "active" || this.#state.kind === "unloaded");
	}

	#writable(): boolean {
		return this.#enabled && this.#state.kind === "active";
	}

	/** Flush after `delay`, unless a flush is already due. The timer never keeps the process alive. */
	#arm(delay: number): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, delay);
		this.#timer.unref?.();
	}

	#touch(): void {
		this.#dirty = true;
		this.#arm(this.#debounceMs);
	}

	/**
	 * Fold one worker frame into the live counters. `key` identifies one worker
	 * process-wide, `source` the bus subscription that delivered the frame.
	 *
	 * Turns are counted, not workers: a worker keeps its key across follow-up
	 * turns, each turn settles and is measured on its own (its progress restarts
	 * from zero), and only the first turn observed is a new worker.
	 *
	 * Turns are told apart by their `started` frames. The same frame can reach
	 * the process once per bus subscription that carries it (an extension only
	 * subscribes to its session bus, `pi.events`; the host's tree-wide
	 * observability bus is not among them), and every bus reports a worker's
	 * turns in the same order, so a bus's n-th turn is the worker's n-th; a frame
	 * of a turn already counted is dropped whichever bus delivers it, however late.
	 * Two kinds of frame need a second look:
	 *
	 * - A worker's first turn publishes progress that has measured nothing yet
	 *   *before* its `started` frame (the host publishes progress while the
	 *   session is still being set up: the task label landing, an advisor
	 *   attaching). That progress opens the turn, and the `started` that follows
	 *   on the same bus belongs to it. Every later turn starts with `started`.
	 * - A bus's first frame for a worker places the bus. One that begins a turn — a
	 *   `started`, or progress that has measured nothing yet — puts it in the
	 *   worker's first turn, which is where a bus that repeats the whole history
	 *   has to start; any other frame joined mid-turn and puts it in the turn in
	 *   progress. A bus that first sees a worker exactly at a later turn's
	 *   beginning is therefore counted from turn 1 and dropped as a repeat.
	 *
	 * A turn is measured only from progress observed for that turn; without any,
	 * its usage is unknown, never zero.
	 */
	observeWorker(source: WorkerSource, key: string, agent: string, frame: WorkerFrame): void {
		if (!this.#recording()) return;
		const track = this.#track(key);
		const position = this.#place(track, source, frame);
		// A turn already counted, reported again by a bus that lags or replays.
		if (position.turn < track.turn) return;
		if (position.turn > track.turn) {
			track.turn = position.turn;
			track.current = { started: false, sampled: false };
		}
		switch (frame.kind) {
			case "started":
				this.#observeStart(track, agent);
				break;
			case "progress":
				this.#observeStart(track, agent);
				track.current.latest = latestOf(track.current.latest, frame.usage);
				break;
			case "settled":
				this.#observeSettled(track, agent, frame.status);
				break;
		}
	}

	/** Move `source` to the turn `frame` belongs to on its own view of the worker; see {@link Telemetry.observeWorker}. */
	#place(track: TrackedWorker, source: WorkerSource, frame: WorkerFrame): BusPosition {
		const measuredNothing = frame.kind === "progress" && frame.usage.tokens === 0 && frame.usage.costUsd === 0;
		const position = track.positions.get(source);
		if (!position) {
			const first: BusPosition = {
				turn: frame.kind === "started" || measuredNothing ? 1 : Math.max(track.turn, 1),
				awaitingStart: measuredNothing,
			};
			track.positions.set(source, first);
			return first;
		}
		if (frame.kind === "started") {
			if (position.awaitingStart) position.awaitingStart = false;
			else position.turn++;
		} else if (!measuredNothing) {
			position.awaitingStart = false;
		}
		return position;
	}

	/** Count the turn's start once: the worker's first observed turn is a new worker, a later one a follow-up. */
	#observeStart(track: TrackedWorker, agent: string): void {
		if (track.current.started) return;
		track.current.started = true;
		this.#counters(agent)[track.startedTurns === 0 ? "startedObserved" : "followUpTurns"]++;
		track.startedTurns++;
		this.#touch();
	}

	/**
	 * Count the turn's outcome once. Usage is sampled only from progress observed
	 * for this turn: without any, the usage is recorded as unknown, and a later
	 * report of the same turn with measured progress turns that unknown into one
	 * sample.
	 */
	#observeSettled(track: TrackedWorker, agent: string, status: WorkerStatus): void {
		const turn = track.current;
		const counters = this.#counters(agent);
		if (turn.status === undefined) {
			turn.status = status;
			counters[status]++;
			if (!turn.latest) counters.usageUnknown++;
		} else if (turn.sampled || !turn.latest) {
			return;
		} else {
			counters.usageUnknown--;
		}
		if (turn.latest) {
			turn.sampled = true;
			counters.usageSamples++;
			if (turn.status === "completed") counters.usageSamplesCompleted++;
			counters.tokens += turn.latest.tokens;
			counters.costUsd += turn.latest.costUsd;
			counters.durationMs += turn.latest.durationMs;
		}
		this.#touch();
	}

	/** The worker's record, moved to most recently seen; the least recent is evicted past the bound. */
	#track(key: string): TrackedWorker {
		const track = this.#tracked.get(key) ?? {
			turn: 0,
			startedTurns: 0,
			current: { started: false, sampled: false },
			positions: new Map<WorkerSource, BusPosition>(),
		};
		this.#tracked.delete(key);
		this.#tracked.set(key, track);
		if (this.#tracked.size > MAX_TRACKED_WORKERS) {
			const oldest = this.#tracked.keys().next();
			if (!oldest.done) this.#tracked.delete(oldest.value);
		}
		return track;
	}

	/** The pending row of `agent`, created on first use: increments over what the file holds. */
	#counters(agent: string): LiveWorkerCounters {
		const existing = this.#pending[agent];
		if (existing) return existing;
		const created = emptyLiveWorker();
		this.#pending[agent] = created;
		return created;
	}

	#enqueue(job: () => Promise<void>): void {
		this.#io = this.#io.then(job).catch(() => {});
	}

	/** Write pending counters once the persisted state is known, and wait for queued writes. Never rejects. */
	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		if (this.#dirty && this.#enabled) {
			await this.load();
			if (this.#dirty && this.#writable()) {
				this.#dirty = false;
				this.#enqueue(() => this.#write());
			}
		}
		await this.#io;
	}

	/**
	 * Add this process's pending counts to the file as it is now. Other processes
	 * write it too, so it is read again under the lock and only increments are
	 * merged in, never totals this process remembers.
	 */
	async #write(): Promise<void> {
		if (!this.#writable()) return;
		const resets = this.#resets;
		try {
			await mkdir(path.dirname(this.#file), { recursive: true });
			await withStateLock(this.#lockFile, lock => this.#merge(lock), this.#lockTiming);
		} catch (error) {
			// A telemetry write must never break a turn: the counts stay pending and are retried.
			if (resets === this.#resets) this.#failed(error);
			return;
		}
		if (resets === this.#resets) this.#succeeded();
	}

	/**
	 * Keep the counts for another attempt, say why (in the state, and once in the log), and schedule that attempt:
	 * without a new frame nothing else would trigger it, and a process may be about to end with counts unwritten.
	 */
	#failed(error: unknown): void {
		this.#dirty = true;
		this.#failures++;
		const message = this.#logger?.describeError(error) ?? messageOf(error).slice(0, 200);
		this.#writeError = { message, since: this.#writeError?.since ?? Date.now(), attempts: this.#failures };
		this.#arm(Math.min(this.#debounceMs * 2 ** (this.#failures - 1), this.#debounceMs * MAX_RETRY_FACTOR));
		if (!this.#warned.has(message)) {
			this.#warned.add(message);
			this.#logger?.warn(`telemetry could not be written to ${this.#file}: ${message}; the counts stay in memory and the write is retried`);
		}
	}

	/** A write got through: the failure is over, and a later one warns again. */
	#succeeded(): void {
		this.#failures = 0;
		this.#writeError = undefined;
		this.#warned.clear();
	}

	/** The critical section of {@link Telemetry.flush}: the file is read as it is now and the pending counts join it. */
	async #merge(lock: StateLock): Promise<void> {
		const resets = this.#resets;
		const disk = await readDisk(this.#file);
		// A reset, or telemetry being turned off, ran while this waited for the lock or the read.
		if (resets !== this.#resets || !this.#writable()) return;
		this.#adopt(disk);
		// A file this version must not touch has suspended recording; only counts to add call for a write.
		if (this.#writable() && Object.keys(this.#pending).length > 0) await this.#persist(lock);
	}

	/**
	 * Replace the file with this process's view of it plus every pending count, publishing it through the lock
	 * so that it lands only if the lock is still held. The counts travel as `#inflight` while the write runs, so
	 * `snapshot()` keeps them and a failed write, a lost lock included, gives them back.
	 */
	async #persist(lock: StateLock): Promise<void> {
		const resets = this.#resets;
		this.#inflight = this.#pending;
		this.#pending = {};
		const base = this.#base;
		const merged: TelemetrySnapshot = { ...base, updatedAt: Date.now(), workers: sumWorkers(base.workers, this.#inflight, 0) };
		try {
			await lock.commit(this.#file, JSON.stringify(merged));
		} catch (error) {
			// A reset that ran meanwhile has already dropped the counts.
			if (resets === this.#resets) {
				this.#pending = sumWorkers(this.#inflight, this.#pending);
				this.#inflight = {};
			}
			throw error;
		}
		// A reset that ran meanwhile deletes this write next; its own state is not this one.
		if (resets !== this.#resets) return;
		this.#base = merged;
		this.#persisted = true;
		this.#inflight = {};
	}

	/**
	 * Clear every count and start a new epoch, then delete the files this plugin
	 * owns, under the state directory's lock, once queued writes and any load in
	 * progress have finished, so nothing deleted is written back. Resolves to the
	 * removed paths; rejects naming each path that could not be removed, after
	 * attempting all of them.
	 */
	async reset(): Promise<string[]> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		const loading = this.#loaded;
		this.#resets++;
		this.#base = emptySnapshot();
		this.#persisted = false;
		this.#pending = {};
		this.#inflight = {};
		this.#dirty = false;
		this.#failures = 0;
		this.#writeError = undefined;
		this.#warned.clear();
		this.#tracked.clear();
		this.#state = { kind: "active" };
		// The cleared state is authoritative; a later `load()` must not re-read.
		this.#loaded = Promise.resolve();
		const removal = Promise.all([this.#io, loading]).then(() => this.#removeOwnedFiles());
		this.#io = removal.then(
			() => {},
			() => {},
		);
		return removal;
	}

	/** Delete the plugin's files while holding the lock, so no other process's write lands in the middle. */
	async #removeOwnedFiles(): Promise<string[]> {
		try {
			return await withStateLock(this.#lockFile, lock => this.#deleteOwnedFiles(lock), this.#lockTiming);
		} catch (error) {
			// No state directory, so nothing was ever written.
			if (errorCode(error) === "ENOENT") return [];
			throw error;
		}
	}

	/** Only exact plugin-owned names; other files, including user exports, are left alone. */
	async #deleteOwnedFiles(lock: StateLock): Promise<string[]> {
		const removed: string[] = [];
		const failed: string[] = [];
		const remove = async (file: string, tree = false) => {
			// A holder judged dead loses its lock: stop rather than delete under whoever holds it now.
			if (!(await lock.holds())) throw new LockLostError(this.#lockFile);
			try {
				if (tree) await rm(file, { recursive: true, force: true });
				else await unlink(file);
				removed.push(file);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") failed.push(`${file} (${messageOf(error)})`);
			}
		};
		const stateDir = path.dirname(this.#file);
		await remove(this.#file);
		await remove(path.join(stateDir, DECISIONS_FILE));
		for (const name of await listNames(stateDir, failed)) {
			if (ACTIVE_TEMP.test(name) || SET_ASIDE.test(name)) await remove(path.join(stateDir, name));
			// Left by an acquisition that died between staging its lock and taking it.
			else if (isLockStaging(path.basename(this.#lockFile), name)) await remove(path.join(stateDir, name), true);
		}
		for (const name of await listNames(this.#historyDir, failed)) {
			if (HISTORY_FILE.test(name)) await remove(path.join(this.#historyDir, name));
		}
		try {
			await rmdir(this.#historyDir);
		} catch (error) {
			// Absent, or still holding files this plugin does not own.
			const code = errorCode(error);
			if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") {
				failed.push(`${this.#historyDir} (${messageOf(error)})`);
			}
		}
		if (failed.length > 0) throw new Error(`Telemetry reset could not remove: ${failed.join("; ")}`);
		return removed;
	}
}
