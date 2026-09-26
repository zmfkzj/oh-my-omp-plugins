import { describe, expect, test } from "bun:test";
import { renderStatus } from "../src/commands.ts";
import { normalizeConfig } from "../src/config.ts";
import { JevRouterRuntime } from "../src/runtime.ts";
import { fakeModel, makeApi } from "./harness.ts";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

function context(roles: Record<string, Model>): ExtensionCommandContext {
	return {
		cwd: "/tmp", hasUI: false,
		sessionManager: { getSessionId: () => "s1" },
		models: { resolve: (spec: string) => roles[spec] },
		modelRegistry: { authStorage: { keys: { get: async () => undefined }, credentials: { has: () => false } } },
	} as unknown as ExtensionCommandContext;
}

const roles = {
	"@task_easy": fakeModel("provider", "easy"),
	"@task_hard": fakeModel("provider", "hard"),
	"@task_challenge": fakeModel("provider", "challenge"),
};

describe("tier role preflight", () => {
	test("missing challenge role warns even when both lower tiers resolve", () => {
		const { pi, logs } = makeApi();
		const runtime = new JevRouterRuntime(pi, "/tmp/jev-router-pkg");
		runtime.checkTierRoles(context({ "@task_easy": roles["@task_easy"], "@task_hard": roles["@task_hard"] }));
		expect(logs.some(line => line.startsWith("warn ") && line.includes("@task_challenge"))).toBe(true);
	});

	test("resolved worker roles do not require default or slow primary roles", () => {
		const { pi, logs } = makeApi();
		const runtime = new JevRouterRuntime(pi, "/tmp/jev-router-pkg");
		runtime.checkTierRoles(context(roles));
		expect(logs).toEqual([]);
	});
});

test("status does not expose credential values", async () => {
	const { pi } = makeApi();
	const runtime = {
		config: normalizeConfig(undefined),
		survey: { genericTaskIsBundled: true, discoveredAliases: new Set(), materialized: { available: [], failed: [], written: [] } },
		credential: async () => ({ key: "ts_super_secret_value", source: "omp-credential-store" }),
		orchestration: {}, task: {},
	} as unknown as JevRouterRuntime;
	const status = await renderStatus(pi, runtime, context(roles));
	expect(status).not.toContain("ts_super_secret_value");
});
