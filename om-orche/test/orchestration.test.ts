import { afterEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { normalizeConfig, type OrcheConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { OrchestrationRouter } from "../src/orchestration.ts";
import {
	currentTurnNotices,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	POLICY_NOTICE_TYPE,
	policyModeOf,
	renderPolicy,
	type PolicyMode,
	type PolicyNoticePayload,
} from "../src/orchestration-policy.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { FakeSession, FakeSessionOptions } from "./harness.ts";

const PROMPT = "Refactor the ingestion pipeline.";
const ALL_TOOLS = ["task", "read", "edit", "write", "bash", "todo"];

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
function otherKeywordNotice(): AgentMessage {
	return { role: "custom", customType: "ultrathink-notice", content: "think", display: false, attribution: "user", timestamp: 1 } as AgentMessage;
}
function skillPrompt(text: string): AgentMessage {
	return { role: "custom", customType: "skill-prompt", content: text, display: true, attribution: "user", timestamp: 20 } as AgentMessage;
}
function autoContinue(text: string): AgentMessage {
	return { role: "developer", content: [{ type: "text", text }], attribution: "agent", synthetic: true, timestamp: 30 } as AgentMessage;
}
function asyncResult(): AgentMessage {
	return { role: "custom", customType: "async-result", content: "<system-notice>\nBackground job bg_1 has completed", display: false, attribution: "agent", timestamp: 5 } as AgentMessage;
}
function compactionSummary(): AgentMessage {
	return { role: "compactionSummary", summary: "Earlier work.", tokensBefore: 1000, timestamp: 1 } as unknown as AgentMessage;
}
function toolActivity(): AgentMessage[] {
	const call = { role: "assistant", content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "init" } }] } as unknown as AgentMessage;
	const result = { role: "toolResult", toolName: "todo", toolCallId: "todo-1", content: [], isError: false, timestamp: 0 } as AgentMessage;
	return [call, result];
}

interface BuildOptions {
	session?: FakeSessionOptions;
	main?: boolean;
	config?: Partial<OrcheConfig>;
	debug?: boolean;
}

/** What a prompt brings into the transcript besides its own text. */
interface Delivery {
	/** The keyword notices OMP queues ahead of the user's message. */
	natives?: AgentMessage[];
	/** The message delivered for the prompt, when it is not a plain user message. */
	message?: AgentMessage;
}

interface Host extends FakeSession {
	router: OrchestrationRouter;
	config: OrcheConfig;
	currentModel: Model;
	transcript: AgentMessage[];
	logs: string[];
	/** Deliver a prompt; returns the notice `before_agent_start` asked OMP to persist, if any. */
	prompt(text: string, delivery?: Delivery): PolicyNoticePayload | undefined;
	/** What the provider receives for the next request. */
	request(): AgentMessage[];
}

/**
 * OMP's prompt path, reduced to what the notice depends on. `before_agent_start` runs first and
 * the message it returns is appended after the delivered ones, exactly as OMP persists it. A
 * provider request then sees a clone of the transcript (as `ExtensionRunner.emitContext` clones)
 * through the `context` hook. Tests append assistant and tool messages to `transcript` directly.
 */
