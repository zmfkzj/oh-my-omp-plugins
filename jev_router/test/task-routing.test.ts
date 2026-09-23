import { describe, expect, test } from "bun:test";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { normalizeCall, routableItems, TaskRouter } from "../src/task-routing.ts";
import { Telemetry } from "../src/telemetry.ts";
import { makeApi, ScriptedDecider } from "./harness.ts";
import type { JevRouterConfig } from "../src/config.ts";
import type { TaskRoute } from "../src/jev.ts";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";

function build(
	tiers: Record<string, { top: TaskRoute; confidence: number; margin: number }> | Error,
	options: { agents?: string[]; config?: Partial<JevRouterConfig>; bundled?: boolean; apiKey?: string | undefined } = {},
) {
	const decider = new ScriptedDecider({ top: "DEFAULT", confidence: 1, margin: 1, confident: true }, tiers);
	const { pi } = makeApi(options.agents);
	const telemetry = new Telemetry("/tmp/jev-router-test-state");
	telemetry.setEnabled(false);
	const config = { ...normalizeConfig(undefined), ...options.config };
	const router = new TaskRouter({
		engine: decider,
		logger: new RouteLogger(pi.logger),
		telemetry,
		credential: async () => ("apiKey" in options ? options.apiKey : "ts_test_key"),
		config: () => config,
		genericTaskIsBundled: () => options.bundled ?? true,
	});
	return { router, pi, decider };
}

/** The rewritten tool input, asserting the router actually produced one. */
function revised(result: ToolCallEventResult | undefined): Record<string, unknown> {
	const input = result?.input;
	if (!input) throw new Error("expected the router to revise this call");
	return input;
}

function revisedAgents(result: ToolCallEventResult | undefined): unknown[] {
	return (revised(result).tasks as { agent: string }[]).map(item => item.agent);
}

/** Shapes here mirror post-validation task input: `agent` is always populated. */
function batch(...items: Record<string, unknown>[]): Record<string, unknown> {
	return { context: "Shared background.", tasks: items };
}

describe("task input normalization", () => {
	test("batch and flat shapes both yield their item list", () => {
		expect(normalizeCall(batch({ agent: "task", task: "a" }))).toMatchObject({ batch: true, items: [{ task: "a" }] });
		expect(normalizeCall({ agent: "task", task: "a" })).toMatchObject({ batch: false });
		expect(normalizeCall({ nonsense: true })).toBeUndefined();
	});

	test("only the validated generic worker is routable", () => {
		const items = [
			{ agent: "task", task: "implement" },
			{ agent: "sonic", task: "mechanical" },
			{ agent: "scout", task: "survey" },
			{ agent: "reviewer", task: "review" },
			{ agent: "security-reviewer", task: "audit" },
			{ agent: "my-custom-agent", task: "custom" },
			{ agent: "m1", task: "tagged model" },
			{ task: "no agent field at all" },
			{ agent: "task", task: "   " },
		];
		expect(routableItems(items).map(item => item.index)).toEqual([0]);
	});
});

