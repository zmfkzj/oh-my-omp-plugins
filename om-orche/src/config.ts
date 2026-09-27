/**
 * Plugin configuration.
 *
 * Storage is OMP's own per-plugin settings map (the `settings["om-orche"]`
 * record inside `omp-plugins.lock.json`), read through
 * `getPluginSettings(name, cwd)` and written through `PluginManager`. That map is
 * deleted by `omp plugin uninstall`, so no configuration outlives the plugin.
 *
 * Users edit it with the native CLI:
 *   omp plugin config set om-orche orchestrationMinConfidence 0.7
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";

export const PLUGIN_NAME = "om-orche";

export interface JevRouterConfig {
	enabled: boolean;
	/** TypeSafe model id; empty string means "SDK default" (`jev-latest`). */
	jevModel: string;

	orchestrationRoutingEnabled: boolean;
	orchestrationMinConfidence: number;
	orchestrationMinMargin: number;

	routingTimeoutMs: number;
	maxRoutingInputChars: number;

	telemetryEnabled: boolean;
	debugLogging: boolean;
}

export const DEFAULT_CONFIG: Readonly<JevRouterConfig> = Object.freeze({
	enabled: true,
	jevModel: "",

	orchestrationRoutingEnabled: true,
	orchestrationMinConfidence: 0.6,
	orchestrationMinMargin: 0.2,

	routingTimeoutMs: 4000,
	maxRoutingInputChars: 12000,

	telemetryEnabled: true,
	debugLogging: false,
});

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof JevRouterConfig)[];

/**
 * Keys removed with per-task tier routing. Stored values are never read into
 * the config; status only reports them so the user can delete them.
 */
export const RETIRED_CONFIG_KEYS = Object.freeze([
	"taskRoutingEnabled",
	"taskMinConfidence",
	"taskMinMargin",
	"easyTaskRole",
	"hardTaskRole",
	"challengeTaskRole",
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

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(raw)) return fallback;
	return Math.min(max, Math.max(min, raw));
}

/** Coerce a raw settings record into a complete, range-clamped config. */
export function normalizeConfig(raw: Record<string, unknown> | undefined): JevRouterConfig {
	const r = raw ?? {};
	return {
		enabled: asBoolean(r.enabled, DEFAULT_CONFIG.enabled),
		jevModel: typeof r.jevModel === "string" ? r.jevModel.trim() : DEFAULT_CONFIG.jevModel,

		orchestrationRoutingEnabled: asBoolean(
			r.orchestrationRoutingEnabled,
			DEFAULT_CONFIG.orchestrationRoutingEnabled,
		),
		orchestrationMinConfidence: asNumber(
			r.orchestrationMinConfidence,
			DEFAULT_CONFIG.orchestrationMinConfidence,
			0,
			1,
		),
		orchestrationMinMargin: asNumber(r.orchestrationMinMargin, DEFAULT_CONFIG.orchestrationMinMargin, 0, 1),

		routingTimeoutMs: asNumber(r.routingTimeoutMs, DEFAULT_CONFIG.routingTimeoutMs, 250, 20_000),
		maxRoutingInputChars: asNumber(r.maxRoutingInputChars, DEFAULT_CONFIG.maxRoutingInputChars, 200, 40_000),

		telemetryEnabled: asBoolean(r.telemetryEnabled, DEFAULT_CONFIG.telemetryEnabled),
		debugLogging: asBoolean(r.debugLogging, DEFAULT_CONFIG.debugLogging),
	};
}

/** Parse a CLI-supplied string for one config key into its stored type. */
export function parseConfigValue(key: keyof JevRouterConfig, value: string): boolean | number | string | undefined {
	const current = DEFAULT_CONFIG[key];
	if (typeof current === "boolean") {
		if (value === "true") return true;
		if (value === "false") return false;
		return undefined;
	}
	if (typeof current === "number") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return value.trim();
}

export interface LoadedConfig {
	config: JevRouterConfig;
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
