import { afterEach, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { normalizeConfig, type OrcheConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { OrchestrationRouter } from "../src/orchestration.ts";
import {
	isPolicySection,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	POLICY_NOTICE_TYPE,
	type PolicyContext,
	type PolicyMode,
	policyModeOf,
	renderKeywordNotice,
	renderPolicy,
} from "../src/orchestration-policy.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { FakeSession, FakeSessionOptions } from "./harness.ts";

const PROMPT = "Refactor the ingestion pipeline.";
const ALL_TOOLS = ["task", "read", "edit", "write", "bash", "todo"];
/** Stands in for OMP's base system prompt, which every prompt starts from. */
const BASE = ["base system prompt"];

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;
}
function agentSteering(text = "Worker A is available."): AgentMessage {
	return { ...user(text), steering: true, attribution: "agent" } as AgentMessage;
}
function userSteering(text: string): AgentMessage {
	return { ...user(text), steering: true, attribution: "user" } as AgentMessage;
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
function toolActivity(): AgentMessage[] {
	const call = { role: "assistant", content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "init" } }] } as unknown as AgentMessage;
	const result = { role: "toolResult", toolName: "todo", toolCallId: "todo-1", content: [], isError: false, timestamp: 0 } as AgentMessage;
	return [call, result];
}
/** What an earlier build persisted with the prompt that needed it. */
function persistedPolicy(text = "earlier build's policy"): AgentMessage {
	return { role: "custom", customType: POLICY_NOTICE_TYPE, content: text, display: false, details: { mode: "default" }, attribution: "user", timestamp: 50 } as AgentMessage;
}

interface BuildOptions {
	session?: FakeSessionOptions;
	main?: boolean;
	config?: Partial<OrcheConfig>;
	debug?: boolean;
	/** `task.enableEffort`. */
	effort?: boolean;
}

/** What a prompt brings into the transcript besides its own text. */
interface Delivery {
	/** The keyword notices OMP queues ahead of the user's message. */
	natives?: AgentMessage[];
	/** The message delivered for the prompt, when it is not a plain user message. */
	message?: AgentMessage;
}

/** Everything one provider request carries that the plugin touches. */
interface Request {
	system: string[];
	messages: AgentMessage[];
}

interface Host extends FakeSession {
	router: OrchestrationRouter;
	config: OrcheConfig;
	currentModel: Model;
	transcript: AgentMessage[];
	logs: string[];
	/** The system prompt the agent holds right now. */
	readonly system: string[];
	/**
	 * Deliver a prompt as OMP does: `before_agent_start` runs first, the system prompt it returns becomes
	 * the turn's (the base otherwise), then the delivered messages join the transcript. Returns the
	 * system prompt the handler asked for, if any.
	 */
	prompt(text: string, delivery?: Delivery): string[] | undefined;
	/** A rebuild of the base prompt between turns: the agent falls back to the plain base. */
	rebuildBase(): void;
	/** What the provider receives for the next request. */
	request(): Request;
}