function build(options: BuildOptions = {}): Host {
	const currentModel = options.session?.currentModel ?? fakeModel("p", "explicit-choice");
	const fake = makeSession({ currentModel, ...options.session });
	const transcript: AgentMessage[] = [];
	Object.assign(fake.session, { messages: transcript });
	if (options.main !== false) registerAsMain(fake.session);
	else clearRegistry();
	const api = makeApi();
	const logger = new RouteLogger(api.pi.logger);
	logger.setEnabled(options.debug === true);
	const config = { ...normalizeConfig(undefined), ...options.config };
	const router = new OrchestrationRouter({ logger, config: () => config });
	return {
		...fake, router, config, currentModel, transcript, logs: api.logs,
		prompt(text, delivery = {}) {
			const notice = router.noticeToPersist(fake.ctx, text);
			transcript.push(...(delivery.natives ?? []), delivery.message ?? user(text));
			if (notice) {
				const persisted: CustomMessage = { role: "custom", ...notice, attribution: "user", timestamp: 100 + transcript.length };
				transcript.push(persisted);
			}
			return notice;
		},
		request() {
			const raw = structuredClone(transcript);
			return router.applyToContext(fake.ctx, raw) ?? raw;
		},
	};
}
/** Plugin policy notices in order, by mode. */
function modes(messages: readonly AgentMessage[] | undefined): PolicyMode[] {
	return messages?.flatMap(message => policyModeOf(message) ?? []) ?? [];
}
function customCount(messages: readonly AgentMessage[] | undefined, customType: string): number {
	return messages?.filter(message => message.role === "custom" && message.customType === customType).length ?? 0;
}
/** What a provider would read: the request converted the way OMP converts it. */
function wire(messages: AgentMessage[]): string[] {
	return convertToLlm(messages).map(message => JSON.stringify(message));
}

afterEach(clearRegistry);

describe("persisted notice", () => {
	test("a governed prompt persists one hidden default notice and later prompts do not repeat it", () => {
		const t = build({ session: { enabledTools: ALL_TOOLS } });
		const notice = t.prompt(PROMPT);
		expect(notice).toEqual({
			customType: POLICY_NOTICE_TYPE,
			content: renderPolicy("default", ALL_TOOLS),
			display: false,
			details: { mode: "default" },
		});
		t.transcript.push(...toolActivity(), assistant("done"));
		for (const text of ["Now the CLI.", "And the docs."]) {
			expect(t.prompt(text)).toBeUndefined();
			t.transcript.push(assistant("done"));
		}
		expect(modes(t.transcript)).toEqual(["default"]);
		expect(modes(t.request())).toEqual(["default"]);
	});

	test("the notice comes back after compaction removed it, and not after one that kept it", () => {
		const t = build();
		t.prompt(PROMPT);
		t.transcript.push(assistant("done"));
		const notice = t.transcript.find(message => policyModeOf(message))!;
		t.transcript.splice(0, t.transcript.length, compactionSummary(), notice, assistant("kept"));
		expect(t.prompt("Continue.")).toBeUndefined();

		t.transcript.splice(0, t.transcript.length, compactionSummary(), assistant("kept"));
		expect(t.prompt("Continue again.")?.details).toEqual({ mode: "default" });
		expect(t.prompt("And again.")).toBeUndefined();
	});

	test("the latest notice governs: only a change of what it would say persists another", () => {
		const tools = ["task", "read", "todo"];
		const t = build({ session: { enabledTools: tools } });
		t.prompt(PROMPT);
		// Tools the notice does not mention leave it as it is.
		tools.push("mcp__docs__search");
		expect(t.prompt("More.")).toBeUndefined();
		// The list of `todo` is part of what it says.
		tools.splice(tools.indexOf("todo"), 1);
		expect(t.prompt("Again.")?.content).toBe(renderPolicy("default", tools));
		// The first wording is still in context, but it is no longer the latest one.
		tools.push("todo");
		expect(t.prompt("Back.")?.content).toBe(renderPolicy("default", tools));
		expect(modes(t.transcript)).toEqual(["default", "default", "default"]);
	});

	test("every prompt gets the same idempotent check: retries, steering and synthetic continuations", () => {
		const t = build();
		// A preparation OMP redoes (the first attempt never delivered) asks for the same notice.
		const first = t.router.noticeToPersist(t.ctx, PROMPT);
		expect(t.router.noticeToPersist(t.ctx, PROMPT)).toEqual(first);
		t.prompt(PROMPT);
		expect(t.prompt("Also cover the CLI.", { message: { ...user("Also cover the CLI."), steering: true, attribution: "user" } as AgentMessage })).toBeUndefined();

		const RESUME = "Resume the user's latest intent.";
		expect(t.prompt(RESUME, { message: autoContinue(RESUME) })).toBeUndefined();
		// Compaction removed the notice: the synthetic prompt that resumes the work restores it.
		t.transcript.splice(0, t.transcript.length, compactionSummary(), assistant("working"));
		expect(t.prompt(RESUME, { message: autoContinue(RESUME) })?.details).toEqual({ mode: "default" });
	});

	test("nothing is persisted where the plugin stays out", () => {
		const skipped: [string, BuildOptions, string][] = [
			["disabled", { config: { enabled: false } }, PROMPT],
			["a subagent", { main: false }, PROMPT],
			["plan mode", { session: { planMode: true } }, PROMPT],
			["a synthetic notice", {}, "<system-notice>continue</system-notice>"],
			["an empty prompt", {}, "   "],
			["no task tool", { session: { enabledTools: ["read", "edit"] } }, PROMPT],
		];
		for (const [reason, options, prompt] of skipped) {
			const t = build(options);
			expect([reason, t.prompt(prompt)]).toEqual([reason, undefined]);
			expect([reason, modes(t.transcript)]).toEqual([reason, []]);
		}
	});

	// Commands never reach before_agent_start; OMP hands the model whatever "/" text remains.
	test("a request that starts with a path or an unknown command is an ordinary prompt", () => {
		for (const prompt of ["/Users/me/app/src/main.ts crashes on startup, fix it", "/nosuchcommand do the thing"]) {
			expect(build().prompt(prompt)?.details).toEqual({ mode: "default" });
		}
	});
});

