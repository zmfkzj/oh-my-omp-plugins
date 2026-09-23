import { afterEach, describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import {
	noticeInsertIndex,
	ORCHESTRATE_NOTICE_TYPE,
	OrchestrationRouter,
	priorUserRequests,
	turnHasNativeOrchestrateNotice,
	UNCERTAIN_NOTICE_TYPE,
} from "../src/orchestration.ts";
import { Telemetry } from "../src/telemetry.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain, ScriptedDecider } from "./harness.ts";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { JevRouterConfig } from "../src/config.ts";
import type { RoleSelection } from "../src/host.ts";
import type { FakeSessionOptions, ScriptedOrchestration } from "./harness.ts";

function build(
	decider: ScriptedDecider,
	options: {
		session?: FakeSessionOptions;
		main?: boolean;
		apiKey?: string | undefined;
		config?: Partial<JevRouterConfig>;
		roles?: Record<string, RoleSelection>;
	} = {},
) {
	const std = fakeModel("p", "std");
	const deep = fakeModel("p", "deep");
	const fake = makeSession({ currentModel: std, ...options.session });
	if (options.main !== false) registerAsMain(fake.session);
	else clearRegistry();
	const telemetry = new Telemetry("/tmp/jev-router-test-state");
	telemetry.setEnabled(false);
	const roles: Record<string, RoleSelection> = options.roles ?? { default: { model: std }, slow: { model: deep, thinkingLevel: ThinkingLevel.High } };
	const router = new OrchestrationRouter({
		engine: decider,
		logger: new RouteLogger(makeApi().pi.logger),
		telemetry,
		credential: async () => ("apiKey" in options ? options.apiKey : "ts_test_key"),
		config: () => ({ ...normalizeConfig(undefined), ...options.config }),
		resolveRole: (_ctx, role) => roles[role],
	});
	return { router, ...fake, std, deep };
}

/** A turn's provider context: optional hidden companions, then the user message. */
function turn(prompt: string, companions: AgentMessage[] = [], trailing: AgentMessage[] = []): AgentMessage[] {
	return [
		{ role: "assistant", content: [{ type: "text", text: "earlier reply" }] } as AgentMessage,
		...companions,
		{ role: "user", content: [{ type: "text", text: prompt }] } as AgentMessage,
		...trailing,
	];
}

/** Custom types present in a message list, for assertions. */
function customTypes(messages: AgentMessage[] | undefined): string[] {
	return (messages ?? [])
		.filter((message): message is AgentMessage & { customType: string } => message.role === "custom")
		.map(message => message.customType);
}

function notice(customType: string): AgentMessage {
	return { role: "custom", customType, content: "x", display: false, attribution: "user" } as AgentMessage;
}

async function route(
	decider: ScriptedDecider,
	prompt: string,
	options: Parameters<typeof build>[1] = {},
	messages?: AgentMessage[],
) {
	const { router, ctx, modelCalls, setCurrentModel, setModelRoleProvenance, std, deep } = build(decider, options);
	await router.beginTurn(ctx, prompt);
	const applied = await router.applyToContext(ctx, messages ?? turn(prompt));
	return { router, ctx, applied, modelCalls, setCurrentModel, setModelRoleProvenance, std, deep };
}

const CONFIDENT_ORCHESTRATE: ScriptedOrchestration = {
	top: "ORCHESTRATE",
	confidence: 0.92,
	margin: 0.84,
	confident: true,
};

afterEach(() => clearRegistry());

describe("native notice detection", () => {
	test("only the current turn's hidden companion run counts", () => {
		expect(turnHasNativeOrchestrateNotice(turn("hi", [notice(ORCHESTRATE_NOTICE_TYPE)]))).toBe(true);
		expect(turnHasNativeOrchestrateNotice(turn("hi", [notice("ultrathink-notice")]))).toBe(false);
		// A notice from an earlier turn sits behind that turn's own user message.
		const previousTurn: AgentMessage[] = [
			notice(ORCHESTRATE_NOTICE_TYPE),
			{ role: "user", content: [{ type: "text", text: "turn 1" }] } as AgentMessage,
			{ role: "assistant", content: [{ type: "text", text: "done" }] } as AgentMessage,
			{ role: "user", content: [{ type: "text", text: "turn 2" }] } as AgentMessage,
		];
		expect(turnHasNativeOrchestrateNotice(previousTurn)).toBe(false);
	});

	test("the notice is inserted where OMP puts its own", () => {
		const messages = turn("hi", [notice("ultrathink-notice")]);
		expect(noticeInsertIndex(messages)).toBe(messages.length - 1);
		// Mid-turn continuations keep the same anchor so the position is stable.
		expect(noticeInsertIndex(turn("hi", [], [notice("x")]))).toBe(1);
	});
});

describe("front-door routing", () => {
	const SLOW: ScriptedOrchestration = { top: "SLOW", confidence: 0.91, margin: 0.72, confident: true };
	const DEFAULT: ScriptedOrchestration = { top: "DEFAULT", confidence: 0.91, margin: 0.72, confident: true };

	test("SLOW switches before context is built, without a notice", async () => {
		const decider = new ScriptedDecider(SLOW);
		const { router, ctx, modelCalls, deep } = build(decider);
		await router.beginTurn(ctx, "Diagnose concurrent ledger reads.");
		expect(modelCalls).toEqual([{ model: deep, thinkingLevel: "high", ephemeral: true }]);
		expect(ctx.model).toEqual(deep);
		expect(await router.applyToContext(ctx, turn("Diagnose concurrent ledger reads."))).toBeUndefined();
		expect(router.lastDecision).toMatchObject({ outcome: "SLOW", model: "@slow" });
		expect(modelCalls).toHaveLength(1);
	});

	test("a settled SLOW turn restores model and thinking level once", async () => {
		const { router, ctx, modelCalls, std, deep } = await route(new ScriptedDecider(SLOW), "Trace concurrent state.");
		await router.endTurn(ctx.model);
		expect(modelCalls).toEqual([
			{ model: deep, thinkingLevel: "high", ephemeral: true },
			{ model: std, thinkingLevel: "medium", ephemeral: true },
		]);
		expect(ctx.model).toEqual(std);
		await router.endTurn(ctx.model);
		expect(modelCalls).toHaveLength(2);
	});

	test("UNCERTAIN upgrades to SLOW and carries the non-orchestration hint", async () => {
		const decider = new ScriptedDecider({ top: "DEFAULT", confidence: 0.54, margin: 0.08, confident: false });
		const { router, applied, modelCalls, deep } = await route(decider, "Improve ingestion consistency.");
		expect(modelCalls).toEqual([{ model: deep, thinkingLevel: "high", ephemeral: true }]);
		expect(customTypes(applied)).toEqual([UNCERTAIN_NOTICE_TYPE]);
		expect(router.lastDecision).toMatchObject({ outcome: "UNCERTAIN", model: "@slow" });
		expect(decider.orchestrationCalls).toBe(1);
	});

	test("DEFAULT keeps the model and adds no notice", async () => {
		const { router, applied, modelCalls } = await route(new ScriptedDecider(DEFAULT), "Fix pagination.");
		expect(applied).toBeUndefined();
		expect(modelCalls).toEqual([]);
		expect(router.lastDecision).toMatchObject({ outcome: "DEFAULT", model: "kept" });
	});

	test("ORCHESTRATE keeps the model and injects OMP's own contract", async () => {
		const { applied, modelCalls } = await route(new ScriptedDecider(CONFIDENT_ORCHESTRATE), "Migrate auth and independently rewrite billing.");
		expect(modelCalls).toEqual([]);
		const injected = applied?.find(message => message.role === "custom") as
			| { customType: string; content: string; display: boolean; attribution: string }
			| undefined;
		expect(injected).toMatchObject({ customType: ORCHESTRATE_NOTICE_TYPE, display: false, attribution: "user" });
		expect(injected?.content).toContain("orchestration request");
	});

	test("a manually chosen third or deep model always wins", async () => {
		for (const currentModel of [fakeModel("p", "other"), fakeModel("p", "deep")]) {
			const { router, ctx, modelCalls } = await route(new ScriptedDecider(SLOW), "Debug scheduler.", { session: { currentModel } });
			expect(modelCalls).toEqual([]);
			expect(router.lastDecision?.model).toBe("skip:explicit-model");
			expect(ctx.model).toEqual(currentModel);
		}
	});

	test("a CLI --model override remains explicit even when it rewrites the default role", async () => {
		const luna = fakeModel("p", "luna");
		const deep = fakeModel("p", "deep");
		const { router, ctx, modelCalls } = await route(new ScriptedDecider(SLOW), "Debug scheduler.", {
			session: { currentModel: luna, modelRoleProvenance: "runtime" },
			roles: { default: { model: luna }, slow: { model: deep } },
		});
		expect(router.lastDecision?.model).toBe("skip:explicit-model");
		expect(ctx.model).toEqual(luna);
		expect(modelCalls).toEqual([]);
	});

	test("choosing the already-switched deep model explicitly prevents restoration", async () => {
		const { router, ctx, modelCalls, deep, setModelRoleProvenance } = await route(new ScriptedDecider(SLOW), "Debug scheduler.");
		setModelRoleProvenance("runtime");
		await router.endTurn(ctx.model);
		expect(ctx.model).toEqual(deep);
		expect(modelCalls).toHaveLength(1);
	});

	test("a mid-turn /model choice is not overwritten at settlement", async () => {
		const { router, ctx, modelCalls, setCurrentModel } = await route(new ScriptedDecider(SLOW), "Debug scheduler.");
		const other = fakeModel("p", "other");
		setCurrentModel(other);
		await router.endTurn(ctx.model);
		expect(modelCalls).toHaveLength(1);
		expect(ctx.model).toEqual(other);
	});

	test("an explicit orchestrate keyword retains its notice after the front-door decision", async () => {
		const decider = new ScriptedDecider(SLOW);
		const prompt = "orchestrate the migration";
		const messages = turn(prompt, [notice(ORCHESTRATE_NOTICE_TYPE)]);
		const { router, ctx, applied, modelCalls, deep } = await route(decider, prompt, {}, messages);
		expect(applied).toBeUndefined();
		expect(await router.applyToContext(ctx, messages)).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(1);
		expect(modelCalls).toEqual([{ model: deep, thinkingLevel: "high", ephemeral: true }]);
		expect(router.lastDecision).toMatchObject({ outcome: "SLOW", model: "@slow" });
	});

	test("a new prompt in the same turn can immediately restore a SLOW choice", async () => {
		const decider = new ScriptedDecider([SLOW, DEFAULT]);
		const { router, ctx, modelCalls, std, deep } = build(decider);
		await router.beginTurn(ctx, "Investigate inconsistent reads.");
		await router.beginTurn(ctx, "Just rename the local variable.");
		expect(modelCalls).toEqual([
			{ model: deep, thinkingLevel: "high", ephemeral: true },
			{ model: std, thinkingLevel: "medium", ephemeral: true },
		]);
		expect(router.lastDecision).toMatchObject({ outcome: "DEFAULT", model: "kept" });
		await router.endTurn(ctx.model);
		expect(modelCalls).toHaveLength(2);
	});

	test("model routing can be off without disabling native orchestration", async () => {
		const { applied, router, modelCalls } = await route(new ScriptedDecider(CONFIDENT_ORCHESTRATE), "Split renderer from parser.", {
			config: { mainModelRoutingEnabled: false },
		});
		expect(modelCalls).toEqual([]);
		expect(router.lastDecision?.model).toBe("skip:routing-disabled");
		expect(customTypes(applied)).toEqual([ORCHESTRATE_NOTICE_TYPE]);
	});

	test("model routing still decides when orchestration routing is off", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { applied, router, modelCalls } = await route(decider, "Split renderer from parser.", {
			config: { orchestrationRoutingEnabled: false },
		});
		expect(decider.orchestrationCalls).toBe(1);
		expect(applied).toBeUndefined();
		expect(modelCalls).toEqual([]);
		expect(router.lastDecision?.model).toBe("kept");
	});

	test("the last two real prior user requests help interpret a follow-up", async () => {
		const prompt = "Continue with that.";
		const branch = ["First task", "Second task", "Third task", prompt, "/compact"]
			.map(text => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })) as SessionEntry[];
		expect(priorUserRequests(branch, prompt, 2)).toEqual(["Second task", "Third task"]);
		const decider = new ScriptedDecider(DEFAULT);
		await route(decider, prompt, { session: { branch } });
		expect(decider.lastPriorRequests).toEqual(["Second task", "Third task"]);
	});

	test("unresolved roles leave the model unchanged and record a reason", async () => {
		const std = fakeModel("p", "std");
		for (const [roles, expected] of [
			[{}, "skip:default-role-unresolved"],
			[{ default: { model: std } }, "skip:deep-role-unresolved"],
		] as const) {
			const { router, modelCalls } = await route(new ScriptedDecider(SLOW), "Diagnose stale state.", { roles });
			expect(modelCalls).toEqual([]);
			expect(router.lastDecision?.model).toBe(expected);
		}
	});

	test("an unauthenticated deep model leaves the main model unchanged", async () => {
		const std = fakeModel("p", "std");
		const decider = new ScriptedDecider(SLOW);
		const { router, ctx, modelCalls } = await route(decider, "Diagnose stale state.", {
			roles: { default: { model: std }, slow: { model: fakeModel("x", "no-auth") } },
		});
		expect(modelCalls).toEqual([]);
		expect(ctx.model).toEqual(std);
		expect(router.lastDecision?.model).toBe("skip:model-auth-missing");
		expect(decider.orchestrationCalls).toBe(1);
	});

	test("identical roles or no active model produce a recorded no-switch", async () => {
		const std = fakeModel("p", "std");
		const same = await route(new ScriptedDecider(SLOW), "Diagnose stale state.", {
			roles: { default: { model: std }, slow: { model: std } },
		});
		expect(same.router.lastDecision?.model).toBe("skip:same-model");
		const absent = await route(new ScriptedDecider(SLOW), "Diagnose stale state.", { session: { currentModel: undefined } });
		expect(absent.router.lastDecision?.model).toBe("skip:no-current-model");
		expect(absent.modelCalls).toEqual([]);
	});

	test("a policy-preparation replay and later provider requests reuse one decision", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { router, ctx } = build(decider);
		const prompt = "Split renderer and parser rewrites.";
		await router.beginTurn(ctx, prompt);
		const first = await router.applyToContext(ctx, turn(prompt));
		await router.beginTurn(ctx, prompt);
		const second = await router.applyToContext(ctx, turn(prompt, [], [notice("tool-ish")]));
		const third = await router.applyToContext(ctx, turn(prompt));
		expect(decider.orchestrationCalls).toBe(1);
		for (const applied of [first, second, third]) expect(customTypes(applied)).toContain(ORCHESTRATE_NOTICE_TYPE);
	});

	test("an orchestrated turn leaves no notice for the next one", async () => {
		const decider = new ScriptedDecider([CONFIDENT_ORCHESTRATE, DEFAULT]);
		const { router, ctx } = build(decider);
		await router.beginTurn(ctx, "Migrate independent subsystems.");
		expect(customTypes(await router.applyToContext(ctx, turn("Migrate independent subsystems."))))
			.toContain(ORCHESTRATE_NOTICE_TYPE);
		await router.endTurn(ctx.model);
		await router.beginTurn(ctx, "Just rename this variable.");
		expect(await router.applyToContext(ctx, turn("Just rename this variable."))).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(2);
	});

	test("a settled turn never touches a later provider request", async () => {
		const { router, ctx } = build(new ScriptedDecider(CONFIDENT_ORCHESTRATE));
		await router.beginTurn(ctx, "Migrate independent subsystems.");
		await router.endTurn(ctx.model);
		expect(await router.applyToContext(ctx, turn("Migrate independent subsystems."))).toBeUndefined();
	});

	test("subagents, plan mode, and disabled routing do not enter the front door", async () => {
		for (const options of [
			{ main: false },
			{ session: { planMode: true } },
			{ session: { enabledTools: ["read", "edit"] }, config: { mainModelRoutingEnabled: false } },
			{ session: { orchestrateKeyword: false }, config: { mainModelRoutingEnabled: false } },
			{ config: { orchestrationRoutingEnabled: false, mainModelRoutingEnabled: false } },
		] satisfies Parameters<typeof build>[1][]) {
			const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
			const { applied, modelCalls } = await route(decider, "Migrate independent subsystems.", options);
			expect(applied).toBeUndefined();
			expect(decider.orchestrationCalls).toBe(0);
			expect(modelCalls).toEqual([]);
		}
	});

	test("missing credentials and Jev failures never change the model", async () => {
		const withoutKey = new ScriptedDecider(SLOW);
		const missing = await route(withoutKey, "Rework scheduler.", { apiKey: undefined });
		expect(withoutKey.orchestrationCalls).toBe(0);
		expect(missing.modelCalls).toEqual([]);
		const failure = await route(new ScriptedDecider(new Error("HTTP 503")), "Rework scheduler.");
		expect(failure.router.lastDecision?.outcome).toBe("ERROR");
		expect(failure.modelCalls).toEqual([]);
	});

	test("slash commands and synthetic notices are not user requests", async () => {
		for (const prompt of ["/compact", "<system-notice>continue</system-notice>", "   "]) {
			const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
			const { applied } = await route(decider, prompt);
			expect(applied).toBeUndefined();
			expect(decider.orchestrationCalls).toBe(0);
		}
	});
});