/** OMP's prompt path, reduced to what the policy depends on. Tests append assistant and tool messages to `transcript`. */
function build(options: BuildOptions = {}): Host {
	const currentModel = options.session?.currentModel ?? fakeModel("p", "explicit-choice");
	const fake = makeSession({ currentModel, ...options.session });
	if (options.effort) Object.assign(fake.session, { settings: Settings.isolated({ "task.enableEffort": true }) });
	const transcript: AgentMessage[] = [];
	const system = [...BASE];
	Object.assign(fake.ctx, { getSystemPrompt: () => system });
	if (options.main !== false) registerAsMain(fake.session);
	else clearRegistry();
	const api = makeApi();
	const logger = new RouteLogger(api.pi.logger);
	logger.setEnabled(options.debug === true);
	const config = { ...normalizeConfig(undefined), ...options.config };
	const router = new OrchestrationRouter({ logger, config: () => config });
	return {
		...fake, router, config, currentModel, transcript, logs: api.logs,
		get system() {
			return system;
		},
		prompt(text, delivery = {}) {
			const applied = router.withPolicy(fake.ctx, BASE);
			system.splice(0, system.length, ...(applied ?? BASE));
			transcript.push(...(delivery.natives ?? []), delivery.message ?? user(text));
			return applied;
		},
		rebuildBase() {
			system.splice(0, system.length, ...BASE);
		},
		request() {
			const raw = structuredClone(transcript);
			return { system: [...system], messages: router.applyToContext(fake.ctx, raw) ?? raw };
		},
	};
}
/** Plugin messages in order, by mode. */
function modes(messages: readonly AgentMessage[] | undefined): PolicyMode[] {
	return messages?.flatMap(message => policyModeOf(message) ?? []) ?? [];
}
function customCount(messages: readonly AgentMessage[] | undefined, customType: string): number {
	return messages?.filter(message => message.role === "custom" && message.customType === customType).length ?? 0;
}
function textOf(message: AgentMessage | undefined): string {
	return message?.role === "custom" && typeof message.content === "string" ? message.content : "";
}
/** What a provider would read of the messages: converted the way OMP converts them. */
function wire(messages: AgentMessage[]): string[] {
	return convertToLlm(messages).map(message => JSON.stringify(message));
}
/** The plugin's element of a system prompt. */
function policyOf(system: readonly string[] | undefined): string | undefined {
	return system?.find(isPolicySection);
}

afterEach(clearRegistry);

describe("policy in the system prompt", () => {
	test("a governed prompt appends the policy once, after the base prompt, and adds nothing to the transcript", () => {
		const t = build({ session: { enabledTools: ALL_TOOLS } });
		const applied = t.prompt(PROMPT);
		expect(applied).toHaveLength(BASE.length + 1);
		expect(applied?.slice(0, BASE.length)).toEqual(BASE);
		expect(isPolicySection(applied!.at(-1)!)).toBe(true);
		expect(t.system).toEqual(applied!);
		expect(BASE).toEqual(["base system prompt"]);
		expect(t.transcript).toEqual([user(PROMPT)]);
		expect(modes(t.request().messages)).toEqual([]);
		// An element that is already there is never added again.
		expect(t.router.withPolicy(t.ctx, applied!)).toBeUndefined();
	});

	test("the system prompt is identical across user turns, steering and synthetic prompts", () => {
		const t = build();
		t.prompt(PROMPT);
		const first = t.request().system;
		expect(policyOf(first)).toBeDefined();
		const SKILL = "[IMPORTANT: User invoked the \"fix\" skill; follow its instructions.]\nUser: fix the parser";
		const RESUME = "Resume the user's latest intent.";
		const prompts: [string, Delivery?][] = [
			["Now the CLI."],
			["Also cover the docs.", { message: userSteering("Also cover the docs.") }],
			[RESUME, { message: autoContinue(RESUME) }],
			["<system-notice>\nBackground job bg_1 has completed</system-notice>", { message: autoContinue("Background job bg_1 has completed") }],
			["   ", { message: autoContinue("   ") }],
			[SKILL, { message: skillPrompt(SKILL) }],
			[PROMPT],
		];
		for (const [text, delivery] of prompts) {
			t.transcript.push(assistant("done"));
			t.prompt(text, delivery);
			expect([text, t.request().system]).toEqual([text, first]);
		}
	});

	test("a change in what the text names changes the element; a change it does not name leaves it alone", () => {
		const tools = ["task", "read", "todo"];
		const t = build({ session: { enabledTools: tools } });
		const first = policyOf(t.prompt(PROMPT));
		tools.push("mcp__docs__search");
		expect(policyOf(t.prompt("More."))).toBe(first);
		tools.splice(tools.indexOf("todo"), 1);
		expect(policyOf(t.prompt("Again."))).not.toBe(first);
	});

	test("the `effort` guidance is part of the element only while the host's schema has `effort`", () => {
		const without = policyOf(build().prompt(PROMPT))!;
		const withEffort = policyOf(build({ effort: true }).prompt(PROMPT))!;
		expect(withEffort.length).toBeGreaterThan(without.length);
		expect(withEffort.length - without.length).toBeLessThan(500);
	});

	test("the plugin stays out where it does not govern", () => {
		const cases: [string, BuildOptions][] = [
			["disabled", { config: { enabled: false } }],
			["a subagent", { main: false }],
			["plan mode", { session: { planMode: true } }],
			["no task tool", { session: { enabledTools: ["read", "edit"] } }],
		];
		for (const [reason, options] of cases) {
			const t = build(options);
			expect([reason, t.prompt(PROMPT)]).toEqual([reason, undefined]);
			expect([reason, t.system]).toEqual([reason, BASE]);
		}
	});

	test("a live change of the gate applies from the next prompt", () => {
		const t = build();
		expect(policyOf(t.prompt(PROMPT))).toBeDefined();
		t.config.enabled = false;
		expect(t.prompt("Next.")).toBeUndefined();
		expect(t.system).toEqual(BASE);
		t.config.enabled = true;
		Object.assign(t.session, { getPlanModeState: () => ({ enabled: true }) });
		expect(t.prompt("Plan.")).toBeUndefined();
		Object.assign(t.session, { getPlanModeState: () => ({ enabled: false }) });
		expect(policyOf(t.prompt("Back."))).toBeDefined();
	});
});

