import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config.ts";
import { OrcheRuntime } from "../src/runtime.ts";
import { Telemetry } from "../src/telemetry.ts";
import { clearRegistry } from "./harness.ts";
import { registeredSession } from "./sessions.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

afterEach(() => {
	clearRegistry();
	Telemetry.resetSharedForTests();
});

/** What a read of a working directory's stored settings returns, or throws; the test edits it between reads. */
type Stored = Record<string, Record<string, unknown> | Error>;

/** A runtime over settings the test controls. It records nothing, so its state directory is never written. */
function runtimeOver(stored: Stored, options: { stateDir?: string; warnings?: string[] } = {}): OrcheRuntime {
	const pi = {
		logger: { debug() {}, info() {}, error() {}, warn: (message: string) => void options.warnings?.push(message) },
	} as unknown as ExtensionAPI;
	const readSettings = async (_plugin: string, cwd: string): Promise<Record<string, unknown>> => {
		const value = stored[cwd] ?? {};
		if (value instanceof Error) throw value;
		return value;
	};
	return new OrcheRuntime(pi, options.stateDir ?? path.join(tmpdir(), `om-orche-runtime-${randomUUID()}`), { readSettings });
}

describe("syncConfig", () => {
	test("a main session picks up what changed in the stored settings", async () => {
		const stored: Stored = { "/project": { enabled: true } };
		const runtime = runtimeOver(stored);
		const ctx = registeredSession("Main", "/project");
		await runtime.reloadConfig(ctx);
		expect(runtime.config.enabled).toBe(true);

		stored["/project"] = { enabled: "false", debugLogging: true };
		await runtime.syncConfig(ctx);

		expect(runtime.config).toEqual({ enabled: false, telemetryEnabled: true, debugLogging: true });
	});

	test("a subagent keeps what it read at its own start", async () => {
		const stored: Stored = { "/project": { enabled: true } };
		const runtime = runtimeOver(stored);
		registeredSession("Main", "/project");
		const subagent = registeredSession("1-worker", "/project", "Main");
		await runtime.reloadConfig(subagent);

		stored["/project"] = { enabled: false };
		await runtime.syncConfig(subagent);

		expect(runtime.config.enabled).toBe(true);
	});
});

describe("settings that cannot be read", () => {
	test("keep what was in effect, and are warned about once however many turns follow", async () => {
		const stored: Stored = { "/project": { enabled: false } };
		const warnings: string[] = [];
		const runtime = runtimeOver(stored, { warnings });
		const ctx = registeredSession("Main", "/project");
		await runtime.reloadConfig(ctx);

		stored["/project"] = new SyntaxError("JSON Parse error: Expected '}'");
		for (let turn = 0; turn < 3; turn++) await runtime.syncConfig(ctx);

		// A half-written store must not switch a disabled plugin back on.
		expect(runtime.config.enabled).toBe(false);
		expect(runtime.configError).toContain("JSON Parse error");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("JSON Parse error");

		stored["/project"] = { enabled: true };
		await runtime.syncConfig(ctx);
		expect(runtime.config.enabled).toBe(true);
		expect(runtime.configError).toBeUndefined();

		// A later failure is a new one and is warned about again.
		stored["/project"] = new SyntaxError("JSON Parse error: Expected '}'");
		await runtime.syncConfig(ctx);
		expect(warnings).toHaveLength(2);
	});

	test("at a session's start, the defaults apply", async () => {
		const warnings: string[] = [];
		const runtime = runtimeOver({ "/project": new SyntaxError("JSON Parse error") }, { warnings });

		await runtime.reloadConfig(registeredSession("Main", "/project"));

		expect(runtime.config).toEqual(normalizeConfig(undefined));
		expect(runtime.configError).toContain("JSON Parse error");
		expect(warnings).toHaveLength(1);
	});

	test("a store that does not exist is no problem", async () => {
		const warnings: string[] = [];
		const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
		const runtime = runtimeOver({ "/project": missing }, { warnings });

		await runtime.reloadConfig(registeredSession("Main", "/project"));

		expect(runtime.config).toEqual(normalizeConfig(undefined));
		expect(runtime.configError).toBeUndefined();
		expect(warnings).toEqual([]);
	});
});

describe("whose telemetry choice a session's workers follow", () => {
	const off = { telemetryEnabled: false };
	const on = { telemetryEnabled: true };

	const orders = [
		["on", "off"],
		["off", "on"],
	] as const;
	for (const order of orders) {
		test(`each main session follows its own, whichever read its configuration last (${order.join(" then ")})`, async () => {
			const stateDir = path.join(tmpdir(), `om-orche-runtime-${randomUUID()}`);
			const stored: Stored = { "/on": on, "/off": off };
			const runtimes = { on: runtimeOver(stored, { stateDir }), off: runtimeOver(stored, { stateDir }) };
			const contexts = { on: registeredSession("acp:on", "/on"), off: registeredSession("acp:off", "/off") };

			for (const choice of order) await runtimes[choice].reloadConfig(contexts[choice]);

			expect(runtimes.on.recordsTelemetry()).toBe(true);
			expect(runtimes.off.recordsTelemetry()).toBe(false);
		});
	}

	test("a subagent follows the main session above it, not the settings of its own working directory", async () => {
		const cases = [
			{ main: off, worker: on },
			{ main: on, worker: off },
		];
		for (const { main, worker } of cases) {
			clearRegistry();
			const stateDir = path.join(tmpdir(), `om-orche-runtime-${randomUUID()}`);
			const stored: Stored = { "/main": main, "/worker": worker, "/nested": worker };
			const top = runtimeOver(stored, { stateDir });
			const child = runtimeOver(stored, { stateDir });
			const grandchild = runtimeOver(stored, { stateDir });

			await top.reloadConfig(registeredSession("acp:1", "/main"));
			await child.reloadConfig(registeredSession("1-worker", "/worker", "acp:1"));
			await grandchild.reloadConfig(registeredSession("2-nested", "/nested", "1-worker"));

			// The subagents read settings that say the opposite, and neither switched the main session's choice.
			expect(child.config.telemetryEnabled).toBe(worker.telemetryEnabled);
			expect([top, child, grandchild].map(runtime => runtime.recordsTelemetry())).toEqual([
				main.telemetryEnabled,
				main.telemetryEnabled,
				main.telemetryEnabled,
			]);
		}
	});

	test("a session whose top-level session is unknown follows what the sessions of the process together want", async () => {
		const stateDir = path.join(tmpdir(), `om-orche-runtime-${randomUUID()}`);
		const stored: Stored = { "/main": off, "/orphan": on };
		const main = runtimeOver(stored, { stateDir });
		const orphan = runtimeOver(stored, { stateDir });
		const mainCtx = registeredSession("acp:1", "/main");
		await main.reloadConfig(mainCtx);

		// Its parent is not in the registry, so nothing says whose session it belongs to.
		await orphan.reloadConfig(registeredSession("9-lost", "/orphan", "gone"));
		expect(orphan.recordsTelemetry()).toBe(false);

		stored["/main"] = on;
		await main.syncConfig(mainCtx);
		expect(orphan.recordsTelemetry()).toBe(true);
	});
});
