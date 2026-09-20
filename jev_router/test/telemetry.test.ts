import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bucketOf, reviveSnapshot, Telemetry } from "../src/telemetry.ts";
import { harvestTaskUsage } from "../src/usage-harvest.ts";

const roots: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "jev-telemetry-"));
	roots.push(dir);
	return dir;
}
afterAll(async () => {
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("telemetry aggregation", () => {
	test("counters and distributions survive a save/load cycle", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.recordOrchestration("DIRECT", 0.91, 0.82, 12);
		telemetry.recordOrchestration("UNCERTAIN", 0.54, 0.08, 20);
		telemetry.recordTaskBatch(9);
		telemetry.recordTaskDecision("TASK_DEEP", 0.6, 0.2, false);
		telemetry.recordFailure("task", true);
		telemetry.recordSpawn("task-deep");
		telemetry.recordWorkerUsage("task-deep", { input: 100, output: 50, costUsd: 0.25 }, 1500);
		await telemetry.flush();

		const reloaded = new Telemetry(dir);
		await reloaded.load();
		const snapshot = reloaded.snapshot();

		expect(snapshot.orchestration).toMatchObject({ requests: 2, DIRECT: 1, UNCERTAIN: 1, latencySumMs: 32 });
		expect(snapshot.orchestration.confidence[9]).toBe(1);
		expect(snapshot.orchestration.confidence[5]).toBe(1);
		expect(snapshot.task).toMatchObject({ batches: 1, TASK_DEEP: 1, fallbackDeep: 1, errors: 1, timeouts: 1 });
		expect(snapshot.workers["task-deep"]).toMatchObject({ spawns: 1, results: 1, output: 50, costUsd: 0.25 });
	});

	test("no prompt, task, or credential text is ever stored", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.recordOrchestration("ORCHESTRATE", 0.9, 0.8, 5);
		telemetry.recordWorkerUsage("task", { input: 1 }, 1);
		await telemetry.flush();

		const raw = await Bun.file(telemetry.file).text();
		// The only strings in the file are structural keys and agent names.
		for (const value of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
			expect(typeof value).not.toBe("string");
		}
		expect(raw).not.toContain("ts_");
	});

	test("reset clears memory and removes the file", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.recordOrchestration("DIRECT", 0.9, 0.8, 1);
		await telemetry.flush();

		await telemetry.reset();

		expect(telemetry.snapshot().orchestration.requests).toBe(0);
		expect(await Bun.file(telemetry.file).exists()).toBe(false);
	});

	test("a corrupt snapshot degrades to empty counters instead of throwing", () => {
		expect(reviveSnapshot("not an object").orchestration.requests).toBe(0);
		expect(reviveSnapshot({ orchestration: { requests: "x", DIRECT: 3 } }).orchestration).toMatchObject({
			requests: 0,
			DIRECT: 3,
		});
	});

	test("probabilities land in the expected histogram bucket", () => {
		expect(bucketOf(0)).toBe(0);
		expect(bucketOf(0.55)).toBe(5);
		expect(bucketOf(1)).toBe(9);
		expect(bucketOf(Number.NaN)).toBe(0);
	});

	test("disabled telemetry records nothing", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.setEnabled(false);
		telemetry.recordOrchestration("DIRECT", 0.9, 0.8, 1);
		await telemetry.flush();

		expect(telemetry.snapshot().orchestration.requests).toBe(0);
		expect(await Bun.file(telemetry.file).exists()).toBe(false);
	});

	test("every session in a process shares one writer, so counts are not lost", async () => {
		const dir = await tempDir();
		Telemetry.resetSharedForTests();
		// Each session builds its own extension runtime; they must not race the file.
		const main = Telemetry.shared(dir);
		const subagent = Telemetry.shared(dir);
		expect(subagent).toBe(main);

		main.recordTaskDecision("TASK_NORMAL", 0.9, 0.8, true);
		subagent.recordTaskDecision("TASK_DEEP", 0.9, 0.8, true);
		await subagent.flush();

		const persisted = reviveSnapshot(await Bun.file(main.file).json());
		expect(persisted.task).toMatchObject({ TASK_NORMAL: 1, TASK_DEEP: 1 });
		Telemetry.resetSharedForTests();
	});

	test("a second load does not discard counts recorded since the first", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		await telemetry.load();
		telemetry.recordOrchestration("DIRECT", 0.9, 0.8, 1);
		await telemetry.load();

		expect(telemetry.snapshot().orchestration.DIRECT).toBe(1);
	});
});

describe("task usage harvesting", () => {
	test("per-spawn usage is attributed to the tier agent that ran it", () => {
		const harvested = harvestTaskUsage({
			results: [
				{ agent: "task", durationMs: 1200, usage: { input: 10, output: 20, cost: { total: 0.01 } } },
				{ agent: "task-deep", durationMs: 3400, usage: { input: 30, output: 40, cost: { total: 0.9 } } },
			],
		});

		expect(harvested).toEqual([
			{ agent: "task", usage: { input: 10, output: 20, cacheRead: undefined, cacheWrite: undefined, costUsd: 0.01 }, durationMs: 1200 },
			{ agent: "task-deep", usage: { input: 30, output: 40, cacheRead: undefined, cacheWrite: undefined, costUsd: 0.9 }, durationMs: 3400 },
		]);
	});

	test("a background call with no settled results yields no samples", () => {
		expect(harvestTaskUsage({ results: [] })).toEqual([]);
		expect(harvestTaskUsage(undefined)).toEqual([]);
		expect(harvestTaskUsage({ results: "nope" })).toEqual([]);
	});
});
