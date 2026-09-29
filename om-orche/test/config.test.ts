import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	CONFIG_KEYS,
	DEFAULT_CONFIG,
	normalizeConfig,
	type OrcheConfig,
	parseConfigValue,
	PLUGIN_NAME,
	RETIRED_CONFIG_KEYS,
	retiredConfigKeys,
} from "../src/config.ts";

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(roots.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("configuration normalization", () => {
	test("CLI-shaped string values from `omp plugin config` are coerced", () => {
		const config = normalizeConfig({ enabled: "false", telemetryEnabled: "false", debugLogging: "true" });
		expect(config).toEqual({ enabled: false, telemetryEnabled: false, debugLogging: true });
	});

	test("garbage values fall back to defaults rather than breaking the policy", () => {
		const config = normalizeConfig({ enabled: 7, debugLogging: "nonsense" });
		expect(config.enabled).toBe(DEFAULT_CONFIG.enabled);
		expect(config.debugLogging).toBe(DEFAULT_CONFIG.debugLogging);
	});

	test("stored retired keys never reach the config and are reported for cleanup", () => {
		const jevRaw = {
			jevModel: "jev-latest",
			orchestrationRoutingEnabled: false,
			orchestrationMinConfidence: 0.99,
			orchestrationMinMargin: 0.9,
			routingTimeoutMs: 250,
			maxRoutingInputChars: 200,
		};
		const tierRaw = { taskRoutingEnabled: false, challengeTaskRole: "slow", taskMinConfidence: 0.9 };
		const raw = { ...jevRaw, ...tierRaw, enabled: false };

		const config = normalizeConfig(raw);
		expect(config).toEqual(normalizeConfig({ enabled: false }));
		expect(Object.keys(config).sort()).toEqual([...CONFIG_KEYS].sort());

		expect(retiredConfigKeys(raw).sort()).toEqual(Object.keys({ ...jevRaw, ...tierRaw }).sort());
		expect(retiredConfigKeys({ enabled: true, telemetryEnabled: false, debugLogging: true })).toEqual([]);
		expect(retiredConfigKeys(undefined)).toEqual([]);
	});

	test("kept and retired keys are disjoint", () => {
		for (const key of CONFIG_KEYS) expect(RETIRED_CONFIG_KEYS as readonly string[]).not.toContain(key);
	});

	test("typed parsing accepts only booleans for the kept keys", () => {
		for (const key of CONFIG_KEYS) {
			expect(parseConfigValue(key, "true")).toBe(true);
			expect(parseConfigValue(key, "false")).toBe(false);
			expect(parseConfigValue(key, "yes")).toBeUndefined();
			expect(parseConfigValue(key, "0.85")).toBeUndefined();
		}
	});
});

/** What `config-probe.ts` reports about a reset. */
interface ProbeResult {
	cleared: string[];
	globalAfterClear: Record<string, unknown>;
	globalAfterCommand: Record<string, unknown>;
	notes: string[];
	config: OrcheConfig;
}

async function tempDir(label: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `om-orche-${label}-`));
	roots.push(dir);
	return dir;
}

/**
 * Reset the plugin's configuration against OMP's real settings store, under a temporary home, in a project whose
 * `plugin-overrides.json` holds `override` (nothing when undefined).
 */
async function resetInProject(override?: Record<string, unknown>): Promise<{ result: ProbeResult; project: string }> {
	const home = await tempDir("home");
	const project = await tempDir("project");
	const state = await tempDir("state");
	if (override) {
		await mkdir(path.join(project, ".omp"));
		await writeFile(path.join(project, ".omp", "plugin-overrides.json"), JSON.stringify({ settings: { [PLUGIN_NAME]: override } }));
	}
	// Nothing of the developer's own OMP setup may reach the probe: the store follows HOME and the XDG and profile variables.
	const env: Record<string, string | undefined> = { ...process.env, HOME: home };
	for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "PI_PROFILE", "OMP_PROFILE", "PI_CODING_AGENT_DIR"]) {
		delete env[name];
	}
	const probe = path.join(import.meta.dir, "config-probe.ts");
	const child = Bun.spawn([process.execPath, "run", probe, project, state], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`config-probe exited ${code}: ${err}`);
	return { result: JSON.parse(out) as ProbeResult, project };
}

describe("resetting the stored configuration", () => {
	test("a project override OMP cannot edit is reported, not passed off as reset", async () => {
		const { result, project } = await resetInProject({ telemetryEnabled: true, enabled: false });

		expect(result.cleared).toEqual(["telemetryEnabled", "enabled"]);
		// What OMP stores globally is gone, the setup marker included; the project's file is untouched and still applies.
		expect(result.globalAfterClear).toEqual({});
		expect(result.globalAfterCommand).toEqual({});
		expect(result.config).toEqual({ enabled: false, telemetryEnabled: true, debugLogging: false });
		const overrides = await readFile(path.join(project, ".omp", "plugin-overrides.json"), "utf8");
		expect(JSON.parse(overrides)).toEqual({ settings: { [PLUGIN_NAME]: { telemetryEnabled: true, enabled: false } } });
		const message = result.notes.join("\n");
		expect(message).toContain("still sets telemetryEnabled, enabled");
		expect(message).not.toContain("reset to defaults");
	});

	test("with no project override the reset reaches the defaults and says so", async () => {
		const { result } = await resetInProject();

		expect(result.cleared).toEqual([]);
		expect(result.globalAfterCommand).toEqual({});
		expect(result.config).toEqual(normalizeConfig(undefined));
		expect(result.notes.join("\n")).toContain("Configuration reset to defaults");
	});
});
