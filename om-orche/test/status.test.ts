import { afterEach, describe, expect, test } from "bun:test";
import { registerCommands, renderStatus } from "../src/commands.ts";
import { normalizeConfig } from "../src/config.ts";
import type { HostSetupStore } from "../src/omp-setup.ts";
import type { OrcheRuntime } from "../src/runtime.ts";
import { clearRegistry, fakeModel, makeApi, makeSession, registerAsMain } from "./harness.ts";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

afterEach(clearRegistry);

/** A marker store that never touches the real plugin settings. */
function setupStore(version?: number): HostSetupStore {
	return { version: async () => version, markApplied: async () => {} };
}

function fakeRuntime(retiredConfigKeys: string[] = [], config: Record<string, unknown> = {}): OrcheRuntime {
	return { config: normalizeConfig(config), retiredConfigKeys } as unknown as OrcheRuntime;
}

/** The main session's command context, resolving only the given role aliases. */
function mainContext(roles: Record<string, Model>) {
	const fake = makeSession();
	registerAsMain(fake.session);
	const ctx = { ...fake.ctx, models: { resolve: (spec: string) => roles[spec] } } as unknown as ExtensionCommandContext;
	return { ctx, settings: fake.session.settings };
}

test("an unresolved @task role is reported without naming a substitute model", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@slow": fakeModel("provider", "slow"), "@smol": fakeModel("provider", "smol") });
	const status = await renderStatus(pi, fakeRuntime(), ctx, setupStore());
	expect(status).toMatch(/@task role\s+unresolved/);
	expect(status).toContain("task workers use the main session's active model");
	expect(status).not.toContain("Set modelRoles.task");
	expect(status).not.toContain("provider/slow");
	expect(status).not.toContain("provider/smol");
});

describe("OMP setup row", () => {
	async function rowFor(version: number | undefined, config: Record<string, unknown> = {}) {
		const { pi } = makeApi();
		const { ctx } = mainContext({});
		return renderStatus(pi, fakeRuntime([], config), ctx, setupStore(version));
	}

	test("a stored marker reports the setup as applied, even while the plugin is disabled", async () => {
		expect(await rowFor(1)).toMatch(/OMP setup\s+applied \(v1\)/);
		expect(await rowFor(1, { enabled: false })).toMatch(/OMP setup\s+applied \(v1\)/);
	});

	test("without a marker the setup is pending, or skipped while the plugin is disabled", async () => {
		expect(await rowFor(undefined)).toMatch(/OMP setup\s+pending — applies at the next main session start/);
		expect(await rowFor(0)).toMatch(/OMP setup\s+pending/);
		expect(await rowFor(undefined, { enabled: false })).toMatch(/OMP setup\s+skipped — plugin disabled/);
	});

	test("an unreadable marker reports the setup as pending instead of failing status", async () => {
		const { pi } = makeApi();
		const { ctx } = mainContext({});
		const store: HostSetupStore = {
			version: async () => {
				throw new Error("unreadable");
			},
			markApplied: async () => {},
		};
		expect(await renderStatus(pi, fakeRuntime(), ctx, store)).toMatch(/OMP setup\s+pending/);
	});
});

test("a resolved @task role is shown as the native worker model", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@task": fakeModel("provider", "worker") });
	const status = await renderStatus(pi, fakeRuntime(), ctx, setupStore());
	expect(status).toMatch(/@task role\s+provider\/worker/);
	expect(status).not.toContain("does not resolve");
});

test("status reports the judgment/production policy and no Jev, credential or gate rows", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@task": fakeModel("provider", "worker") });
	const status = await renderStatus(pi, fakeRuntime(), ctx, setupStore());
	expect(status).toMatch(/Execution policy\s+judgment\/production \(om-orche-policy-notice\)/);
	expect(status).toMatch(/Primary model\s+unchanged/);
	expect(status).not.toMatch(/credential|jev|typesafe|gate|confidence|margin|last orchestration/i);
});

test("a disabled plugin reports native behavior instead of the policy", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@task": fakeModel("provider", "worker") });
	const status = await renderStatus(pi, fakeRuntime([], { enabled: false }), ctx, setupStore());
	expect(status).toMatch(/om-orche\s+disabled/);
	expect(status).toMatch(/Execution policy\s+native \(plugin disabled\)/);
	expect(status).not.toContain("judgment/production");
});

test("retired settings and leftover tier roles are reported with delete instructions but left untouched", async () => {
	const { pi } = makeApi();
	const { ctx, settings } = mainContext({ "@task": fakeModel("provider", "worker") });
	settings.setModelRole("task_easy", "@smol");
	settings.setModelRole("task_challenge", "@slow");

	const status = await renderStatus(pi, fakeRuntime(["taskRoutingEnabled", "jevModel", "routingTimeoutMs"]), ctx, setupStore());

	expect(status).toContain("taskRoutingEnabled, jevModel, routingTimeoutMs");
	expect(status).toContain("omp plugin config delete om-orche <key>");
	expect(status).toContain("@task_easy, @task_challenge");
	expect(status).not.toContain("@task_hard");
	expect(settings.getModelRole("task_easy")).toBe("@smol");
	expect(settings.getModelRole("task_challenge")).toBe("@slow");
});

test("a clean install reports neither retired settings nor leftover roles", async () => {
	const { pi } = makeApi();
	const { ctx } = mainContext({ "@task": fakeModel("provider", "worker") });
	const status = await renderStatus(pi, fakeRuntime(), ctx, setupStore());
	expect(status).not.toContain("Retired settings");
	expect(status).not.toContain("no longer used");
});

test("the removed setup and test subcommands are rejected before anything runs", async () => {
	const { pi } = makeApi();
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const registering = {
		...pi,
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	let reloads = 0;
	const runtime = { ...fakeRuntime(), reloadConfig: async () => void reloads++ } as unknown as OrcheRuntime;
	registerCommands(registering, runtime);

	const notes: { message: string; level: string }[] = [];
	const { ctx } = mainContext({});
	const commandCtx = {
		...ctx,
		ui: { notify: (message: string, level: string) => notes.push({ message, level }) },
	} as unknown as ExtensionCommandContext;

	for (const sub of ["setup", "test"]) await handler?.(sub, commandCtx);

	expect(notes.map(note => note.level)).toEqual(["warning", "warning"]);
	expect(notes[0]?.message).toContain('Unknown subcommand "setup". Use: status, stats, reset.');
	expect(notes[1]?.message).toContain('Unknown subcommand "test"');
	expect(reloads).toBe(0);
});
