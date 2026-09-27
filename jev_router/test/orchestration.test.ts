import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase, TodoStatus } from "@oh-my-pi/pi-tui/tools/todo";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { noticeInsertIndex, OrchestrationRouter } from "../src/orchestration.ts";
import {
	currentTurnNotices,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	policyModeOf,
	type PolicyMode,
} from "../src/orchestration-policy.ts";
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
function notice(timestamp = 1): AgentMessage {
	return { role: "custom", customType: NATIVE_ORCHESTRATE_NOTICE_TYPE, content: "native", display: false, attribution: "user", timestamp } as AgentMessage;
}
function workflowNotice(timestamp = 1): AgentMessage {
	return { role: "custom", customType: NATIVE_WORKFLOW_NOTICE_TYPE, content: "workflow", display: false, attribution: "user", timestamp } as AgentMessage;
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
	onReview?: (call: ReviewCall) => boolean | void;
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
			return options.onReview?.(call);
		},
	});
	return { router, branch, currentModel, reviews, ...fake };
}
/** Plugin policy notices in order, by mode. */
function modes(messages: AgentMessage[] | undefined): PolicyMode[] {
	return messages?.flatMap(message => policyModeOf(message) ?? []) ?? [];
}
function customCount(messages: AgentMessage[] | undefined, customType: string): number {
	return messages?.filter(message => message.role === "custom" && message.customType === customType).length ?? 0;
}

afterEach(clearRegistry);

