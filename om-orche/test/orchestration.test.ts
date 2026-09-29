import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { normalizeConfig, type OrcheConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { OrchestrationRouter } from "../src/orchestration.ts";
import {
	currentTurnNotices,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	policyModeOf,
	renderPolicy,
	type PolicyMode,
} from "../src/orchestration-policy.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { FakeSessionOptions } from "./harness.ts";

const PROMPT = "Refactor the ingestion pipeline.";
const ALL_TOOLS = ["task", "read", "edit", "write", "bash", "todo"];

function entry(message: AgentMessage): SessionEntry {
	return { type: "message", message, id: crypto.randomUUID(), parentId: null, timestamp: "2026-01-01" } as SessionEntry;
}
function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}
function agentSteering(text = "Worker A is available."): AgentMessage {
	return { ...user(text), steering: true, attribution: "agent" } as AgentMessage;
}
function nativeOrchestrate(timestamp = 1): AgentMessage {
	return { role: "custom", customType: NATIVE_ORCHESTRATE_NOTICE_TYPE, content: "native", display: false, attribution: "user", timestamp } as AgentMessage;
}
function nativeWorkflow(timestamp = 1): AgentMessage {
	return { role: "custom", customType: NATIVE_WORKFLOW_NOTICE_TYPE, content: "workflow", display: false, attribution: "user", timestamp } as AgentMessage;
}
function skillPrompt(text: string, attribution: "user" | "agent" = "user"): AgentMessage {
	return { role: "custom", customType: "skill-prompt", content: text, display: true, attribution, timestamp: 20 } as AgentMessage;
}
function customEntry(message: AgentMessage): SessionEntry {
	const { customType, content, display, attribution } = message as Extract<AgentMessage, { role: "custom" }>;
	return { type: "custom_message", customType, content, display, attribution, id: crypto.randomUUID(), parentId: null, timestamp: "2026-01-01" } as SessionEntry;
}
function autoContinue(text: string): AgentMessage {
	return { role: "developer", content: [{ type: "text", text }], attribution: "agent", synthetic: true, timestamp: 30 } as AgentMessage;
}
function build(options: { session?: FakeSessionOptions; main?: boolean; config?: Partial<OrcheConfig>; debug?: boolean } = {}) {
	const currentModel = options.session?.currentModel ?? fakeModel("p", "explicit-choice");
	const branch = options.session?.branch ?? [];
	const fake = makeSession({ currentModel, ...options.session, branch });
	if (options.main !== false) registerAsMain(fake.session);
	else clearRegistry();
	const api = makeApi();
	const logger = new RouteLogger(api.pi.logger);
	logger.setEnabled(options.debug === true);
	const config = { ...normalizeConfig(undefined), ...options.config };
	const router = new OrchestrationRouter({ logger, config: () => config });
	return { router, branch, currentModel, config, logs: api.logs, ...fake };
}
/** Plugin policy notices in order, by mode. */
function modes(messages: AgentMessage[] | undefined): PolicyMode[] {
	return messages?.flatMap(message => policyModeOf(message) ?? []) ?? [];
}
function customCount(messages: AgentMessage[] | undefined, customType: string): number {
	return messages?.filter(message => message.role === "custom" && message.customType === customType).length ?? 0;
}

afterEach(clearRegistry);

