import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { bucketOf, reviveSnapshot, Telemetry } from "../src/telemetry.ts";
import { SUBAGENT_LIFECYCLE_CHANNEL, SUBAGENT_PROGRESS_CHANNEL, trackWorkerUsage } from "../src/worker-usage.ts";

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
		telemetry.recordOrchestration("DEFAULT", 0.91, 0.82, 12);
		telemetry.recordOrchestration("ORCHESTRATE", 0.88, 0.7, 14);
		telemetry.recordOrchestration("DEFAULT", 0.54, 0.08, 20);
		telemetry.recordTaskBatch(9);
		telemetry.recordTaskDecision("TASK_CHALLENGE", 0.6, 0.2, false);
		telemetry.recordFailure("task", true);
		telemetry.recordSpawn("task-challenge");
		telemetry.recordWorkerSettled("call:a", "task-challenge", { tokens: 150, costUsd: 0.25, durationMs: 1500, completed: true });
		await telemetry.flush();

		const reloaded = new Telemetry(dir);
		await reloaded.load();
		const snapshot = reloaded.snapshot();

		expect(snapshot.orchestration).toMatchObject({ requests: 3, DEFAULT: 2, ORCHESTRATE: 1, latencySumMs: 46 });
		expect(snapshot.orchestration.confidence[9]).toBe(1);
		expect(snapshot.orchestration.confidence[5]).toBe(1);
		expect(snapshot.task).toMatchObject({ batches: 1, TASK_CHALLENGE: 1, fallbackChallenge: 1, errors: 1, timeouts: 1 });
		expect(snapshot.workers["task-challenge"]).toMatchObject({ spawns: 1, results: 1, completed: 1, tokens: 150, costUsd: 0.25 });
	});

	test("no prompt, task, or credential text is ever stored", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.recordOrchestration("ORCHESTRATE", 0.9, 0.8, 5);
		telemetry.recordWorkerSettled("call:a", "task", { tokens: 1, costUsd: 0, durationMs: 1, completed: true });
		await telemetry.flush();

		const raw = await Bun.file(telemetry.file).text();
		// The only strings in the file are structural keys and agent names.
		for (const value of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
			expect(typeof value).not.toBe("string");
		}
		expect(raw).not.toContain("ts_");
	});

	test("reset clears memory and removes both files", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		telemetry.appendDecision({ kind: "task", route: "ERROR", timedOut: false });
		await telemetry.flush();

		await telemetry.reset();

		expect(telemetry.snapshot().orchestration.requests).toBe(0);
		expect(await Bun.file(telemetry.file).exists()).toBe(false);
		expect(await Bun.file(telemetry.decisionsFile).exists()).toBe(false);
	});

	test("v1 DIRECT counts are migrated so route counters still sum to requests", async () => {
		const dir = await tempDir();
		const v1 = { version: 1, orchestration: { requests: 5, DIRECT: 3, ORCHESTRATE: 1, UNCERTAIN: 1 } };
		await Bun.write(path.join(dir, "telemetry.json"), JSON.stringify(v1));
		const telemetry = new Telemetry(dir);
		await telemetry.load();

		expect(telemetry.snapshot().orchestration).toMatchObject({ requests: 5, legacyDecisions: 4, ORCHESTRATE: 1 });
	});

	test("v2 split token fields fold into tokens, excluding cacheRead", async () => {
		const dir = await tempDir();
		const v2 = {
			version: 2,
			workers: { "task-deep": { spawns: 2, results: 1, input: 100, output: 40, cacheRead: 999, cacheWrite: 10, costUsd: 0.5 } },
		};
		await Bun.write(path.join(dir, "telemetry.json"), JSON.stringify(v2));
		const telemetry = new Telemetry(dir);
		await telemetry.load();

		expect(telemetry.snapshot().workers["task-deep"]).toMatchObject({ spawns: 2, results: 1, tokens: 150, costUsd: 0.5 });
	});

	test("retired tier labels remain historical and migration is idempotent", () => {
		const migrated = reviveSnapshot({
			version: 3,
			orchestration: { requests: 7, DEFAULT: 2, SLOW: 3, UNCERTAIN: 2 },
			task: { TASK_NORMAL: 29, TASK_DEEP: 34, fallbackDeep: 21 },
		});
		expect(migrated.orchestration).toMatchObject({ DEFAULT: 2, legacyDecisions: 5 });
		expect(migrated.task).toMatchObject({ TASK_EASY: 0, TASK_HARD: 0, TASK_CHALLENGE: 0, legacyDecisions: 63, legacyFallbacks: 21 });
		expect(reviveSnapshot(migrated)).toEqual(migrated);
	});

	test("a snapshot from a newer plugin version is set aside, not overwritten", async () => {
		const dir = await tempDir();
		const future = JSON.stringify({ version: 99, orchestration: { requests: 5 } });
		await Bun.write(path.join(dir, "telemetry.json"), future);
		const telemetry = new Telemetry(dir);
		await telemetry.load();
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await telemetry.flush();

		expect(await Bun.file(path.join(dir, "telemetry.v99.json")).text()).toBe(future);
		expect(telemetry.snapshot().orchestration.requests).toBe(1);
	});

	test("the decision log keeps the pre-gate label so another gate can be replayed", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		telemetry.appendDecision({
			kind: "task",
			route: "TASK_CHALLENGE",
			top: "TASK_HARD",
			probabilities: { TASK_HARD: 0.7, TASK_CHALLENGE: 0.2, TASK_EASY: 0.1 },
			confidence: 0.7,
			margin: 0.4,
			confident: false,
			latencyMs: 12,
			batchSize: 1,
		});
		await telemetry.flush();

		const lines = (await Bun.file(telemetry.decisionsFile).text()).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toMatchObject({ route: "TASK_CHALLENGE", top: "TASK_HARD", probabilities: { TASK_HARD: 0.7 } });
	});

	test("a corrupt snapshot degrades to empty counters instead of throwing", () => {
		expect(reviveSnapshot("not an object").orchestration.requests).toBe(0);
		expect(reviveSnapshot({ orchestration: { requests: "x", DIRECT: 3 } }).orchestration).toMatchObject({
			requests: 0,
			DEFAULT: 0,
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
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
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

		main.recordTaskDecision("TASK_EASY", 0.9, 0.8, true);
		subagent.recordTaskDecision("TASK_CHALLENGE", 0.9, 0.8, true);
		await subagent.flush();

		const persisted = reviveSnapshot(await Bun.file(main.file).json());
		expect(persisted.task).toMatchObject({ TASK_EASY: 1, TASK_CHALLENGE: 1 });
		Telemetry.resetSharedForTests();
	});

	test("a second load does not discard counts recorded since the first", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		await telemetry.load();
		telemetry.recordOrchestration("DEFAULT", 0.9, 0.8, 1);
		await telemetry.load();

		expect(telemetry.snapshot().orchestration.DEFAULT).toBe(1);
	});
});