describe("TASK tier routing", () => {
	test("a well-specified implementation stays on @task and rewrites nothing", async () => {
		const { router, pi, decider } = build({ t0: { top: "TASK_NORMAL", confidence: 0.88, margin: 0.76 } });

		const result = await router.route(pi, "call-1", batch({ agent: "task", task: "Add a --json flag." }));

		expect(result).toBeUndefined();
		expect(decider.taskCalls).toBe(1);
		expect(router.lastDecision?.route).toBe("TASK_NORMAL");
	});

	test("a deep-reasoning subtask is rerouted to the task-deep alias", async () => {
		const { router, pi } = build({ t0: { top: "TASK_DEEP", confidence: 0.86, margin: 0.72 } });

		const result = await router.route(pi, "call-2", batch({ agent: "task", task: "Find the race condition." }));

		expect(revised(result)).toMatchObject({
			context: "Shared background.",
			tasks: [{ agent: "task-deep", task: "Find the race condition." }],
		});
	});

	test("every non-routing field survives the rewrite", async () => {
		const { router, pi } = build({ t0: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } });
		const item = {
			name: "Prober",
			agent: "task",
			task: "Reason about the migration.",
			effort: "hi",
			isolated: true,
			tools: ["probe"],
			outputSchema: { type: "object" },
			schemaMode: "strict",
		};

		const result = await router.route(pi, "call-3", batch(item));

		expect((revised(result).tasks as Record<string, unknown>[])[0]).toEqual({
			...item,
			agent: "task-deep",
		});
	});

	test("a mixed batch is classified in a single Jev request", async () => {
		const { router, pi, decider } = build({
			t0: { top: "TASK_NORMAL", confidence: 0.9, margin: 0.8 },
			t1: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 },
			t2: { top: "TASK_NORMAL", confidence: 0.9, margin: 0.8 },
		});

		const result = await router.route(
			pi,
			"call-4",
			batch(
				{ agent: "task", task: "A: implement the adapter." },
				{ agent: "task", task: "B: decide the consistency model." },
				{ agent: "task", task: "C: add the CRUD endpoints." },
			),
		);

		expect(decider.taskCalls).toBe(1);
		expect(revisedAgents(result)).toEqual([
			"task",
			"task-deep",
			"task",
		]);
	});

	test("specialized and custom agents in a batch are never rewritten", async () => {
		const { router, pi, decider } = build({ t1: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } });

		const result = await router.route(
			pi,
			"call-5",
			batch(
				{ agent: "sonic", task: "Mechanical edit." },
				{ agent: "task", task: "Root-cause the failure." },
				{ agent: "my-custom-agent", task: "Domain work." },
			),
		);

		expect(revisedAgents(result)).toEqual(["sonic", "task-deep", "my-custom-agent"]);
		// Only the generic item was ever shown to Jev.
		expect(decider.lastSubtasks.map(subtask => subtask.id)).toEqual(["t1"]);
	});

	test("a call with no generic item never reaches Jev", async () => {
		const { router, pi, decider } = build({});

		expect(await router.route(pi, "call-6", batch({ agent: "sonic", task: "Mechanical." }))).toBeUndefined();
		expect(decider.taskCalls).toBe(0);
	});

	test("a low-confidence tier decision fails quality-safe to the deep tier", async () => {
		const { router, pi } = build({ t0: { top: "TASK_NORMAL", confidence: 0.6, margin: 0.2 } });

		const result = await router.route(pi, "call-7", batch({ agent: "task", task: "Ambiguous work." }));

		expect(revisedAgents(result)[0]).toBe("task-deep");
		expect(router.lastDecision?.confident).toBe(false);
	});

	test("a Jev failure routes the whole call to the deep tier", async () => {
		const { router, pi } = build(new Error("HTTP 429 rate limited"));

		const result = await router.route(
			pi,
			"call-8",
			batch({ agent: "task", task: "One." }, { agent: "task", task: "Two." }),
		);

		expect(revisedAgents(result)).toEqual([
			"task-deep",
			"task-deep",
		]);
	});

	test("a missing credential routes to the deep tier without calling Jev", async () => {
		const { router, pi, decider } = build({}, { apiKey: undefined });

		const result = await router.route(pi, "call-9", batch({ agent: "task", task: "Work." }));

		expect(revisedAgents(result)[0]).toBe("task-deep");
		expect(decider.taskCalls).toBe(0);
	});

	test("the same tool call is classified once even if the event fires twice", async () => {
		const { router, pi, decider } = build({ t0: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } });
		const input = batch({ agent: "task", task: "Reason about it." });

		const first = await router.route(pi, "call-10", input);
		const second = await router.route(pi, "call-10", input);

		expect(decider.taskCalls).toBe(1);
		expect(second).toBe(first);
	});

	test("an unspawnable task-deep alias leaves the call native", async () => {
		const { router, pi, decider } = build({ t0: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } }, {
			agents: ["task", "scout"],
		});

		expect(await router.route(pi, "call-11", batch({ agent: "task", task: "Work." }))).toBeUndefined();
		expect(decider.taskCalls).toBe(0);
	});

	test("a shadowed generic `task` agent disables tier routing", async () => {
		const { router, pi, decider } = build({ t0: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } }, {
			bundled: false,
		});

		expect(await router.route(pi, "call-12", batch({ agent: "task", task: "Work." }))).toBeUndefined();
		expect(decider.taskCalls).toBe(0);
	});

	test("routing can be switched off without touching OMP", async () => {
		const { router, pi, decider } = build({ t0: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } }, {
			config: { taskRoutingEnabled: false },
		});

		expect(await router.route(pi, "call-13", batch({ agent: "task", task: "Work." }))).toBeUndefined();
		expect(decider.taskCalls).toBe(0);
	});

	test("the flat (non-batch) shape is routed too", async () => {
		const { router, pi } = build({ t0: { top: "TASK_DEEP", confidence: 0.9, margin: 0.8 } });

		const result = await router.route(pi, "call-14", { agent: "task", task: "Reason hard.", name: "Solo" });

		expect(revised(result)).toEqual({ agent: "task-deep", task: "Reason hard.", name: "Solo" });
	});
});
