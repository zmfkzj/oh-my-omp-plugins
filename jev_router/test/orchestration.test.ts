import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase, TodoStatus } from "@oh-my-pi/pi-tui/tools/todo";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { noticeInsertIndex, ORCHESTRATE_NOTICE_TYPE, OrchestrationRouter, turnHasNativeOrchestrateNotice } from "../src/orchestration.ts";
import type { ReviewCheckpoint } from "../src/orchestration.ts";
import { Telemetry } from "../src/telemetry.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain, ScriptedDecider } from "./harness.ts";
import type { FakeSessionOptions, ScriptedOrchestration, ScriptedReview } from "./harness.ts";
import type { JevRouterConfig } from "../src/config.ts";

const DEFAULT: ScriptedOrchestration = { top: "DEFAULT", confidence: 0.92, margin: 0.84, confident: true };
const ORCHESTRATE: ScriptedOrchestration = { top: "ORCHESTRATE", confidence: 0.92, margin: 0.84, confident: true };
const REQUIRED_REVIEW: ScriptedReview = { top: "REQUIRED", confidence: 0.9, margin: 0.8 };
const PROMPT = "Refactor the ingestion pipeline.";

interface ReviewCall {
	required: boolean;
	checkpoint: ReviewCheckpoint;
	reason: string;
	request: string;
}
function review(required: boolean, checkpoint: ReviewCheckpoint, reason: string, request = PROMPT): ReviewCall {
	return { required, checkpoint, reason, request };
}

function entry(message: AgentMessage): SessionEntry {
	return { type: "message", message, id: crypto.randomUUID(), parentId: null, timestamp: "2026-01-01" } as SessionEntry;
}
function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}
function notice(): AgentMessage {
	return { role: "custom", customType: ORCHESTRATE_NOTICE_TYPE, content: "native", display: false, attribution: "user" } as AgentMessage;
}
function toolCall(id: string, op = "init"): AgentMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "todo", arguments: { op } }] } as unknown as AgentMessage;
}
function toolResultMessage(id: string): AgentMessage {
	return { role: "toolResult", toolName: "todo", toolCallId: id, content: [], isError: false, timestamp: Date.now() };
}
function todoResult(phases: TodoPhase[], op = "init", id = "todo-1", isError = false): ToolResultEvent {
	return {
		type: "tool_result", toolName: "todo", toolCallId: id, input: { op },
		content: [{ type: "text", text: "Result summary must not reach Jev" }],
		isError, details: { op, phases },
	} as ToolResultEvent;
}
function plan(...tasks: string[]): TodoPhase[] {
	return [{ name: "Integration", tasks: tasks.map(content => ({ content, status: "pending" })) }];
}
function withStatus(phases: TodoPhase[], content: string, status: TodoStatus): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => (task.content === content ? { ...task, status } : task)),
	}));
}
function committedPlan(phases: TodoPhase[]): SessionEntry {
	return { type: "custom", customType: "user_todo_edit", data: { phases }, id: "plan", parentId: null, timestamp: "2026-01-01" } as SessionEntry;
}
function build(decider: ScriptedDecider, options: {
	session?: FakeSessionOptions;
	main?: boolean;
	apiKey?: string | undefined;
	config?: Partial<JevRouterConfig>;
	/** Runs after each recorded review decision; throwing stands in for a failed requirement store. */
	onReview?: (call: ReviewCall) => void;
} = {}) {
	const currentModel = options.session?.currentModel ?? fakeModel("p", "explicit-choice");
	const branch = options.session?.branch ?? [];
	const fake = makeSession({ currentModel, ...options.session, branch });
	if (options.main !== false) registerAsMain(fake.session);
	else clearRegistry();
	const telemetry = new Telemetry("/tmp/jev-router-test-state");
	telemetry.setEnabled(false);
	const reviews: ReviewCall[] = [];
	const router = new OrchestrationRouter({
		engine: decider, logger: new RouteLogger(makeApi().pi.logger), telemetry,
		credential: async () => ("apiKey" in options ? options.apiKey : "ts_test_key"),
		config: () => ({ ...normalizeConfig(undefined), ...options.config }),
		onReviewDecision: (_ctx, required, checkpoint, reason, request) => {
			const call = { required, checkpoint, reason, request };
			reviews.push(call);
			options.onReview?.(call);
		},
	});
	return { router, branch, currentModel, reviews, ...fake };
}
function customCount(messages: AgentMessage[] | undefined): number {
	return messages?.filter(message => message.role === "custom" && message.customType === ORCHESTRATE_NOTICE_TYPE).length ?? 0;
}

