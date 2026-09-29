import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Telemetry } from "../src/telemetry.ts";
import { trackWorkerUsage } from "../src/worker-usage.ts";
import { FOLLOW_UP_ASYNC, FOLLOW_UP_SYNC, ONE_TURN_ASYNC, replay } from "./recorded-frames.ts";
import {
	firstRun,
	type FrameOwner,
	type FrameUsage,
	NO_TOOL_CALL,
	NOTHING_YET,
	progress,
	settled,
	started,
	TASK_TOOL,
	turn,
} from "./worker-frames.ts";

const roots: string[] = [];
const instances: Telemetry[] = [];
afterAll(async () => {
	// Settle debounced writes before their directories disappear.
	await Promise.all(instances.map(telemetry => telemetry.flush()));
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

/** The scope of buses that carry one session's frames: a frame reaching several of them counts once. */
const ONE_SESSION = { scope: "session" };

/** A loaded telemetry over a fresh temp state directory, following the frames of `buses`, all of one session. */
async function tracked(...buses: EventBus[]): Promise<Telemetry> {
	const dir = await mkdtemp(path.join(tmpdir(), "om-orche-worker-usage-"));
	roots.push(dir);
	const telemetry = new Telemetry(dir);
	instances.push(telemetry);
	await telemetry.load();
	for (const bus of buses) trackWorkerUsage(bus, telemetry, ONE_SESSION);
	return telemetry;
}

const NONE = {
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
const FIRST = { tokens: 500, cost: 0.25, durationMs: 800 };
/** A follow-up turn restarts from zero, so its final usage sits below the first turn's. */
const SECOND = { tokens: 300, cost: 0.125, durationMs: 400 };
const ONE_COMPLETED_TURN = {
	...NONE,
	startedObserved: 1,
	completed: 1,
	usageSamples: 1,
	usageSamplesCompleted: 1,
	tokens: 500,
	costUsd: 0.25,
	durationMs: 800,
};
/** What FIRST then SECOND, both completed, add up to. */
const TWO_COMPLETED_TURNS = {
	...NONE,
	startedObserved: 1,
	followUpTurns: 1,
	completed: 2,
	usageSamples: 2,
	usageSamplesCompleted: 2,
	tokens: 800,
	costUsd: 0.375,
	durationMs: 1200,
};

type TurnEmitter = (
	buses: readonly EventBus[],
	id: string,
	final: FrameUsage,
	options?: { owner?: FrameOwner; status?: string },
) => void;

/** The two ways a worker's first turn opens: the host's usual order, and `started` first (a label given up front, as eval `agent()` sets). */
const FIRST_TURNS: Record<string, TurnEmitter> = {
	"progress before started": firstRun,
	"started first": turn,
};

describe("frames recorded from the real host", () => {
	const recordings = [
		{
			name: "S1: one worker, one turn (async)",
			frames: ONE_TURN_ASYNC,
			expected: { ...NONE, startedObserved: 1, completed: 1, usageSamples: 1, usageSamplesCompleted: 1, tokens: 3203, durationMs: 100 },
		},
		{
			name: "S2: a worker and one follow-up turn (async)",
			frames: FOLLOW_UP_ASYNC,
			expected: { ...NONE, startedObserved: 1, followUpTurns: 1, completed: 2, usageSamples: 2, usageSamplesCompleted: 2, tokens: 3203 + 3315, durationMs: 122 + 10 },
		},
		{
			name: "S2: a worker and one follow-up turn (sync)",
			frames: FOLLOW_UP_SYNC,
			expected: { ...NONE, startedObserved: 1, followUpTurns: 1, completed: 2, usageSamples: 2, usageSamplesCompleted: 2, tokens: 3205 + 3317, durationMs: 66 + 11 },
		},
	];
	const deliveries: Record<string, (main: EventBus, child: EventBus, frames: (typeof recordings)[number]["frames"]) => void> = {
		"one bus": (main, _child, frames) => replay([main], frames),
		"two subscriptions, one payload per frame": (main, child, frames) => replay([main, child], frames),
		"the whole recording repeated on a second bus afterwards": (main, child, frames) => {
			replay([main], frames);
			replay([child], frames);
		},
	};
	for (const { name, frames, expected } of recordings) {
		for (const [delivery, deliver] of Object.entries(deliveries)) {
			test(`${name} counts as recorded — ${delivery}`, async () => {
				const main = new EventBus();
				const child = new EventBus();
				const telemetry = await tracked(main, child);
				deliver(main, child, frames);

				expect(telemetry.snapshot().workers.task).toEqual(expected);
			});
		}
	}
});

describe("the turns of one worker", () => {
	for (const [order, open] of Object.entries(FIRST_TURNS)) {
		test(`a first turn is one worker and no follow-up, however it opens: ${order}`, async () => {
			const bus = new EventBus();
			const telemetry = await tracked(bus);
			open([bus], "0-W", FIRST);

			expect(telemetry.snapshot().workers.task).toEqual(ONE_COMPLETED_TURN);
		});

		test(`a task-tool worker's follow-up turn settles and is measured on its own, without a new worker: ${order}`, async () => {
			const bus = new EventBus();
			const telemetry = await tracked(bus);
			open([bus], "0-W", FIRST);
			turn([bus], "0-W", SECOND);

			expect(telemetry.snapshot().workers.task).toEqual(TWO_COMPLETED_TURNS);
		});

		test(`a worker without a tool call id — eval agent() or workpool — keeps its key across turns: ${order}`, async () => {
			const bus = new EventBus();
			const telemetry = await tracked(bus);
			open([bus], "0-Pool", FIRST, { owner: NO_TOOL_CALL });
			turn([bus], "0-Pool", SECOND, { owner: NO_TOOL_CALL });

			expect(telemetry.snapshot().workers.task).toEqual(TWO_COMPLETED_TURNS);
		});
	}

	test("a worker continued twice is one worker and two follow-up turns", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		firstRun([bus], "0-W", FIRST);
		turn([bus], "0-W", SECOND);
		turn([bus], "0-W", SECOND);

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			followUpTurns: 2,
			completed: 3,
			usageSamples: 3,
			usageSamplesCompleted: 3,
			tokens: 1100,
			costUsd: 0.5,
			durationMs: 1600,
		});
	});

	test("an absent tool call id is no follow-up marker: workers are told apart by id", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		firstRun([bus], "0-A", FIRST, { owner: NO_TOOL_CALL });
		firstRun([bus], "1-B", SECOND, { owner: NO_TOOL_CALL });

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 2,
			completed: 2,
			usageSamples: 2,
			usageSamplesCompleted: 2,
			tokens: 800,
			costUsd: 0.375,
			durationMs: 1200,
		});
	});

	test("every turn keeps its own outcome; cost per completed counts only completed turns", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		firstRun([bus], "0-W", FIRST, { status: "failed" });
		turn([bus], "0-W", SECOND, { status: "completed" });

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			followUpTurns: 1,
			completed: 1,
			failed: 1,
			usageSamples: 2,
			usageSamplesCompleted: 1,
			tokens: 800,
			costUsd: 0.375,
			durationMs: 1200,
		});
	});

	test("a follow-up turn without progress adds an unknown usage, never zeros, and keeps the earlier sample", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		firstRun([bus], "0-W", FIRST);
		turn([bus], "0-W", undefined);

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			followUpTurns: 1,
			completed: 2,
			usageSamples: 1,
			usageSamplesCompleted: 1,
			usageUnknown: 1,
			tokens: 500,
			costUsd: 0.25,
			durationMs: 800,
		});
	});

	test("a turn that never settles is not counted, and its usage does not leak into the next turn", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		// The host emits no terminal frame when finalizing a turn throws.
		progress([bus], "0-W", NOTHING_YET);
		started([bus], "0-W");
		progress([bus], "0-W", { tokens: 900, cost: 0.9, durationMs: 900 });
		turn([bus], "0-W", SECOND);

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			followUpTurns: 1,
			completed: 1,
			usageSamples: 1,
			usageSamplesCompleted: 1,
			tokens: 300,
			costUsd: 0.125,
			durationMs: 400,
		});
	});

	test("progress before a start that never came does not claim the next turn's start once its turn has settled", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		// Cancelled before the session started: early progress, then the terminal frame, no `started`.
		progress([bus], "0-W", NOTHING_YET);
		settled([bus], "0-W", "aborted");
		turn([bus], "0-W", SECOND);

		expect(telemetry.snapshot().workers.task).toEqual({
			...NONE,
			startedObserved: 1,
			followUpTurns: 1,
			aborted: 1,
			completed: 1,
			usageSamples: 2,
			usageSamplesCompleted: 1,
			tokens: 300,
			costUsd: 0.125,
			durationMs: NOTHING_YET.durationMs + SECOND.durationMs,
		});
	});

	test("a reset while a worker runs leaves its next turn a follow-up, not a swallowed repeat", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		progress([bus], "0-W", NOTHING_YET);
		started([bus], "0-W");
		progress([bus], "0-W", { tokens: 250, cost: 0.125, durationMs: 400 });
		await telemetry.reset();
		progress([bus], "0-W", FIRST);
		settled([bus], "0-W", "completed");
		turn([bus], "0-W", SECOND);

		expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 1, followUpTurns: 1, completed: 2 });
	});
});

