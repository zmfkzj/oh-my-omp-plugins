import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { historySnapshotName, Telemetry } from "../src/telemetry.ts";
import { SUBAGENT_LIFECYCLE_CHANNEL, SUBAGENT_PROGRESS_CHANNEL, trackWorkerUsage } from "../src/worker-usage.ts";
import { firstRun, publish, settled, turn } from "./worker-frames.ts";

const roots: string[] = [];
const instances: Telemetry[] = [];
afterAll(async () => {
	// Settle debounced writes before their directories disappear.
	await Promise.all(instances.map(telemetry => telemetry.flush()));
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

/** A fresh state directory, optionally holding `telemetry.json`. */
async function stateDir(active?: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "om-orche-telemetry-"));
	roots.push(dir);
	if (active !== undefined) await writeFile(path.join(dir, "telemetry.json"), active);
	return dir;
}

async function loaded(dir: string, enabled = true): Promise<Telemetry> {
	const telemetry = new Telemetry(dir);
	instances.push(telemetry);
	telemetry.setEnabled(enabled);
	await telemetry.load();
	return telemetry;
}

/** A loaded telemetry following the worker frames of a fresh bus. */
async function following(dir: string, enabled = true): Promise<{ telemetry: Telemetry; bus: EventBus }> {
	const telemetry = await loaded(dir, enabled);
	const bus = new EventBus();
	trackWorkerUsage(bus, telemetry);
	return { telemetry, bus };
}

/** Every path under `dir`, relative and sorted. */
async function tree(dir: string): Promise<string[]> {
	return (await readdir(dir, { recursive: true })).map(String).sort();
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

	test("the live epoch holds workers only: no routing counter is kept, and no decision log is written", async () => {
		const dir = await stateDir();
		const { telemetry, bus } = await following(dir);
		firstRun([bus], "0-W", FIRST);
		await telemetry.flush();

		expect(Object.keys(JSON.parse(await readFile(telemetry.file, "utf8")))).toEqual(["version", "updatedAt", "epoch", "workers"]);
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
				version: 6,
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
		expect(persisted).toMatchObject({ version: 6, epoch: snapshot.epoch, workers: {}, jevRouting: V5_JEV_ROUTING, historical: V5.historical });
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
		expect(JSON.parse(await readFile(telemetry.file, "utf8")).version).toBe(6);
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
		"a failed active write keeps the original and its backup, and the next start completes the migration",
		async () => {
			const dir = await stateDir(V5_TEXT);
			const history = path.join(dir, "telemetry-history");
			await mkdir(history);
			await chmod(dir, 0o555);
			const failed = await loaded(dir).finally(() => chmod(dir, 0o755));

			expect(failed.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
			expect(await readFile(failed.file, "utf8")).toBe(V5_TEXT);
			expect(await readdir(history)).toEqual([V5_BACKUP]);

			const resumed = await loaded(dir);
			expect(resumed.state()).toEqual({ kind: "active" });
			expect(resumed.snapshot().jevRouting).toEqual(V5_JEV_ROUTING);
			expect(await readdir(history)).toEqual([V5_BACKUP]);
		},
	);

	test("rollback and re-upgrade keep every original, start a new epoch, and never merge epochs", async () => {
		const dir = await stateDir(V5_TEXT);
		const { telemetry: upgraded, bus } = await following(dir);
		firstRun([bus], "0-W", FIRST);
		await upgraded.flush();

		// Rollback: archive the v6 file, then the previous plugin counts on in a restored v5 file.
		const v6Text = await readFile(upgraded.file, "utf8");
		const v6Archive = historySnapshotName(6, sha256(v6Text));
		await writeFile(path.join(upgraded.historyDir, v6Archive), v6Text, { flag: "wx" });
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
			[V5_BACKUP, historySnapshotName(5, sha256(rolledBack)), v6Archive].sort(),
		);
		expect(await readFile(path.join(upgraded.historyDir, V5_BACKUP), "utf8")).toBe(V5_TEXT);
		expect(await readFile(path.join(upgraded.historyDir, v6Archive), "utf8")).toBe(v6Text);
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
			version: 6,
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

		const current = JSON.stringify({ version: 6, epoch: { id: "epoch-6", startedAt: 1 }, workers: { task: { completed: 1 } } });
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
});
