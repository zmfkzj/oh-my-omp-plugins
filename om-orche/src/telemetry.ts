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
 *
 * An epoch is one span of measurements under one behavior. Migration moves a
 * v5 file's live epoch into `jevRouting`, carries its tier-routing
 * `historical` section over unchanged (a pre-v5 file's counters are converted
 * into `historical` instead), and starts an empty live epoch; reset starts
 * another. Historical numbers are never added to live ones: they count other
 * things — routing decisions and selections, and (in v5) workers counted once,
 * without their follow-up turns.
 *
 * Live worker usage comes from OMP's subagent progress/lifecycle frames (see
 * `worker-usage.ts`). `ctx.sessionManager.getUsageStatistics()` is a single
 * session-wide total with no per-agent breakdown, so it cannot substitute.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

const HISTOGRAM_BUCKETS = 10;
export const TELEMETRY_VERSION = 6;
/** The last format whose live epoch held routing counters; its files convert into `jevRouting`. */
const JEV_ROUTING_VERSION = 5;

const HISTORY_DIR = "telemetry-history";
/** The routing eras' per-decision log: never written any more, still removed by a reset. */
const DECISIONS_FILE = "decisions.jsonl";
/** Temp files of `telemetry.json`: `telemetry.json.<pid>-<n>.tmp`. */
const ACTIVE_TEMP = /^telemetry\.json\.\d+-\d+\.tmp$/;
/** Where plugin versions before v5 set aside a newer version's file. */
const SET_ASIDE = /^telemetry\.v\d+\.json$/;
/** Migration backups, rollback archives, and their temp files. */
const HISTORY_FILE = /^(?:v\d+-[0-9a-f]{64}\.json|decisions-[0-9a-f]{64}\.jsonl)(?:\.\d+-\d+\.tmp)?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FLUSH_DEBOUNCE_MS = 2000;
/** Workers remembered for turn accounting and de-duplication across buses; bounded against leaks. */
const MAX_TRACKED_WORKERS = 4096;

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
	/** The usage samples that completed: the cost-per-completed denominator. */
	usageSamplesCompleted: number;
	/** Settled turns without any observed progress: usage unknown, never counted as zero. */
	usageUnknown: number;
	/** Input + output + cacheWrite tokens (OMP's `AgentProgress.tokens`; excludes cacheRead), usage samples only. */
	tokens: number;
	/** Provider-reported spend, usage samples only. */
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

/**
 * Whether counts are recorded and persisted. Only `active` writes; `unloaded`
 * records into memory and merges into what the first load finds.
 */
export type TelemetryState =
	| { kind: "unloaded" }
	| { kind: "active" }
	/** Telemetry is disabled and `telemetry.json` predates v6: shown read-only, migrated once enabled. */
	| { kind: "deferred"; version: number; sha256: string }
	/** Written by a newer plugin: left untouched and nothing is recorded. */
	| { kind: "suspended"; reason: "future-version"; version: number }
	/** `telemetry.json` is left untouched and nothing is recorded. */
	| { kind: "suspended"; reason: "unreadable"; detail: string }
	/** The older file stays active, unmigrated: its version and hash identify the sections read from it. */
	| { kind: "suspended"; reason: "migration-failed"; detail: string; version: number; sha256: string };

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

