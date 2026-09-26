import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { noticeInsertIndex, ORCHESTRATE_NOTICE_TYPE, OrchestrationRouter, turnHasNativeOrchestrateNotice } from "../src/orchestration.ts";
import { Telemetry } from "../src/telemetry.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain, ScriptedDecider } from "./harness.ts";
import type { FakeSessionOptions, ScriptedOrchestration } from "./harness.ts";
import type { JevRouterConfig } from "../src/config.ts";

const DEFAULT: ScriptedOrchestration = { top: "DEFAULT", confidence: 0.92, margin: 0.84, confident: true };
const ORCHESTRATE: ScriptedOrchestration = { top: "ORCHESTRATE", confidence: 0.92, margin: 0.84, confident: true };
const PROMPT = "Refactor the ingestion pipeline.";

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
function build(decider: ScriptedDecider, options: {
	session?: FakeSessionOptions;
	main?: boolean;
	apiKey?: string | undefined;
	config?: Partial<JevRouterConfig>;
} = {}) {
	const currentModel = options.session?.currentModel ?? fakeModel("p", "explicit-choice");
	const branch = options.session?.branch ?? [];
	const fake = makeSession({ currentModel, ...options.session, branch });
	if (options.main !== false) registerAsMain(fake.session);
	else clearRegistry();
	const telemetry = new Telemetry("/tmp/jev-router-test-state");
	telemetry.setEnabled(false);
	const router = new OrchestrationRouter({
		engine: decider, logger: new RouteLogger(makeApi().pi.logger), telemetry,
		credential: async () => ("apiKey" in options ? options.apiKey : "ts_test_key"),
		config: () => ({ ...normalizeConfig(undefined), ...options.config }),
	});
	return { router, branch, currentModel, ...fake };
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

	test("explicit native orchestrate wins; a replay cannot duplicate any notice", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const native = [notice(), user(PROMPT)];
		expect(await router.applyToContext(ctx, native)).toBeUndefined();
		const injected = await router.applyToContext(ctx, [user(PROMPT)]);
		expect(customCount(injected)).toBe(1);
		expect(await router.applyToContext(ctx, injected!)).toBeUndefined();
	});

	test("an initial decision keeps its pre-user anchor after todo activity", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const messages = [user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1")];
		const applied = await router.applyToContext(ctx, messages);
		expect(applied?.[0]).toMatchObject({ role: "custom", customType: ORCHESTRATE_NOTICE_TYPE });
	});

	test("same-turn retries reuse the route; settlement clears provider guidance", async () => {
		const decider = new ScriptedDecider(ORCHESTRATE);
		const { router, ctx } = build(decider);
		await router.beginTurn(ctx, PROMPT);
		await router.beginTurn(ctx, PROMPT);
		expect(decider.orchestrationCalls).toBe(1);
		router.endTurn();
		expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
	});

	test("subagents, plan mode, unavailable orchestration and synthetic prompts do not classify", async () => {
		for (const options of [
			{ main: false }, { session: { planMode: true } },
			{ session: { enabledTools: ["read"] } }, { session: { orchestrateKeyword: false } },
			{ config: { orchestrationRoutingEnabled: false } }, { config: { enabled: false } },
		]) {
			const decider = new ScriptedDecider(ORCHESTRATE);
			const { router, ctx } = build(decider, options);
			await router.beginTurn(ctx, PROMPT);
			expect(decider.orchestrationCalls).toBe(0);
			expect(await router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
		}
		for (const prompt of ["/compact", "<system-notice>continue</system-notice>", "   "]) {
			const decider = new ScriptedDecider(ORCHESTRATE);
			const { router, ctx } = build(decider);
			await router.beginTurn(ctx, prompt);
			expect(decider.orchestrationCalls).toBe(0);
		}
	});

	test("missing credential or decision error never alters the model", async () => {
		for (const [decision, options, outcome] of [
			[ORCHESTRATE, { apiKey: undefined }, "SKIP"],
			[new Error("HTTP 503"), {}, "ERROR"],
		] as const) {
			const { router, ctx, modelCalls, currentModel } = build(new ScriptedDecider(decision), options);
			await router.beginTurn(ctx, PROMPT);
			expect(router.lastDecision?.outcome).toBe(outcome);
			expect(ctx.model).toEqual(currentModel);
			expect(modelCalls).toEqual([]);
		}
	});
});

describe("committed todo promotion", () => {
	test("init promotes only once and places native notice after the todo result", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, modelCalls } = build(decider, { session: { branch } });
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

	test("explicit native guidance and a disabled live gate prevent todo reclassification", async () => {
		for (const disable of [false, true]) {
			const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
			const config = { orchestrationRoutingEnabled: true };
			const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
			const { router, ctx } = build(decider, { session: { branch }, config });
			await router.beginTurn(ctx, PROMPT);
			if (disable) config.orchestrationRoutingEnabled = false;
			else expect(await router.applyToContext(ctx, [notice(), user(PROMPT)])).toBeUndefined();
			await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
			expect(decider.orchestrationCalls).toBe(1);
			expect(router.lastDecision?.outcome).toBe("DEFAULT");
		}
	});

	test("append can promote an initially direct plan; unchanged plans and already-orchestrated turns do not reclassify", async () => {
		const initial = plan("Review parser");
		const branch = [entry(user(PROMPT)),
			{ type: "custom", customType: "user_todo_edit", data: { phases: initial }, id: "plan", parentId: null, timestamp: "2026-01-01" } as SessionEntry,
			entry(toolCall("todo-2", "append"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		await router.onTodoResult(ctx, todoResult(initial, "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(1);
		await router.onTodoResult(ctx, todoResult(plan("Review parser", "Independent billing migration"), "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(2);
		await router.onTodoResult(ctx, todoResult(plan("Review parser", "Yet another task"), "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(2);
	});

	test("failed, view, status-only, malformed and unrelated results cannot promote", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch } });
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
	});

	test("a late result after turn settlement or a different user request cannot promote", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const decider = new ScriptedDecider([DEFAULT, DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		router.endTurn();
		await router.onTodoResult(ctx, todoResult(plan("Separate services")));
		branch.push(entry(user("Fix one typo.")));
		await router.beginTurn(ctx, "Fix one typo.");
		await router.onTodoResult(ctx, todoResult(plan("Separate services")));
		expect(decider.orchestrationCalls).toBe(2);
		expect(router.lastDecision?.outcome).toBe("DEFAULT");
	});
});
