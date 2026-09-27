import { afterEach, expect, test } from "bun:test";
import { renderStatus } from "../src/commands.ts";
import { normalizeConfig } from "../src/config.ts";
import type { JevRouterRuntime } from "../src/runtime.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

afterEach(clearRegistry);

function fakeRuntime(retiredConfigKeys: string[] = []): JevRouterRuntime {
	return {
		config: normalizeConfig(undefined),
		retiredConfigKeys,
		credential: async () => ({ key: "ts_super_secret_value", source: "omp-credential-store" }),
		orchestration: { lastDecision: undefined },
	} as unknown as JevRouterRuntime;
}

/** The main session's command context, resolving only the given role aliases. */
function mainContext(roles: Record<string, Model>) {
	const fake = makeSession();
	registerAsMain(fake.session);
	const ctx = { ...fake.ctx, models: { resolve: (spec: string) => roles[spec] } } as unknown as ExtensionCommandContext;
	return { ctx, settings: fake.session.settings };
}

test("status does not expose credential values", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({});
	const status = await renderStatus(pi, fakeRuntime(), ctx);
	expect(status).not.toContain("ts_super_secret_value");
});

test("an unresolved @task role is reported without naming a substitute model", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@slow": fakeModel("provider", "slow"), "@smol": fakeModel("provider", "smol") });
	const status = await renderStatus(pi, fakeRuntime(), ctx);
	expect(status).toMatch(/@task role\s+unresolved/);
	expect(status).not.toContain("provider/slow");
	expect(status).not.toContain("provider/smol");
});

test("a resolved @task role is shown as the native worker model", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@task": fakeModel("provider", "worker") });
	const status = await renderStatus(pi, fakeRuntime(), ctx);
	expect(status).toMatch(/@task role\s+provider\/worker/);
	expect(status).not.toContain("does not resolve");
});

test("retired settings and leftover tier roles are reported but left untouched", async () => {
	const { pi } = makeApi();
	const { ctx, settings } = mainContext({ "@task": fakeModel("provider", "worker") });
	settings.setModelRole("task_easy", "@smol");
	settings.setModelRole("task_challenge", "@slow");

	const status = await renderStatus(pi, fakeRuntime(["taskRoutingEnabled", "hardTaskRole"]), ctx);

	expect(status).toContain("taskRoutingEnabled, hardTaskRole");
	expect(status).toContain("@task_easy, @task_challenge");
	expect(status).not.toContain("@task_hard");
	expect(settings.getModelRole("task_easy")).toBe("@smol");
	expect(settings.getModelRole("task_challenge")).toBe("@slow");
});

test("a clean install reports neither retired settings nor leftover roles", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@task": fakeModel("provider", "worker") });
	const status = await renderStatus(pi, fakeRuntime(), ctx);
	expect(status).not.toContain("Retired settings");
	expect(status).not.toContain("no longer used");
});
