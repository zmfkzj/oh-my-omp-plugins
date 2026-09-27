import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { bucketOf, DECISION_POLICY, historySnapshotName, Telemetry } from "../src/telemetry.ts";
import { SUBAGENT_LIFECYCLE_CHANNEL, SUBAGENT_PROGRESS_CHANNEL, trackWorkerUsage } from "../src/worker-usage.ts";

const roots: string[] = [];
const instances: Telemetry[] = [];
afterAll(async () => {
	// Settle debounced writes before their directories disappear.
	await Promise.all(instances.map(telemetry => telemetry.flush()));
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

/** A fresh state directory, optionally holding `telemetry.json`. */
async function stateDir(active?: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "jev-telemetry-"));
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

/** Every path under `dir`, relative and sorted. */
async function tree(dir: string): Promise<string[]> {
	return (await readdir(dir, { recursive: true })).map(String).sort();
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

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

describe("live epoch", () => {
	test("counters and histograms survive a save/load cycle within one epoch", async () => {
		const dir = await stateDir();
		const telemetry = await loaded(dir);
		telemetry.recordOrchestration("DEFAULT", 0.91, 0.82, 12);
		telemetry.recordOrchestration("ORCHESTRATE", 0.88, 0.7, 14);
		telemetry.recordOrchestration("DEFAULT", 0.54, 0.08, 20);
		telemetry.recordFailure("orchestration", true);
		await telemetry.flush();

		const reloaded = await loaded(dir);
		const snapshot = reloaded.snapshot();
		expect(reloaded.state()).toEqual({ kind: "active" });
		expect(snapshot.epoch).toEqual(telemetry.snapshot().epoch);
		expect(snapshot.orchestration).toMatchObject({ requests: 3, DEFAULT: 2, ORCHESTRATE: 1, errors: 1, timeouts: 1, latencySumMs: 46 });
		expect(snapshot.orchestration.confidence).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 1, 1]);
		expect(snapshot.historical).toBeUndefined();
	});

	test("no prompt, task, or credential text is ever stored", async () => {
		const dir = await stateDir();
		const telemetry = await loaded(dir);
		const bus = new EventBus();
		trackWorkerUsage(bus, telemetry);
		const secret = "ts_live_secret refactor the billing ledger";
		bus.emit(SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			task: secret,
			assignment: secret,
			parentToolCallId: "call-1",
			progress: { id: "Ledger", agent: "task", task: secret, description: secret, tokens: 5, cost: 0.5, durationMs: 9 },
		});
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "Ledger", agent: "task", description: secret, parentToolCallId: "call-1", status: "completed", index: 0 });
		telemetry.recordOrchestration("ORCHESTRATE", 0.9, 0.8, 5);
		telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut: false });
		await telemetry.flush();

		for (const file of [telemetry.file, telemetry.decisionsFile]) {
			const text = await readFile(file, "utf8");
			expect(text).not.toContain("ts_live");
			expect(text).not.toContain("billing");
			expect(text).not.toContain("Ledger");
		}
	});

	test("counts recorded before the first load are merged into the loaded epoch", async () => {
		const dir = await stateDir();
		const first = await loaded(dir);
		first.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		first.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await first.flush();

		const second = new Telemetry(dir);
		instances.push(second);
		second.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await second.load();
		expect(second.snapshot().orchestration.DEFAULT).toBe(3);
		expect(second.snapshot().epoch.id).toBe(first.snapshot().epoch.id);
		await second.flush();
		expect((await loaded(dir)).snapshot().orchestration.DEFAULT).toBe(3);
	});

	test("every session in a process shares one writer, so counts are not lost", async () => {
		const dir = await stateDir();
		Telemetry.resetSharedForTests();
		try {
			// Each session builds its own extension runtime; they must not race the file.
			const main = Telemetry.shared(dir);
			const subagent = Telemetry.shared(dir);
			expect(subagent).toBe(main);
			main.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
			subagent.recordOrchestration("ORCHESTRATE", 0.9, 0.8, 1);
			await subagent.flush();
			expect((await loaded(dir)).snapshot().orchestration).toMatchObject({ DEFAULT: 1, ORCHESTRATE: 1 });
		} finally {
			Telemetry.resetSharedForTests();
		}
	});

	test("a malformed field degrades to zero without discarding the rest", async () => {
		const dir = await stateDir(
			JSON.stringify({
				version: 5,
				epoch: { id: "epoch-1", startedAt: 1 },
				orchestration: { requests: "x", DEFAULT: 3, confidence: [1, "y"] },
				workers: { task: { completed: 2, tokens: null }, bogus: 7 },
			}),
		);
		const telemetry = await loaded(dir);
		const snapshot = telemetry.snapshot();
		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(snapshot.epoch.id).toBe("epoch-1");
		expect(snapshot.orchestration).toMatchObject({ requests: 0, DEFAULT: 3 });
		expect(snapshot.orchestration.confidence.slice(0, 2)).toEqual([1, 0]);
		expect(Object.keys(snapshot.workers)).toEqual(["task"]);
		expect(snapshot.workers.task).toMatchObject({ completed: 2, tokens: 0 });
	});

	test("probabilities land in the expected histogram bucket", () => {
		expect(bucketOf(0)).toBe(0);
		expect(bucketOf(0.55)).toBe(5);
		expect(bucketOf(1)).toBe(9);
		expect(bucketOf(Number.NaN)).toBe(0);
	});
});

