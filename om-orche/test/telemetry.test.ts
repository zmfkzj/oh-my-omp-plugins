import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { z } from "zod";
import { renderStats } from "../src/commands.ts";
import { normalizeConfig } from "../src/config.ts";
import { registerOmOrche } from "../src/index.ts";
import { RouteLogger } from "../src/logging.ts";
import { HOST_SETUP_VERSION } from "../src/omp-setup.ts";
import { OrcheRuntime } from "../src/runtime.ts";
import {
	cacheHitRatio,
	historySnapshotName,
	type LiveWorkerCounters,
	providerUsageOf,
	type RequestUsage,
	Telemetry,
	TELEMETRY_VERSION,
	type TelemetryOptions,
	type TelemetryWriteError,
} from "../src/telemetry.ts";
import { SUBAGENT_LIFECYCLE_CHANNEL, SUBAGENT_PROGRESS_CHANNEL, trackWorkerUsage } from "../src/worker-usage.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";
import { registeredSession } from "./sessions.ts";
import { firstRun, NO_TOOL_CALL, progress, publish, settled, turn } from "./worker-frames.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";

const roots: string[] = [];
const instances: Telemetry[] = [];
afterAll(async () => {
	// Settle debounced writes before their directories disappear.
	await Promise.all(instances.map(telemetry => telemetry.flush()));
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});
afterEach(() => {
	clearRegistry();
	Telemetry.resetSharedForTests();
});

/** A fresh state directory, optionally holding `telemetry.json`. */
async function stateDir(active?: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "om-orche-telemetry-"));
	roots.push(dir);
	if (active !== undefined) await writeFile(path.join(dir, "telemetry.json"), active);
	return dir;
}

async function loaded(dir: string, enabled = true, options?: TelemetryOptions): Promise<Telemetry> {
	const telemetry = new Telemetry(dir, options);
	instances.push(telemetry);
	telemetry.setEnabled(enabled);
	await telemetry.load();
	return telemetry;
}

/** A loaded telemetry following the worker frames of a fresh bus. */
async function following(dir: string, enabled = true, options?: TelemetryOptions): Promise<{ telemetry: Telemetry; bus: EventBus }> {
	const telemetry = await loaded(dir, enabled, options);
	const bus = new EventBus();
	trackWorkerUsage(bus, telemetry);
	return { telemetry, bus };
}

/** Every path under `dir`, relative and sorted. */
async function tree(dir: string): Promise<string[]> {
	return (await readdir(dir, { recursive: true })).map(String).sort();
}