describe("request prefix stability", () => {
	test("every message of one turn's last request is an identical prefix of the next turn's, and the system prompt is the same", () => {
		const t = build({ session: { enabledTools: ALL_TOOLS } });
		t.prompt(PROMPT);
		t.transcript.push(...toolActivity(), assistant("done"));
		const before = t.request();

		t.prompt("Now the CLI.");
		const after = t.request();
		expect(after.system).toEqual(before.system);
		expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
		expect(after.messages.length).toBeGreaterThan(before.messages.length);
		// The cache works on the provider's bytes, not on the plugin's messages.
		expect(wire(after.messages).slice(0, wire(before.messages).length)).toEqual(wire(before.messages));
	});

	test("the requests inside one turn each extend the previous one", () => {
		const t = build();
		t.prompt(PROMPT);
		let previous = t.request();
		for (const next of [toolActivity(), [agentSteering()], [asyncResult()], [assistant("done")]]) {
			t.transcript.push(...next);
			const request = t.request();
			expect(request.system).toEqual(previous.system);
			expect(request.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
			previous = request;
		}
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
			expect([name, after.system]).toEqual([name, before.system]);
			expect([name, after.messages.slice(0, before.messages.length)]).toEqual([name, before.messages]);
			expect([name, wire(after.messages).slice(0, wire(before.messages).length)]).toEqual([name, wire(before.messages)]);
		}
	});

	test("a worker delivery that wakes an idle session runs with the same system prompt and the same prefix", () => {
		const t = build();
		t.prompt(PROMPT);
		t.transcript.push(assistant("workers started"));
		const before = t.request();
		t.transcript.push(asyncResult());
		const woken = t.request();
		expect(woken.system).toEqual(before.system);
		expect(woken.messages.slice(0, before.messages.length)).toEqual(before.messages);
		expect(woken.messages.at(-1)).toEqual(asyncResult());
		expect(modes(woken.messages)).toEqual([]);
	});
});