describe("migration from the tier-routing era", () => {
	test("history keeps every tier counter and worker row, task included, and the live epoch starts empty", async () => {
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
		expect(snapshot.orchestration.requests).toBe(0);
		expect(snapshot.workers).toEqual({});
		expect(await readFile(path.join(telemetry.historyDir, V4_BACKUP), "utf8")).toBe(V4_TEXT);
		expect(JSON.parse(await readFile(telemetry.file, "utf8"))).toMatchObject({
			version: 5,
			epoch: snapshot.epoch,
			historical: { source: { version: 4, sha256: sha256(V4_TEXT) } },
		});
	});

	test("reloading neither migrates again, duplicates the backup, changes the epoch, nor merges history into live counts", async () => {
		const dir = await stateDir(V4_TEXT);
		const first = await loaded(dir);
		first.recordOrchestration("ORCHESTRATE", 0.9, 0.8, 5);
		await first.flush();

		const second = await loaded(dir);
		const snapshot = second.snapshot();
		expect(snapshot.epoch).toEqual(first.snapshot().epoch);
		expect(snapshot.orchestration).toMatchObject({ requests: 1, ORCHESTRATE: 1 });
		expect(snapshot.historical).toEqual(first.snapshot().historical);
		expect(snapshot.historical?.orchestration).toMatchObject({ requests: 6, ORCHESTRATE: 1 });
		expect(await tree(dir)).toEqual(["telemetry-history", path.join("telemetry-history", V4_BACKUP), "telemetry.json"]);
	});

	test("an interrupted migration resumes with the backup it already wrote", async () => {
		const dir = await stateDir(V4_TEXT);
		const history = path.join(dir, "telemetry-history");
		await mkdir(history);
		// Stopped after the backup, before the active file was replaced.
		await writeFile(path.join(history, V4_BACKUP), V4_TEXT);

		const telemetry = await loaded(dir);
		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(JSON.parse(await readFile(telemetry.file, "utf8")).version).toBe(5);
		expect(await readdir(history)).toEqual([V4_BACKUP]);
	});

	test("a conflicting backup is never overwritten and the original stays active", async () => {
		const dir = await stateDir(V4_TEXT);
		const history = path.join(dir, "telemetry-history");
		await mkdir(history);
		await writeFile(path.join(history, V4_BACKUP), "other bytes");

		const telemetry = await loaded(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut: true });
		await telemetry.flush();

		expect(await readFile(telemetry.file, "utf8")).toBe(V4_TEXT);
		expect(await readFile(path.join(history, V4_BACKUP), "utf8")).toBe("other bytes");
		expect(await tree(dir)).toEqual(["telemetry-history", path.join("telemetry-history", V4_BACKUP), "telemetry.json"]);
	});

	test("a failed backup keeps the original active file and never saves empty counters", async () => {
		const dir = await stateDir(V4_TEXT);
		await writeFile(path.join(dir, "telemetry-history"), "not a directory");

		const telemetry = await loaded(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await telemetry.flush();

		expect(await readFile(telemetry.file, "utf8")).toBe(V4_TEXT);
		expect(await tree(dir)).toEqual(["telemetry-history", "telemetry.json"]);
	});

	// Root ignores directory permissions, so the write cannot be made to fail.
	test.skipIf(process.getuid?.() === 0)(
		"a failed active write keeps the original and its backup, and the next start completes the migration",
		async () => {
			const dir = await stateDir(V4_TEXT);
			const history = path.join(dir, "telemetry-history");
			await mkdir(history);
			await chmod(dir, 0o555);
			const failed = await loaded(dir).finally(() => chmod(dir, 0o755));

			expect(failed.state()).toMatchObject({ kind: "suspended", reason: "migration-failed" });
			expect(await readFile(failed.file, "utf8")).toBe(V4_TEXT);
			expect(await readdir(history)).toEqual([V4_BACKUP]);

			const resumed = await loaded(dir);
			expect(resumed.state()).toEqual({ kind: "active" });
			expect(resumed.snapshot().historical?.source.sha256).toBe(sha256(V4_TEXT));
			expect(await readdir(history)).toEqual([V4_BACKUP]);
		},
	);

	test("rollback and re-upgrade keep every original, start a new epoch, and never merge epochs", async () => {
		const dir = await stateDir(V4_TEXT);
		const upgraded = await loaded(dir);
		upgraded.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await upgraded.flush();

		// Rollback: archive the v5 file, then the previous plugin counts on in a restored v4 file.
		const v5Text = await readFile(upgraded.file, "utf8");
		const v5Archive = historySnapshotName(5, sha256(v5Text));
		await writeFile(path.join(upgraded.historyDir, v5Archive), v5Text, { flag: "wx" });
		const rolledBack = JSON.stringify({ ...V4, orchestration: { ...V4.orchestration, requests: 8, DEFAULT: 5 } });
		await writeFile(upgraded.file, rolledBack);

		const reupgraded = await loaded(dir);
		const snapshot = reupgraded.snapshot();
		expect(snapshot.epoch.id).not.toBe(upgraded.snapshot().epoch.id);
		expect(snapshot.orchestration.requests).toBe(0);
		expect(snapshot.historical?.source).toEqual({ version: 4, sha256: sha256(rolledBack) });
		expect(snapshot.historical?.orchestration).toMatchObject({ requests: 8, DEFAULT: 5 });
		expect((await readdir(upgraded.historyDir)).sort()).toEqual(
			[V4_BACKUP, historySnapshotName(4, sha256(rolledBack)), v5Archive].sort(),
		);
		expect(await readFile(path.join(upgraded.historyDir, V4_BACKUP), "utf8")).toBe(V4_TEXT);
		expect(await readFile(path.join(upgraded.historyDir, v5Archive), "utf8")).toBe(v5Text);
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
			expect(await readFile(path.join(telemetry.historyDir, historySnapshotName(version, sha256(text))), "utf8")).toBe(text);
		}
	});

	test("a newer version's file is left untouched and recording is suspended", async () => {
		const future = JSON.stringify({ version: 99, orchestration: { requests: 5 } });
		const dir = await stateDir(future);
		const telemetry = await loaded(dir);
		expect(telemetry.state()).toEqual({ kind: "suspended", reason: "future-version", version: 99 });

		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut: false });
		await telemetry.flush();

		expect(telemetry.snapshot().orchestration.requests).toBe(0);
		expect(await readFile(telemetry.file, "utf8")).toBe(future);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("an unreadable file is never replaced with empty counters; reset is the explicit way out", async () => {
		const dir = await stateDir("{ truncated");
		const telemetry = await loaded(dir);
		expect(telemetry.state()).toMatchObject({ kind: "suspended", reason: "unreadable" });
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await telemetry.flush();
		expect(await readFile(telemetry.file, "utf8")).toBe("{ truncated");

		await telemetry.reset();
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await telemetry.flush();
		expect((await loaded(dir)).snapshot().orchestration.DEFAULT).toBe(1);
	});

	test("disabled telemetry never changes a file: nothing is created, and a pre-v5 file is only read", async () => {
		const empty = await stateDir();
		const fresh = await loaded(empty, false);
		fresh.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		fresh.appendDecision({ kind: "orchestration", route: "ERROR", timedOut: false });
		await fresh.flush();
		expect(fresh.snapshot().orchestration.requests).toBe(0);
		expect(await tree(empty)).toEqual([]);

		const dir = await stateDir(V4_TEXT);
		const telemetry = await loaded(dir, false);
		expect(telemetry.state()).toEqual({ kind: "deferred", version: 4, sha256: sha256(V4_TEXT) });
		expect(telemetry.snapshot().historical?.workers.task).toEqual(V4.workers.task);
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut: false });
		await telemetry.flush();
		expect(await readFile(telemetry.file, "utf8")).toBe(V4_TEXT);
		expect(await tree(dir)).toEqual(["telemetry.json"]);
	});

	test("enabling after a read-only load migrates before the first write", async () => {
		const dir = await stateDir(V4_TEXT);
		const telemetry = await loaded(dir, false);
		telemetry.setEnabled(true);
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await telemetry.flush();

		expect(telemetry.state()).toEqual({ kind: "active" });
		expect(await readFile(path.join(telemetry.historyDir, V4_BACKUP), "utf8")).toBe(V4_TEXT);
		const reloaded = (await loaded(dir)).snapshot();
		expect(reloaded.orchestration.DEFAULT).toBe(1);
		expect(reloaded.historical?.source.sha256).toBe(sha256(V4_TEXT));
	});
});