describe("policy notice placement", () => {
	test("detects only a current user's native prefix, not old history", () => {
		expect(currentTurnNotices([assistant("older"), notice(), user("new")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([1]);
		expect(currentTurnNotices([notice(), user("older"), assistant("done"), user("new")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
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
			expect(modes(applied)).toEqual([outcome === "ORCHESTRATE" ? "orchestrate" : "default"]);
			router.endTurn();
			expect(ctx.model).toEqual(currentModel);
		}
	});

	test("review is decided independently of the route; only ORCHESTRATE switches the policy", async () => {
		const cases: [ScriptedOrchestration, ReviewCall, PolicyMode][] = [
			[DEFAULT, review(false, "initial-plan", "review-optional"), "default"],
			[{ ...DEFAULT, review: REQUIRED_REVIEW }, review(true, "initial-plan", "review-required"), "default"],
			[{ ...DEFAULT, review: { top: "OPTIONAL", confidence: 0.55, margin: 0.1 } }, review(true, "initial-plan", "review-uncertain"), "default"],
			[{ ...DEFAULT, review: null }, review(true, "initial-plan", "review-missing"), "default"],
			[{ ...ORCHESTRATE, confident: false, confidence: 0.51, margin: 0.02 }, review(false, "initial-plan", "review-optional"), "default"],
			[ORCHESTRATE, review(true, "initial-plan", "orchestrate"), "orchestrate"],
		];
		for (const [decision, expected, mode] of cases) {
			const { router, ctx, reviews, modelCalls, currentModel } = build(new ScriptedDecider(decision));
			await router.beginTurn(ctx, PROMPT);
			expect(reviews).toEqual([expected]);
			expect(router.lastDecision?.reviewRequired).toBe(expected.required);
			expect(modes(await router.applyToContext(ctx, [user(PROMPT)]))).toEqual([mode]);
			expect(modelCalls).toEqual([]);
			expect(ctx.model).toEqual(currentModel);
		}
	});

	test("explicit native orchestrate is replaced in place; a replay cannot duplicate any notice", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const replaced = await router.applyToContext(ctx, [notice(), user(PROMPT)]);
		expect(modes(replaced)).toEqual(["orchestrate"]);
		expect(policyModeOf(replaced?.[0])).toBe("orchestrate");
		expect(customCount(replaced, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(await router.applyToContext(ctx, replaced!)).toBeUndefined();
		// Once seen, the explicit route governs even a request whose native notice was compacted away.
		const injected = await router.applyToContext(ctx, [user(PROMPT)]);
		expect(modes(injected)).toEqual(["orchestrate"]);
		expect(await router.applyToContext(ctx, injected!)).toBeUndefined();
	});

	test("explicit native orchestrate requires an initial-plan review once, even over a direct route", async () => {
		const { router, ctx, reviews } = build(new ScriptedDecider(DEFAULT));
		await router.beginTurn(ctx, PROMPT);
		for (let request = 0; request < 2; request++) {
			expect(modes(await router.applyToContext(ctx, [notice(), user(PROMPT)]))).toEqual(["orchestrate"]);
		}
		expect(reviews).toEqual([review(false, "initial-plan", "review-optional"), review(true, "initial-plan", "explicit-orchestrate")]);
	});

	test("an initial decision keeps its pre-user anchor after todo activity", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const messages = [user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1")];
		const applied = await router.applyToContext(ctx, messages);
		expect(policyModeOf(applied?.[0])).toBe("orchestrate");
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

	test("unavailable automatic orchestration still assesses review and keeps the default policy", async () => {
		for (const [options, mode] of [
			[{ session: { enabledTools: ["read"] } }, undefined],
			[{ config: { orchestrationRoutingEnabled: false } }, "default"],
		] as const) {
			for (const [decision, expected] of [
				[{ ...ORCHESTRATE, review: REQUIRED_REVIEW }, review(true, "initial-plan", "review-required")],
				[ORCHESTRATE, review(false, "initial-plan", "review-optional")],
			] as const) {
				const decider = new ScriptedDecider(decision);
				const { router, ctx, reviews, modelCalls } = build(decider, options);
				await router.beginTurn(ctx, PROMPT);
				expect(decider.orchestrationCalls).toBe(1);
				expect(router.lastDecision?.outcome).toBe("DEFAULT");
				const applied = await router.applyToContext(ctx, [user(PROMPT)]);
				// Without `task`, no delegation guidance is advertised at all.
				if (mode) expect(modes(applied)).toEqual([mode]);
				else expect(applied).toBeUndefined();
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
			expect(modes(await router.applyToContext(ctx, [user(PROMPT)]))).toEqual(["default"]);
		}
	});
});

describe("policy precedence", () => {
	test("OMP's keyword setting never gates automatic routing; routing off still honors an explicit request", async () => {
		const keywordOff = build(new ScriptedDecider(ORCHESTRATE), { session: { orchestrateKeyword: false, magicKeywords: false } });
		await keywordOff.router.beginTurn(keywordOff.ctx, PROMPT);
		expect(keywordOff.router.lastDecision?.outcome).toBe("ORCHESTRATE");
		expect(modes(await keywordOff.router.applyToContext(keywordOff.ctx, [user(PROMPT)]))).toEqual(["orchestrate"]);

		const routingOff = build(new ScriptedDecider(ORCHESTRATE), { config: { orchestrationRoutingEnabled: false } });
		await routingOff.router.beginTurn(routingOff.ctx, PROMPT);
		expect(routingOff.router.lastDecision?.outcome).toBe("DEFAULT");
		const explicit = await routingOff.router.applyToContext(routingOff.ctx, [notice(), user(PROMPT)]);
		expect(modes(explicit)).toEqual(["orchestrate"]);
		expect(customCount(explicit, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(routingOff.reviews.at(-1)).toEqual(review(true, "initial-plan", "explicit-orchestrate"));
	});

	test("a workflow notice keeps its execution method; one auxiliary policy notice joins it", async () => {
		for (const [route, explicit] of [[DEFAULT, false], [ORCHESTRATE, false], [DEFAULT, true], [ORCHESTRATE, true]] as const) {
			const { router, ctx, reviews } = build(new ScriptedDecider(route));
			await router.beginTurn(ctx, PROMPT);
			const workflow = workflowNotice(5);
			const messages = [assistant("previous"), ...(explicit ? [notice(5)] : []), workflow, user(PROMPT)];
			const applied = await router.applyToContext(ctx, messages);
			expect(modes(applied)).toEqual(["workflow"]);
			expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
			expect(applied?.filter(message => message === workflow)).toHaveLength(1);
			// A replaced explicit notice keeps its slot; otherwise the supplement precedes the user.
			expect(policyModeOf(applied?.[explicit ? 1 : 2])).toBe("workflow");
			expect(await router.applyToContext(ctx, applied!)).toBeUndefined();
			// Guidance precedence never relaxes review.
			expect(reviews.some(call => call.required)).toBe(route === ORCHESTRATE || explicit);
		}
	});

	test("promotion inside a workflow turn keeps the single supplement before the user", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const { router, ctx, reviews } = build(new ScriptedDecider([DEFAULT, ORCHESTRATE]), { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		const messages = [workflowNotice(), user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
		const before = await router.applyToContext(ctx, messages);
		expect(modes(before)).toEqual(["workflow"]);
		await router.onTodoResult(ctx, todoResult(plan("Split parser service", "Split billing service")));
		expect(router.lastDecision?.outcome).toBe("ORCHESTRATE");
		expect(await router.applyToContext(ctx, messages)).toEqual(before!);
		expect(reviews.at(-1)).toEqual(review(true, "initial-plan", "orchestrate"));
	});

	test("only the live turn's notice is replaced; history and shared objects are never mutated", async () => {
		const { router, ctx } = build(new ScriptedDecider(DEFAULT));
		await router.beginTurn(ctx, PROMPT);
		const historical = notice(1);
		const messages = [historical, user("Earlier request"), assistant("done"), notice(2), user(PROMPT)]
			.map(message => Object.freeze(message));
		const snapshot = structuredClone(messages);
		const applied = await router.applyToContext(ctx, Object.freeze([...messages]) as AgentMessage[]);
		expect(messages).toEqual(snapshot);
		expect(applied?.[0]).toBe(historical);
		expect(policyModeOf(applied?.[3])).toBe("orchestrate");
		expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
		// A later user message in the same turn cannot re-expose the replaced notice, and the
		// replacement keeps its content and timestamp.
		const steered = await router.applyToContext(ctx, [...messages, assistant("working"), user("Also cover the CLI.")]);
		expect(steered?.[3]).toEqual(applied![3]!);
		expect(customCount(steered, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
		expect(modes(steered)).toEqual(["orchestrate"]);
	});
});

describe("committed todo promotion", () => {
	test("init promotes only once and its policy replaces the default notice behind the todo result", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, modelCalls, reviews } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		const messages = [user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
		const direct = await router.applyToContext(ctx, messages);
		expect(modes(direct)).toEqual(["default"]);
		expect(policyModeOf(direct?.[0])).toBe("default");
		const phases = plan("Refactor parser", "Rewrite isolated billing module");
		await Promise.all([router.onTodoResult(ctx, todoResult(phases)), router.onTodoResult(ctx, todoResult(phases))]);
		expect(decider.orchestrationCalls).toBe(2);
		expect(decider.lastContext?.plan).toContain("Rewrite isolated billing module");
		expect(router.lastDecision?.outcome).toBe("ORCHESTRATE");
		// The promotion waits for its own todo result to reach provider context.
		expect(await router.applyToContext(ctx, [user(PROMPT), toolCall("todo-1")])).toBeUndefined();
		const applied = await router.applyToContext(ctx, messages);
		expect(policyModeOf(applied?.[3])).toBe("orchestrate");
		expect(modes(applied)).toEqual(["orchestrate"]);
		// A context that still carries this turn's default notice keeps only the promoted policy.
		expect(await router.applyToContext(ctx, direct!)).toEqual(applied!);
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
		expect(policyModeOf(applied?.[3])).toBe("orchestrate");
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
		// A disabled router leaves OMP's own guidance exactly as it is.
		expect(await router.applyToContext(ctx, [notice(), user(PROMPT)])).toBeUndefined();
		expect(reviews).toHaveLength(1);
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
		expect(modes(await router.applyToContext(ctx, messages))).toEqual(["default"]);
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
			expect(modes(await router.applyToContext(ctx, messages))).toEqual(["default"]);
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

	test("a continuation inherits its task's phase-review obligation even when new risk is optional", async () => {
		const start = plan("Finish accepted implementation");
		const branch = [entry(user(PROMPT)), committedPlan(start), entry(toolCall("finish", "done"))];
		const { router, ctx, reviews } = build(new ScriptedDecider(DEFAULT), {
			session: { branch }, onReview: () => true,
		});
		await router.beginTurn(ctx, PROMPT);
		await router.onTodoResult(ctx, todoResult(withStatus(start, "Finish accepted implementation", "completed"), "done", "finish"));
		expect(reviews).toEqual([
			review(false, "initial-plan", "review-optional"),
			review(true, "phase-boundary", "phase-completed"),
		]);
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
		expect(modes(await router.applyToContext(ctx, [user(PROMPT)]))).toEqual(["default"]);
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