/** Add every counter of `source` into `target`, histograms included. */
function addCounters<T extends object>(target: T, source: T): T {
	const fields = target as Record<string, unknown>;
	for (const [key, value] of Object.entries(source)) {
		const current = fields[key];
		if (typeof current === "number" && typeof value === "number") {
			fields[key] = current + value;
		} else if (Array.isArray(current) && Array.isArray(value)) {
			for (let index = 0; index < current.length; index++) current[index] += finite(value[index]) ?? 0;
		}
	}
	return target;
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

/** Fold counts recorded before the file was read into the loaded snapshot. */
function mergePending(loaded: TelemetrySnapshot, pending: TelemetrySnapshot): TelemetrySnapshot {
	for (const [agent, counters] of Object.entries(pending.workers)) {
		const existing = loaded.workers[agent];
		loaded.workers[agent] = existing ? addCounters(existing, counters) : counters;
	}
	return loaded;
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

/** Replace `file` by renaming a complete sibling temp file over it. */
async function replaceAtomically(file: string, data: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temp = tempPath(file);
	try {
		await writeNew(temp, data);
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => {});
		throw error;
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

/**
 * In-memory worker counters with a debounced JSON sink.
 *
 * One instance per state directory per process. Every session in an OMP
 * process — the main session and each subagent — builds its own extension
 * runtime (the factory runs per session), and they all target the same files;
 * separate instances would race and lose counts, so {@link Telemetry.shared}
 * hands them the same writer. Disabled telemetry never changes a file on disk
 * except through an explicit {@link Telemetry.reset}.
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
	#state: TelemetryState = { kind: "unloaded" };
	#enabled = true;
	#dirty = false;
	#timer: Timer | undefined;
	#loaded: Promise<void> | undefined;
	/** Incremented by every reset; a load that started earlier must not apply its result. */
	#resets = 0;
	/** Serializes snapshot writes and reset deletions in call order. */
	#io: Promise<void> = Promise.resolve();
	readonly #tracked = new Map<string, TrackedWorker>();
	readonly #file: string;
	readonly #historyDir: string;

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "telemetry.json");
		this.#historyDir = path.join(stateDir, HISTORY_DIR);
	}

	get file(): string {
		return this.#file;
	}

	/** Preserved originals, named by {@link historySnapshotName}. */
	get historyDir(): string {
		return this.#historyDir;
	}

	state(): Readonly<TelemetryState> {
		return this.#state;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		if (enabled && this.#state.kind === "deferred") {
			// The older file was only read. Its view is dropped so it can never be written
			// without a preserved original; the next load migrates the file first.
			this.#state = { kind: "unloaded" };
			this.#loaded = undefined;
			delete this.#snapshot.historical;
			delete this.#snapshot.jevRouting;
		}
	}

	snapshot(): Readonly<TelemetrySnapshot> {
		return this.#snapshot;
	}

	/** Read the persisted counters once, migrating an older file; later sessions reuse the result. Never rejects. */
	load(): Promise<void> {
		this.#loaded ??= this.#read().catch(error => {
			this.#state = { kind: "suspended", reason: "unreadable", detail: messageOf(error) };
		});
		return this.#loaded;
	}

	async #read(): Promise<void> {
		const resets = this.#resets;
		let bytes: Buffer;
		try {
			bytes = await readFile(this.#file);
		} catch (error) {
			if (resets !== this.#resets) return;
			this.#state =
				errorCode(error) === "ENOENT"
					? { kind: "active" }
					: { kind: "suspended", reason: "unreadable", detail: messageOf(error) };
			return;
		}
		if (resets !== this.#resets) return;
		const raw = parseObject(bytes);
		const version = raw?.version ?? 0;
		if (!raw || !isVersion(version)) {
			const detail = raw ? `unrecognized version ${JSON.stringify(raw.version)}` : "not a JSON object";
			this.#state = { kind: "suspended", reason: "unreadable", detail };
			return;
		}
		if (version > TELEMETRY_VERSION) {
			this.#state = { kind: "suspended", reason: "future-version", version };
			return;
		}
		if (version === TELEMETRY_VERSION) {
			this.#snapshot = mergePending(reviveSnapshot(raw), this.#snapshot);
			this.#state = { kind: "active" };
			return;
		}
		const source = { version, sha256: createHash("sha256").update(bytes).digest("hex") };
		this.#adoptEarlierEras(raw, source);
		if (!this.#enabled) {
			this.#state = { kind: "deferred", ...source };
			return;
		}
		try {
			await this.#migrate(bytes, source);
			if (resets === this.#resets) this.#state = { kind: "active" };
		} catch (error) {
			if (resets === this.#resets) {
				this.#state = { kind: "suspended", reason: "migration-failed", detail: messageOf(error), ...source };
			}
		}
	}

	/**
	 * Set the read-only sections an older file converts into; the live epoch stays
	 * empty. A v5 file becomes the Jev-routing era and hands over the tier-routing
	 * era it carried; a pre-v5 file is the tier-routing era itself.
	 */
	#adoptEarlierEras(raw: Record<string, unknown>, source: HistoricalTelemetry["source"]): void {
		if (source.version === JEV_ROUTING_VERSION) {
			this.#snapshot.jevRouting = jevRoutingFrom(raw, source);
			const carried = reviveHistorical(raw.historical);
			if (carried) this.#snapshot.historical = carried;
		} else {
			this.#snapshot.historical = historicalFrom(raw, source);
		}
	}

	/**
	 * Replace an older `telemetry.json` with its v6 conversion. The original is
	 * preserved first under a content-addressed name that is never overwritten;
	 * the conversion then replaces the active file by atomic rename. Any failure
	 * leaves the original active file in place, and a later load resumes with
	 * the same backup and the same conversion.
	 */
	async #migrate(bytes: Buffer, source: HistoricalTelemetry["source"]): Promise<void> {
		await preserve(this.#historyDir, historySnapshotName(source.version, source.sha256), bytes);
		// Writers are expected to be stopped; still, never replace a file that changed since it was read.
		if (!(await readFile(this.#file)).equals(bytes)) throw new Error("telemetry.json changed during migration");
		this.#snapshot.updatedAt = Date.now();
		await replaceAtomically(this.#file, JSON.stringify(this.#snapshot));
	}

	/** Before the first load, counts are kept in memory and merged into what the load finds. */
	#recording(): boolean {
		return this.#enabled && (this.#state.kind === "active" || this.#state.kind === "unloaded");
	}

	#writable(): boolean {
		return this.#enabled && this.#state.kind === "active";
	}

	#touch(): void {
		this.#dirty = true;
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, FLUSH_DEBOUNCE_MS);
		this.#timer.unref?.();
	}

	/**
	 * Fold one worker frame into the live counters. `key` identifies one worker
	 * process-wide, `source` the bus subscription that delivered the frame.
	 *
	 * Turns are counted, not workers: a worker keeps its key across follow-up
	 * turns, each turn settles and is measured on its own (its progress restarts
	 * from zero), and only the first turn observed is a new worker.
	 *
	 * Turns are told apart by their `started` frames. The same frame reaches the
	 * process once per bus that carries it, and every bus reports a worker's turns
	 * in the same order, so a bus's n-th turn is the worker's n-th; a frame of a
	 * turn already counted is dropped whichever bus delivers it, however late.
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

	#counters(agent: string): LiveWorkerCounters {
		const existing = this.#snapshot.workers[agent];
		if (existing) return existing;
		const created = emptyLiveWorker();
		this.#snapshot.workers[agent] = created;
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
				const snapshot = this.#snapshot;
				this.#enqueue(() => this.#write(snapshot));
			}
		}
		await this.#io;
	}

	async #write(snapshot: TelemetrySnapshot): Promise<void> {
		// A reset replaced the snapshot; the new one is written by its own flush.
		if (snapshot !== this.#snapshot || !this.#writable()) return;
		snapshot.updatedAt = Date.now();
		try {
			await replaceAtomically(this.#file, JSON.stringify(snapshot));
		} catch {
			// A telemetry write must never break a turn; the next flush retries.
			this.#dirty = true;
		}
	}

	/**
	 * Clear every count and start a new epoch, then delete the files this plugin
	 * owns once queued writes and any load in progress have finished, so nothing
	 * deleted is written back. Resolves to the removed paths; rejects naming each
	 * path that could not be removed, after attempting all of them.
	 */
	async reset(): Promise<string[]> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		const loading = this.#loaded;
		this.#resets++;
		this.#snapshot = emptySnapshot();
		this.#dirty = false;
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

	/** Only exact plugin-owned names; other files, including user exports, are left alone. */
	async #removeOwnedFiles(): Promise<string[]> {
		const removed: string[] = [];
		const failed: string[] = [];
		const remove = async (file: string) => {
			try {
				await unlink(file);
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