describe("notice placement", () => {
	test("detects only a current user's native prefix, not old history", () => {
		expect(currentTurnNotices([assistant("older"), nativeOrchestrate(), user("new")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([1]);
		expect(currentTurnNotices([nativeOrchestrate(), user("older"), assistant("done"), user("new")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
	});

	test("the notice precedes the current user message, also after agent steering and tool activity", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const todoCall = { role: "assistant", content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "init" } }] } as unknown as AgentMessage;
		const todoResult = { role: "toolResult", toolName: "todo", toolCallId: "todo-1", content: [], isError: false, timestamp: 0 } as AgentMessage;
		const persisted = [assistant("previous"), user(PROMPT), todoCall, todoResult, agentSteering()];
		const applied = router.applyToContext(ctx, persisted);
		expect(modes(applied)).toEqual(["default"]);
		expect(policyModeOf(applied?.[1])).toBe("default");
		// Todo activity is not a routing signal: every later request keeps the same single notice.
		expect(router.applyToContext(ctx, applied!)).toBeUndefined();
		expect(router.applyToContext(ctx, [...persisted, assistant("continuing")])).toEqual([...applied!, assistant("continuing")]);
	});

	test("a notice whose user message was compacted away is restored at the end of context", () => {
		for (const native of [false, true]) {
			const { router, ctx } = build();
			router.beginTurn(ctx, PROMPT);
			const before = router.applyToContext(ctx, [...(native ? [nativeOrchestrate()] : []), user(PROMPT)]);
			const policy = before!.find(message => policyModeOf(message))!;
			const compacted = [assistant("summary of earlier work"), assistant("continuing")];
			const restored = router.applyToContext(ctx, compacted);
			expect(restored).toEqual([...compacted, policy]);
			expect(router.applyToContext(ctx, restored!)).toBeUndefined();
		}
	});
});

describe("mode selection", () => {
	test("with `task` a governed turn carries exactly the default policy; without it, no notice", () => {
		const withTask = build();
		withTask.router.beginTurn(withTask.ctx, PROMPT);
		const applied = withTask.router.applyToContext(withTask.ctx, [user(PROMPT)]);
		expect(modes(applied)).toEqual(["default"]);
		expect(policyModeOf(applied?.[0])).toBe("default");

		const withoutTask = build({ session: { enabledTools: ["read", "edit"] } });
		withoutTask.router.beginTurn(withoutTask.ctx, PROMPT);
		expect(withoutTask.router.applyToContext(withoutTask.ctx, [user(PROMPT)])).toBeUndefined();
	});

	test("an explicit native orchestrate notice is replaced in place, with or without `task`", () => {
		for (const enabledTools of [ALL_TOOLS, ["read", "edit"]]) {
			const { router, ctx } = build({ session: { enabledTools } });
			router.beginTurn(ctx, PROMPT);
			const messages = [assistant("previous"), nativeOrchestrate(), user(PROMPT), agentSteering()];
			const applied = router.applyToContext(ctx, messages);
			expect(modes(applied)).toEqual(["orchestrate"]);
			expect(policyModeOf(applied?.[1])).toBe("orchestrate");
			expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
			expect(applied).toHaveLength(messages.length);
			// A replay of the composed context, or of a rebuilt one, cannot duplicate anything.
			expect(router.applyToContext(ctx, applied!)).toBeUndefined();
			expect(router.applyToContext(ctx, messages)).toEqual(applied!);
		}
	});

	test("the workflow notice is kept and joined by exactly one supplement, with or without an explicit notice", () => {
		for (const explicit of [false, true]) {
			const { router, ctx } = build();
			router.beginTurn(ctx, PROMPT);
			const workflow = nativeWorkflow(5);
			const messages = [assistant("previous"), ...(explicit ? [nativeOrchestrate(5)] : []), workflow, user(PROMPT), agentSteering()];
			const applied = router.applyToContext(ctx, messages);
			expect(modes(applied)).toEqual(["workflow"]);
			expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
			expect(applied?.filter(message => message === workflow)).toHaveLength(1);
			// A replaced explicit notice keeps its slot; otherwise the supplement precedes the user.
			expect(policyModeOf(applied?.[explicit ? 1 : 2])).toBe("workflow");
			expect(router.applyToContext(ctx, applied!)).toBeUndefined();
		}
	});

	test("the mode follows the tools enabled on each request while the turn's notice stays stable otherwise", () => {
		const enabledTools = [...ALL_TOOLS];
		const { router, ctx } = build({ session: { enabledTools } });
		router.beginTurn(ctx, PROMPT);
		const first = router.applyToContext(ctx, [user(PROMPT)]);
		expect(router.applyToContext(ctx, [user(PROMPT)])).toEqual(first!);
		enabledTools.splice(0, 1);
		// `task` vanished mid-turn: the delegation policy is withdrawn rather than left dangling.
		expect(router.applyToContext(ctx, first!)).toEqual([user(PROMPT)]);
	});
});

describe("gate", () => {
	test("a disabled plugin leaves OMP's native notices exactly as they are", () => {
		const { router, ctx } = build({ config: { enabled: false } });
		router.beginTurn(ctx, PROMPT);
		expect(router.applyToContext(ctx, [nativeOrchestrate(), nativeWorkflow(), user(PROMPT)])).toBeUndefined();
	});

	test("a live master switch stops an already begun turn", () => {
		const { router, ctx, config } = build();
		router.beginTurn(ctx, PROMPT);
		config.enabled = false;
		expect(router.applyToContext(ctx, [nativeOrchestrate(), user(PROMPT)])).toBeUndefined();
	});

	test("subagents, plan mode, slash commands, synthetic and empty prompts get no notice", () => {
		const skipped: [Parameters<typeof build>[0], string][] = [
			[{ main: false }, PROMPT],
			[{ session: { planMode: true } }, PROMPT],
			[{}, "/compact"],
			[{}, "<system-notice>continue</system-notice>"],
			[{}, "   "],
		];
		for (const [options, prompt] of skipped) {
			const { router, ctx } = build(options);
			router.beginTurn(ctx, prompt);
			expect(router.applyToContext(ctx, [nativeOrchestrate(), user(PROMPT)])).toBeUndefined();
		}
	});

	test("a skipped turn discards the previous turn's state", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		expect(modes(router.applyToContext(ctx, [user(PROMPT)]))).toEqual(["default"]);
		router.beginTurn(ctx, "/compact");
		expect(router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
	});

	test("plan mode enabled after the turn began withholds the notice from later requests", () => {
		const { router, ctx, session } = build();
		router.beginTurn(ctx, PROMPT);
		expect(modes(router.applyToContext(ctx, [user(PROMPT)]))).toEqual(["default"]);
		Object.assign(session, { getPlanModeState: () => ({ enabled: true }) });
		expect(router.applyToContext(ctx, [user(PROMPT)])).toBeUndefined();
	});
});

function asyncResult(): AgentMessage {
	return { role: "custom", customType: "async-result", content: "<system-notice>\nBackground job bg_1 has completed", display: false, attribution: "agent", timestamp: 5 } as AgentMessage;
}
function ircIncoming(): AgentMessage {
	return { role: "custom", customType: "irc:incoming", content: "<irc from=\"Worker\">done</irc>", display: false, attribution: "agent", timestamp: 6 } as AgentMessage;
}

// OMP starts these turns without `before_agent_start` when a worker result or message reaches an idle session.
describe("autonomous continuations", () => {
	test("a worker delivery after settlement keeps the turn's single, identical notice before the user message", () => {
		for (const delivery of [asyncResult, ircIncoming]) {
			const { router, ctx } = build();
			router.beginTurn(ctx, PROMPT);
			const first = router.applyToContext(ctx, [assistant("previous"), user(PROMPT)]);
			const notice = first![1]!;
			const persisted = [assistant("previous"), user(PROMPT), assistant("workers started"), delivery()];
			const woken = router.applyToContext(ctx, persisted);
			expect(modes(woken)).toEqual(["default"]);
			expect(woken?.[1]).toBe(notice);
			expect(woken?.[2]).toEqual(user(PROMPT));
			const again = router.applyToContext(ctx, [...persisted, assistant("integrating"), delivery()]);
			expect(modes(again)).toEqual(["default"]);
			expect(again?.[1]).toBe(notice);
			expect(router.applyToContext(ctx, woken!)).toBeUndefined();
		}
	});

	test("a notice whose user message was compacted away is restored at the end for a worker delivery", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const notice = router.applyToContext(ctx, [user(PROMPT)])![0]!;
		const summary = { role: "compactionSummary", summary: "Earlier work.", tokensBefore: 1000, timestamp: 1 } as unknown as AgentMessage;
		const persisted = [summary, assistant("workers started"), asyncResult()];
		const woken = router.applyToContext(ctx, persisted);
		expect(woken).toEqual([...persisted, notice]);
		expect(router.applyToContext(ctx, woken!)).toBeUndefined();
	});

	test("a following gated user prompt ends the policy; a following governed one gets a fresh notice", () => {
		for (const gated of ["/compact", "plan"]) {
			const { router, ctx, session } = build();
			router.beginTurn(ctx, PROMPT);
			router.applyToContext(ctx, [user(PROMPT)]);
			if (gated === "plan") Object.assign(session, { getPlanModeState: () => ({ enabled: true }) });
			router.beginTurn(ctx, gated === "plan" ? "Next request" : gated);
			expect(router.applyToContext(ctx, [user(PROMPT), assistant("done"), user("Next request")])).toBeUndefined();
			expect(router.applyToContext(ctx, [user(PROMPT), assistant("done"), asyncResult()])).toBeUndefined();
		}
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		router.applyToContext(ctx, [user(PROMPT)]);
		router.beginTurn(ctx, "Next request");
		const applied = router.applyToContext(ctx, [user(PROMPT), assistant("done"), asyncResult(), user("Next request")]);
		expect(modes(applied)).toEqual(["default"]);
		expect(policyModeOf(applied?.[3])).toBe("default");
		expect(applied?.[0]).toEqual(user(PROMPT));
	});

	test("a synthetic prompt or another session's call leaves the ongoing turn untouched", () => {
		const { router, ctx, session } = build();
		router.beginTurn(ctx, PROMPT);
		const notice = router.applyToContext(ctx, [user(PROMPT)])![0]!;
		router.beginTurn(ctx, "<system-notice>\nBackground job bg_1 has completed</system-notice>");
		clearRegistry();
		router.beginTurn(ctx, PROMPT);
		registerAsMain(session);
		const woken = router.applyToContext(ctx, [user(PROMPT), assistant("workers started"), asyncResult()]);
		expect(woken?.[0]).toBe(notice);
		expect(modes(woken)).toEqual(["default"]);
	});

	test("an explicit native notice keeps governing the continuation, replaced wherever it appears", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const first = router.applyToContext(ctx, [nativeOrchestrate(), user(PROMPT)]);
		const woken = router.applyToContext(ctx, [nativeOrchestrate(), user(PROMPT), assistant("workers started"), asyncResult()]);
		expect(modes(woken)).toEqual(["orchestrate"]);
		expect(woken?.[0]).toBe(first![0]!);
		expect(customCount(woken, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
	});
});

describe("turn identity", () => {
	test("preparation retries reuse the turn's notice and what it already learned", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const first = router.applyToContext(ctx, [nativeOrchestrate(), user(PROMPT)]);
		// OMP prepares before persisting the input, including on retries.
		router.beginTurn(ctx, PROMPT);
		const retried = router.applyToContext(ctx, [user(PROMPT)]);
		expect(modes(retried)).toEqual(["orchestrate"]);
		expect(retried?.[0]).toEqual(first![0]!);
	});

	test("agent steering continues the turn; same-text user steering starts a new one", () => {
		const { router, ctx, branch } = build();
		router.beginTurn(ctx, PROMPT);
		const first = user(PROMPT);
		const workflow = nativeWorkflow();
		branch.push(entry(first));
		expect(modes(router.applyToContext(ctx, [workflow, first]))).toEqual(["workflow"]);
		const injected = agentSteering();
		branch.push(entry(injected));
		expect(modes(router.applyToContext(ctx, [workflow, first, injected]))).toEqual(["workflow"]);

		// A real user steer invokes before_agent_start before its message is delivered.
		router.beginTurn(ctx, PROMPT);
		const steering = { ...user(PROMPT), steering: true, attribution: "user" } as AgentMessage;
		branch.push(entry(steering));
		const applied = router.applyToContext(ctx, [workflow, first, assistant("working"), steering]);
		expect(modes(applied)).toEqual(["default"]);
		expect(applied?.[0]).toBe(workflow);
		expect(policyModeOf(applied?.[3])).toBe("default");
		expect(applied?.[4]).toBe(steering);
	});
});

describe("skill prompts", () => {
	const SKILL = "[IMPORTANT: User invoked the \"fix\" skill; follow its instructions.]\nUser: fix the parser";

	test("a user-invoked skill prompt starts the turn; its keyword prefix excludes it and agent-attributed ones do not", () => {
		const messages = [assistant("older"), nativeOrchestrate(), skillPrompt(SKILL)];
		expect(currentTurnNotices(messages, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([1]);
		expect(currentTurnNotices([nativeOrchestrate(), user("older"), skillPrompt(SKILL), assistant("done"), skillPrompt(SKILL)], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
		const collab = { ...skillPrompt("from a peer"), customType: "collab-prompt" } as AgentMessage;
		expect(currentTurnNotices([assistant("older"), nativeOrchestrate(), collab], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([1]);
		// An agent-attributed skill injection is a continuation, so the earlier user turn still owns the notices.
		expect(currentTurnNotices([nativeOrchestrate(), user("request"), assistant("loading"), skillPrompt(SKILL, "agent")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([0]);
	});

	test("a skill turn after an orchestrate turn is a fresh default turn, notice placed before the skill message", () => {
		const { router, ctx, branch } = build();
		const first = user("orchestrate the ingestion refactor");
		router.beginTurn(ctx, "orchestrate the ingestion refactor");
		expect(modes(router.applyToContext(ctx, [nativeOrchestrate(), first]))).toEqual(["orchestrate"]);
		branch.push(entry(first), entry(assistant("done")));
		router.beginTurn(ctx, SKILL);
		const skill = skillPrompt(SKILL);
		const applied = router.applyToContext(ctx, [nativeOrchestrate(), first, assistant("done"), skill]);
		expect(modes(applied)).toEqual(["default"]);
		expect(policyModeOf(applied?.[3])).toBe("default");
		expect(applied?.[4]).toBe(skill);
		// The earlier turn's native notice is history, not this turn's.
		expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
	});

	test("a native keyword notice queued before the skill message is replaced by exactly one plugin notice", () => {
		const { router, ctx, branch } = build();
		const previous = user("explain the parser");
		branch.push(entry(previous), entry(assistant("explained")));
		router.beginTurn(ctx, SKILL);
		const skill = skillPrompt(SKILL);
		const applied = router.applyToContext(ctx, [previous, assistant("explained"), nativeOrchestrate(5), skill]);
		expect(modes(applied)).toEqual(["orchestrate"]);
		expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(policyModeOf(applied?.[2])).toBe("orchestrate");
		expect(applied?.[3]).toBe(skill);
		// A later worker delivery keeps the same notice even though the native one is no longer in the prefix.
		const woken = router.applyToContext(ctx, [previous, assistant("explained"), nativeOrchestrate(5), skill, assistant("working"), asyncResult()]);
		expect(modes(woken)).toEqual(["orchestrate"]);
		expect(customCount(woken, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
	});

	test("a persisted skill prompt separates repeated identical skill turns", () => {
		const { router, ctx, branch } = build();
		router.beginTurn(ctx, SKILL);
		const skill = skillPrompt(SKILL);
		expect(modes(router.applyToContext(ctx, [nativeOrchestrate(), skill]))).toEqual(["orchestrate"]);
		branch.push(customEntry(skill), entry(assistant("done")));
		router.beginTurn(ctx, SKILL);
		const applied = router.applyToContext(ctx, [nativeOrchestrate(), skill, assistant("done"), skill]);
		expect(modes(applied)).toEqual(["default"]);
	});
});

describe("synthetic agent prompts", () => {
	const RESUME = "Resume the user's latest intent. Re-read kept recent messages above the summary to confirm the latest request.";
	const summary = { role: "compactionSummary", summary: "Earlier work.", tokensBefore: 1000, timestamp: 2 } as unknown as AgentMessage;

	test("auto-continue after compaction keeps an explicit orchestrate or workflow turn", () => {
		for (const [native, mode] of [[nativeOrchestrate(), "orchestrate"], [nativeWorkflow(), "workflow"]] as const) {
			const { router, ctx, branch } = build();
			const request = user("migrate everything");
			router.beginTurn(ctx, "migrate everything");
			const first = router.applyToContext(ctx, [native, request]);
			expect(modes(first)).toEqual([mode]);
			branch.push(entry(request));
			router.beginTurn(ctx, RESUME);
			const applied = router.applyToContext(ctx, [summary, assistant("working"), autoContinue(RESUME)]);
			expect(modes(applied)).toEqual([mode]);
			expect(applied?.[0]).toBe(summary);
			expect(applied?.find(message => policyModeOf(message))).toEqual(first?.find(message => policyModeOf(message)));
			// The same text typed by the user is a user request.
			router.beginTurn(ctx, RESUME);
			expect(modes(router.applyToContext(ctx, [summary, assistant("working"), user(RESUME)]))).toEqual(["default"]);
		}
	});

	test("a synthetic prompt never starts a turn when none is in progress", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, RESUME);
		expect(router.applyToContext(ctx, [summary, autoContinue(RESUME)])).toBeUndefined();
	});

	test("an agent-attributed hidden prompt or a batch of queued user messages is told apart by its delivery", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const notice = router.applyToContext(ctx, [user(PROMPT)])![0]!;
		const hidden = { role: "custom", customType: "next-turn", content: "Check the results.", display: false, attribution: "agent", timestamp: 9 } as AgentMessage;
		router.beginTurn(ctx, "Check the results.");
		expect(router.applyToContext(ctx, [user(PROMPT), assistant("done"), hidden])?.[0]).toBe(notice);
		// Joined queued user messages match no single message: still a user turn.
		router.beginTurn(ctx, "First.\n\nSecond.");
		const applied = router.applyToContext(ctx, [user(PROMPT), assistant("done"), user("First."), user("Second.")]);
		expect(policyModeOf(applied?.[3])).toBe("default");
		expect(applied?.[0]).toEqual(user(PROMPT));
		expect(applied?.[0]).not.toBe(notice);
	});
});

describe("isolation", () => {
	test("history and shared objects are never mutated; only the live turn's native notice is replaced", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const historical = nativeOrchestrate(1);
		const messages = [historical, user("Earlier request"), assistant("done"), nativeOrchestrate(2), user(PROMPT)]
			.map(message => Object.freeze(message));
		const snapshot = structuredClone(messages);
		const applied = router.applyToContext(ctx, Object.freeze([...messages]) as AgentMessage[]);
		expect(messages).toEqual(snapshot);
		expect(applied?.[0]).toBe(historical);
		expect(policyModeOf(applied?.[3])).toBe("orchestrate");
		expect(customCount(applied, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
		// A later user message in the same turn cannot re-expose the replaced notice; content and timestamp stay stable.
		const steered = router.applyToContext(ctx, [...messages, assistant("working"), user("Also cover the CLI.")]);
		expect(steered?.[3]).toEqual(applied![3]!);
		expect(customCount(steered, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
		expect(modes(steered)).toEqual(["orchestrate"]);
	});

	test("a duplicated own notice is collapsed to one", () => {
		const { router, ctx } = build();
		router.beginTurn(ctx, PROMPT);
		const applied = router.applyToContext(ctx, [user(PROMPT)])!;
		const duplicated = [applied[0]!, applied[0]!, applied[1]!];
		const collapsed = router.applyToContext(ctx, duplicated);
		expect(modes(collapsed)).toEqual(["default"]);
	});

	test("no mode ever changes the primary model", () => {
		for (const messages of [[user(PROMPT)], [nativeOrchestrate(), user(PROMPT)], [nativeWorkflow(), user(PROMPT)]]) {
			const { router, ctx, modelCalls, currentModel } = build();
			router.beginTurn(ctx, PROMPT);
			router.applyToContext(ctx, messages);
			router.resetTurn();
			expect(modelCalls).toEqual([]);
			expect(ctx.model).toEqual(currentModel);
		}
	});
});

describe("debug log", () => {
	test("one metrics line per turn and mode, never the prompt text", () => {
		const { router, ctx, logs } = build({ debug: true });
		const secretPrompt = "Refactor the ingestion pipeline with token abc123.";
		router.beginTurn(ctx, secretPrompt);
		router.applyToContext(ctx, [user(secretPrompt)]);
		router.applyToContext(ctx, [user(secretPrompt)]);
		router.beginTurn(ctx, "/compact");
		expect(logs).toEqual(["debug om-orche.policy mode=default", "debug om-orche.policy skip=slash-command"]);
	});

	test("nothing is logged unless debug logging is on", () => {
		const { router, ctx, logs } = build();
		router.beginTurn(ctx, PROMPT);
		router.applyToContext(ctx, [user(PROMPT)]);
		expect(logs).toEqual([]);
	});
});

// These check what the notices tell the model, not what the model then does.
describe("policy content checks", () => {
	const tools = [...ALL_TOOLS, "orche_advisor"];
	const withoutTask = tools.filter(name => name !== "task");
	const count = (text: string, needle: string) => text.split(needle).length - 1;

	test("selection: both policies once, chosen per stage by the main, with no classifier", () => {
		const text = renderPolicy("default", tools);
		expect(count(text, "Judgment (판단형)")).toBe(1);
		expect(count(text, "Production (제작형)")).toBe(1);
		expect(text).toContain("Ask what the user must receive to be done");
		expect(text).toContain("Type = current stage, not request label");
		expect(text).toContain("never call a model, router or subagent to classify");
		expect(text).toContain("Both → Judgment first, Production once cause, scope and contract are settled enough to implement (no new approval if both were asked)");
		expect(text).toContain("Analysis/proposal only → never Production just because a fix became clear");
		expect(text).toContain("Premise or contract breaks in Production → Judgment for the affected part only");
		expect(text).toContain("Findings saved as Markdown or a throwaway repro script stay Judgment");
		expect(text).toContain("a one-file or strictly sequential change is not Judgment");
	});

	test("the precedence line names both directions of the generic defaults it overrides and grants no capability", () => {
		const text = renderPolicy("default", tools);
		for (const quoted of ["Map unknown code via task", "Multi-round search MUST use Task + scout", "Inline first / NEVER delegate one slice",
			"No subagents unless explicitly requested", "tasks skip build/lint/tests mid-flight"]) expect(text).toContain(quoted);
		expect(text).toContain("host limits (tools, concurrency, permissions, plan mode, read-only) bind; no capability granted");
	});

	test("judgment: the main analyzes itself, delegates only bounded investigations, and labels what was executed", () => {
		const text = renderPolicy("default", tools);
		expect(text).toContain("you are the responsible analyst, not a relay");
		expect(text).toContain("read key code/logs/docs yourself");
		expect(text).toContain("Delegate only bounded independent investigations");
		expect(text).toContain("Zero workers is normal for small or well-evidenced questions");
		expect(text).toContain("verify key evidence yourself");
		expect(text).toContain("Never fix the conclusion first and send workers for support");
		expect(text).toContain("thought experiment, static analysis or actually executed; nothing unexecuted is verified");
		expect(text).toContain("no product code, config or assets change");
	});

	test("judgment names todo and advice only when those tools are enabled", () => {
		expect(renderPolicy("default", tools)).toContain("no worker, todo list, task contract or advice call required");
		const bare = renderPolicy("default", ["task", "read"]);
		expect(bare).toContain("no worker or task contract required");
		expect(bare).not.toMatch(/todo|advice/);
	});

	test("production: one worker for cohesive work, parallel only for independent units, direct edits only under all five conditions", () => {
		const text = renderPolicy("default", tools);
		expect(text).toContain("Cohesive or strongly sequential work → one worker end to end");
		expect(text).toContain("\"can't be parallelized\" never moves it to you");
		expect(text).toContain("Parallelize only independent units under verified prerequisites");
		expect(text).toContain("delegation and parallelism are separate decisions");
		expect(text).toContain("never solve the implementation yourself and have a worker type it");
		expect(text).toContain("Edit source yourself only for a small integration finish when ALL hold");
		for (const condition of ["cause and fix settled", "no new investigation, design or substantial debugging",
			"contract and scope unchanged", "no conflict with another writer's ownership or writes", "clearly smaller than delegating"]) {
			expect(text).toContain(condition);
		}
		expect(text).toContain("a run of exceptions must not make you the implementer");
	});

	test("production: a blocked worker is classified before any takeover; worker success is not acceptance", () => {
		const text = renderPolicy("default", tools);
		expect(text).toContain("Classify a failure or blocked worker first");
		expect(text).toContain("never as a takeover");
		expect(text).toContain("a worker's success report is not acceptance");
		expect(text).toContain("Never report an unrun check as passed");
	});

	test("production: assets follow the sample-then-rest flow and a file is not visual verification", () => {
		const text = renderPolicy("default", tools);
		expect(text).toContain("check a few samples against them");
		expect(text).toContain("never assume workers have generation tools");
		expect(text).toContain("a created file or text report is not visual verification");
	});

	test("transitions and reuse: same session and model; `write agent://<id>` only when `write` is enabled", () => {
		const withWrite = renderPolicy("default", tools);
		expect(withWrite).toContain("Switching keeps the same session and your model");
		expect(withWrite).toContain("update only the changed goal/contract and affected work");
		expect(withWrite).toContain("`write agent://<id>` (`task` cannot resume)");
		expect(withWrite).toContain("a same-named new worker is not the old context");
		expect(withWrite).toContain("never claim a reuse that did not happen");
		const without = renderPolicy("default", tools.filter(name => name !== "write"));
		expect(without).not.toContain("agent://");
		expect(without).toContain("no follow-up channel exists this turn");
	});

	test("task bodies keep the six sections, effort only with `task`, and per-type acceptance", () => {
		const text = renderPolicy("default", tools);
		for (const heading of ["# Goal", "# Scope and non-goals", "# Decided and open", "# Inputs and dependencies", "# Acceptance and verification", "# Return"]) {
			expect(text).toContain(heading);
		}
		expect(text).toContain("Judgment worker: evidence answering its question, not whether code changed; Production worker: the change plus verification");
		expect(text).toContain("When the schema has `effort`");
		expect(text).toContain("an explicit effort overrides the task role's level and auto: omit it to keep those");
		expect(text).toContain("workers analyze within their question, you own the judgment");
		expect(text).toContain("never the whole conversation, earlier reports or large logs");
		expect(renderPolicy("workflow", ["read"])).not.toContain("effort");
	});

	test("verification names project checks only with `bash`", () => {
		expect(renderPolicy("default", tools)).toContain("boundary project checks");
		expect(renderPolicy("default", tools.filter(name => name !== "bash"))).toContain("boundary available checks");
	});

	test("the removed universal coordinator-first rules appear in no mode", () => {
		const removed = ["One worker is the normal path", "Zero workers: explanation", "investigate minimally", "You are the coordinator",
			"coordinator-first", "worker-first", "coordinated through workers", "Work directly when the task is cohesive",
			"Fix small obvious gaps directly"];
		for (const mode of ["default", "orchestrate", "workflow"] as const) {
			for (const set of [tools, withoutTask, ["task"]]) {
				const text = renderPolicy(mode, set);
				for (const phrase of removed) expect(text).not.toContain(phrase);
			}
		}
	});

	test("explicit orchestrate: the default body plus a delegation-lean line that grants no product-change permission", () => {
		const base = renderPolicy("default", tools);
		const explicit = renderPolicy("orchestrate", tools);
		expect(base.split("\n").every(line => explicit.includes(line))).toBe(true);
		expect(explicit).toContain("The user explicitly asked for orchestration: within the current goal, lean further toward delegation");
		expect(explicit).toContain("does not turn an analysis-only request into permission to change the product");
	});

	test("explicit orchestrate without `task` is an honest direct notice", () => {
		const direct = renderPolicy("orchestrate", withoutTask);
		expect(direct).toContain("`task` is not enabled for this turn");
		expect(direct).toContain("Never claim or simulate delegation");
		expect(direct).toContain("An analysis-only request stays analysis");
		expect(direct).not.toMatch(/tasks\[\]|agent:\/\/|parallel|Production \(/);
	});

	test("the workflow supplement has the task-body contract, result labels and analysis-only boundary, but no dispatch, reuse or analyze-directly instruction", () => {
		const text = renderPolicy("workflow", tools);
		expect(text).toContain("# Goal");
		expect(text).toContain("# Return");
		expect(text).toContain("thought experiment, static analysis or actually executed");
		expect(text).toContain("Analysis-only is not permission to change the product");
		expect(text).toContain("a worker's success report is not acceptance");
		expect(text).not.toMatch(/parallel|tasks\[\]|agent:\/\/|reuse|delegate|dispatch|read key code|responsible analyst|Zero workers/i);
	});
});
