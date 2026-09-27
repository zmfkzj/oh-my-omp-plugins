import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
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
function committedPlan(phases: TodoPhase[]): SessionEntry {
	return { type: "custom", customType: "user_todo_edit", data: { phases }, id: "plan", parentId: null, timestamp: "2026-01-01" } as SessionEntry;
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

	test("explicit native orchestrate is replaced in place; a replay cannot duplicate any notice", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const steering = { ...user("Worker A is available."), steering: true, attribution: "agent" } as AgentMessage;
		const replaced = await router.applyToContext(ctx, [notice(), user(PROMPT), steering]);
		expect(modes(replaced)).toEqual(["orchestrate"]);
		expect(policyModeOf(replaced?.[0])).toBe("orchestrate");
		expect(customCount(replaced, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(await router.applyToContext(ctx, replaced!)).toBeUndefined();
		// Once seen, the explicit route governs even a request whose native notice was compacted away.
		const injected = await router.applyToContext(ctx, [user(PROMPT)]);
		expect(modes(injected)).toEqual(["orchestrate"]);
		expect(await router.applyToContext(ctx, injected!)).toBeUndefined();
	});

	test("an initial decision keeps its pre-user anchor after todo activity and agent steering", async () => {
		const { router, ctx } = build(new ScriptedDecider(ORCHESTRATE));
		await router.beginTurn(ctx, PROMPT);
		const messages = [user(PROMPT), toolCall("todo-1"),
			toolResultMessage("todo-1"),
			{ ...user("Worker A is available."), steering: true, attribution: "agent" } as AgentMessage];
		const applied = await router.applyToContext(ctx, messages);
		expect(policyModeOf(applied?.[0])).toBe("orchestrate");
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

	test("same-text user steering starts a new turn, but preparation retries reuse its route", async () => {
		const decider = new ScriptedDecider([ORCHESTRATE, DEFAULT]);
		const { router, ctx, branch } = build(decider);
		// OMP prepares policy before persisting the input, including on retries.
		await router.beginTurn(ctx, PROMPT);
		await router.beginTurn(ctx, PROMPT);
		expect(decider.orchestrationCalls).toBe(1);
		const first = user(PROMPT);
		const workflow = workflowNotice();
		branch.push(entry(first), entry(toolCall("old-todo")));
		expect(modes(await router.applyToContext(ctx, [workflow, first]))).toEqual(["workflow"]);

		// A real user steer invokes before_agent_start before its message is delivered.
		await router.beginTurn(ctx, PROMPT);
		await router.beginTurn(ctx, PROMPT);
		expect(decider.orchestrationCalls).toBe(2);
		expect(router.lastDecision?.outcome).toBe("DEFAULT");
		const steering = { ...user(PROMPT), steering: true, attribution: "user" } as AgentMessage;
		branch.push(entry(steering));
		const applied = await router.applyToContext(ctx, [workflow, first, assistant("working"), steering]);
		expect(modes(applied)).toEqual(["default"]);
		expect(applied?.[0]).toBe(workflow);
		expect(policyModeOf(applied?.[3])).toBe("default");
		await router.onTodoResult(ctx, todoResult(plan("Late old plan"), "init", "old-todo"));
		expect(decider.orchestrationCalls).toBe(2);
	});

	test("subagents, plan mode, a disabled router and synthetic prompts are not classified", async () => {
		for (const options of [{ main: false }, { session: { planMode: true } }, { config: { enabled: false } }]) {
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

	test("unavailable automatic orchestration withholds the route and keeps the default policy", async () => {
		for (const [options, mode] of [
			[{ session: { enabledTools: ["read"] } }, undefined],
			[{ config: { orchestrationRoutingEnabled: false } }, "default"],
		] as const) {
			const decider = new ScriptedDecider(ORCHESTRATE);
			const { router, ctx, modelCalls } = build(decider, options);
			await router.beginTurn(ctx, PROMPT);
			expect(decider.orchestrationCalls).toBe(1);
			expect(router.lastDecision?.outcome).toBe("DEFAULT");
			const applied = await router.applyToContext(ctx, [user(PROMPT)]);
			// Without `task`, no delegation guidance is advertised at all.
			if (mode) expect(modes(applied)).toEqual([mode]);
			else expect(applied).toBeUndefined();
			expect(modelCalls).toEqual([]);
		}
	});

	test("a missing credential or failed classification falls back to the default policy without touching the model", async () => {
		for (const [decision, options, outcome] of [
			[ORCHESTRATE, { apiKey: undefined }, "SKIP"],
			[new Error("HTTP 503"), {}, "ERROR"],
			[new Error("Request timeout after 4000ms"), {}, "ERROR"],
		] as const) {
			const { router, ctx, modelCalls, currentModel } = build(new ScriptedDecider(decision), options);
			await router.beginTurn(ctx, PROMPT);
			expect(router.lastDecision?.outcome).toBe(outcome);
			expect(ctx.model).toEqual(currentModel);
			expect(modelCalls).toEqual([]);
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
	});

	test("a workflow notice keeps its execution method; one auxiliary policy notice joins it", async () => {
		for (const [route, explicit] of [[DEFAULT, false], [ORCHESTRATE, false], [DEFAULT, true], [ORCHESTRATE, true]] as const) {
			const { router, ctx } = build(new ScriptedDecider(route));
			await router.beginTurn(ctx, PROMPT);
			const workflow = workflowNotice(5);
			const messages = [assistant("previous"), ...(explicit ? [notice(5)] : []), workflow, user(PROMPT),
				{ ...user("Worker A is available."), steering: true, attribution: "agent" } as AgentMessage];
			const applied = await router.applyToContext(ctx, messages);
			expect(modes(applied)).toEqual(["workflow"]);
			expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
			expect(applied?.filter(message => message === workflow)).toHaveLength(1);
			// A replaced explicit notice keeps its slot; otherwise the supplement precedes the user.
			expect(policyModeOf(applied?.[explicit ? 1 : 2])).toBe("workflow");
			expect(await router.applyToContext(ctx, applied!)).toBeUndefined();
		}
	});

	test("promotion inside a workflow turn keeps the single supplement before the user", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const { router, ctx } = build(new ScriptedDecider([DEFAULT, ORCHESTRATE]), { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		const messages = [workflowNotice(), user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
		const before = await router.applyToContext(ctx, messages);
		expect(modes(before)).toEqual(["workflow"]);
		await router.onTodoResult(ctx, todoResult(plan("Split parser service", "Split billing service")));
		expect(router.lastDecision?.outcome).toBe("ORCHESTRATE");
		expect(await router.applyToContext(ctx, messages)).toEqual(before!);
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
		const { router, ctx, modelCalls } = build(decider, { session: { branch } });
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

	test("agent steering keeps promoted guidance behind the complete originating result group", async () => {
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx, branch } = build(decider);
		await router.beginTurn(ctx, PROMPT);
		const request = user(PROMPT);
		const call = toolCall("todo-1");
		const result = toolResultMessage("todo-1");
		const siblingResult = { ...toolResultMessage("read-1"), toolName: "read" } as AgentMessage;
		const steering = { ...user("Worker A is available."), steering: true, attribution: "agent" } as AgentMessage;
		branch.push(entry(request), entry(call));
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		branch.push(entry(result), entry(siblingResult), entry(steering));
		const persisted = [request, call, result, siblingResult, steering];
		const applied = await router.applyToContext(ctx, persisted);
		expect(modes(applied)).toEqual(["orchestrate"]);
		expect(applied?.slice(0, 4)).toEqual(persisted.slice(0, 4));
		expect(policyModeOf(applied?.[4])).toBe("orchestrate");
		expect(applied?.[5]).toBe(steering);
		// Every provider request starts from persisted messages, not the previous hook's copy.
		expect(await router.applyToContext(ctx, [...persisted, assistant("continuing")]))
			.toEqual([...applied!, assistant("continuing")]);
		expect(decider.orchestrationCalls).toBe(2);
	});

	test("promoted guidance survives compaction of its originating todo result", async () => {
		const request = entry(user(PROMPT));
		const call = { ...entry(toolCall("todo-1")), parentId: request.id };
		const result = { ...entry(toolResultMessage("todo-1")), parentId: call.id };
		const continuation = { ...entry(assistant("Continuing the implementation.")), parentId: result.id };
		const branch = [request, call];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		// A prepared notice is not yet delivered: wait until its result reaches context.
		expect(await router.applyToContext(ctx, buildSessionContext(branch).messages)).toBeUndefined();
		branch.push(result, continuation);
		const before = await router.applyToContext(ctx, buildSessionContext(branch).messages);
		expect(modes(before)).toEqual(["orchestrate"]);
		const policy = before!.find(message => policyModeOf(message) === "orchestrate")!;

		branch.push({
			type: "compaction", id: "compaction", parentId: continuation.id, timestamp: "2026-01-02",
			summary: "Parser and API work is in progress.", tokensBefore: 100_000,
			firstKeptEntryId: continuation.id,
		});
		const compacted = buildSessionContext(branch).messages;
		expect(compacted.map(message => message.role)).toEqual(["compactionSummary", "assistant"]);
		const restored = await router.applyToContext(ctx, compacted);
		expect(restored).toEqual([...compacted, policy]);
		expect(modes(restored)).toEqual(["orchestrate"]);
		// Rebuilding provider context must neither lose nor duplicate the restored notice.
		expect(await router.applyToContext(ctx, buildSessionContext(branch).messages)).toEqual(restored!);
		expect(await router.applyToContext(ctx, restored!)).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(2);
		router.endTurn();
		expect(await router.applyToContext(ctx, compacted)).toBeUndefined();
	});

	test("a live master switch stops todo reclassification", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const config = { enabled: true };
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch }, config });
		await router.beginTurn(ctx, PROMPT);
		config.enabled = false;
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		expect(decider.orchestrationCalls).toBe(1);
		expect(router.lastDecision?.outcome).toBe("DEFAULT");
		// A disabled router leaves OMP's own guidance exactly as it is.
		expect(await router.applyToContext(ctx, [notice(), user(PROMPT)])).toBeUndefined();
	});

	test("disabling orchestration mid-turn withholds promotion of a reclassified plan", async () => {
		const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
		const config = { orchestrationRoutingEnabled: true };
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch }, config });
		await router.beginTurn(ctx, PROMPT);
		config.orchestrationRoutingEnabled = false;
		await router.onTodoResult(ctx, todoResult(plan("Change parser", "Update independent API")));
		expect(decider.orchestrationCalls).toBe(2);
		expect(router.lastDecision).toMatchObject({ outcome: "DEFAULT", reason: "orchestration-routing-disabled" });
		const messages = [user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
		expect(modes(await router.applyToContext(ctx, messages))).toEqual(["default"]);
	});

	test("once orchestrated, a changed plan triggers no further Jev request", async () => {
		for (const explicit of [false, true]) {
			const branch = [entry(user(PROMPT)), entry(toolCall("todo-1")), entry(toolCall("todo-2", "append"))];
			const decider = new ScriptedDecider(explicit ? DEFAULT : ORCHESTRATE);
			const { router, ctx } = build(decider, { session: { branch } });
			await router.beginTurn(ctx, PROMPT);
			if (explicit) await router.applyToContext(ctx, [notice(), user(PROMPT)]);
			const initial = plan("Split parser service", "Split billing service");
			await router.onTodoResult(ctx, todoResult(initial));
			await router.onTodoResult(ctx, todoResult(initial));
			const expanded: TodoPhase[] = [...initial, { name: "Docs", tasks: [{ content: "Document both services", status: "pending" }] }];
			await router.onTodoResult(ctx, todoResult(expanded, "append", "todo-2"));
			expect(decider.orchestrationCalls).toBe(1);
			expect(modes(await router.applyToContext(ctx, [user(PROMPT)]))).toEqual(["orchestrate"]);
		}
	});

	test("a changed plan in a direct turn is reclassified; a DEFAULT or failed reclassification stays direct", async () => {
		for (const [reclassified, outcome] of [[DEFAULT, "DEFAULT"], [new Error("HTTP 503"), "ERROR"]] as const) {
			const branch = [entry(user(PROMPT)), entry(toolCall("todo-1"))];
			const decider = new ScriptedDecider([DEFAULT, reclassified]);
			const { router, ctx } = build(decider, { session: { branch } });
			await router.beginTurn(ctx, PROMPT);
			await router.onTodoResult(ctx, todoResult(plan("Backfill invoice totals", "Switch billing reads to the new column")));
			expect(decider.orchestrationCalls).toBe(2);
			expect(router.lastDecision?.outcome).toBe(outcome);
			const messages = [user(PROMPT), toolCall("todo-1"), toolResultMessage("todo-1")];
			expect(modes(await router.applyToContext(ctx, messages))).toEqual(["default"]);
		}
	});

	test("append can promote an initially direct plan; unchanged plans and orchestrated turns do not reclassify", async () => {
		const initial = plan("Review parser");
		const branch = [entry(user(PROMPT)), committedPlan(initial), entry(toolCall("todo-2", "append"))];
		const decider = new ScriptedDecider([DEFAULT, ORCHESTRATE]);
		const { router, ctx } = build(decider, { session: { branch } });
		await router.beginTurn(ctx, PROMPT);
		await router.onTodoResult(ctx, todoResult(initial, "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(1);
		await router.onTodoResult(ctx, todoResult(plan("Review parser", "Independent billing migration"), "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(2);
		await router.onTodoResult(ctx, todoResult(plan("Review parser", "Yet another task"), "append", "todo-2"));
		expect(decider.orchestrationCalls).toBe(2);
		expect(router.lastDecision?.outcome).toBe("ORCHESTRATE");
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
		expect(modes(await router.applyToContext(ctx, [user(PROMPT)]))).toEqual(["default"]);
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