describe("the same frames reaching telemetry from more than one bus", () => {
	const deliveries: Record<string, (open: TurnEmitter, main: EventBus, child: EventBus) => void> = {
		"one payload delivered to both subscriptions": (open, main, child) => {
			open([main, child], "0-W", FIRST);
			turn([main, child], "0-W", SECOND);
		},
		"the whole history repeated on the second bus after the first delivered it": (open, main, child) => {
			for (const bus of [main, child]) {
				open([bus], "0-W", FIRST);
				turn([bus], "0-W", SECOND);
			}
		},
		"each turn delivered on one bus, then rebuilt on the other": (open, main, child) => {
			open([main], "0-W", FIRST);
			open([child], "0-W", FIRST);
			turn([main], "0-W", SECOND);
			turn([child], "0-W", SECOND);
		},
	};
	for (const [order, open] of Object.entries(FIRST_TURNS)) {
		for (const [name, deliver] of Object.entries(deliveries)) {
			test(`count once: ${name}; first turn opens with ${order}`, async () => {
				const main = new EventBus();
				const child = new EventBus();
				const telemetry = await tracked(main, child);
				deliver(open, main, child);

				expect(telemetry.snapshot().workers.task).toEqual(TWO_COMPLETED_TURNS);
			});
		}

		test(`a bus that lags a whole turn behind cannot disturb the turn in progress: ${order}`, async () => {
			const main = new EventBus();
			const child = new EventBus();
			const telemetry = await tracked(main, child);
			open([main], "0-W", FIRST);
			started([main], "0-W");
			progress([main], "0-W", NOTHING_YET);
			progress([main], "0-W", { tokens: 150, cost: 0.0625, durationMs: 200 });
			// The second bus delivers the first turn only now, while the second one runs.
			open([child], "0-W", FIRST);
			progress([main], "0-W", SECOND);
			settled([main], "0-W", "completed");

			expect(telemetry.snapshot().workers.task).toEqual(TWO_COMPLETED_TURNS);
		});
	}

	test("a bus that joins mid-turn is placed in the turn in progress, and carries the next turn alone once the first is gone", async () => {
		const main = new EventBus();
		const late = new EventBus();
		const telemetry = await tracked();
		const stopMain = trackWorkerUsage(main, telemetry, ONE_SESSION);
		firstRun([main], "0-W", FIRST);
		started([main], "0-W");
		progress([main], "0-W", NOTHING_YET);
		progress([main], "0-W", { tokens: 150, cost: 0.0625, durationMs: 200 });

		trackWorkerUsage(late, telemetry, ONE_SESSION);
		progress([main, late], "0-W", SECOND);
		// An older frame arriving late never lowers what was seen.
		progress([late], "0-W", { tokens: 150, cost: 0.0625, durationMs: 200 });
		settled([main, late], "0-W", "completed");
		expect(telemetry.snapshot().workers.task).toEqual(TWO_COMPLETED_TURNS);

		stopMain();
		turn([late], "0-W", SECOND);
		expect(telemetry.snapshot().workers.task).toMatchObject({
			startedObserved: 1,
			followUpTurns: 2,
			completed: 3,
			usageSamples: 3,
			tokens: 1100,
			costUsd: 0.5,
		});
	});

	test("measured usage arriving after a settlement-only report upgrades the unknown exactly once", async () => {
		const first = new EventBus();
		const second = new EventBus();
		const telemetry = await tracked(first, second);
		settled([first], "0-W", "completed");
		progress([second], "0-W", FIRST);
		settled([second], "0-W", "completed");
		// Later repeats — no `started` opens no new turn — change nothing, whatever they carry.
		settled([first], "0-W", "completed");
		progress([first], "0-W", { tokens: 900, cost: 1, durationMs: 900 });
		settled([first], "0-W", "completed");

		expect(telemetry.snapshot().workers.task).toEqual(ONE_COMPLETED_TURN);
	});
});