afterEach(clearRegistry);

describe("native orchestration placement", () => {
	test("detects only a current user's native prefix, not old history", () => {
		expect(turnHasNativeOrchestrateNotice([assistant("older"), notice(), user("new")])).toBe(true);
		expect(turnHasNativeOrchestrateNotice([notice(), user("older"), assistant("done"), user("new")])).toBe(false);
	});

	test("a promotion remains behind its originating todo result across later requests", () => {
		const messages = [assistant("previous"), user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1"),
			assistant("continuing"), toolCall("todo-2"),
			toolResultMessage("todo-2")];
		expect(noticeInsertIndex(messages, "todo-1")).toBe(4);
		expect(noticeInsertIndex(messages, "todo-2")).toBe(7);
		expect(noticeInsertIndex(messages, "todo-3")).toBe(-1);
		expect(noticeInsertIndex(messages)).toBe(1);
	});

	test("promotion never splits consecutive results from one assistant tool batch", () => {
		const messages = [user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1"),
			{ role: "toolResult", toolName: "read", toolCallId: "read-1", content: [], isError: false, timestamp: 0 } as AgentMessage,
			assistant("next request")];
		expect(noticeInsertIndex(messages, "todo-1")).toBe(4);
	});
});

describe("binary front-door routing", () => {
	test("DEFAULT, ORCHESTRATE and uncertain outcomes never touch the active model", async () => {
		for (const decision of [DEFAULT, ORCHESTRATE, { ...ORCHESTRATE, confident: false, confidence: 0.51, margin: 0.02 }]) {
			const decider = new ScriptedDecider(decision);
			const { router, ctx, modelCalls, currentModel } = build(decider);
			await router.beginTurn(ctx, PROMPT);
			const applied = await router.applyToContext(ctx, [user(PROMPT)]);
			const outcome = decision.confident ? decision.top : "DEFAULT";
			expect(router.lastDecision).toMatchObject({ outcome, confidence: decision.confidence, margin: decision.margin });
			expect(router.lastDecision).not.toHaveProperty("model");
			expect(ctx.model).toEqual(currentModel);
			expect(modelCalls).toEqual([]);
			expect(customCount(applied)).toBe(outcome === "ORCHESTRATE" ? 1 : 0);
			router.endTurn();
			expect(ctx.model).toEqual(currentModel);
		}
	});

	test("review is decided independently of the route; only ORCHESTRATE adds guidance", async () => {
		const cases: [ScriptedOrchestration, ReviewCall, number][] = [
			[DEFAULT, review(false, "initial-plan", "review-optional"), 0],
			[{ ...DEFAULT, review: REQUIRED_REVIEW }, review(true, "initial-plan", "review-required"), 0],
			[{ ...DEFAULT, review: { top: "OPTIONAL", confidence: 0.55, margin: 0.1 } }, review(true, "initial-plan", "review-uncertain"), 0],
			[{ ...DEFAULT, review: null }, review(true, "initial-plan", "review-missing"), 0],
			[{ ...ORCHESTRATE, confident: false, confidence: 0.51, margin: 0.02 }, review(false, "initial-plan", "review-optional"), 0],
			[ORCHESTRATE, review(true, "initial-plan", "orchestrate"), 1],
		];
		for (const [decision, expected, notices] of cases) {
			const { router, ctx, reviews, modelCalls, currentModel } = build(new ScriptedDecider(decision));
			await router.beginTurn(ctx, PROMPT);
			expect(reviews).toEqual([expected]);
			expect(router.lastDecision?.reviewRequired).toBe(expected.required);
			expect(customCount(await router.applyToContext(ctx, [user(PROMPT)]))).toBe(notices);
			expect(modelCalls).toEqual([]);
			expect(ctx.model).toEqual(currentModel);
		}
	});

	test("explicit native orchestrate wins; a replay cannot duplicate any notice", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const native = [notice(), user(PROMPT)];
		expect(await router.applyToContext(ctx, native)).toBeUndefined();
		const injected = await router.applyToContext(ctx, [user(PROMPT)]);
		expect(customCount(injected)).toBe(1);
		expect(await router.applyToContext(ctx, injected!)).toBeUndefined();
	});

	test("explicit native orchestrate requires an initial-plan review once, even over a direct route", async () => {
		const { router, ctx, reviews } = build(new ScriptedDecider(DEFAULT));
		await router.beginTurn(ctx, PROMPT);
		for (let request = 0; request < 2; request++) {
			expect(await router.applyToContext(ctx, [notice(), user(PROMPT)])).toBeUndefined();
		}
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional"), review(true, "initial-plan", "explicit-orchestrate")]);
	});

	test("an initial decision keeps its pre-user anchor after todo activity", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const messages = [user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1")];
		const applied = await router.applyToContext(ctx, messages);
		expect(applied?.[0]).toMatchObject({ role: "custom", customType: ORCHESTRATE_NOTICE_TYPE });
	});

	test("same-turn retries reuse the route and its review requirement; settlement clears provider guidance", async () => {
		const decider = new ScriptedDecider(ORCHESTRATE);
		const { router, ctx, reviews } = build(decider);
		await router.beginTurn(ctx, PROMPT);
		await router.beginTurn(ctx, PROMPT);
		expect(decider.orchestrationCalls).toBe(1);
		expect(reviews).toEqual([review(true, "initial-plan", "orchestrate")]);
		router.endTurn();
		expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
	});

	test("subagents, plan mode, a disabled router and synthetic prompts neither classify nor report review", async () => {
		for (const options of [{ main: false }, { session: { planMode: true } }, { config: { enabled: false } }]) {
			const decider = new ScriptedDecider(ORCHESTRATE);
			const { router, ctx, reviews } = build(decider, options);
			await router.beginTurn(ctx, PROMPT);
			expect(decider.orchestrationCalls).toBe(0);
			expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
			expect(reviews).toEqual([]);
		}
		for (const prompt of ["/compact", "<system-notice>continue</system-notice>", "   "]) {
			const decider = new ScriptedDecider(ORCHESTRATE);
			const { router, ctx, reviews } = build(decider);
			await router.beginTurn(ctx, prompt);
			expect(decider.orchestrationCalls).toBe(0);
			expect(reviews).toEqual([]);
		}
	});

	test("unavailable orchestration still assesses review for inline work but never adds guidance", async () => {
		for (const options of [
			{ session: { enabledTools: ["read"] } }, { session: { orchestrateKeyword: false } },
			{ config: { orchestrationRoutingEnabled: false } },
		]) {
			for (const [decision, expected] of [
				[{ ...ORCHESTRATE, review: REQUIRED_REVIEW }, review(true, "initial-plan", "review-required")],
				[ORCHESTRATE, review(false, "initial-plan", "review-optional")],
			] as const) {
				const decider = new ScriptedDecider(decision);
				const { router, ctx, reviews, modelCalls } = build(decider, options);
				await router.beginTurn(ctx, PROMPT);
				expect(decider.orchestrationCalls).toBe(1);
				expect(router.lastDecision?.outcome).toBe("DEFAULT");
				expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
				expect(reviews).toEqual([expected]);
				expect(modelCalls).toEqual([]);
			}
		}
	});

	test("a missing credential or failed classification requires review without touching the model", async () => {
		for (const [decision, options, outcome, reason] of [
			[ORCHESTRATE, { apiKey: undefined }, "SKIP", "credential-missing"],
			[new Error("HTTP 503"), {}, "ERROR", "classification-error"],
			[new Error("Request timeout after 4000ms"), {}, "ERROR", "classification-timeout"],
		] as const) {
			const { router, ctx, modelCalls, currentModel, reviews } = build(new ScriptedDecider(decision), options);
			await router.beginTurn(ctx, PROMPT);
			expect(router.lastDecision?.outcome).toBe(outcome);
			expect(ctx.model).toEqual(currentModel);
			expect(modelCalls).toEqual([]);
			expect(reviews).toEqual([review(true, "initial-plan", reason)]);
			expect(router.lastDecision?.reviewRequired).toBe(true);
			expect(customCount(await router.applyToContext(ctx, [user(PROMPT)]))).toBe(0);
		}
	});
});

