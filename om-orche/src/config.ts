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
 *
 * The map also holds one internal key, the one-time OMP setup marker
 * ({@link HOST_SETUP_KEY}). It is not a setting and no configuration reset
 * removes it.
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";

export const PLUGIN_NAME = "om-orche";

/** Key of the one-time OMP setup marker in the plugin's settings map; see `omp-setup.ts`. */
export const HOST_SETUP_KEY = "hostSetupVersion";

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

export interface LoadedConfig {
	config: OrcheConfig;
	/** Retired keys still stored for this plugin; they have no effect. */
	retiredKeys: string[];
	/** Why the stored settings could not be read, when they could not: `config` is then the defaults. */
	error?: unknown;
}

/** Reads the merged plugin settings record for a working directory; OMP's own loader unless a caller supplies one. */
export type SettingsReader = (pluginName: string, cwd: string) => Promise<Record<string, unknown>>;

/**
 * Read the merged (global + project-override) plugin settings. Settings that
 * are not there (no plugin store at all, as when loaded outside the plugin
 * manager with `--extension ./src/index.ts`) mean defaults, and that is not a
 * problem. Any other failure, a corrupt or unreadable lock file, also yields
 * defaults, but is returned as `error` rather than passed off as a clean read:
 * silently defaulting would switch a plugin the user disabled back on.
 */
export async function loadConfig(cwd: string, read: SettingsReader = getPluginSettings): Promise<LoadedConfig> {
	let raw: Record<string, unknown>;
	try {
		raw = await read(PLUGIN_NAME, cwd);
	} catch (error) {
		const missing = (error as { code?: unknown } | null | undefined)?.code === "ENOENT";
		return { config: normalizeConfig(undefined), retiredKeys: [], ...(missing ? {} : { error }) };
	}
	return { config: normalizeConfig(raw), retiredKeys: retiredConfigKeys(raw) };
}

/**
 * Drop every setting stored for this plugin in OMP's plugin settings, restoring
 * defaults, and resolve to the keys the project override for `cwd` still sets.
 * `plugin-overrides.json` belongs to the project and OMP offers no way to edit
 * it, so what it sets stays in effect there. The one-time setup marker stays:
 * it records what the setup already did, not what the user wants, and dropping
 * it would re-run the setup and re-fill OMP keys the user deliberately deleted.
 */
export async function clearStoredConfig(cwd: string): Promise<string[]> {
	const manager = new PluginManager();
	const stored = await manager.getPluginSettings(PLUGIN_NAME);
	for (const key of Object.keys(stored)) {
		if (key !== HOST_SETUP_KEY) await manager.deletePluginSetting(PLUGIN_NAME, key);
	}
	// The global settings are gone, so what the merged record still holds is the project's, and the marker.
	return Object.keys(await getPluginSettings(PLUGIN_NAME, cwd)).filter(key => key !== HOST_SETUP_KEY);
}