describe("workers of different sessions in one process", () => {
	// A session's bus carries only its own workers' frames, and the host allocates worker ids per session.
	const owners: Record<string, FrameOwner> = {
		"eval agent() or workpool, which carry no tool call id": NO_TOOL_CALL,
		"the task tool, whose tool call ids two sessions can repeat": TASK_TOOL,
	};
	for (const [kind, owner] of Object.entries(owners)) {
		test(`two sessions that allocate the same worker id run two workers: ${kind}`, async () => {
			const first = new EventBus();
			const second = new EventBus();
			const telemetry = await tracked();
			trackWorkerUsage(first, telemetry);
			trackWorkerUsage(second, telemetry);
			firstRun([first], "0-W", FIRST, { owner });
			firstRun([second], "0-W", SECOND, { owner });

			expect(telemetry.snapshot().workers.task).toEqual({
				...NONE,
				startedObserved: 2,
				completed: 2,
				usageSamples: 2,
				usageSamplesCompleted: 2,
				tokens: 800,
				costUsd: 0.375,
				durationMs: 1200,
			});
		});

		test(`each session's worker keeps its own follow-up turns: ${kind}`, async () => {
			const first = new EventBus();
			const second = new EventBus();
			const telemetry = await tracked();
			trackWorkerUsage(first, telemetry);
			trackWorkerUsage(second, telemetry);
			firstRun([first], "0-W", FIRST, { owner });
			firstRun([second], "0-W", FIRST, { owner });
			turn([first], "0-W", SECOND, { owner });
			turn([second], "0-W", SECOND, { owner });

			expect(telemetry.snapshot().workers.task).toEqual({
				...NONE,
				startedObserved: 2,
				followUpTurns: 2,
				completed: 4,
				usageSamples: 4,
				usageSamplesCompleted: 4,
				tokens: 1600,
				costUsd: 0.75,
				durationMs: 2400,
			});
		});
	}

	test("subscriptions on one bus are one session: a frame that reaches both counts once", async () => {
		const bus = new EventBus();
		const telemetry = await tracked();
		trackWorkerUsage(bus, telemetry);
		trackWorkerUsage(bus, telemetry);
		firstRun([bus], "0-W", FIRST);
		turn([bus], "0-W", SECOND);

		expect(telemetry.snapshot().workers.task).toEqual(TWO_COMPLETED_TURNS);
	});

	test("a tool call id and a worker id that only read alike once joined name different workers", async () => {
		const bus = new EventBus();
		const telemetry = await tracked();
		trackWorkerUsage(bus, telemetry);
		firstRun([bus], "c", FIRST, { owner: { agent: "task", parentToolCallId: "a:b" } });
		firstRun([bus], "b:c", SECOND, { owner: { agent: "task", parentToolCallId: "a" } });

		expect(telemetry.snapshot().workers.task).toMatchObject({ startedObserved: 2, followUpTurns: 0, completed: 2, tokens: 800 });
	});
});