describe("worker usage from subagent frames", () => {
	const progress = (bus: EventBus, agent: string, cost: number) =>
		bus.emit(SUBAGENT_PROGRESS_CHANNEL, {
			parentToolCallId: "call-1",
			progress: { id: "0-W", agent, tokens: 500, cost, durationMs: 800 },
		});

	test("a settled background spawn records its final usage once, even when seen on two buses", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		const tiers = new Set(["task", "task-challenge"]);
		const main = new EventBus();
		const child = new EventBus();
		trackWorkerUsage(main, telemetry, tiers);
		trackWorkerUsage(child, telemetry, tiers);

		for (const bus of [main, child]) {
			progress(bus, "task-challenge", 0.1);
			progress(bus, "task-challenge", 0.4);
			bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "0-W", agent: "task-challenge", parentToolCallId: "call-1", status: "completed" });
		}

		expect(telemetry.snapshot().workers["task-challenge"]).toMatchObject({
			results: 1,
			completed: 1,
			tokens: 500,
			costUsd: 0.4,
			durationMs: 800,
		});
	});

	test("non-tier agents, non-terminal frames, and spawns without usage are ignored; failures settle uncompleted", async () => {
		const dir = await tempDir();
		const telemetry = new Telemetry(dir);
		const bus = new EventBus();
		trackWorkerUsage(bus, telemetry, new Set(["task"]));

		progress(bus, "scout", 1);
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "0-W", agent: "scout", parentToolCallId: "call-1", status: "completed" });
		progress(bus, "task", 0.2);
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "0-W", agent: "task", parentToolCallId: "call-1", status: "started" });
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "0-W", agent: "task", parentToolCallId: "call-1", status: "failed" });
		bus.emit(SUBAGENT_LIFECYCLE_CHANNEL, { id: "1-X", agent: "task", parentToolCallId: "call-1", status: "completed" });

		const workers = telemetry.snapshot().workers;
		expect(workers.scout).toBeUndefined();
		expect(workers.task).toMatchObject({ results: 1, completed: 0, costUsd: 0.2 });
	});
});