describe("prompt cache prefix", () => {
	test("every message of one turn's last request is an identical prefix of the next turn's request", () => {
		const t = build({ session: { enabledTools: ALL_TOOLS } });
		t.prompt(PROMPT);
		t.transcript.push(...toolActivity(), assistant("done"));
		const before = t.request();
		expect(modes(before)).toEqual(["default"]);

		t.prompt("Now the CLI.");
		const after = t.request();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.length).toBeGreaterThan(before.length);
		// The cache works on the provider's bytes, not on the plugin's messages.
		expect(wire(after).slice(0, wire(before).length)).toEqual(wire(before));
	});

	test("the requests inside one turn each extend the previous one", () => {
		const t = build();
		t.prompt(PROMPT);
		let previous = t.request();
		for (const next of [toolActivity(), [agentSteering()], [asyncResult()], [assistant("done")]]) {
			t.transcript.push(...next);
			const request = t.request();
			expect(request.slice(0, previous.length)).toEqual(previous);
			previous = request;
		}
		expect(modes(previous)).toEqual(["default"]);
	});

	test("a keyword turn leaves the next turn's prefix alone", () => {
		const cases: [string, AgentMessage[]][] = [
			["orchestrate", [nativeOrchestrate()]],
			["workflow", [nativeWorkflow()]],
			["both", [nativeOrchestrate(), nativeWorkflow()]],
			["another keyword", [otherKeywordNotice()]],
		];
		for (const [name, natives] of cases) {
			const t = build();
			t.prompt("orchestrate the refactor", { natives });
			t.transcript.push(...toolActivity(), assistant("done"));
			const before = t.request();
			t.prompt("And the docs.");
			const after = t.request();
			expect([name, after.slice(0, before.length)]).toEqual([name, before]);
			expect([name, wire(after).slice(0, wire(before).length)]).toEqual([name, wire(before)]);
		}
	});

	test("a worker delivery that wakes an idle session keeps the persisted notice and adds no copy", () => {
		const t = build();
		t.prompt(PROMPT);
		t.transcript.push(assistant("workers started"));
		const before = t.request();
		t.transcript.push(asyncResult());
		const woken = t.request();
		expect(modes(woken)).toEqual(["default"]);
		expect(woken.slice(0, before.length)).toEqual(before);
		expect(woken.at(-1)).toEqual(asyncResult());
	});
});