describe("committed todo promotion", () => {
	test("init promotes only once and places native notice after the todo result", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, modelCalls, reviews } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
		const phases = plan("Refactor parser", "Rewrite isolated billing module");
		await Promise.all([router.onTodoResult(ctx, todoResult(phases)), router.onTodoResult(ctx, todoResult(phases))]);
		expect(decider.orchestrationCalls).toBe(2);
		expect(decider.lastContext?.plan).toContain("Rewrite isolated billing module");
		expect(router.lastDecision?.outcome).toBe("ORCHESTRATE");
		expect(await router.applyToContext(ctx, [user(PROMPT), toolCall("todo-1")])).toBeUndefined();
		const messages = [user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1")];
		const applied = await router.applyToContext(ctx, messages);
		expect(applied?.[3]).toMatchObject({ role: "custom", customType: ORCHESTRATE_NOTICE_TYPE });
		expect(customCount(applied)).toBe(1);
		expect(await router.applyToContext(ctx, applied!)).toBeUndefined();
		expect(modelCalls).toEqual([]);
		await router.onTodoResult(ctx, todoResult(phases));
		expect(decider.orchestrationCalls).toBe(2);
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional"), review(true, "initial-plan", "orchestrate")]);
	});

	test("promoted guidance stays at its originating result after another todo call", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const { router, ctx } = build(new ScriptedDecider([DEFAULT, ORCHESTRATE]), { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		const messages = [user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1"),
			toolCall("todo-2", "view"),
			toolResultMessage("todo-2")];
		const applied = await router.applyToContext(ctx, messages);
		expect(applied?.[3]).toMatchObject({ role: "custom", customType: ORCHESTRATE_NOTICE_TYPE });
	});

	test("a live master switch stops todo reclassification and review renewal", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const config = { enabled: true };
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, reviews } = build(decider, { session: { branch }, config });
		await router.beginTurn(ctx, PROMPT);
		config.enabled = false;
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		expect(decider.orchestrationCalls).toBe(1);
		expect(router.lastDecision?.outcome).toBe("DEFAULT");
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional")]);
	});

	test("disabling orchestration mid-turn withholds promotion but still reassesses a changed plan's review", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const config = { orchestrationRoutingEnabled: true };
		const decider = new ScriptedDecider([DEFAULT, { ...ORCHESTRATE, review: REQUIRED_REVIEW }]);
		const { router, ctx, reviews } = build(decider, { session: { branch }, config });
		await router.beginTurn(ctx, PROMPT);
		config.orchestrationRoutingEnabled = false;
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		expect(decider.orchestrationCalls).toBe(2);
		expect(router.lastDecision).toMatchObject({ outcome: "DEFAULT", reason: "orchestration-routing-disabled", reviewRequired: true });
		const messages = [user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
		expect(await router.applyToContext(ctx, messages)).toBeUndefined();
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional"), review(true, "initial-plan", "review-required")]);
	});

	test("once orchestrated, a changed plan renews required review without another Jev request", async () => {
		for (const explicit of [false, true]) {
			const branch = [entry(user(PROMPT)), entry(toolCall("todo-1")), entry(toolCall("todo-2", "append"))];
			const decider = new ScriptedDecider(explicit ? DEFAULT : ORCHESTRATE);
			const { router, ctx, reviews } = build(decider, { session: { branch } });
			await router.beginTurn(ctx, PROMPT);
			if (explicit) await router.applyToContext(ctx, [notice(), user(PROMPT)]);
			reviews.length = 0;
			const initial = plan("Split parser service", "Split billing service");
			await router.onTodoResult(ctx, todoResult(initial));
			await router.onTodoResult(ctx, todoResult(initial));
			const expanded: TodoPhase[] = [...initial, { name: "Docs", tasks: [{ content: "Document both services", status: "pending" }] }];
			await router.onTodoResult(ctx, todoResult(expanded, "append", "todo-2"));
			const reason = explicit ? "explicit-orchestrate" : "orchestrate";
			expect(reviews).toEqual([review(true, "initial-plan", reason), review(true, "scope-expansion", reason)]);
			expect(decider.orchestrationCalls).toBe(1);
		}
	});

	test("a changed plan in a direct turn is reclassified; a required or failed assessment requires review while staying direct", async () => {
		for (const [reclassified, reason] of [
			[{ ...DEFAULT, review: REQUIRED_REVIEW }, "review-required"],
			[new Error("HTTP 503"), "classification-error"],
		] as const) {
			const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
			const decider = new ScriptedDecider([DEFAULT, reclassified]);
			const { router, ctx, reviews } = build(decider, { session: { branch } });
			await router.beginTurn(ctx, PROMPT);
			await router.onTodoResult(ctx, todoResult(plan("Backfill invoice totals", "Switch billing reads to the new column")));
			expect(decider.orchestrationCalls).toBe(2);
			expect(reviews).toEqual([review(false, "initial-plan", "review-optional"), review(true, "initial-plan", reason)]);
			const messages = [user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
			expect(await router.applyToContext(ctx, messages)).toBeUndefined();
		}
	});

	test("append can promote an initially direct plan; unchanged plans do not reclassify and orchestrated turns renew review directly", async () => {
		const initial = plan("Review parser");
		const branch = [entry(user(PROMPT)), committedPlan(initial), entry(toolCall("todo-2", "append"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, reviews } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		await router.onTodoResult(ctx, todoResult(initial, "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(1);
		await router.onTodoResult(ctx, todoResult(plan("Review parser", "Independent billing migration"), "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(2);
		await router.onTodoResult(ctx, todoResult(plan("Review parser", "Yet another task"), "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(2);
		const expansion = review(true, "scope-expansion", "orchestrate");
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional"), expansion, expansion]);
	});

	test("a finished phase requires phase-boundary review once the turn requires review, not on every done", async () => {
		const start: TodoPhase[] = [
			{ name: "Build", tasks: [
				{ content: "Parser", status: "completed" },
				{ content: "Billing", status: "in_progress" },
				{ content: "Cache", status: "pending" },
			] },
			{ name: "Verify", tasks: [{ content: "Run suite", status: "pending" }] },
		];
		const billingDone = withStatus(start, "Billing", "completed");
		const cacheDropped = withStatus(billingDone, "Cache", "abandoned");
		const suiteDone = withStatus(cacheDropped, "Run suite", "completed");
		for (const [route, required] of [
			[ORCHESTRATE, true], [{ ...DEFAULT, review: REQUIRED_REVIEW }, true], [DEFAULT, false],
		] as const) {
			const branch = [entry(user(PROMPT)), committedPlan(start),
				entry(toolCall("todo-3", "done")), entry(toolCall("todo-4", "drop")), entry(toolCall("todo-5", "done"))];
			const decider = new ScriptedDecider(route);
			const { router, ctx, reviews } = build(decider, { session: { branch } });
			await router.beginTurn(ctx, PROMPT);
			reviews.length = 0;
			await router.onTodoResult(ctx, todoResult(billingDone, "done", "todo-3"));
			expect(reviews).toEqual([]);
			await router.onTodoResult(ctx, todoResult(cacheDropped, "drop", "todo-4"));
			await router.onTodoResult(ctx, todoResult(cacheDropped, "drop", "todo-4"));
			await router.onTodoResult(ctx, todoResult(suiteDone, "done", "todo-5"));
			const boundary = review(true, "phase-boundary", "phase-completed");
			expect(reviews).toEqual(required ? [boundary, boundary] : []);
			expect(decider.orchestrationCalls).toBe(1);
		}
	});

	test("a failing review handler fails its hook while the requirement still governs the turn", async () => {
		const start: TodoPhase[] = [{ name: "Build", tasks: [{ content: "Parser", status: "in_progress" }] }];
		const branch = [entry(user(PROMPT)), committedPlan(start), entry(toolCall("todo-3", "done"))];
		const { router, ctx, reviews } = build(new ScriptedDecider({ ...DEFAULT, review: REQUIRED_REVIEW }), {
			session: { branch },
			onReview: call => {
				if (call.checkpoint === "initial-plan") throw new Error("requirement store unavailable");
			},
		});
		await expect(router.beginTurn(ctx, PROMPT)).rejects.toThrow("requirement store unavailable");
		await router.onTodoResult(ctx, todoResult(withStatus(start, "Parser", "completed"), "done", "todo-3"));
		expect(reviews).toEqual([review(true, "initial-plan", "review-required"), review(true, "phase-boundary", "phase-completed")]);
	});

	test("failed, view, status-only, malformed and unrelated results cannot promote", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, reviews } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		const phases = plan("Parse service", "Rewrite other service");
		for (const event of [
			todoResult(phases, "init", "todo-1", true), todoResult(phases, "view"),
			todoResult(phases, "done"), todoResult(phases, "start"),
			{ ...todoResult(phases), details: { op: "init", phases: [{ name: "broken", tasks: [{ content: 3 }] }] } },
			{ ...todoResult(phases), details: undefined },
			{ ...todoResult(phases), toolCallId: "old-turn-id" },
			{ ...todoResult(phases), toolName: "read" },
		]) await router.onTodoResult(ctx, event as ToolResultEvent);
		expect(decider.orchestrationCalls).toBe(1);
		expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional")]);
	});

	test("a late result after turn settlement or a different user request cannot promote", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, DEFAULT, ORCHESTRATE]);
		const { router, ctx, reviews } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		router.endTurn();
		await router.onTodoResult(ctx, todoResult(plan("Separate services")));
		branch.push(entry(user("Fix one typo.")));
		await router.beginTurn(ctx, "Fix one typo.");
		await router.onTodoResult(ctx, todoResult(plan("Separate services")));
		expect(decider.orchestrationCalls).toBe(2);
		expect(router.lastDecision?.outcome).toBe("DEFAULT");
		expect(reviews).toEqual([
			review(false, "initial-plan", "review-optional"),
			review(false, "initial-plan", "review-optional", "Fix one typo."),
		]);
	});
});