describe("decision log", () => {
	test("new rows carry policy and epoch beside the pre-gate label; earlier rows are never rewritten", async () => {
		const oldRow = JSON.stringify({ ts: 1, kind: "task", route: "TASK_HARD", top: "TASK_HARD", probabilities: { TASK_HARD: 0.7 }, confidence: 0.7, margin: 0.4, confident: true, latencyMs: 9, batchSize: 1 });
		const dir = await stateDir(V4_TEXT);
		await writeFile(path.join(dir, "decisions.jsonl"), `${oldRow}\n`);
		const telemetry = await loaded(dir);
		telemetry.appendDecision({
			kind: "orchestration",
			route: "DEFAULT",
			top: "ORCHESTRATE",
			probabilities: { ORCHESTRATE: 0.55, DEFAULT: 0.45 },
			confidence: 0.55,
			margin: 0.1,
			confident: false,
			latencyMs: 12,
		});
		await telemetry.flush();

		const lines = (await readFile(telemetry.decisionsFile, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(oldRow);
		expect(JSON.parse(lines[1]!)).toMatchObject({
			policy: DECISION_POLICY,
			epoch: telemetry.snapshot().epoch.id,
			kind: "orchestration",
			route: "DEFAULT",
			top: "ORCHESTRATE",
			probabilities: { ORCHESTRATE: 0.55 },
		});
	});
});

describe("reset", () => {
	test("removes exactly the plugin-owned telemetry files", async () => {
		const dir = await stateDir();
		await mkdir(path.join(dir, "telemetry-history"));
		const hash = "a".repeat(64);
		const owned = [
			"telemetry.json",
			"decisions.jsonl",
			"telemetry.json.4242-7.tmp",
			"telemetry.v6.json",
			path.join("telemetry-history", `v4-${hash}.json`),
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
		const dir = await stateDir(V4_TEXT);
		const telemetry = await loaded(dir);
		const before = telemetry.snapshot().epoch.id;
		const bus = new EventBus();
		trackWorkerUsage(bus, telemetry);
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut: true });
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "0-W", agent: "task", parentToolCallId: "call-1", status: "completed", index: 0 });
		const flushing = telemetry.flush();
		await telemetry.reset();
		await flushing;

		expect(await tree(dir)).toEqual([]);
		const snapshot = telemetry.snapshot();
		expect(snapshot.epoch.id).not.toBe(before);
		expect(snapshot.historical).toBeUndefined();
		expect(snapshot.orchestration.requests).toBe(0);
		expect(snapshot.workers).toEqual({});
		expect((await loaded(dir)).snapshot().historical).toBeUndefined();

		telemetry.recordOrchestration("ORCHESTRATE", 0.9, 0.8, 1);
		await telemetry.flush();
		const persisted = JSON.parse(await readFile(telemetry.file, "utf8"));
		expect(persisted).toMatchObject({ epoch: { id: snapshot.epoch.id }, orchestration: { requests: 1, ORCHESTRATE: 1 } });
		expect(persisted.historical).toBeUndefined();
	});

	test("a reset during a load in progress wins: nothing is migrated or restored afterwards", async () => {
		const dir = await stateDir(V4_TEXT);
		const telemetry = new Telemetry(dir);
		instances.push(telemetry);
		const loading = telemetry.load();
		await telemetry.reset();
		await loading;

		expect(telemetry.state()).toEqual({ kind: "active" });
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

describe("task worker usage from subagent frames", () => {
	const USAGE = { tokens: 500, cost: 0.25, durationMs: 800 };
	const NONE = {
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
	function progress(bus: EventBus, id: string, usage = USAGE, agent = "task") {
		bus.emit(SUBAGENT_PROGRESS_CHANNEL, { index: 0, agent, parentToolCallId: "call-1", task: "work", progress: { id, agent, ...usage } });
	}
	function lifecycle(bus: EventBus, id: string, status: string, agent = "task") {
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id, agent, parentToolCallId: "call-1", status, index: 0 });
	}
	async function tracked(...buses: EventBus[]): Promise<Telemetry> {
		const telemetry = await loaded(await stateDir());
		for (const bus of buses) trackWorkerUsage(bus, telemetry);
		return telemetry;
	}

	test("a worker reported on two buses is started, settled, and measured once", async () => {
		const main = new EventBus();
		const child = new EventBus();
		const telemetry = await tracked(main, child);
		for (const bus of [main, child]) {
			lifecycle(bus, "0-W", "started");
			progress(bus, "0-W", { tokens: 200, cost: 0.125, durationMs: 300 });
			progress(bus, "0-W");
			lifecycle(bus, "0-W", "completed");
		}

		expect(telemetry.snapshot().workers).toEqual({
			task: { ...NONE, startedObserved: 1, completed: 1, usageSamples: 1, usageSamplesCompleted: 1, tokens: 500, costUsd: 0.25, durationMs: 800 },
		});
	});

	test("a settlement without observed progress records the outcome and unknown usage, not zeros or a start", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		lifecycle(bus, "0-W", "failed");
		await telemetry.flush();

		const unknown = { ...NONE, failed: 1, usageUnknown: 1 };
		expect(telemetry.snapshot().workers.task).toEqual(unknown);
		expect((await loaded(path.dirname(telemetry.file))).snapshot().workers.task).toEqual(unknown);
	});

	test("measured usage arriving after a settlement-only report upgrades the unknown exactly once", async () => {
		const first = new EventBus();
		const second = new EventBus();
		const telemetry = await tracked(first, second);
		lifecycle(first, "0-W", "completed");
		progress(second, "0-W");
		lifecycle(second, "0-W", "completed");
		// Later duplicates change nothing, whatever they carry.
		lifecycle(first, "0-W", "completed");
		progress(first, "0-W", { tokens: 900, cost: 1, durationMs: 900 });
		lifecycle(first, "0-W", "completed");

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			completed: 1,
			usageSamples: 1,
			usageSamplesCompleted: 1,
			tokens: 500,
			costUsd: 0.25,
			durationMs: 800,
		});
	});

	test("OMP's aborted status stays aborted, and statuses OMP does not emit are ignored", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		progress(bus, "0-A", { tokens: 100, cost: 0.5, durationMs: 10 });
		lifecycle(bus, "0-A", "aborted");
		progress(bus, "1-F", { tokens: 50, cost: 0.25, durationMs: 5 });
		lifecycle(bus, "1-F", "failed");
		lifecycle(bus, "2-X", "cancelled");

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 2,
			aborted: 1,
			failed: 1,
			usageSamples: 2,
			tokens: 150,
			costUsd: 0.75,
			durationMs: 15,
		});
	});

	test("only generic task workers are counted, including eval agent() spawns without a parent tool call", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		for (const agent of ["scout", "task-challenge", "my-reviewer"]) {
			progress(bus, `0-${agent}`, USAGE, agent);
			lifecycle(bus, `0-${agent}`, "completed", agent);
		}
		// eval agent() spawns carry no parent tool call.
		bus.emit(SUBAGENT_PROGRESS_CHANNEL, { index: 0, agent: "task", task: "probe", progress: { id: "Probe", agent: "task", ...USAGE } });
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "Probe", agent: "task", status: "completed", index: 0 });

		expect(Object.keys(telemetry.snapshot().workers)).toEqual(["task"]);
		expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 1, completed: 1, usageSamples: 1, tokens: 500 });
	});

	test("live worker counts persist in their epoch and never mix with historical rows", async () => {
		const dir = await stateDir(V4_TEXT);
		const telemetry = await loaded(dir);
		const bus = new EventBus();
		trackWorkerUsage(bus, telemetry);
		lifecycle(bus, "0-W", "started");
		progress(bus, "0-W");
		lifecycle(bus, "0-W", "completed");
		await telemetry.flush();

		const reloaded = (await loaded(dir)).snapshot();
		expect(reloaded.workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			completed: 1,
			usageSamples: 1,
			usageSamplesCompleted: 1,
			tokens: 500,
			costUsd: 0.25,
			durationMs: 800,
		});
		expect(reloaded.historical?.workers.task).toEqual(V4.workers.task);
	});
});