describe("withheld notices", () => {
	/** An orchestrate turn, then a workflow turn: the transcript carries each kind of notice. */
	function governedHistory(t: Host) {
		t.prompt("orchestrate the refactor", { natives: [nativeOrchestrate(1)] });
		t.transcript.push(assistant("done"));
		t.prompt("workflowz the CLI", { natives: [nativeWorkflow(2)] });
	}

	test("a disabled plugin withholds its notices at once and leaves OMP's own exactly as they are", () => {
		const t = build();
		governedHistory(t);
		expect(modes(t.request())).not.toEqual([]);
		t.config.enabled = false;
		const request = t.request();
		expect(modes(request)).toEqual([]);
		expect(request).toEqual(t.transcript.filter(message => policyModeOf(message) === undefined));
		expect(customCount(request, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
		expect(customCount(request, NATIVE_WORKFLOW_NOTICE_TYPE)).toBe(1);
		t.config.enabled = true;
		expect(modes(t.request())).not.toEqual([]);
	});

	test("plan mode and subagent sessions withhold them too", () => {
		const t = build();
		governedHistory(t);
		Object.assign(t.session, { getPlanModeState: () => ({ enabled: true }) });
		expect(modes(t.request())).toEqual([]);
		Object.assign(t.session, { getPlanModeState: () => ({ enabled: false }) });
		expect(modes(t.request())).not.toEqual([]);

		// A background clone of the main session inherits its transcript but is no main session.
		clearRegistry();
		expect(modes(t.request())).toEqual([]);
	});

	test("without `task` the delegation policy is withheld, and an orchestrate request still gets its honest notice", () => {
		const tools = [...ALL_TOOLS];
		const t = build({ session: { enabledTools: tools } });
		governedHistory(t);
		tools.splice(0, 1);
		const request = t.request();
		expect(modes(request)).toEqual(["orchestrate", "workflow"]);
		expect(t.prompt("Once more.")).toBeUndefined();
		tools.unshift("task");
		expect(modes(t.request())).toEqual(["orchestrate", "default", "workflow"]);
	});
});

describe("native keyword notices", () => {
	test("an orchestrate notice gives way to the plugin's, in place, in every turn's prefix", () => {
		const t = build();
		t.prompt("orchestrate A", { natives: [nativeOrchestrate(1)] });
		t.transcript.push(assistant("done"));
		t.prompt("orchestrate B", { natives: [nativeOrchestrate(2)] });
		const request = t.request();
		expect(customCount(request, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(modes(request)).toEqual(["orchestrate", "default", "orchestrate"]);
		expect(request).toHaveLength(t.transcript.length);
		// Each stands where its native notice stood, before the user message it belongs to.
		expect(policyModeOf(request[0])).toBe("orchestrate");
		expect(request[1]).toEqual(t.transcript[1]!);
		expect(request.findIndex(message => policyModeOf(message) === "orchestrate" && message.role === "custom" && message.timestamp === 2))
			.toBe(t.transcript.findIndex(message => message.role === "custom" && message.customType === NATIVE_ORCHESTRATE_NOTICE_TYPE && message.timestamp === 2));
		// A replay of a composed request changes nothing.
		expect(t.router.applyToContext(t.ctx, request)).toBeUndefined();
	});

	test("a workflow notice is kept and followed by exactly one supplement", () => {
		const t = build();
		t.prompt("workflowz the refactor", { natives: [nativeWorkflow(5)] });
		t.transcript.push(agentSteering());
		const request = t.request();
		const at = request.findIndex(message => message.role === "custom" && message.customType === NATIVE_WORKFLOW_NOTICE_TYPE);
		expect(request[at]).toEqual(nativeWorkflow(5));
		expect(policyModeOf(request[at + 1])).toBe("workflow");
		expect(modes(request)).toEqual(["workflow", "default"]);
		expect(t.router.applyToContext(t.ctx, request)).toBeUndefined();
	});

	test("with both in one prefix the workflow notice alone decides, so only its supplement is added", () => {
		const t = build();
		t.prompt("orchestrate workflowz the refactor", { natives: [nativeOrchestrate(3), nativeWorkflow(3)] });
		const request = t.request();
		expect(customCount(request, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(customCount(request, NATIVE_WORKFLOW_NOTICE_TYPE)).toBe(1);
		expect(modes(request)).toEqual(["workflow", "default"]);
	});

	test("a user-invoked skill prompt starts the turn its keyword notices belong to", () => {
		const SKILL = "[IMPORTANT: User invoked the \"fix\" skill; follow its instructions.]\nUser: fix the parser orchestrate";
		const skill = skillPrompt(SKILL);
		expect(currentTurnNotices([assistant("older"), nativeOrchestrate(), skill], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([1]);
		// An agent-attributed skill injection continues the earlier user turn.
		const injected = { ...skill, attribution: "agent" } as AgentMessage;
		expect(currentTurnNotices([nativeOrchestrate(), user("request"), assistant("loading"), injected], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([0]);

		const t = build();
		t.prompt("explain the parser");
		t.transcript.push(assistant("explained"));
		t.prompt(SKILL, { natives: [nativeOrchestrate(5)], message: skill });
		const request = t.request();
		expect(customCount(request, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(modes(request)).toEqual(["default", "orchestrate"]);
		expect(request.at(-1)).toEqual(skill);
	});

	test("other keyword notices and messages are never touched", () => {
		const t = build();
		t.prompt("ultrathink about it", { natives: [otherKeywordNotice()] });
		t.transcript.push(agentSteering(), asyncResult());
		const request = t.request();
		expect(request).toEqual(t.transcript);
	});

	test("the current turn's keyword prefix leaves out the notices of older turns", () => {
		expect(currentTurnNotices([assistant("older"), nativeOrchestrate(), user("new")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([1]);
		expect(currentTurnNotices([nativeOrchestrate(), user("older"), assistant("done"), user("new")], NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
	});
});

describe("compaction inside a run", () => {
	test("a request without the notice carries a copy at the end until a prompt persists one", () => {
		const t = build();
		t.prompt(PROMPT);
		t.transcript.push(...toolActivity());
		// Mid-run compaction: the notice was summarized away, and no prompt ran since.
		t.transcript.splice(0, t.transcript.length, compactionSummary(), ...toolActivity());
		const request = t.request();
		expect(modes(request)).toEqual(["default"]);
		expect(policyModeOf(request.at(-1))).toBe("default");
		expect(modes(t.transcript)).toEqual([]);

		// The copy stays last, so the requests that follow reuse everything before it.
		t.transcript.push(assistant("next"), ...toolActivity());
		const later = t.request();
		expect(later.slice(0, request.length - 1)).toEqual(request.slice(0, -1));
		expect(policyModeOf(later.at(-1))).toBe("default");
		expect(t.router.applyToContext(t.ctx, later)).toBeUndefined();

		// The next prompt persists it, and the copy is gone.
		expect(t.prompt("Continue.")?.details).toEqual({ mode: "default" });
		expect(modes(t.request())).toEqual(["default"]);
		expect(policyModeOf(t.request().at(-1))).toBe("default");
		expect(t.request().filter(message => policyModeOf(message) === "default")).toHaveLength(1);
	});

	test("a prompt the plugin skipped is still governed by a copy", () => {
		const t = build();
		t.prompt("   ");
		expect(policyModeOf(t.request().at(-1))).toBe("default");
		expect(modes(t.transcript)).toEqual([]);
	});

	test("the copy is attributed like the message it follows, so it never changes who initiated the request", () => {
		const cases: [AgentMessage, string | undefined][] = [
			[{ ...user(PROMPT), attribution: "user" } as AgentMessage, "user"],
			[agentSteering(), "agent"],
			[toolActivity()[1]!, undefined],
		];
		for (const [tail, attribution] of cases) {
			const t = build();
			t.transcript.push(compactionSummary(), tail);
			const copy = t.request().at(-1);
			expect([policyModeOf(copy), copy?.role === "custom" ? copy.attribution : "not a custom message"]).toEqual(["default", attribution]);
		}
	});
});

describe("isolation", () => {
	test("nothing shared is mutated, and a native notice is replaced by a copy", () => {
		const t = build();
		const natives = [nativeOrchestrate(1), nativeWorkflow(1)];
		t.prompt("orchestrate workflowz it", { natives });
		const frozen = t.transcript.map(message => Object.freeze(structuredClone(message)));
		const snapshot = structuredClone(frozen);
		const request = t.router.applyToContext(t.ctx, Object.freeze([...frozen]) as AgentMessage[]);
		expect(frozen).toEqual(snapshot);
		expect(request).toBeDefined();
		expect(request?.filter(message => frozen.includes(message)).length).toBeLessThan(frozen.length);
	});

	test("no mode ever changes the primary model", () => {
		for (const natives of [[], [nativeOrchestrate()], [nativeWorkflow()]]) {
			const t = build();
			t.prompt(PROMPT, { natives });
			t.request();
			expect(t.modelCalls).toEqual([]);
			expect(t.ctx.model).toEqual(t.currentModel);
		}
	});
});

describe("debug log", () => {
	test("one metrics line per governed prompt and per keyword notice, never the prompt text", () => {
		const t = build({ debug: true });
		const secretPrompt = "Refactor the ingestion pipeline with token abc123.";
		t.prompt(secretPrompt);
		t.request();
		t.request();
		t.prompt("   ");
		expect(t.logs).toEqual(["debug om-orche.policy mode=default", "debug om-orche.policy skip=empty-prompt"]);

		t.logs.length = 0;
		t.prompt("orchestrate it", { natives: [nativeOrchestrate(7)] });
		t.request();
		t.request();
		expect(t.logs).toEqual(["debug om-orche.policy mode=default", "debug om-orche.policy mode=orchestrate"]);
	});

	test("nothing is logged unless debug logging is on", () => {
		const t = build();
		t.prompt(PROMPT, { natives: [nativeOrchestrate()] });
		t.request();
		expect(t.logs).toEqual([]);
	});
});

// What the rendered notices carry depends on the tools enabled and on the mode. These check that
// dependence, not what the notices tell the model or what the model then does.
describe("tool- and mode-dependent content", () => {
	const tools = [...ALL_TOOLS, "orche_advisor"];
	const withoutTask = tools.filter(name => name !== "task");

	test("the default policy names the todo list and the advice call only when those tools are enabled", () => {
		expect(renderPolicy("default", tools)).toMatch(/todo/);
		expect(renderPolicy("default", tools)).toMatch(/advice/);
		expect(renderPolicy("default", ["task", "read"])).not.toMatch(/todo|advice/);
	});

	test("worker follow-up through `write agent://<id>` is offered only when `write` is enabled", () => {
		expect(renderPolicy("default", tools)).toContain("write agent://<id>");
		expect(renderPolicy("default", tools.filter(name => name !== "write"))).not.toContain("agent://");
	});

	test("the `effort` guidance needs `task`, and project checks are named only with `bash`", () => {
		expect(renderPolicy("default", tools)).toContain("`effort`");
		expect(renderPolicy("default", withoutTask)).not.toContain("`effort`");
		expect(renderPolicy("default", tools)).toContain("project checks");
		expect(renderPolicy("default", tools.filter(name => name !== "bash"))).not.toContain("project checks");
	});

	test("an orchestrate notice is a short addition to the policy in context, not a second copy of it", () => {
		expect(renderPolicy("orchestrate", tools).length).toBeLessThan(renderPolicy("default", tools).length / 5);
	});

	test("without `task` an orchestrate notice never offers delegation", () => {
		expect(renderPolicy("orchestrate", withoutTask)).not.toMatch(/tasks\[\]|agent:\/\/|parallel|Production \(/);
	});

	test("the workflow supplement carries none of the method's choices, which stay with the native notice", () => {
		expect(renderPolicy("workflow", tools)).not.toMatch(/tasks\[\]|agent:\/\/|parallel|reuse|dispatch/i);
	});
});
