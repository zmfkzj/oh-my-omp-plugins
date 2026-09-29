/**
 * Plugin configuration.
 *
 * Storage is OMP's own per-plugin settings map (the `settings["om-orche"]`
 * record inside `omp-plugins.lock.json`), read through
 * `getPluginSettings(name, cwd)` and written through `PluginManager`. That map is
 * deleted by `omp plugin uninstall`, so no configuration outlives the plugin.
 *
 * Users edit it with the native CLI:
 *   omp plugin config set om-orche telemetryEnabled false
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";

export const PLUGIN_NAME = "om-orche";

export interface OrcheConfig {
	/** Master switch for the Judgment/Production execution policy and automatic guidance. */
	enabled: boolean;
	telemetryEnabled: boolean;
	debugLogging: boolean;
}

export const DEFAULT_CONFIG: Readonly<OrcheConfig> = Object.freeze({
	enabled: true,
	telemetryEnabled: true,
	debugLogging: false,
});

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof OrcheConfig)[];

/**
 * Keys removed with per-task tier routing and with Jev routing. Stored values
 * are never read into the config; status only reports them so the user can
 * delete them.
 */
export const RETIRED_CONFIG_KEYS = Object.freeze([
	"taskRoutingEnabled",
	"taskMinConfidence",
	"taskMinMargin",
	"easyTaskRole",
	"hardTaskRole",
	"challengeTaskRole",
	"jevModel",
	"orchestrationRoutingEnabled",
	"orchestrationMinConfidence",
	"orchestrationMinMargin",
	"routingTimeoutMs",
	"maxRoutingInputChars",
] as const);

/** Retired keys present in a raw settings record, in declaration order. */
export function retiredConfigKeys(raw: Record<string, unknown> | undefined): string[] {
	return raw ? RETIRED_CONFIG_KEYS.filter(key => Object.hasOwn(raw, key)) : [];
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

/** Coerce a raw settings record into a complete config. */
export function normalizeConfig(raw: Record<string, unknown> | undefined): OrcheConfig {
	const r = raw ?? {};
	return {
		enabled: asBoolean(r.enabled, DEFAULT_CONFIG.enabled),
		telemetryEnabled: asBoolean(r.telemetryEnabled, DEFAULT_CONFIG.telemetryEnabled),
		debugLogging: asBoolean(r.debugLogging, DEFAULT_CONFIG.debugLogging),
	};
}

/** Parse a CLI-supplied string for one config key into its stored type. */
export function parseConfigValue(key: keyof OrcheConfig, value: string): boolean | undefined {
	const current = DEFAULT_CONFIG[key];
	if (typeof current === "boolean") {
		if (value === "true") return true;
		if (value === "false") return false;
	}
	return undefined;
}

export interface LoadedConfig {
	config: OrcheConfig;
	/** Retired keys still stored for this plugin; they have no effect. */
	retiredKeys: string[];
}

/** Read the merged (global + project-override) plugin settings record. */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
	let raw: Record<string, unknown> | undefined;
	try {
		raw = await getPluginSettings(PLUGIN_NAME, cwd);
	} catch {
		// Loaded outside the plugin manager (e.g. `--extension ./src/index.ts`): defaults apply.
		raw = undefined;
	}
	return { config: normalizeConfig(raw), retiredKeys: retiredConfigKeys(raw) };
}

/** Drop every stored key, restoring defaults. */
export async function clearStoredConfig(): Promise<void> {
	const manager = new PluginManager();
	const stored = await manager.getPluginSettings(PLUGIN_NAME);
	for (const key of Object.keys(stored)) {
		await manager.deletePluginSetting(PLUGIN_NAME, key);
	}
}
