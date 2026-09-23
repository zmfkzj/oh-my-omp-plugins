import { describe, expect, test } from "bun:test";
import { renderStatus } from "../src/commands.ts";
import { normalizeConfig } from "../src/config.ts";
import { DEEP_AGENT_NAME } from "../src/deep-agent.ts";
import { fakeModel, makeApi } from "./harness.ts";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { JevRouterConfig } from "../src/config.ts";
import { JevRouterRuntime } from "../src/runtime.ts";

function makeCommandCtx(roles: Record<string, Model | undefined>): ExtensionCommandContext {
	const resolvedRoles = {
		"@default": fakeModel("openai", "gpt-5.4"),
		"@slow": fakeModel("openai", "separate-slow-model"),
		...roles,
	};
	return {
		cwd: "/tmp",
		hasUI: false,
		sessionManager: { getSessionId: () => "s1" },
		models: { resolve: (spec: string) => resolvedRoles[spec as keyof typeof resolvedRoles] },
		modelRegistry: {
			authStorage: { getApiKey: async () => undefined, hasNonEnvCredential: () => false },
		},
	} as unknown as ExtensionCommandContext;
}

function makeRuntime(options: { config?: Partial<JevRouterConfig>; bundled?: boolean; aliases?: string[] } = {}) {
	return {
		config: { ...normalizeConfig(undefined), ...options.config },
		survey: {
			genericTaskIsBundled: options.bundled ?? true,
			discoveredAliases: new Set(options.aliases ?? [DEEP_AGENT_NAME]),
			materialized: { available: [DEEP_AGENT_NAME], failed: [], written: [] },
		},
		credential: async () => undefined,
		orchestration: { lastDecision: { outcome: "DEFAULT", confidence: 0.91, model: "kept", at: 0 } },
		task: { lastDecision: { route: "TASK_NORMAL", confidence: 0.87, margin: 0.7, confident: true, at: 0 } },
	} as unknown as JevRouterRuntime;
}

describe("/jev-router status", () => {
	test("reports both tiers, their resolved models, and the last routes", async () => {
		const { pi } = makeApi();
		const ctx = makeCommandCtx({
			"@task": fakeModel("openai", "gpt-5.4"),
			"@task_hard": fakeModel("anthropic", "claude-opus-5"),
			"@slow": fakeModel("openai", "separate-slow-model"),
		});

		const status = await renderStatus(pi, makeRuntime(), ctx);

		expect(status).toContain("TASK_NORMAL            @task → openai/gpt-5.4");
		expect(status).toContain("TASK_DEEP              @task_hard → anthropic/claude-opus-5");
		expect(status).toContain("MAIN_DEFAULT           @default → openai/gpt-5.4");
		expect(status).toContain("MAIN_SLOW              @slow → openai/separate-slow-model");
		expect(status).toContain("Last orchestration     DEFAULT 0.91 model=kept");
		expect(status).toContain("Last TASK route        TASK_NORMAL 0.87");
		expect(status).toContain(`${DEEP_AGENT_NAME} — discoverable and spawnable`);
		expect(status).not.toContain("no model-cost differentiation");
	});

	test("identical tier models are an informational note, not an error", async () => {
		const { pi } = makeApi();
		const same = fakeModel("anthropic", "claude-opus-5");
		const ctx = makeCommandCtx({ "@task": same, "@task_hard": same });

		const status = await renderStatus(pi, makeRuntime(), ctx);

		expect(status).toContain("TASK_NORMAL and TASK_DEEP currently resolve to the same model.");
		expect(status).toContain("Tier routing is active but provides no model-cost differentiation.");
		expect(status).toContain("TASK tier routing      enabled");
		expect(status).toContain("Main model routing     enabled");
	});

	test("an unresolvable role is called out with the fix", async () => {
		const { pi } = makeApi();
		const ctx = makeCommandCtx({
			"@task": fakeModel("openai", "gpt-5.4"),
			"@slow": fakeModel("anthropic", "claude-opus-5"),
		});

		const status = await renderStatus(pi, makeRuntime(), ctx);

		expect(status).toContain("Unresolved role(s): @task_hard.");
		expect(status).toContain("modelRoles.<role>");
	});

	test("an on-disk but unspawnable alias is distinguished from a missing one", async () => {
		const ctx = makeCommandCtx({ "@task": fakeModel("openai", "a"), "@task_hard": fakeModel("anthropic", "b") });

		const unspawnable = await renderStatus(makeApi(["task", "scout"]).pi, makeRuntime(), ctx);
		expect(unspawnable).toContain("on disk but NOT spawnable in this session");

		const missing = await renderStatus(makeApi(["task"]).pi, makeRuntime({ aliases: [] }), ctx);
		expect(missing).toContain(`${DEEP_AGENT_NAME} — MISSING`);
	});

	test("a shadowed generic task agent is reported as a disabled tier router", async () => {
		const { pi } = makeApi();
		const ctx = makeCommandCtx({ "@task": fakeModel("openai", "a"), "@task_hard": fakeModel("anthropic", "b") });

		const status = await renderStatus(pi, makeRuntime({ bundled: false }), ctx);

		expect(status).toContain("shadows OMP's bundled worker");
	});

	test("no secret ever appears in status output", async () => {
		const { pi } = makeApi();
		const ctx = makeCommandCtx({ "@task": fakeModel("openai", "a"), "@task_hard": fakeModel("anthropic", "b") });
		const runtime = makeRuntime();
		(runtime as unknown as { credential: () => Promise<unknown> }).credential = async () => ({
			key: "ts_super_secret_value",
			source: "omp-credential-store",
		});

		const status = await renderStatus(pi, runtime, ctx);

		expect(status).toContain("Credential             configured (OMP credential store)");
		expect(status).not.toContain("ts_super_secret_value");
	});
});

describe("startup model-role preflight", () => {
	test("an unresolvable tier role is reported once, without touching modelRoles", () => {
		const { pi, logs } = makeApi();
		const runtime = new JevRouterRuntime(pi, "/tmp/jev-router-pkg");
		runtime.checkTierRoles(makeCommandCtx({ "@task": fakeModel("openai", "gpt-5.4") }));

		expect(logs.some(line => line.startsWith("warn ") && line.includes("@task_hard"))).toBe(true);
	});

	test("identical tier models are informational, not a warning", () => {
		const { pi, logs } = makeApi();
		const runtime = new JevRouterRuntime(pi, "/tmp/jev-router-pkg");
		const same = fakeModel("anthropic", "claude-opus-5");
		runtime.checkTierRoles(makeCommandCtx({ "@task": same, "@task_hard": same }));

		// `note` is debug-gated, so a healthy-but-undifferentiated setup stays silent.
		expect(logs).toEqual([]);
	});

	test("distinct resolved tiers log nothing at all", () => {
		const { pi, logs } = makeApi();
		const runtime = new JevRouterRuntime(pi, "/tmp/jev-router-pkg");
		runtime.checkTierRoles(
			makeCommandCtx({ "@task": fakeModel("openai", "gpt-5.4"), "@task_hard": fakeModel("anthropic", "opus") }),
		);

		expect(logs).toEqual([]);
	});
});
