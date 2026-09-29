import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_CONFIG,
	loadConfig,
	normalizeConfig,
	type OrcheConfig,
	PLUGIN_NAME,
	RETIRED_CONFIG_KEYS,
	retiredConfigKeys,
} from "../src/config.ts";
import { HOST_SETUP_VERSION } from "../src/omp-setup.ts";

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
		expect(Object.keys(config).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());

		expect(retiredConfigKeys(raw).sort()).toEqual(Object.keys({ ...jevRaw, ...tierRaw }).sort());
		expect(retiredConfigKeys({ enabled: true, telemetryEnabled: false, debugLogging: true })).toEqual([]);
		expect(retiredConfigKeys(undefined)).toEqual([]);
	});

	test("kept and retired keys are disjoint", () => {
		for (const key of Object.keys(DEFAULT_CONFIG)) expect(RETIRED_CONFIG_KEYS as readonly string[]).not.toContain(key);
	});
});

describe("reading the stored settings", () => {
	const failing = (error: Error) => async (): Promise<Record<string, unknown>> => {
		throw error;
	};

	test("a store that is not there means defaults, and is not a problem", async () => {
		const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });

		const loaded = await loadConfig("/project", failing(missing));

		expect(loaded).toEqual({ config: normalizeConfig(undefined), retiredKeys: [] });
	});

	test("any other failure is returned with the defaults instead of passing for a clean read", async () => {
		const corrupt = new SyntaxError("JSON Parse error: Expected '}'");

		const loaded = await loadConfig("/project", failing(corrupt));

		expect(loaded.config).toEqual(normalizeConfig(undefined));
		expect(loaded.error).toBe(corrupt);
	});

	test("what is stored is read for the plugin and working directory asked for", async () => {
		const asked: [string, string][] = [];

		const loaded = await loadConfig("/project", async (name, cwd) => {
			asked.push([name, cwd]);
			return { enabled: "false", jevModel: "old" };
		});

		expect(asked).toEqual([[PLUGIN_NAME, "/project"]]);
		expect(loaded).toEqual({ config: normalizeConfig({ enabled: false }), retiredKeys: ["jevModel"] });
	});
});

/** What `config-probe.ts` reports about a reset. */
interface ResetResult {
	cleared: string[];
	globalAfterClear: Record<string, unknown>;
	globalAfterCommand: Record<string, unknown>;
	notes: string[];
	config: OrcheConfig;
	setupMarker: number | undefined;
}

async function tempDir(label: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), `om-orche-${label}-`));
	roots.push(dir);
	return dir;
}

/**
 * Run `config-probe.ts` in `mode` against OMP's real settings store, under a temporary home, in a project whose
 * `plugin-overrides.json` holds `override` (nothing when undefined).
 */
async function probe<T>(mode: string, override?: Record<string, unknown>): Promise<{ result: T; project: string }> {
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
	const script = path.join(import.meta.dir, "config-probe.ts");
	const child = Bun.spawn([process.execPath, "run", script, mode, project, state], { env, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`config-probe exited ${code}: ${err}`);
	return { result: JSON.parse(out) as T, project };
}

const resetInProject = (override?: Record<string, unknown>) => probe<ResetResult>("reset", override);

describe("resetting the stored configuration", () => {
	test("a project override OMP cannot edit is reported, not passed off as reset", async () => {
		const { result, project } = await resetInProject({ telemetryEnabled: true, enabled: false });

		expect(result.cleared).toEqual(["telemetryEnabled", "enabled"]);
		// What OMP stores globally is gone, the one-time setup marker apart; the project's file is untouched and still applies.
		expect(result.globalAfterClear).toEqual({ hostSetupVersion: HOST_SETUP_VERSION });
		expect(result.globalAfterCommand).toEqual({ hostSetupVersion: HOST_SETUP_VERSION });
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
		expect(result.globalAfterCommand).toEqual({ hostSetupVersion: HOST_SETUP_VERSION });
		expect(result.config).toEqual(normalizeConfig(undefined));
		expect(result.notes.join("\n")).toContain("Configuration reset to defaults");
	});

	test("the one-time setup marker survives, so keys the user deleted are not filled in again", async () => {
		const { result } = await resetInProject();

		// The marker is what makes the setup run once; a reset that dropped it would run it again at the next session.
		expect(result.setupMarker).toBe(HOST_SETUP_VERSION);
	});
});

/** What `config-probe.ts live` reports about a running session's settings. */
interface LiveResult {
	atStart: OrcheConfig;
	afterChange: OrcheConfig & { recordsTelemetry: boolean };
	afterSubagentTurn: OrcheConfig;
	afterMainTurn: OrcheConfig;
	whileCorrupt: { config: OrcheConfig; error: string; warnings: string[] };
	afterRepair: { config: OrcheConfig; error: string | null; warnings: string[] };
}

describe("a running session and the stored settings", () => {
	test("a change made with `omp plugin config` reaches the next turn of the main session, and only of the main session", async () => {
		const { result } = await probe<LiveResult>("live");

		expect(result.atStart).toEqual(normalizeConfig(undefined));
		// Both settings were switched off in the store while the session ran.
		expect(result.afterChange).toEqual({ enabled: false, telemetryEnabled: false, debugLogging: false, recordsTelemetry: false });
		// A subagent's turn keeps what it read at its own start; the main session's next turn takes the new value.
		expect(result.afterSubagentTurn).toEqual({ enabled: false, telemetryEnabled: false, debugLogging: false });
		expect(result.afterMainTurn).toEqual({ enabled: true, telemetryEnabled: false, debugLogging: false });
	});

	test("a store that breaks mid-session keeps what was in effect and is reported once, not switched to defaults", async () => {
		const { result } = await probe<LiveResult>("live");

		expect(result.whileCorrupt.config).toEqual(result.afterMainTurn);
		expect(result.whileCorrupt.error).toMatch(/SyntaxError/);
		expect(result.whileCorrupt.warnings).toHaveLength(1);
		expect(result.whileCorrupt.warnings[0]).toMatch(/could not read the stored settings.*stay in effect/);
		// Repaired, it applies again and the failure is over.
		expect(result.afterRepair.config).toEqual({ enabled: false, telemetryEnabled: true, debugLogging: false });
		expect(result.afterRepair.error).toBeNull();
	});
});

/** What `config-probe.ts corrupt` reports about sessions that start over a corrupt, a repaired and a missing store. */
interface CorruptResult {
	overCorruptStore: { config: OrcheConfig; error: string; warnings: string[] };
	afterRepair: { config: OrcheConfig; error: string | null };
	overMissingStore: { config: OrcheConfig; error: string | null; newWarnings: number };
}

describe("a session starting over an unreadable store", () => {
	test("gets the defaults and a warning, where a store that does not exist is silent", async () => {
		const { result } = await probe<CorruptResult>("corrupt");

		expect(result.overCorruptStore.config).toEqual(normalizeConfig(undefined));
		expect(result.overCorruptStore.error).toMatch(/SyntaxError/);
		expect(result.overCorruptStore.warnings).toHaveLength(1);
		expect(result.overCorruptStore.warnings[0]).toMatch(/could not read the stored settings.*defaults apply/);
		expect(result.afterRepair.config).toEqual({ enabled: false, telemetryEnabled: true, debugLogging: false });
		expect(result.afterRepair.error).toBeNull();
		expect(result.overMissingStore).toEqual({ config: normalizeConfig(undefined), error: null, newWarnings: 0 });
	});
});