describe("notices an earlier build persisted", () => {
	test("are dropped from every request, in place of nothing else, whether or not the plugin governs", () => {
		const t = build();
		const history = [user("Earlier."), persistedPolicy(), assistant("done"), nativeOrchestrate(3), user(PROMPT)];
		t.transcript.push(...history);
		const governed = t.request().messages;
		expect(modes(governed)).toEqual(["orchestrate"]);
		expect(customCount(governed, POLICY_NOTICE_TYPE)).toBe(1);
		expect(governed.map(message => message.role)).toEqual(["user", "assistant", "custom", "user"]);
		// The same input gives the same output every time: what the cache sees never wobbles.
		expect(t.request().messages).toEqual(governed);

		t.config.enabled = false;
		const withheld = t.request().messages;
		expect(withheld).toEqual(history.filter(message => policyModeOf(message) === undefined));
		expect(customCount(withheld, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(1);
	});

	test("are dropped without `task` as well, and a stand-in an earlier run of the hook made is kept", () => {
		const t = build({ session: { enabledTools: ["read", "edit"] } });
		t.transcript.push(persistedPolicy(), nativeOrchestrate(), user(PROMPT));
		const composed = t.request().messages;
		expect(modes(composed)).toEqual(["orchestrate"]);
		expect(t.router.applyToContext(t.ctx, composed)).toBeUndefined();
	});
});

describe("withheld messages", () => {
	function keywordHistory(t: Host) {
		t.transcript.push(persistedPolicy(), nativeOrchestrate(1), user("orchestrate the refactor"), assistant("done"),
			nativeWorkflow(2), user("workflowz the CLI"));
	}

	test("a disabled plugin withholds its messages at once and leaves OMP's own exactly as OMP built them", () => {
		const t = build();
		keywordHistory(t);
		const composed = t.request().messages;
		expect(modes(composed)).toEqual(["orchestrate", "workflow"]);
		t.config.enabled = false;
		const request = t.request().messages;
		expect(modes(request)).toEqual([]);
		expect(request).toEqual(t.transcript.filter(message => policyModeOf(message) === undefined));
		// Counterparts already made for a request the plugin then stops governing go with it.
		expect(t.router.applyToContext(t.ctx, composed)?.filter(message => policyModeOf(message) !== undefined)).toEqual([]);
		t.config.enabled = true;
		expect(modes(t.request().messages)).toEqual(["orchestrate", "workflow"]);
	});

	test("plan mode and subagent sessions withhold them too", () => {
		const t = build();
		keywordHistory(t);
		Object.assign(t.session, { getPlanModeState: () => ({ enabled: true }) });
		expect(modes(t.request().messages)).toEqual([]);
		Object.assign(t.session, { getPlanModeState: () => ({ enabled: false }) });
		expect(modes(t.request().messages)).toEqual(["orchestrate", "workflow"]);

		// A background clone of the main session inherits its transcript but is no main session.
		clearRegistry();
		expect(modes(t.request().messages)).toEqual([]);
	});

	test("without `task` an orchestrate request still gets its honest counterpart", () => {
		const tools = [...ALL_TOOLS];
		const t = build({ session: { enabledTools: tools } });
		keywordHistory(t);
		tools.splice(0, 1);
		expect(modes(t.request().messages)).toEqual(["orchestrate", "workflow"]);
		expect(t.prompt("Once more.")).toBeUndefined();
	});
});

describe("native keyword notices", () => {
	test("an orchestrate notice gives way to the plugin's, in place, in every turn's prefix", () => {
		const t = build();
		t.prompt("orchestrate A", { natives: [nativeOrchestrate(1)] });
		t.transcript.push(assistant("done"));
		t.prompt("orchestrate B", { natives: [nativeOrchestrate(2)] });
		const { messages } = t.request();
		expect(customCount(messages, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(modes(messages)).toEqual(["orchestrate", "orchestrate"]);
		expect(messages).toHaveLength(t.transcript.length);
		// Each stands where its native notice stood, before the user message it belongs to, and is dated like it.
		for (const stamp of [1, 2]) {
			const at = t.transcript.findIndex(message => message.role === "custom" && message.customType === NATIVE_ORCHESTRATE_NOTICE_TYPE && message.timestamp === stamp);
			const stand = messages[at];
			expect(policyModeOf(stand)).toBe("orchestrate");
			expect(stand?.role === "custom" && stand.timestamp).toBe(stamp);
			expect(messages[at + 1]?.role).toBe("user");
		}
		// A replay of a composed request changes nothing.
		expect(t.router.applyToContext(t.ctx, messages)).toBeUndefined();
	});

	test("a workflow notice is kept and followed by exactly one supplement", () => {
		const t = build();
		t.prompt("workflowz the refactor", { natives: [nativeWorkflow(5)] });
		t.transcript.push(agentSteering());
		const { messages } = t.request();
		const at = messages.findIndex(message => message.role === "custom" && message.customType === NATIVE_WORKFLOW_NOTICE_TYPE);
		expect(messages[at]).toEqual(nativeWorkflow(5));
		expect(policyModeOf(messages[at + 1])).toBe("workflow");
		expect(modes(messages)).toEqual(["workflow"]);
		expect(t.router.applyToContext(t.ctx, messages)).toBeUndefined();
	});

	test("with both in one prefix the workflow notice alone decides, so only its supplement is added", () => {
		const t = build();
		t.prompt("orchestrate workflowz the refactor", { natives: [nativeOrchestrate(3), nativeWorkflow(3)] });
		const { messages } = t.request();
		expect(customCount(messages, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(customCount(messages, NATIVE_WORKFLOW_NOTICE_TYPE)).toBe(1);
		expect(modes(messages)).toEqual(["workflow"]);
	});

	test("keyword notices OMP queues before a user-invoked skill prompt belong to that prompt", () => {
		const SKILL = "[IMPORTANT: User invoked the \"fix\" skill; follow its instructions.]\nUser: fix the parser orchestrate";
		const skill = skillPrompt(SKILL);
		const t = build();
		t.prompt("explain the parser");
		t.transcript.push(assistant("explained"));
		t.prompt(SKILL, { natives: [nativeOrchestrate(5)], message: skill });
		const { messages } = t.request();
		expect(customCount(messages, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toBe(0);
		expect(modes(messages)).toEqual(["orchestrate"]);
		expect(messages.at(-1)).toEqual(skill);

		// An agent-attributed skill injection is no turn start, so a workflow notice before it is not its own.
		const injected = { ...skill, attribution: "agent" } as AgentMessage;
		expect(prefixModes([nativeOrchestrate(), nativeWorkflow(), injected])).toEqual(["workflow"]);
	});

	function prefixModes(natives: AgentMessage[]): PolicyMode[] {
		const t = build();
		t.transcript.push(...natives);
		return modes(t.request().messages);
	}

	test("other keyword notices and messages are never touched", () => {
		const t = build();
		t.prompt("ultrathink about it", { natives: [otherKeywordNotice()] });
		t.transcript.push(agentSteering(), asyncResult());
		expect(t.request().messages).toEqual(t.transcript);
	});
});

describe("the workflow supplement follows the system prompt it is sent with", () => {
	function supplementLength(request: Request): number {
		return textOf(request.messages.find(message => policyModeOf(message) === "workflow")).length;
	}

	test("it only points at the policy while the policy is in the system prompt, and carries the duties itself otherwise", () => {
		const t = build();
		t.prompt("workflowz the refactor", { natives: [nativeWorkflow(5)] });
		const pointing = t.request();
		expect(policyOf(pointing.system)).toBeDefined();
		t.rebuildBase();
		const carrying = t.request();
		expect(policyOf(carrying.system)).toBeUndefined();
		expect(supplementLength(carrying)).toBeGreaterThan(supplementLength(pointing) * 3);
		// The next prompt applies the policy again and the supplement shrinks back.
		t.prompt("And the docs.");
		expect(supplementLength(t.request())).toBe(supplementLength(pointing));
	});

	test("each request's text is a function of that request alone: repeated requests are byte-identical", () => {
		const t = build();
		t.prompt("workflowz the refactor", { natives: [nativeWorkflow(5)] });
		t.transcript.push(assistant("done"), ...toolActivity());
		const first = t.request();
		expect(t.request()).toEqual(first);
		t.transcript.push(agentSteering());
		expect(t.request().messages.slice(0, first.messages.length)).toEqual(first.messages);
	});
});

describe("isolation", () => {
	test("nothing shared is mutated, and a native notice is replaced by a copy", () => {
		const t = build();
		t.prompt("orchestrate workflowz it", { natives: [nativeOrchestrate(1), nativeWorkflow(1)] });
		t.transcript.splice(0, 0, persistedPolicy());
		const frozen = t.transcript.map(message => Object.freeze(structuredClone(message)));
		const snapshot = structuredClone(frozen);
		const request = t.router.applyToContext(t.ctx, Object.freeze([...frozen]) as AgentMessage[]);
		expect(frozen).toEqual(snapshot);
		expect(request).toBeDefined();
		expect(request?.filter(message => frozen.includes(message)).length).toBeLessThan(frozen.length);
	});

	test("no prompt ever changes the primary model", () => {
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
	test("one metrics line per prompt and per keyword notice, never the prompt text", () => {
		const t = build({ debug: true });
		const secretPrompt = "Refactor the ingestion pipeline with token abc123.";
		t.prompt(secretPrompt);
		t.request();
		t.request();
		// A synthetic or empty prompt gets the same system prompt and the same line: the text never decides.
		t.prompt("   ", { message: autoContinue("   ") });
		expect(t.logs).toEqual(["debug om-orche.policy mode=default", "debug om-orche.policy mode=default"]);

		t.logs.length = 0;
		t.prompt("orchestrate it", { natives: [nativeOrchestrate(7)] });
		t.request();
		t.request();
		expect(t.logs).toEqual(["debug om-orche.policy mode=default", "debug om-orche.policy mode=orchestrate"]);
	});

	test("each reason to stay out is logged with its own bounded name", () => {
		const cases: [string, BuildOptions][] = [
			["disabled", { config: { enabled: false } }],
			["not-main-session", { main: false }],
			["plan-mode", { session: { planMode: true } }],
			["task-tool-unavailable", { session: { enabledTools: ["read"] } }],
		];
		for (const [reason, options] of cases) {
			const t = build({ ...options, debug: true });
			t.prompt(PROMPT);
			expect(t.logs).toEqual([`debug om-orche.policy skip=${reason}`]);
		}
	});

	test("nothing is logged unless debug logging is on", () => {
		const t = build();
		t.prompt(PROMPT, { natives: [nativeOrchestrate()] });
		t.request();
		expect(t.logs).toEqual([]);
	});
});

// What the rendered texts carry depends on the tools enabled, the settings and the mode. These check that
// dependence, not what the texts tell the model or what the model then does.
describe("tool- and mode-dependent content", () => {
	const tools = [...ALL_TOOLS, "orche_advisor"];
	const withoutTask = tools.filter(name => name !== "task");
	const context = (enabled: readonly string[] = tools, effort = false): PolicyContext => ({ tools: enabled, effort });

	test("the policy names the todo list and the advice call only when those tools are enabled", () => {
		expect(renderPolicy(context())).toMatch(/todo/);
		expect(renderPolicy(context())).toMatch(/advice/);
		expect(renderPolicy(context(["task", "read"]))).not.toMatch(/todo|advice/);
	});

	test("worker follow-up through `write agent://<id>` is offered only when `write` is enabled", () => {
		expect(renderPolicy(context())).toContain("write agent://<id>");
		expect(renderPolicy(context(tools.filter(name => name !== "write")))).not.toContain("agent://");
	});

	test("the `effort` guidance needs both `task` and the setting, and project checks are named only with `bash`", () => {
		expect(renderPolicy(context(tools, true)).length).toBeGreaterThan(renderPolicy(context(tools, false)).length);
		expect(renderPolicy(context(withoutTask, true))).toBe(renderPolicy(context(withoutTask, false)));
		expect(renderPolicy(context())).not.toBe(renderPolicy(context(tools.filter(name => name !== "bash"))));
	});

	test("an orchestrate counterpart is a short addition to the policy, not a second copy of it", () => {
		expect(renderKeywordNotice("orchestrate", context(), true).length).toBeLessThan(renderPolicy(context()).length / 10);
		// It may point at the policy only while the policy is there.
		expect(renderKeywordNotice("orchestrate", context(), true)).not.toBe(renderKeywordNotice("orchestrate", context(), false));
	});

	test("without `task` an orchestrate counterpart never offers delegation", () => {
		expect(renderKeywordNotice("orchestrate", context(withoutTask), false)).not.toMatch(/tasks\[\]|agent:\/\/|parallel|Production \(/);
	});

	test("the workflow supplement carries none of the method's choices, which stay with the native notice", () => {
		for (const policyInPrompt of [true, false]) {
			expect(renderKeywordNotice("workflow", context(), policyInPrompt)).not.toMatch(/tasks\[\]|agent:\/\/|parallel|reuse|dispatch/i);
		}
	});

	test("with the policy in the system prompt the workflow supplement is a small fraction of the one that carries the duties", () => {
		const lean = renderKeywordNotice("workflow", context(), true);
		const full = renderKeywordNotice("workflow", context(), false);
		expect(lean.length).toBeLessThan(full.length / 3);
	});
});
