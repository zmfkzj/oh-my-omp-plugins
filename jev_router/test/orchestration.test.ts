import { afterEach, describe, expect, test } from "bun:test";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import {
	noticeInsertIndex,
	ORCHESTRATE_NOTICE_TYPE,
	OrchestrationRouter,
	turnHasNativeOrchestrateNotice,
	UNCERTAIN_NOTICE_TYPE,
} from "../src/orchestration.ts";
import { Telemetry } from "../src/telemetry.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain, ScriptedDecider } from "./harness.ts";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { FakeSessionOptions, ScriptedOrchestration } from "./harness.ts";

const CONFIG = normalizeConfig(undefined);

function build(
	decider: ScriptedDecider,
	options: { session?: FakeSessionOptions; main?: boolean; apiKey?: string | undefined } = {},
) {
	const { session, ctx } = makeSession(options.session);
	if (options.main !== false) registerAsMain(session);
	else clearRegistry();
	const telemetry = new Telemetry("/tmp/jev-router-test-state");
	telemetry.setEnabled(false);
	const router = new OrchestrationRouter({
		engine: decider,
		logger: new RouteLogger(makeApi().pi.logger),
		telemetry,
		credential: async () => ("apiKey" in options ? options.apiKey : "ts_test_key"),
		config: () => CONFIG,
	});
	return { router, ctx };
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
	const { router, ctx } = build(decider, options);
	router.beginTurn(ctx, prompt);
	const applied = await router.applyToContext(ctx, messages ?? turn(prompt));
	return { router, ctx, applied };
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

describe("front-door orchestration routing", () => {
	test("a confident ORCHESTRATE injects OMP's own contract for this turn", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { applied } = await route(decider, "Migrate auth and independently rewrite the billing importer.");

		expect(applied).toBeDefined();
		const injected = applied?.find(message => message.role === "custom") as
			| { customType: string; content: string; display: boolean; attribution: string }
			| undefined;
		expect(injected).toMatchObject({
			customType: ORCHESTRATE_NOTICE_TYPE,
			display: false,
			attribution: "user",
		});
		expect(injected?.content).toContain("orchestration request");
	});

	test("a confident DIRECT leaves the context byte-identical", async () => {
		const decider = new ScriptedDecider({ top: "DIRECT", confidence: 0.91, margin: 0.82, confident: true });
		const { applied } = await route(decider, "Fix the off-by-one in the pagination helper.");
		expect(applied).toBeUndefined();
	});

	test("a split decision yields the UNCERTAIN hint, not a second routing call", async () => {
		const decider = new ScriptedDecider({ top: "DIRECT", confidence: 0.54, margin: 0.08, confident: false });
		const { applied } = await route(decider, "Improve the ingestion pipeline.");

		expect(customTypes(applied)).toContain(UNCERTAIN_NOTICE_TYPE);
		expect(decider.orchestrationCalls).toBe(1);
	});

	test("an explicit user `orchestrate` bypasses the router without spending a call", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const messages = turn("orchestrate the migration", [notice(ORCHESTRATE_NOTICE_TYPE)]);
		const { applied, router } = await route(decider, "orchestrate the migration", {}, messages);

		expect(applied).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(0);
		expect(router.lastDecision?.outcome).not.toBe("ORCHESTRATE");
	});

	test("a subagent session never re-enters the front door", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { applied } = await route(decider, "Do the whole migration.", { main: false });

		expect(applied).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(0);
	});

	test("a Jev failure falls back to plain primary execution", async () => {
		const decider = new ScriptedDecider(new Error("HTTP 503"));
		const { applied, router } = await route(decider, "Rework the scheduler.");

		expect(applied).toBeUndefined();
		expect(router.lastDecision?.outcome).toBe("ERROR");
	});

	test("a missing credential routes nothing and never calls Jev", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { applied } = await route(decider, "Rework the scheduler.", { apiKey: undefined });

		expect(applied).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(0);
	});

	test("every request in one turn reuses the single decision", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { router, ctx } = build(decider);
		const prompt = "Split the renderer and the parser rewrites.";
		router.beginTurn(ctx, prompt);

		const first = await router.applyToContext(ctx, turn(prompt));
		// A policy-preparation replay plus two more provider requests in the turn.
		router.beginTurn(ctx, prompt);
		const second = await router.applyToContext(ctx, turn(prompt, [], [notice("tool-ish")]));
		const third = await router.applyToContext(ctx, turn(prompt));

		expect(decider.orchestrationCalls).toBe(1);
		for (const applied of [first, second, third]) {
			expect(customTypes(applied)).toContain(ORCHESTRATE_NOTICE_TYPE);
		}
	});

	test("an orchestrated turn leaves nothing behind for the next one", async () => {
		const decider = new ScriptedDecider([
			CONFIDENT_ORCHESTRATE,
			{ top: "DIRECT", confidence: 0.93, margin: 0.86, confident: true },
		]);
		const { router, ctx } = build(decider);

		router.beginTurn(ctx, "Migrate two independent subsystems in parallel.");
		const turn1 = await router.applyToContext(ctx, turn("Migrate two independent subsystems in parallel."));
		expect(customTypes(turn1)).toContain(ORCHESTRATE_NOTICE_TYPE);
		router.endTurn();

		// Turn 2's context never carries turn 1's notice: it was never persisted.
		router.beginTurn(ctx, "Just rename this variable.");
		const turn2 = await router.applyToContext(ctx, turn("Just rename this variable."));

		expect(turn2).toBeUndefined();
		expect(decider.orchestrationCalls).toBe(2);
	});

	test("a settled turn stops the router from touching later requests", async () => {
		const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
		const { router, ctx } = build(decider);
		router.beginTurn(ctx, "Migrate two independent subsystems.");
		await router.applyToContext(ctx, turn("Migrate two independent subsystems."));
		router.endTurn();

		expect(await router.applyToContext(ctx, turn("Migrate two independent subsystems."))).toBeUndefined();
	});

	test("plan mode, a missing task tool, and a disabled keyword all suppress routing", async () => {
		for (const session of [
			{ planMode: true },
			{ enabledTools: ["read", "edit"] },
			{ orchestrateKeyword: false },
		] satisfies FakeSessionOptions[]) {
			const decider = new ScriptedDecider(CONFIDENT_ORCHESTRATE);
			const { applied } = await route(decider, "Migrate two independent subsystems.", { session });
			expect(applied).toBeUndefined();
			expect(decider.orchestrationCalls).toBe(0);
		}
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