describe("what counts as a task worker frame", () => {
	test("a settlement without observed progress records the outcome and unknown usage, not zeros or a start", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		settled([bus], "0-W", "failed");
		await telemetry.flush();

		const unknown = { ...NONE, failed: 1, usageUnknown: 1 };
		expect(telemetry.snapshot().workers.task).toEqual(unknown);
		const reloaded = new Telemetry(path.dirname(telemetry.file));
		instances.push(reloaded);
		await reloaded.load();
		expect(reloaded.snapshot().workers.task).toEqual(unknown);
	});

	test("OMP's aborted status stays aborted, and statuses OMP does not emit are ignored", async () => {
		const bus = new EventBus();
		const telemetry = await tracked(bus);
		progress([bus], "0-A", { tokens: 100, cost: 0.5, durationMs: 10 });
		settled([bus], "0-A", "aborted");
		progress([bus], "1-F", { tokens: 50, cost: 0.25, durationMs: 5 });
		settled([bus], "1-F", "failed");
		settled([bus], "2-X", "cancelled");

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
			firstRun([bus], `0-${agent}`, FIRST, { owner: { agent, parentToolCallId: "call-1" } });
		}
		// A worker OMP revives from disk after a restart reports its own id as the agent name.
		turn([bus], "0-Revived", SECOND, { owner: { agent: "0-Revived" } });
		firstRun([bus], "Probe", FIRST, { owner: NO_TOOL_CALL });

		expect(Object.keys(telemetry.snapshot().workers)).toEqual(["task"]);
		expect(telemetry.snapshot().workers.task).toEqual(ONE_COMPLETED_TURN);
	});
});