/** Why the last write of `telemetry` failed, while it keeps failing. */
function writeErrorOf(telemetry: Telemetry): TelemetryWriteError | undefined {
	const state = telemetry.state();
	return state.kind === "active" ? state.writeError : undefined;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const FIRST = { tokens: 500, cost: 0.25, durationMs: 800 };
const SECOND = { tokens: 300, cost: 0.125, durationMs: 400 };

/** A tier-routing era file; its worker rows include the generic `task` agent. */
const V4 = {
	version: 4,
	updatedAt: 1_700_000_000_000,
	orchestration: {
		requests: 6,
		errors: 1,
		timeouts: 1,
		latencySumMs: 50,
		latencyCount: 5,
		confidence: [0, 0, 0, 0, 0, 1, 0, 0, 2, 2],
		margin: [0, 1, 0, 0, 0, 0, 0, 2, 1, 1],
		DEFAULT: 3,
		ORCHESTRATE: 1,
		legacyDecisions: 1,
	},
	task: {
		requests: 3,
		errors: 0,
		timeouts: 0,
		latencySumMs: 30,
		latencyCount: 3,
		confidence: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
		margin: [0, 0, 1, 1, 1, 1, 0, 0, 0, 0],
		batches: 3,
		TASK_EASY: 2,
		TASK_HARD: 1,
		TASK_CHALLENGE: 1,
		fallbackChallenge: 1,
		legacyDecisions: 0,
		legacyFallbacks: 0,
	},
	workers: {
		task: { spawns: 5, results: 4, completed: 3, tokens: 900, costUsd: 0.9, durationMs: 9000 },
		"task-challenge": { spawns: 1, results: 1, completed: 1, tokens: 4000, costUsd: 4, durationMs: 40000 },
	},
};
const V4_TEXT = JSON.stringify(V4);
const V4_BACKUP = historySnapshotName(4, sha256(V4_TEXT));

/** A Jev-routing era file: its live epoch holds routing counters, and it carries the tier era a v4 migration converted. */
const V5 = {
	version: 5,
	updatedAt: 1_750_000_000_000,
	epoch: { id: "epoch-v5", startedAt: 1_749_000_000_000 },
	orchestration: {
		requests: 9,
		errors: 2,
		timeouts: 1,
		latencySumMs: 90,
		latencyCount: 7,
		confidence: [0, 0, 1, 0, 0, 2, 0, 0, 3, 1],
		margin: [0, 2, 0, 0, 1, 0, 0, 3, 0, 1],
		DEFAULT: 5,
		ORCHESTRATE: 2,
	},
	workers: {
		task: {
			startedObserved: 4,
			completed: 3,
			failed: 1,
			aborted: 0,
			usageSamples: 3,
			usageSamplesCompleted: 2,
			usageUnknown: 1,
			tokens: 3000,
			costUsd: 1.5,
			durationMs: 30000,
		},
	},
	historical: {
		source: { version: 4, sha256: sha256(V4_TEXT) },
		updatedAt: V4.updatedAt,
		orchestration: V4.orchestration,
		taskRouting: V4.task,
		workers: V4.workers,
	},
};
/** Pretty-printed with a trailing newline, so a backup that re-serialized the JSON would differ. */
const V5_TEXT = `${JSON.stringify(V5, null, 2)}\n`;
const V5_BACKUP = historySnapshotName(5, sha256(V5_TEXT));
const V5_JEV_ROUTING = {
	source: { version: 5, sha256: sha256(V5_TEXT) },
	epoch: V5.epoch,
	updatedAt: V5.updatedAt,
	orchestration: V5.orchestration,
	workers: V5.workers,
};

/** The v5 plugin's per-decision log; nothing writes it any more. */
const DECISIONS = `${JSON.stringify({ ts: 1, policy: "self-orchestration/1", epoch: "epoch-v5", kind: "orchestration", route: "DEFAULT" })}\n`;

describe("live epoch", () => {
	test("worker counters persist and reload within one epoch", async () => {
		const dir = await stateDir();
		const { telemetry, bus } = await following(dir);
		firstRun([bus], "0-W", FIRST);
		turn([bus], "0-W", SECOND);
		await telemetry.flush();

		const reloaded = await loaded(dir);
		const snapshot = reloaded.snapshot();
		expect(reloaded.state()).toEqual({ kind: "active" });
		expect(snapshot.epoch).toEqual(telemetry.snapshot().epoch);
		expect(snapshot.workers).toEqual(telemetry.snapshot().workers);
		expect(snapshot.workers.task).toMatchObject({ startedObserved: 1, followUpTurns: 1, completed: 2, tokens: 800 });
		expect(snapshot.historical).toBeUndefined();
		expect(snapshot.jevRouting).toBeUndefined();
	});

	test("the live epoch holds worker and main-session usage only: no routing counter is kept, and no decision log is written", async () => {
		const dir = await stateDir();
		const { telemetry, bus } = await following(dir);
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();

		expect(Object.keys(JSON.parse(await readFile(telemetry.file, "utf8")))).toEqual(["version", "updatedAt", "epoch", "workers", "mainSession"]);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("no prompt, task, or credential text is ever stored", async () => {
		const dir = await stateDir();
		const { telemetry, bus } = await following(dir);
		const secret = "ts_live_secret refactor the billing ledger";
		const lifecycle = (status: string) =>
			publish([bus], SUBAGENT_LIFECYCLE_CHANNEL, { id: "Ledger", agent: "task", description: secret, parentToolCallId: "call-1", status, index: 0 });
		const report = (tokens: number) =>
			publish([bus], SUBAGENT_PROGRESS_CHANNEL, {
				index: 0,
				agent: "task",
				task: secret,
				assignment: secret,
				parentToolCallId: "call-1",
				progress: { id: "Ledger", agent: "task", task: secret, description: secret, tokens, cost: tokens / 10, durationMs: 9 },
			});
		// A first turn, as the host publishes it, then a follow-up turn.
		report(0);
		lifecycle("started");
		report(5);
		lifecycle("completed");
		lifecycle("started");
		report(0);
		report(5);
		lifecycle("completed");
		await telemetry.flush();

		const text = await readFile(telemetry.file, "utf8");
		expect(text).not.toContain("ts_live");
		expect(text).not.toContain("billing");
		expect(text).not.toContain("Ledger");
		expect(JSON.parse(text).workers.task).toMatchObject({ startedObserved: 1, followUpTurns: 1, completed: 2 });
	});

	test("no message text reaches the file with a request's usage", async () => {
		const dir = await stateDir();
		const telemetry = await loaded(dir);
		const secret = "ts_live_secret refactor the billing ledger";
		const message = {
			...assistantMessage({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 0.01 }),
			content: [{ type: "text", text: secret }],
			errorMessage: secret,
		};
		const usage = providerUsageOf(message);
		if (!usage) throw new Error("the message reported usage");
		telemetry.observeMainRequest(usage);
		telemetry.observeWorkerRequest("task", usage);
		await telemetry.flush();

		expect(await readFile(telemetry.file, "utf8")).not.toContain(secret);
	});

	test("counts recorded before the first load are merged into the loaded epoch", async () => {
		const dir = await stateDir();
		const first = await following(dir);
		firstRun([first.bus], "0-A", FIRST);
		await first.telemetry.flush();

		const second = new Telemetry(dir);
		instances.push(second);
		const bus = new EventBus();
		trackWorkerUsage(bus, second);
		firstRun([bus], "1-B", SECOND);
		await second.load();
		expect(second.snapshot().workers.task).toMatchObject({ startedObserved: 2, completed: 2 });
		expect(second.snapshot().epoch.id).toBe(first.telemetry.snapshot().epoch.id);
		await second.flush();
		expect((await loaded(dir)).snapshot().workers.task).toMatchObject({ startedObserved: 2, completed: 2, tokens: 800 });
	});

	test("every session in a process shares one writer, so counts are not lost", async () => {
		const dir = await stateDir();
		Telemetry.resetSharedForTests();
		try {
			// Each session builds its own extension runtime; they must not race the file.
			const main = Telemetry.shared(dir);
			const subagent = Telemetry.shared(dir);
			expect(subagent).toBe(main);
			const mainBus = new EventBus();
			const subagentBus = new EventBus();
			trackWorkerUsage(mainBus, main);
			trackWorkerUsage(subagentBus, subagent);
			firstRun([mainBus], "0-A", FIRST);
			firstRun([subagentBus], "1-B", SECOND);
			await subagent.flush();
			expect((await loaded(dir)).snapshot().workers.task).toMatchObject({ startedObserved: 2, completed: 2 });
		} finally {
			Telemetry.resetSharedForTests();
		}
	});

	test("a malformed field degrades to zero without discarding the rest", async () => {
		const dir = await stateDir(
			JSON.stringify({
				version: TELEMETRY_VERSION,
				epoch: { id: "epoch-1", startedAt: 1 },
				workers: { task: { completed: 2, tokens: null }, bogus: 7 },
				jevRouting: { source: { version: 5, sha256: "not-a-hash" }, orchestration: { requests: 4 } },
				historical: { source: "x" },
			}),
		);
		const telemetry = await loaded(dir);
		const snapshot = telemetry.snapshot();
		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(snapshot.epoch.id).toBe("epoch-1");
		expect(Object.keys(snapshot.workers)).toEqual(["task"]);
		expect(snapshot.workers.task).toMatchObject({ completed: 2, tokens: 0, followUpTurns: 0 });
		// A read-only section whose preserved original cannot be identified is dropped, not guessed.
		expect(snapshot.jevRouting).toBeUndefined();
		expect(snapshot.historical).toBeUndefined();
	});
});

describe("migration from the Jev-routing era (v5)", () => {
	test("the v5 live epoch becomes a read-only section, the tier era is carried over, and the live epoch starts empty", async () => {
		const dir = await stateDir(V5_TEXT);
		const telemetry = await loaded(dir);
		const snapshot = telemetry.snapshot();

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(await readFile(path.join(telemetry.historyDir, V5_BACKUP))).toEqual(Buffer.from(V5_TEXT));
		expect(snapshot.jevRouting).toEqual(V5_JEV_ROUTING);
		expect(snapshot.historical).toEqual(V5.historical);
		expect(snapshot.epoch.id).not.toBe(V5.epoch.id);
		expect(snapshot.workers).toEqual({});

		const persisted = JSON.parse(await readFile(telemetry.file, "utf8"));
		expect(persisted).toMatchObject({ version: TELEMETRY_VERSION, epoch: snapshot.epoch, workers: {}, jevRouting: V5_JEV_ROUTING, historical: V5.historical });
		expect(persisted.orchestration).toBeUndefined();
	});

	test("reloading neither migrates again, duplicates the backup, changes the epoch, nor merges history into live counts", async () => {
		const dir = await stateDir(V5_TEXT);
		await writeFile(path.join(dir, "decisions.jsonl"), DECISIONS);
		const first = await following(dir);
		firstRun([first.bus], "0-W", FIRST);
		await first.telemetry.flush();

		const second = await loaded(dir);
		const snapshot = second.snapshot();
		expect(snapshot.epoch).toEqual(first.telemetry.snapshot().epoch);
		expect(snapshot.jevRouting).toEqual(V5_JEV_ROUTING);
		expect(snapshot.historical).toEqual(V5.historical);
		// One live worker; v5's four started workers and 3000 tokens stay in their own section.
		expect(snapshot.workers.task).toMatchObject({ startedObserved: 1, completed: 1, tokens: 500 });
		expect(snapshot.jevRouting?.workers.task).toEqual(V5.workers.task);
		expect(await tree(dir)).toEqual(["decisions.jsonl", "telemetry-history", path.join("telemetry-history", V5_BACKUP), "telemetry.json"]);
		// The decision log is no longer written; migration leaves it as it was.
		expect(await readFile(path.join(dir, "decisions.jsonl"), "utf8")).toBe(DECISIONS);
	});

	test("an interrupted migration resumes with the backup it already wrote", async () => {
		const dir = await stateDir(V5_TEXT);
		const history = path.join(dir, "telemetry-history");
		await mkdir(history);
		// Stopped after the backup, before the active file was replaced.
		await writeFile(path.join(history, V5_BACKUP), V5_TEXT);

		const telemetry = await loaded(dir);
		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(JSON.parse(await readFile(telemetry.file, "utf8")).version).toBe(TELEMETRY_VERSION);
		expect(telemetry.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
		expect(await readdir(history)).toEqual([V5_BACKUP]);
	});

	test("a conflicting backup is never overwritten and the original stays active", async () => {
		const dir = await stateDir(V5_TEXT);
		const history = path.join(dir, "telemetry-history");
		await mkdir(history);
		await writeFile(path.join(history, V5_BACKUP), "other bytes");

		const { telemetry, bus } = await following(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();

		expect(telemetry.snapshot().workers).toEqual({});
		expect(await readFile(telemetry.file, "utf8")).toBe(V5_TEXT);
		expect(await readFile(path.join(history, V5_BACKUP), "utf8")).toBe("other bytes");
		expect(await tree(dir)).toEqual(["telemetry-history", path.join("telemetry-history", V5_BACKUP), "telemetry.json"]);
	});

	test("a failed backup keeps the original active file and never saves empty counters", async () => {
		const dir = await stateDir(V5_TEXT);
		await writeFile(path.join(dir, "telemetry-history"), "not a directory");

		const { telemetry, bus } = await following(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();

		expect(await readFile(telemetry.file, "utf8")).toBe(V5_TEXT);
		expect(await tree(dir)).toEqual(["telemetry-history", "telemetry.json"]);
	});

	// Root ignores directory permissions, so the write cannot be made to fail.
	test.skipIf(process.getuid?.() === 0)(
		"a migration that cannot write keeps the original active, and the next start completes it",
		async () => {
			const dir = await stateDir(V5_TEXT);
			await chmod(dir, 0o555);
			const failed = await loaded(dir).finally(() => chmod(dir, 0o755));

			expect(failed.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
			expect(await readFile(failed.file, "utf8")).toBe(V5_TEXT);
			expect(await tree(dir)).toEqual(["telemetry.json"]);

			const resumed = await loaded(dir);
			expect(resumed.state()).toEqual({ kind: "active" });
			expect(resumed.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
			expect(await readdir(path.join(dir, "telemetry-history"))).toEqual([V5_BACKUP]);
		},
	);

	test("rollback and re-upgrade keep every original, start a new epoch, and never merge epochs", async () => {
		const dir = await stateDir(V5_TEXT);
		const { telemetry: upgraded, bus } = await following(dir);
		firstRun([bus], "0-W", FIRST);
		await upgraded.flush();

		// Rollback: archive the current file, then the previous plugin counts on in a restored v5 file.
		const currentText = await readFile(upgraded.file, "utf8");
		const currentArchive = historySnapshotName(TELEMETRY_VERSION, sha256(currentText));
		await writeFile(path.join(upgraded.historyDir, currentArchive), currentText, { flag: "wx" });
		const rolledBack = JSON.stringify({ ...V5, orchestration: { ...V5.orchestration, requests: 12, DEFAULT: 8 } });
		await writeFile(upgraded.file, rolledBack);

		const reupgraded = await loaded(dir);
		const snapshot = reupgraded.snapshot();
		expect(snapshot.epoch.id).not.toBe(upgraded.snapshot().epoch.id);
		expect(snapshot.workers).toEqual({});
		expect(snapshot.jevRouting?.source).toEqual({ version: 5, sha256: sha256(rolledBack) });
		expect(snapshot.jevRouting?.orchestration).toMatchObject({ requests: 12, DEFAULT: 8 });
		expect(snapshot.historical).toEqual(V5.historical);
		expect((await readdir(upgraded.historyDir)).sort()).toEqual(
			[V5_BACKUP, historySnapshotName(5, sha256(rolledBack)), currentArchive].sort(),
		);
		expect(await readFile(path.join(upgraded.historyDir, V5_BACKUP), "utf8")).toBe(V5_TEXT);
		expect(await readFile(path.join(upgraded.historyDir, currentArchive), "utf8")).toBe(currentText);
	});

	test("a v5 file without a tier era, or with a malformed epoch, still converts", async () => {
		const bare = JSON.stringify({ version: 5, epoch: { id: 7 }, orchestration: { requests: 2, DEFAULT: 2 }, workers: { task: { startedObserved: 1 } } });
		const telemetry = await loaded(await stateDir(bare));
		const snapshot = telemetry.snapshot();
		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(snapshot.historical).toBeUndefined();
		expect(snapshot.jevRouting).toMatchObject({
			source: { version: 5, sha256: sha256(bare) },
			epoch: { id: "", startedAt: 0 },
			orchestration: { requests: 2, DEFAULT: 2 },
			workers: { task: { startedObserved: 1, completed: 0 } },
		});
		expect(await readFile(path.join(telemetry.historyDir, historySnapshotName(5, sha256(bare))), "utf8")).toBe(bare);
	});
});

describe("migration from the tier-routing era (pre-v5)", () => {
	test("history keeps every tier counter and worker row, task included; there is no Jev-routing era and the live epoch starts empty", async () => {
		const dir = await stateDir(V4_TEXT);
		const telemetry = await loaded(dir);
		const snapshot = telemetry.snapshot();

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(snapshot.historical).toEqual({
			source: { version: 4, sha256: sha256(V4_TEXT) },
			updatedAt: V4.updatedAt,
			orchestration: V4.orchestration,
			taskRouting: V4.task,
			workers: V4.workers,
		});
		expect(snapshot.jevRouting).toBeUndefined();
		expect(snapshot.workers).toEqual({});
		expect(await readFile(path.join(telemetry.historyDir, V4_BACKUP), "utf8")).toBe(V4_TEXT);
		expect(JSON.parse(await readFile(telemetry.file, "utf8"))).toMatchObject({
			version: TELEMETRY_VERSION,
			epoch: snapshot.epoch,
			historical: { source: { version: 4, sha256: sha256(V4_TEXT) } },
		});
	});

	test("retired labels from every earlier format stay accounted for in history", async () => {
		const cases: { version: number; file: Record<string, unknown>; expected: Record<string, unknown> }[] = [
			{
				version: 1,
				file: { version: 1, orchestration: { requests: 5, DIRECT: 3, ORCHESTRATE: 1, UNCERTAIN: 1 } },
				expected: { orchestration: { requests: 5, ORCHESTRATE: 1, legacyDecisions: 4 } },
			},
			{
				version: 2,
				file: { version: 2, workers: { "task-deep": { spawns: 2, results: 1, input: 100, output: 40, cacheRead: 999, cacheWrite: 10, costUsd: 0.5 } } },
				expected: { workers: { "task-deep": { spawns: 2, results: 1, tokens: 150, costUsd: 0.5 } } },
			},
			{
				version: 3,
				file: { version: 3, orchestration: { requests: 7, DEFAULT: 2, SLOW: 3, UNCERTAIN: 2 }, task: { TASK_NORMAL: 29, TASK_DEEP: 34, fallbackDeep: 21 } },
				expected: {
					orchestration: { DEFAULT: 2, legacyDecisions: 5 },
					taskRouting: { TASK_EASY: 0, legacyDecisions: 63, legacyFallbacks: 21 },
				},
			},
			{ version: 0, file: { orchestration: { requests: 1, DIRECT: 1 } }, expected: { orchestration: { legacyDecisions: 1 } } },
		];
		for (const { version, file, expected } of cases) {
			const text = JSON.stringify(file);
			const telemetry = await loaded(await stateDir(text));
			expect(telemetry.snapshot().historical).toMatchObject({ source: { version, sha256: sha256(text) }, ...expected });
			expect(telemetry.snapshot().jevRouting).toBeUndefined();
			expect(await readFile(path.join(telemetry.historyDir, historySnapshotName(version, sha256(text))), "utf8")).toBe(text);
		}
	});
});

describe("files this version does not write", () => {
	test("a newer version's file is left untouched and recording is suspended", async () => {
		const future = JSON.stringify({ version: 99, workers: { task: { completed: 5 } } });
		const dir = await stateDir(future);
		const { telemetry, bus } = await following(dir);
		expect(telemetry.state()).toEqual({ kind: "suspended", reason: "future-version", version: 99 });

		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();

		expect(telemetry.snapshot().workers).toEqual({});
		expect(await readFile(telemetry.file, "utf8")).toBe(future);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("an unreadable file is never replaced with empty counters; reset is the explicit way out", async () => {
		const dir = await stateDir("{ truncated");
		const { telemetry, bus } = await following(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "unreadable" });
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();
		expect(await readFile(telemetry.file, "utf8")).toBe("{ truncated");

		await telemetry.reset();
		firstRun([bus], "1-W", FIRST);
		await telemetry.flush();
		expect((await loaded(dir)).snapshot().workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
	});

	test("disabled telemetry never changes a file: nothing is created, and an older file is only read", async () => {
		const empty = await stateDir();
		const fresh = await following(empty, false);
		firstRun([fresh.bus], "0-W", FIRST);
		await fresh.telemetry.flush();
		expect(fresh.telemetry.snapshot().workers).toEqual({});
		expect(await tree(empty)).toEqual([]);

		const dir = await stateDir(V5_TEXT);
		const { telemetry, bus } = await following(dir, false);
		expect(telemetry.state()).toEqual({ kind: "deferred", version: 5, sha256: sha256(V5_TEXT) });
		expect(telemetry.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
		expect(telemetry.snapshot().historical).toEqual(V5.historical);
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();
		expect(telemetry.snapshot().workers).toEqual({});
		expect(await readFile(telemetry.file, "utf8")).toBe(V5_TEXT);
		expect(await tree(dir)).toEqual(["telemetry.json"]);

		const current = JSON.stringify({ version: TELEMETRY_VERSION, epoch: { id: "epoch-6", startedAt: 1 }, workers: { task: { completed: 1 } } });
		const readOnly = await following(await stateDir(current), false);
		firstRun([readOnly.bus], "0-W", FIRST);
		await readOnly.telemetry.flush();
		expect(readOnly.telemetry.snapshot().workers.task).toMatchObject({ completed: 1, startedObserved: 0 });
		expect(await readFile(readOnly.telemetry.file, "utf8")).toBe(current);
	});

	test("enabling after a read-only load migrates before the first write", async () => {
		const dir = await stateDir(V5_TEXT);
		const { telemetry, bus } = await following(dir, false);
		telemetry.setEnabled(true);
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(await readFile(path.join(telemetry.historyDir, V5_BACKUP), "utf8")).toBe(V5_TEXT);
		const reloaded = (await loaded(dir)).snapshot();
		expect(reloaded.workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
		expect(reloaded.jevRouting).toEqual(V5_JEV_ROUTING);
		expect(reloaded.historical).toEqual(V5.historical);
	});
});

describe("reset", () => {
	test("removes exactly the plugin-owned telemetry files, the retired decision log included", async () => {
		const dir = await stateDir();
		await mkdir(path.join(dir, "telemetry-history"));
		const hash = "a".repeat(64);
		const owned = [
			"telemetry.json",
			"decisions.jsonl",
			"telemetry.json.4242-7.tmp",
			"telemetry.v7.json",
			path.join("telemetry-history", `v4-${hash}.json`),
			path.join("telemetry-history", `v5-${hash}.json`),
			path.join("telemetry-history", `decisions-${hash}.jsonl`),
			path.join("telemetry-history", `v5-${hash}.json.4242-8.tmp`),
		];
		const foreign = [
			"config.json",
			"telemetry.json.bak",
			"telemetry-export.json",
			path.join("telemetry-history", "my-export.json"),
			path.join("telemetry-history", "v4-abc.json"),
		];
		for (const name of [...owned, ...foreign]) await writeFile(path.join(dir, name), "x");

		const removed = await new Telemetry(dir).reset();
		expect(removed.map(file => path.relative(dir, file)).sort()).toEqual([...owned].sort());
		expect(await tree(dir)).toEqual(["telemetry-history", ...foreign].sort());
	});

	test("pending writes finish before deletion, and nothing comes back in memory or after a restart", async () => {
		const dir = await stateDir(V5_TEXT);
		await writeFile(path.join(dir, "decisions.jsonl"), DECISIONS);
		const { telemetry, bus } = await following(dir);
		const before = telemetry.snapshot().epoch.id;
		settled([bus], "0-W", "completed");
		const flushing = telemetry.flush();
		await telemetry.reset();
		await flushing;

		expect(await tree(dir)).toEqual([]);
		const snapshot = telemetry.snapshot();
		expect(snapshot.epoch.id).not.toBe(before);
		expect(snapshot.jevRouting).toBeUndefined();
		expect(snapshot.historical).toBeUndefined();
		expect(snapshot.workers).toEqual({});
		expect((await loaded(dir)).snapshot().jevRouting).toBeUndefined();

		firstRun([bus], "1-W", FIRST);
		await telemetry.flush();
		const persisted = JSON.parse(await readFile(telemetry.file, "utf8"));
		expect(persisted).toMatchObject({ epoch: { id: snapshot.epoch.id }, workers: { task: { startedObserved: 1, completed: 1 } } });
		expect(persisted.jevRouting).toBeUndefined();
		expect(persisted.historical).toBeUndefined();
	});

	test("a reset during a load in progress wins: nothing is migrated or restored afterwards", async () => {
		const dir = await stateDir(V5_TEXT);
		const telemetry = new Telemetry(dir);
		instances.push(telemetry);
		const loading = telemetry.load();
		await telemetry.reset();
		await loading;

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(telemetry.snapshot().jevRouting).toBeUndefined();
		expect(telemetry.snapshot().historical).toBeUndefined();
		expect(await tree(dir)).toEqual([]);
	});

	test("a file that cannot be removed fails the reset instead of reporting success", async () => {
		const dir = await stateDir();
		await mkdir(path.join(dir, "telemetry.json"));
		await writeFile(path.join(dir, "telemetry.json", "inner"), "x");
		await writeFile(path.join(dir, "decisions.jsonl"), "{}\n");

		await expect(new Telemetry(dir).reset()).rejects.toThrow("telemetry.json");
		expect(await tree(dir)).toEqual(["telemetry.json", path.join("telemetry.json", "inner")]);
	});

	test("a state directory that was never created is neither an error nor created by a reset", async () => {
		const parent = await stateDir();

		expect(await new Telemetry(path.join(parent, "never-created")).reset()).toEqual([]);
		expect(await tree(parent)).toEqual([]);
	});

	test("removes the staging directory of a lock acquisition that died, and nothing that only looks like one", async () => {
		const dir = await stateDir();
		const staging = path.join(dir, `telemetry.lock.${randomUUID()}.tmp`);
		await mkdir(staging);
		await writeFile(path.join(staging, randomUUID()), "");
		await writeFile(path.join(dir, "telemetry.lock.backup"), "x");

		const removed = await new Telemetry(dir).reset();

		expect(removed).toEqual([staging]);
		expect(await tree(dir)).toEqual(["telemetry.lock.backup"]);
	});
});

describe("a write that cannot reach the disk", () => {
	/** A loaded telemetry over `dir`, following a fresh bus, whose warnings land in `warnings` and which retries a failed write within milliseconds. */
	async function watched(dir: string, warnings: string[]) {
		const logger = new RouteLogger({
			debug() {},
			info() {},
			error() {},
			warn: (message: string) => void warnings.push(message),
		} as unknown as ExtensionAPI["logger"]);
		return following(dir, true, { logger, flushDebounceMs: 20 });
	}

	/** Put a plain file where the state directory is, so that no write can succeed, whoever runs the test (permissions do not stop root). */
	async function blockStateDir(dir: string): Promise<void> {
		await rm(dir, { recursive: true });
		await writeFile(dir, "not a directory");
	}

	async function unblockStateDir(dir: string): Promise<void> {
		await rm(dir, { force: true });
		// A retry may recreate the directory between these two calls.
		await mkdir(dir, { recursive: true });
	}

	/** Wait for something only a retry timer brings about; elapsed time is the point, so this polls. */
	async function eventually(condition: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 400; attempt++) {
			if (condition()) return;
			await Bun.sleep(5);
		}
		throw new Error("the retry did not happen");
	}

	test("is shown in the state and in the stats, warned about once, retried without a new frame, and forgotten once it lands", async () => {
		const dir = await stateDir();
		const warnings: string[] = [];
		const { telemetry, bus } = await watched(dir, warnings);
		await blockStateDir(dir);
		firstRun([bus], "0-W", FIRST);

		await telemetry.flush();

		// Nothing reached the disk, and the process says so instead of looking healthy.
		const failure = writeErrorOf(telemetry);
		expect(failure?.attempts).toBeGreaterThanOrEqual(1);
		expect(failure?.message).toContain(dir);
		expect(renderStats({ telemetry, config: normalizeConfig(undefined) } as unknown as OrcheRuntime)).toContain(failure?.message ?? "");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(telemetry.file);
		// Nobody flushes again, yet the write is retried; the same failure is not warned about twice.
		await eventually(() => (writeErrorOf(telemetry)?.attempts ?? 0) >= 3);
		expect(warnings).toHaveLength(1);
		expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 1, completed: 1 });

		await unblockStateDir(dir);
		await eventually(() => writeErrorOf(telemetry) === undefined);
		expect(JSON.parse(await readFile(telemetry.file, "utf8")).workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(warnings).toHaveLength(1);
	});

	test("a failure after a recovery is warned about again", async () => {
		const dir = await stateDir();
		const warnings: string[] = [];
		const { telemetry, bus } = await watched(dir, warnings);
		await blockStateDir(dir);
		firstRun([bus], "0-a", FIRST);
		await telemetry.flush();
		expect(warnings).toHaveLength(1);

		await unblockStateDir(dir);
		await telemetry.flush();
		expect(writeErrorOf(telemetry)).toBeUndefined();

		await blockStateDir(dir);
		firstRun([bus], "0-b", FIRST);
		await telemetry.flush();
		expect(writeErrorOf(telemetry)).toBeDefined();
		expect(warnings).toHaveLength(2);
	});
});

describe("several processes sharing one state directory", () => {
	// Each Telemetry stands for one OMP process: they share nothing but the directory.
	const persisted = async (dir: string) => JSON.parse(await readFile(path.join(dir, "telemetry.json"), "utf8"));
	const lockOf = (dir: string) => path.join(dir, "telemetry.lock");

	/**
	 * Let a writer that is waiting on another process's lock run for a while,
	 * report what `observe` sees meanwhile, then release the lock. Real time is
	 * the point: only elapsed time tells a writer that waits from one that never
	 * tried, and the lock stays held throughout, so a correct writer cannot fail.
	 */
	async function releaseAfterWaiting<T>(dir: string, observe: () => Promise<T>): Promise<T> {
		await Bun.sleep(100);
		const seen = await observe();
		await rm(lockOf(dir));
		return seen;
	}

	test("every process's counts reach the file, in whatever order they write", async () => {
		const dir = await stateDir();
		const a = await following(dir);
		const b = await following(dir);
		firstRun([a.bus], "0-a1", FIRST);
		firstRun([a.bus], "0-a2", FIRST);
		await a.telemetry.flush();
		firstRun([b.bus], "0-b1", SECOND);
		await b.telemetry.flush();
		firstRun([a.bus], "0-a3", FIRST);
		await a.telemetry.flush();

		const file = await persisted(dir);
		expect(file.workers.task).toMatchObject({ startedObserved: 4, completed: 4, tokens: 500 * 3 + 300, costUsd: 0.875 });
		// Both started with no file: the first writer's epoch is the one they share.
		expect(file.epoch).toEqual(a.telemetry.snapshot().epoch);
		expect(b.telemetry.snapshot().epoch).toEqual(file.epoch);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("flushes that race for the file all land", async () => {
		const dir = await stateDir();
		const processes = await Promise.all([following(dir), following(dir), following(dir), following(dir)]);
		processes.forEach(({ bus }, index) => firstRun([bus], `0-w${index}`, FIRST));
		await Promise.all(processes.map(({ telemetry }) => telemetry.flush()));

		expect((await persisted(dir)).workers.task).toMatchObject({ startedObserved: 4, completed: 4, tokens: 2000 });
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("usage measured after its settlement was written turns the unknown into one sample", async () => {
		const dir = await stateDir();
		const telemetry = await loaded(dir);
		// Two buses carrying one session's frames, so the same worker reaches this process twice.
		const first = new EventBus();
		const second = new EventBus();
		trackWorkerUsage(first, telemetry, { scope: "session" });
		trackWorkerUsage(second, telemetry, { scope: "session" });
		settled([first], "0-W", "completed");
		await telemetry.flush();
		expect((await persisted(dir)).workers.task).toMatchObject({ completed: 1, usageSamples: 0, usageUnknown: 1 });

		progress([second], "0-W", FIRST);
		settled([second], "0-W", "completed");
		// The decrement is still pending over the written unknown: the view already nets them.
		expect(telemetry.snapshot().workers.task).toMatchObject({ usageSamples: 1, usageUnknown: 0 });
		await telemetry.flush();
		const task = (await persisted(dir)).workers.task;
		expect(task).toMatchObject({ startedObserved: 1, completed: 1, usageSamples: 1, usageSamplesCompleted: 1, usageUnknown: 0, tokens: 500 });
		expect(telemetry.snapshot().workers.task).toEqual(task);
	});

	describe("a reset in another process", () => {
		test("is not undone by this process's next write", async () => {
			const dir = await stateDir();
			const a = await following(dir);
			firstRun([a.bus], "0-a1", FIRST);
			await a.telemetry.flush();
			const cleared = a.telemetry.snapshot().epoch;
			const b = await following(dir);
			await b.telemetry.reset();
			expect(await tree(dir)).toEqual([]);

			firstRun([a.bus], "0-a2", SECOND);
			await a.telemetry.flush();

			// What a counted before the reset is gone for good; what it counted since starts a new epoch.
			const file = await persisted(dir);
			expect(file.epoch.id).not.toBe(cleared.id);
			expect(file.workers.task).toMatchObject({ startedObserved: 1, completed: 1, tokens: 300 });
			expect(a.telemetry.snapshot().epoch).toEqual(file.epoch);
		});

		test("leaves the epoch the resetting process opens afterwards to be joined, not replaced", async () => {
			const dir = await stateDir();
			const a = await following(dir);
			firstRun([a.bus], "0-a1", FIRST);
			await a.telemetry.flush();
			const b = await following(dir);
			await b.telemetry.reset();
			firstRun([b.bus], "0-b1", SECOND);
			await b.telemetry.flush();
			firstRun([a.bus], "0-a2", FIRST);
			await a.telemetry.flush();

			const file = await persisted(dir);
			expect(file.epoch).toEqual(b.telemetry.snapshot().epoch);
			expect(file.workers.task).toMatchObject({ startedObserved: 2, completed: 2, tokens: 800 });
			expect(a.telemetry.snapshot().epoch).toEqual(file.epoch);
		});

		test("waits for a live process's lock instead of deleting the file in the middle of its write", async () => {
			const dir = await stateDir();
			const { telemetry, bus } = await following(dir);
			firstRun([bus], "0-W", FIRST);
			await telemetry.flush();
			await writeFile(lockOf(dir), "other-process");

			const resetting = telemetry.reset();
			const seen = await releaseAfterWaiting(dir, () => tree(dir));
			await resetting;

			expect(seen).toEqual(["telemetry.json", "telemetry.lock"]);
			expect(await tree(dir)).toEqual([]);
		});
	});

	describe("the lock on the state directory", () => {
		test("a write waits for a live process's lock and lands once it is released", async () => {
			const dir = await stateDir();
			await writeFile(lockOf(dir), "other-process");
			const { telemetry, bus } = await following(dir);
			firstRun([bus], "0-W", FIRST);

			const flushing = telemetry.flush();
			const seen = await releaseAfterWaiting(dir, () => tree(dir));
			await flushing;

			expect(seen).toEqual(["telemetry.lock"]);
			expect((await persisted(dir)).workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
			expect(await tree(dir)).toEqual(["telemetry.json"]);
		});

		test("a write that cannot get the lock in time gives up without losing its counts", async () => {
			const dir = await stateDir();
			await writeFile(lockOf(dir), "other-process");
			const { telemetry, bus } = await following(dir);
			firstRun([bus], "0-W", FIRST);

			await telemetry.flush();
			expect(await tree(dir)).toEqual(["telemetry.lock"]);
			expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 1, completed: 1 });

			await rm(lockOf(dir));
			await telemetry.flush();
			expect((await persisted(dir)).workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
		});

		test("a lock left behind by a process that died is broken", async () => {
			const dir = await stateDir();
			await writeFile(lockOf(dir), "dead-process");
			const longAgo = new Date(Date.now() - 60_000);
			await utimes(lockOf(dir), longAgo, longAgo);
			const { telemetry, bus } = await following(dir);
			firstRun([bus], "0-W", FIRST);
			await telemetry.flush();

			expect((await persisted(dir)).workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
			expect(await tree(dir)).toEqual(["telemetry.json"]);
		});

		test("writers that race to break a dead process's lock all land their counts", async () => {
			// Ten writers, over rounds enough that a break which does not check who holds the lock by then would lose counts in some.
			// They poll quickly: the default interval would make each round wait on it, not on the race.
			const writers = 10;
			const lock = { pollMs: 2 };
			for (let round = 0; round < 12; round++) {
				const dir = await stateDir();
				const processes = await Promise.all(Array.from({ length: writers }, () => following(dir, true, { lock })));
				await writeFile(lockOf(dir), "dead-process");
				const longAgo = new Date(Date.now() - 60_000);
				await utimes(lockOf(dir), longAgo, longAgo);
				processes.forEach(({ bus }, index) => firstRun([bus], `0-w${index}`, FIRST));

				await Promise.all(processes.map(({ telemetry }) => telemetry.flush()));

				expect((await persisted(dir)).workers.task).toMatchObject({
					startedObserved: writers,
					completed: writers,
					tokens: 500 * writers,
				});
				expect(await tree(dir)).toEqual(["telemetry.json"]);
			}
		});

		test("writers whose locks are broken under them keep their counts and land them on a later attempt", async () => {
			// A stale limit this short makes every writer that is slow look dead, as a process stopped inside its critical
			// section would: its publication must fail and leave its counts for the next attempt, never overwrite or drop anything.
			const dir = await stateDir();
			const lock = { staleMs: 6, waitMs: 10_000, pollMs: 1 };
			const processes = await Promise.all(Array.from({ length: 4 }, () => following(dir, true, { lock })));
			processes.forEach(({ bus }, index) => {
				for (let worker = 0; worker < 3; worker++) firstRun([bus], `0-p${index}w${worker}`, FIRST);
			});

			let unfinished = true;
			for (let attempt = 0; unfinished && attempt < 500; attempt++) {
				await Promise.all(processes.map(({ telemetry }) => telemetry.flush()));
				unfinished = processes.some(({ telemetry }) => writeErrorOf(telemetry) !== undefined);
			}

			expect(unfinished).toBe(false);
			expect((await persisted(dir)).workers.task).toMatchObject({ startedObserved: 12, completed: 12, tokens: 500 * 12 });
			expect(await tree(dir)).toEqual(["telemetry.json"]);
		});

		test("telemetry turned off while a migration waits for the lock is not migrated", async () => {
			const dir = await stateDir(V5_TEXT);
			await writeFile(lockOf(dir), "other-process");
			const telemetry = new Telemetry(dir);
			instances.push(telemetry);
			const loading = telemetry.load();
			await releaseAfterWaiting(dir, async () => telemetry.setEnabled(false));
			await loading;

			expect(telemetry.state()).toEqual({ kind: "deferred", version: 5, sha256: sha256(V5_TEXT) });
			expect(await readFile(telemetry.file, "utf8")).toBe(V5_TEXT);
			expect(await tree(dir)).toEqual(["telemetry.json"]);
		});

		test("a reset racing a migration leaves nothing behind, whichever gets the lock first", async () => {
			const dir = await stateDir(V5_TEXT);
			await writeFile(lockOf(dir), "other-process");
			const migrating = new Telemetry(dir);
			const resetting = new Telemetry(dir);
			instances.push(migrating, resetting);
			const loading = migrating.load();
			const clearing = resetting.reset();
			await releaseAfterWaiting(dir, async () => {});
			await Promise.all([loading, clearing]);

			expect(await tree(dir)).toEqual([]);
		});

		// Root ignores directory permissions, so the write cannot be made to fail.
		test.skipIf(process.getuid?.() === 0)("a write that fails keeps its counts for the next one", async () => {
			const dir = await stateDir();
			const { telemetry, bus } = await following(dir);
			firstRun([bus], "0-W", FIRST);
			await chmod(dir, 0o555);
			await telemetry.flush().finally(() => chmod(dir, 0o755));

			expect(await tree(dir)).toEqual([]);
			expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
			expect(writeErrorOf(telemetry)?.message).toContain(dir);
			await telemetry.flush();
			expect((await persisted(dir)).workers.task).toMatchObject({ startedObserved: 1, completed: 1 });
			expect(writeErrorOf(telemetry)).toBeUndefined();
		});
	});

	const replacements = {
		"newer format": JSON.stringify({ version: 99, workers: { task: { completed: 5 } } }),
		"file that is not telemetry": "{ truncated",
		"older format": V5_TEXT,
	};
	for (const [name, content] of Object.entries(replacements)) {
		test(`a file another process replaced with a ${name} is never overwritten`, async () => {
			const dir = await stateDir();
			const { telemetry, bus } = await following(dir);
			firstRun([bus], "0-a1", FIRST);
			await telemetry.flush();
			await writeFile(telemetry.file, content);

			firstRun([bus], "0-a2", FIRST);
			await telemetry.flush();

			expect(await readFile(telemetry.file, "utf8")).toBe(content);
			expect(telemetry.state()).toMatchObject({ kind: "suspended" });
			expect(await tree(dir)).toEqual(["telemetry.json"]);
		});
	}

	test("processes migrating the same older file end in one epoch with one backup", async () => {
		const dir = await stateDir(V5_TEXT);
		const [a, b] = await Promise.all([loaded(dir), loaded(dir)]);

		expect(a.state()).toEqual({ kind: "active" });
		expect(b.state()).toEqual({ kind: "active" });
		expect(b.snapshot().epoch).toEqual(a.snapshot().epoch);
		expect(b.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
		expect((await persisted(dir)).epoch).toEqual(a.snapshot().epoch);
		expect(await tree(dir)).toEqual(["telemetry-history", path.join("telemetry-history", V5_BACKUP), "telemetry.json"]);
	});
});

describe("refreshing what a process sees of the file", () => {
	const inodeOf = async (file: string) => (await stat(file)).ino;

	test("shows what other processes wrote, keeps this process's unwritten counts on top, and writes nothing", async () => {
		const dir = await stateDir();
		const a = await following(dir);
		const b = await following(dir);
		firstRun([b.bus], "0-b1", SECOND);
		await b.telemetry.flush();
		firstRun([a.bus], "0-a1", FIRST);
		const before = { inode: await inodeOf(a.telemetry.file), bytes: await readFile(a.telemetry.file, "utf8") };

		await a.telemetry.refresh();

		expect(a.telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 2, completed: 2, tokens: 800 });
		expect({ inode: await inodeOf(a.telemetry.file), bytes: await readFile(a.telemetry.file, "utf8") }).toEqual(before);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
		await a.telemetry.flush();
		expect(JSON.parse(await readFile(a.telemetry.file, "utf8")).workers.task).toMatchObject({ startedObserved: 2, tokens: 800 });
	});

	test("after a reset elsewhere, what was cleared leaves the view, unwritten counts stay, and the next write joins the epoch shown", async () => {
		const dir = await stateDir();
		const a = await following(dir);
		firstRun([a.bus], "0-a1", FIRST);
		await a.telemetry.flush();
		const cleared = a.telemetry.snapshot().epoch;
		firstRun([a.bus], "0-a2", SECOND);
		await (await loaded(dir)).reset();

		await a.telemetry.refresh();

		const shown = a.telemetry.snapshot();
		expect(shown.epoch.id).not.toBe(cleared.id);
		expect(shown.workers.task).toMatchObject({ startedObserved: 1, completed: 1, tokens: 300 });
		await a.telemetry.flush();
		const file = JSON.parse(await readFile(a.telemetry.file, "utf8"));
		expect(file.epoch).toEqual(shown.epoch);
		expect(file.workers.task).toMatchObject({ startedObserved: 1, tokens: 300 });
	});

	test("a process with telemetry off shows the file as others left it, and still writes nothing", async () => {
		const dir = await stateDir();
		const writer = await following(dir);
		firstRun([writer.bus], "0-w1", FIRST);
		await writer.telemetry.flush();
		const reader = await loaded(dir, false);
		expect(reader.snapshot().workers.task).toMatchObject({ startedObserved: 1 });
		firstRun([writer.bus], "0-w2", SECOND);
		await writer.telemetry.flush();
		const before = await inodeOf(reader.file);

		await reader.refresh();

		expect(reader.snapshot().workers.task).toMatchObject({ startedObserved: 2, tokens: 800 });
		expect(await inodeOf(reader.file)).toBe(before);
	});

	test("a file replaced by a newer version's suspends recording and is never written", async () => {
		const dir = await stateDir();
		const { telemetry, bus } = await following(dir);
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();
		const future = JSON.stringify({ version: 99, workers: { task: { completed: 5 } } });
		await writeFile(telemetry.file, future);

		await telemetry.refresh();

		expect(telemetry.state()).toEqual({ kind: "suspended", reason: "future-version", version: 99 });
		firstRun([bus], "1-W", FIRST);
		await telemetry.flush();
		expect(await readFile(telemetry.file, "utf8")).toBe(future);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("telemetry just turned on over an older file has migrated it by the time the view is read", async () => {
		const dir = await stateDir(V5_TEXT);
		const telemetry = await loaded(dir, false);
		expect(telemetry.state()).toMatchObject({ kind: "deferred" });
		telemetry.setEnabled(true);

		await telemetry.refresh();

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(telemetry.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
		expect(await readFile(path.join(telemetry.historyDir, V5_BACKUP), "utf8")).toBe(V5_TEXT);
		expect(JSON.parse(await readFile(telemetry.file, "utf8")).version).toBe(TELEMETRY_VERSION);
	});

	test("a deferred view follows another process's migration of the file without writing it", async () => {
		const dir = await stateDir(V5_TEXT);
		const disabled = await loaded(dir, false);
		await loaded(dir);
		const before = await inodeOf(disabled.file);

		await disabled.refresh();

		expect(disabled.state()).toEqual({ kind: "active" });
		expect(disabled.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
		expect(await inodeOf(disabled.file)).toBe(before);
	});

	test("a suspended process stays as it is, whatever the file becomes", async () => {
		const dir = await stateDir("{ truncated");
		const telemetry = await loaded(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "unreadable" });
		await writeFile(telemetry.file, JSON.stringify({ version: TELEMETRY_VERSION, epoch: { id: "e", startedAt: 1 }, workers: { task: { completed: 3 } } }));

		await telemetry.refresh();

		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "unreadable" });
		expect(telemetry.snapshot().workers).toEqual({});
	});
});

type SessionStart = (event: object, ctx: ExtensionContext) => Promise<void>;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type MessageEnd = (event: object, ctx: ExtensionContext) => void | Promise<void>;

/** A project directory whose plugin override sets `telemetryEnabled`. */
async function project(telemetryEnabled: boolean): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "om-orche-project-"));
	roots.push(cwd);
	await mkdir(path.join(cwd, ".omp"));
	await setTelemetryOverride(cwd, telemetryEnabled);
	return cwd;
}

/** Change what a project's plugin override says about `telemetryEnabled`, as a user editing it between two commands would. */
async function setTelemetryOverride(cwd: string, telemetryEnabled: boolean): Promise<void> {
	const overrides = { settings: { "om-orche": { telemetryEnabled } } };
	await writeFile(path.join(cwd, ".omp", "plugin-overrides.json"), JSON.stringify(overrides));
}

/** The main session, or a subagent's, working in `cwd`; what the plugin shows the user lands in `notes`. */
function sessionIn(cwd: string, main: boolean, notes: string[] = []): ExtensionCommandContext {
	const fake = makeSession();
	// A real main AgentSession always has these live-roster APIs. Keep discovery isolated
	// in this fixture's project, rather than using the developer's WATCHDOG configuration.
	let advisorsEnabled = false;
	let advisors: AdvisorConfig[] = [];
	Object.assign(fake.session.sessionManager, { getCwd: () => cwd });
	Object.assign(fake.session.settings, { getAgentDir: () => path.join(cwd, ".omp") });
	Object.assign(fake.session, {
		isAdvisorEnabled: () => advisorsEnabled,
		setAdvisorEnabled: (enabled: boolean) => { advisorsEnabled = enabled; },
		applyAdvisorConfigs: (configs: AdvisorConfig[]) => { advisors = configs; },
		getAdvisorStats: () => ({
			advisors: advisors.map(advisor => ({ name: advisor.name, status: advisor.enabled === false ? "paused" : "running" })),
		}),
	});
	if (main) registerAsMain(fake.session);
	const ui = { notify: (message: string) => void notes.push(message) };
	return { ...fake.ctx, cwd, ui } as unknown as ExtensionCommandContext;
}

/**
 * The whole plugin on a fake host over `dir`, as one session's extension builds it: `start` runs its
 * session_start handlers for a session, `command` its `/om-orche`, and `bus` carries that session's worker frames.
 */
function host(dir: string) {
	const starts: SessionStart[] = [];
	const messageEnds: MessageEnd[] = [];
	let handler: CommandHandler | undefined;
	const bus = new EventBus();
	const pi = {
		zod: z,
		logger: { debug() {}, warn() {}, info() {}, error() {} },
		events: bus,
		setLabel() {},
		registerCommand(_name: string, options: { handler: CommandHandler }) {
			handler = options.handler;
		},
		registerTool() {},
		getActiveTools: () => [],
		setActiveTools: async () => {},
		on(event: string, listener: SessionStart) {
			if (event === "session_start") starts.push(listener);
			else if (event === "message_end") messageEnds.push(listener);
		},
	} as unknown as ExtensionAPI;
	const store = { version: async () => HOST_SETUP_VERSION, markApplied: async () => {} };
	const runtime = registerOmOrche(pi, store, dir);
	instances.push(runtime.telemetry);
	return {
		runtime,
		bus,
		async start(ctx: ExtensionContext) {
			for (const listener of starts) await listener({}, ctx);
		},
		async messageEnd(ctx: ExtensionContext, message: object) {
			for (const listener of messageEnds) await listener({ type: "message_end", message }, ctx);
		},
		async command(args: string, ctx: ExtensionCommandContext) {
			await handler?.(args, ctx);
		},
	};
}

describe("subagent sessions and the process's shared telemetry", () => {
	test("a subagent's start cannot switch on telemetry the main session turned off", async () => {
		const dir = await stateDir(V5_TEXT);
		const main = host(dir);
		const subagent = host(dir);
		const mainCtx = sessionIn(await project(false), true);
		const subagentCtx = sessionIn(await project(true), false);

		await main.start(mainCtx);
		const deferred = { kind: "deferred", version: 5, sha256: sha256(V5_TEXT) } as const;
		expect(main.runtime.telemetry.state()).toEqual(deferred);
		await subagent.start(subagentCtx);
		firstRun([main.bus], "0-W", FIRST);
		firstRun([subagent.bus], "1-W", FIRST);
		await main.runtime.telemetry.flush();

		// Still off: nothing was migrated, recorded, or written.
		expect(main.runtime.telemetry.state()).toEqual(deferred);
		expect(main.runtime.telemetry.snapshot().workers).toEqual({});
		expect(await readFile(main.runtime.telemetry.file, "utf8")).toBe(V5_TEXT);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("a subagent's start cannot switch off telemetry the main session turned on, and its own workers still count", async () => {
		const dir = await stateDir();
		const main = host(dir);
		const subagent = host(dir);
		const mainCtx = sessionIn(await project(true), true);
		const subagentCtx = sessionIn(await project(false), false);

		await main.start(mainCtx);
		await subagent.start(subagentCtx);
		firstRun([main.bus], "0-W", FIRST);
		firstRun([subagent.bus], "1-W", SECOND);
		await main.runtime.telemetry.flush();

		const file = JSON.parse(await readFile(main.runtime.telemetry.file, "utf8"));
		expect(file.workers.task).toMatchObject({ startedObserved: 2, completed: 2, tokens: 800 });
	});

	test("a subagent's start neither loads nor migrates the file; the main session's does", async () => {
		const dir = await stateDir(V5_TEXT);
		const main = host(dir);
		const subagent = host(dir);
		const mainCtx = sessionIn(await project(true), true);
		const subagentCtx = sessionIn(await project(true), false);

		await subagent.start(subagentCtx);
		expect(subagent.runtime.telemetry.state()).toEqual({ kind: "unloaded" });
		expect(await readFile(subagent.runtime.telemetry.file, "utf8")).toBe(V5_TEXT);
		expect(await tree(dir)).toEqual(["telemetry.json"]);

		await main.start(mainCtx);
		expect(main.runtime.telemetry.state()).toEqual({ kind: "active" });
		expect(await readFile(path.join(main.runtime.telemetry.historyDir, V5_BACKUP), "utf8")).toBe(V5_TEXT);
		expect(JSON.parse(await readFile(main.runtime.telemetry.file, "utf8")).version).toBe(TELEMETRY_VERSION);
	});

	test("a running main session's recording follows telemetryEnabled as it changes in the stored settings, from its next turn on", async () => {
		const app = host(await stateDir());
		const cwd = await project(false);
		const ctx = sessionIn(cwd, true);
		await app.start(ctx);
		const recorded = () => app.runtime.telemetry.snapshot().workers.task?.startedObserved ?? 0;

		firstRun([app.bus], "0-a", FIRST);
		expect(recorded()).toBe(0);

		// Switched on in the store: the running session keeps its choice until its next turn reads the store.
		await setTelemetryOverride(cwd, true);
		firstRun([app.bus], "0-b", FIRST);
		expect(recorded()).toBe(0);
		await app.runtime.syncConfig(ctx);
		firstRun([app.bus], "0-c", FIRST);
		expect(recorded()).toBe(1);

		await setTelemetryOverride(cwd, false);
		await app.runtime.syncConfig(ctx);
		firstRun([app.bus], "0-d", FIRST);
		expect(recorded()).toBe(1);
	});

	const orders = [
		["on", "off"],
		["off", "on"],
	] as const;
	for (const order of orders) {
		test(`two main sessions of one process each keep their own telemetry choice, whichever reads its configuration last (${order.join(" then ")})`, async () => {
			const dir = await stateDir();
			const apps = { on: host(dir), off: host(dir) };
			const contexts = {
				on: registeredSession("acp:on", await project(true)),
				off: registeredSession("acp:off", await project(false)),
			};
			for (const choice of order) await apps[choice].start(contexts[choice]);

			firstRun([apps.on.bus], "0-on", FIRST);
			firstRun([apps.off.bus], "0-off", SECOND);
			await apps.on.runtime.telemetry.flush();

			// The session that opted out records nothing, the other one's worker is written.
			const file = JSON.parse(await readFile(apps.on.runtime.telemetry.file, "utf8"));
			expect(file.workers.task).toMatchObject({ startedObserved: 1, completed: 1, tokens: 500 });
		});
	}

	test("a subagent's workers, and its own subagents', follow the main session above them, whatever their working directories say", async () => {
		for (const [mainOn, workersOn] of [[false, true], [true, false]] as const) {
			clearRegistry();
			const dir = await stateDir();
			const main = host(dir);
			const worker = host(dir);
			const nested = host(dir);
			await main.start(registeredSession("acp:1", await project(mainOn)));
			await worker.start(registeredSession("1-worker", await project(workersOn), "acp:1"));
			await nested.start(registeredSession("2-nested", await project(workersOn), "1-worker"));

			firstRun([main.bus], "0-main", FIRST);
			firstRun([worker.bus], "1-a", FIRST);
			firstRun([nested.bus], "2-a", SECOND);
			await main.runtime.telemetry.flush();

			// All three sessions' workers count, or none: the subagents' own directories decided nothing, and their
			// starts left the main session's choice as it was.
			expect(main.runtime.telemetry.snapshot().workers.task?.startedObserved ?? 0).toBe(mainOn ? 3 : 0);
		}
	});

	test("two sessions of one process that allocate the same worker id run two workers, not one", async () => {
		const dir = await stateDir();
		// Each session's extension subscribes the bus of its own session; the host's output managers are per session.
		const first = host(dir);
		const second = host(dir);
		firstRun([first.bus], "reviewers-0", FIRST, { owner: NO_TOOL_CALL });
		firstRun([second.bus], "reviewers-0", SECOND, { owner: NO_TOOL_CALL });
		await first.runtime.telemetry.flush();

		const file = JSON.parse(await readFile(first.runtime.telemetry.file, "utf8"));
		expect(file.workers.task).toMatchObject({ startedObserved: 2, followUpTurns: 0, completed: 2, tokens: 800 });
	});
});

describe("/om-orche stats", () => {
	test("telemetry turned on over an older file shows the migrated file at once, not an empty epoch", async () => {
		const dir = await stateDir(V5_TEXT);
		const app = host(dir);
		const cwd = await project(false);
		const notes: string[] = [];
		const ctx = sessionIn(cwd, true, notes);
		await app.start(ctx);
		expect(app.runtime.telemetry.state()).toMatchObject({ kind: "deferred" });

		await setTelemetryOverride(cwd, true);
		await app.command("stats", ctx);

		const [shown] = notes;
		expect(shown).toContain("Jev routing era (v5)");
		expect(shown).toContain(`Source snapshot: ${path.join(app.runtime.telemetry.historyDir, V5_BACKUP)}`);
		expect(shown).not.toContain("not migrated");
		expect(JSON.parse(await readFile(app.runtime.telemetry.file, "utf8")).version).toBe(TELEMETRY_VERSION);
	});

	test("shows what another process has counted, without writing anything", async () => {
		const dir = await stateDir();
		const notes: string[] = [];
		const app = host(dir);
		const ctx = sessionIn(await project(true), true, notes);
		await app.start(ctx);
		const other = await following(dir);
		firstRun([other.bus], "0-W", FIRST);
		await other.telemetry.flush();
		const before = (await stat(app.runtime.telemetry.file)).ino;

		await app.command("stats", ctx);

		expect(notes[0]).toMatch(/workers started\s+1 observed/);
		expect(notes[0]).toMatch(/settled turns\s+1 completed/);
		expect((await stat(app.runtime.telemetry.file)).ino).toBe(before);
	});

	test("drops what another process's reset cleared", async () => {
		const dir = await stateDir();
		const notes: string[] = [];
		const app = host(dir);
		const ctx = sessionIn(await project(true), true, notes);
		await app.start(ctx);
		firstRun([app.bus], "0-W", FIRST);
		await app.runtime.telemetry.flush();
		await (await loaded(dir)).reset();

		await app.command("stats", ctx);

		expect(notes[0]).toContain("none observed");
		expect(await tree(dir)).toEqual([]);
	});

	test("cost per completed says what it divides: all measured spend, failed and cancelled included", async () => {
		const { telemetry, bus } = await following(await stateDir());
		firstRun([bus], "0-W", { tokens: 1000, cost: 1, durationMs: 100 }, { status: "failed" });
		turn([bus], "0-W", { tokens: 100, cost: 0.1, durationMs: 100 }, { status: "completed" });

		const shown = renderStats({ telemetry, config: normalizeConfig(undefined) } as unknown as OrcheRuntime);

		// $1.00 of a failed turn and $0.10 of the completed one, over the one measured completion.
		const row = shown.split("\n").find(line => line.includes("cost per completed")) ?? "";
		expect(row).toContain("$1.1000");
		expect(row).toMatch(/failed and cancelled/);
	});
});

/** A finished assistant message as the host emits it: its usage as the provider reported it. The text is never read. */
function assistantMessage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) {
	const { cost, ...tokens } = usage;
	return {
		role: "assistant",
		content: [{ type: "text", text: "never recorded" }],
		usage: { ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite, cost: { total: cost } },
		stopReason: "stop",
	};
}

/** What the provider reported for one request, as telemetry counts it. */
function request(input: number, output: number, cacheRead: number, cacheWrite: number, costUsd = 0): RequestUsage {
	return { input, output, cacheRead, cacheWrite, costUsd };
}

describe("provider usage and the cache hit ratio", () => {
	test("the main session's requests add up, persist with the file, and give the hit ratio", async () => {
		const dir = await stateDir();
		const telemetry = await loaded(dir);
		telemetry.observeMainRequest(request(100, 50, 0, 900, 0.25));
		telemetry.observeMainRequest(request(20, 30, 900, 80, 0.05));

		const expected = { requests: 2, inputTokens: 120, cacheReadTokens: 900, cacheWriteTokens: 980, outputTokens: 80 };
		expect(telemetry.snapshot().mainSession).toMatchObject(expected);
		// 900 cache reads of 2,000 prompt tokens.
		expect(cacheHitRatio(telemetry.snapshot().mainSession)).toBeCloseTo(0.45, 10);

		await telemetry.flush();
		const file = JSON.parse(await readFile(telemetry.file, "utf8"));
		expect(file.version).toBe(TELEMETRY_VERSION);
		expect(file.mainSession).toMatchObject(expected);
		expect(file.mainSession.costUsd).toBeCloseTo(0.3, 10);
		expect((await loaded(dir)).snapshot().mainSession).toMatchObject(expected);
	});

	test("the ratio is undefined until a prompt token was counted", () => {
		expect(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeUndefined();
		expect(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 0 })).toBe(1);
		expect(cacheHitRatio({ inputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 50 })).toBe(0);
	});

	test("only a finished assistant message that reported tokens is a request, and only its numbers are read", () => {
		const message = assistantMessage({ input: 10, output: 5, cacheRead: 200, cacheWrite: 30, cost: 0.02 });

		expect(providerUsageOf(message)).toEqual({ input: 10, output: 5, cacheRead: 200, cacheWrite: 30, costUsd: 0.02 });
		expect(providerUsageOf({ role: "user", content: "text", usage: message.usage })).toBeUndefined();
		expect(providerUsageOf({ role: "toolResult", usage: message.usage })).toBeUndefined();
		expect(providerUsageOf(assistantMessage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }))).toBeUndefined();
		expect(providerUsageOf({ role: "assistant", usage: "garbage" })).toBeUndefined();
		expect(providerUsageOf({ role: "assistant" })).toBeUndefined();
		expect(providerUsageOf(undefined)).toBeUndefined();
		expect(providerUsageOf({ role: "assistant", usage: { input: -5, output: Number.NaN, cacheRead: 7 } })).toEqual({
			input: 0,
			output: 0,
			cacheRead: 7,
			cacheWrite: 0,
			costUsd: 0,
		});
	});

	test("a worker session's requests join its row beside the frame counters and give the worker's own ratio", async () => {
		const { telemetry, bus } = await following(await stateDir());
		firstRun([bus], "0-W", FIRST);
		telemetry.observeWorkerRequest("task", request(50, 10, 0, 450));
		telemetry.observeWorkerRequest("task", request(5, 10, 450, 20));

		const row: LiveWorkerCounters | undefined = telemetry.snapshot().workers.task;
		if (!row) throw new Error("no worker row");
		// The frame counters are untouched by the provider counters, and the other way round.
		expect(row).toMatchObject({ startedObserved: 1, completed: 1, tokens: 500, requests: 2, inputTokens: 55, cacheReadTokens: 450, cacheWriteTokens: 470, outputTokens: 20 });
		expect(cacheHitRatio(row)).toBeCloseTo(450 / 975, 10);
		expect(telemetry.snapshot().mainSession.requests).toBe(0);
	});

	test("the requests of several processes add, whichever writes last", async () => {
		const dir = await stateDir();
		const a = await loaded(dir);
		const b = await loaded(dir);
		a.observeMainRequest(request(10, 1, 100, 0, 0.1));
		b.observeMainRequest(request(20, 2, 0, 200, 0.2));
		b.observeWorkerRequest("task", request(1, 1, 1, 1));
		await a.flush();
		await b.flush();

		const file = JSON.parse(await readFile(a.file, "utf8"));
		expect(file.mainSession).toMatchObject({ requests: 2, inputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 200, outputTokens: 3 });
		expect(file.workers.task).toMatchObject({ requests: 1, cacheReadTokens: 1 });
	});

	test("nothing is counted while telemetry is off", async () => {
		const dir = await stateDir();
		const telemetry = await loaded(dir, false);
		telemetry.observeMainRequest(request(1, 1, 1, 1));
		telemetry.observeWorkerRequest("task", request(1, 1, 1, 1));
		await telemetry.flush();

		expect(telemetry.snapshot().mainSession.requests).toBe(0);
		expect(telemetry.snapshot().workers).toEqual({});
		expect(await tree(dir)).toEqual([]);
	});

	test("stats shows the main session's requests and hit ratio, and each worker's own ratio", async () => {
		const { telemetry, bus } = await following(await stateDir());
		firstRun([bus], "0-W", FIRST);
		telemetry.observeMainRequest(request(100, 50, 0, 900, 0.25));
		telemetry.observeMainRequest(request(20, 30, 900, 80, 0.05));
		telemetry.observeWorkerRequest("task", request(10, 5, 90, 0));

		const shown = renderStats({ telemetry, config: normalizeConfig(undefined) } as unknown as OrcheRuntime);

		expect(shown).toMatch(/requests\s+2\b/);
		expect(shown).toMatch(/cache hit ratio\s+45\.0%/);
		expect(shown).toMatch(/cache hit ratio\s+90\.0%/);
		expect(shown).toContain("$0.3000");
	});
});

describe("which sessions' finished assistant messages are counted", () => {
	test("each follows its own top-level session's choice, and only main and generic worker sessions count", async () => {
		const dir = await stateDir();
		const [on, off, worker, explorer] = [host(dir), host(dir), host(dir), host(dir)] as const;
		const mainOn = registeredSession("acp:on", await project(true));
		const mainOff = registeredSession("acp:off", await project(false));
		// A worker's own directory says off, but it belongs to the main session that says on.
		const taskWorker = registeredSession("1-task", await project(false), "acp:on");
		const other = registeredSession("2-explore", await project(true), "acp:on");
		const explorerCtx = { ...other, agent: { ...other.agent, name: "explore" } } as ExtensionCommandContext;
		await on.start(mainOn);
		await off.start(mainOff);
		await worker.start(taskWorker);
		await explorer.start(explorerCtx);

		const message = assistantMessage({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: 0.01 });
		await on.messageEnd(mainOn, message);
		await off.messageEnd(mainOff, message);
		await worker.messageEnd(taskWorker, message);
		await explorer.messageEnd(explorerCtx, message);
		await on.messageEnd(mainOn, { role: "user", content: "not a request" });

		const { mainSession, workers } = on.runtime.telemetry.snapshot();
		expect(mainSession).toMatchObject({ requests: 1, inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 5 });
		expect(workers.task).toMatchObject({ requests: 1, cacheReadTokens: 100 });
	});
});

/** A file of the format before provider-usage counters, with a live epoch worth keeping and both read-only eras. */
const V6 = {
	version: 6,
	updatedAt: 1_760_000_000_000,
	epoch: { id: "epoch-v6", startedAt: 1_759_000_000_000 },
	workers: {
		task: {
			startedObserved: 3,
			followUpTurns: 1,
			completed: 3,
			failed: 1,
			aborted: 0,
			usageSamples: 4,
			usageSamplesCompleted: 3,
			usageUnknown: 0,
			tokens: 900,
			costUsd: 0.9,
			durationMs: 3000,
		},
	},
	jevRouting: V5_JEV_ROUTING,
	historical: V5.historical,
};
/** Pretty-printed with a trailing newline, so a backup that re-serialized the JSON would differ. */
const V6_TEXT = `${JSON.stringify(V6, null, 2)}\n`;

describe("a file of the version before provider usage", () => {
	test("converts with its live epoch and read-only eras intact, and the new counters start at zero", async () => {
		const dir = await stateDir(V6_TEXT);
		const telemetry = await loaded(dir);

		expect(telemetry.state()).toEqual({ kind: "active" });
		const snapshot = telemetry.snapshot();
		expect(snapshot.epoch).toEqual(V6.epoch);
		expect(snapshot.workers.task).toMatchObject({ ...V6.workers.task, requests: 0, cacheReadTokens: 0 });
		expect(snapshot.mainSession).toMatchObject({ requests: 0, cacheReadTokens: 0 });
		expect(snapshot.jevRouting).toEqual(V5_JEV_ROUTING);
		expect(snapshot.historical).toEqual(V5.historical);
		// The original is kept byte for byte, and what is on disk now is the new version.
		expect(await readFile(path.join(telemetry.historyDir, historySnapshotName(6, sha256(V6_TEXT))), "utf8")).toBe(V6_TEXT);
		expect(JSON.parse(await readFile(telemetry.file, "utf8"))).toMatchObject({
			version: TELEMETRY_VERSION,
			epoch: V6.epoch,
			workers: { task: V6.workers.task },
		});

		// The epoch goes on: new counts add to the carried ones.
		telemetry.observeMainRequest(request(1, 1, 8, 1));
		await telemetry.flush();
		expect(JSON.parse(await readFile(telemetry.file, "utf8"))).toMatchObject({
			epoch: V6.epoch,
			mainSession: { requests: 1, cacheReadTokens: 8 },
			workers: { task: { startedObserved: 3 } },
		});
	});

	test("with telemetry off is shown as it is and left untouched, and converts once telemetry is on", async () => {
		const dir = await stateDir(V6_TEXT);
		const telemetry = await loaded(dir, false);

		expect(telemetry.state()).toEqual({ kind: "deferred", version: 6, sha256: sha256(V6_TEXT) });
		expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 3 });
		expect(await readFile(telemetry.file, "utf8")).toBe(V6_TEXT);
		const shown = renderStats({ telemetry, config: normalizeConfig({ telemetryEnabled: false }) } as unknown as OrcheRuntime);
		expect(shown).toMatch(/workers started\s+3 observed/);

		telemetry.setEnabled(true);
		await telemetry.refresh();

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(JSON.parse(await readFile(telemetry.file, "utf8")).version).toBe(TELEMETRY_VERSION);
	});
});
