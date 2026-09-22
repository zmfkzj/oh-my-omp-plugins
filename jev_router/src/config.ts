/**
 * Plugin configuration.
 *
 * Storage is OMP's own per-plugin settings map (the `settings["omp-jev-router"]`
 * record inside `omp-plugins.lock.json`), read through
 * `getPluginSettings(name, cwd)` and written through `PluginManager`. That map is
 * deleted by `omp plugin uninstall`, so no configuration outlives the plugin.
 *
 * Users edit it with the native CLI:
 *   omp plugin config omp-jev-router set taskMinConfidence 0.8
 */
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";

export const PLUGIN_NAME = "omp-jev-router";

export interface JevRouterConfig {
	enabled: boolean;
	/** TypeSafe model id; empty string means "SDK default" (`jev-latest`). */
	jevModel: string;

	orchestrationRoutingEnabled: boolean;
	orchestrationMinConfidence: number;
	orchestrationMinMargin: number;

	taskRoutingEnabled: boolean;
	taskMinConfidence: number;
	taskMinMargin: number;

	/** Role a TASK_NORMAL spawn resolves through. `task` = leave OMP's bundled agent untouched. */
	normalTaskRole: string;
	/** Role a TASK_DEEP spawn resolves through. */
	deepTaskRole: string;

	routingTimeoutMs: number;
	maxRoutingInputChars: number;

	telemetryEnabled: boolean;
	debugLogging: boolean;
}

export const DEFAULT_CONFIG: Readonly<JevRouterConfig> = Object.freeze({
	enabled: true,
	jevModel: "",

	orchestrationRoutingEnabled: true,
	orchestrationMinConfidence: 0.8,
	orchestrationMinMargin: 0.25,

	taskRoutingEnabled: true,
	taskMinConfidence: 0.75,
	taskMinMargin: 0.2,

	normalTaskRole: "task",
	deepTaskRole: "task_hard",

	routingTimeoutMs: 4000,
	maxRoutingInputChars: 4000,

	telemetryEnabled: true,
	debugLogging: false,
});

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof JevRouterConfig)[];

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

function asRole(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	// Accept both `task_hard` and `@task_hard`; roles are stored bare.
	const trimmed = value.trim().replace(/^@/, "");
	return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : fallback;
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

		taskRoutingEnabled: asBoolean(r.taskRoutingEnabled, DEFAULT_CONFIG.taskRoutingEnabled),
		taskMinConfidence: asNumber(r.taskMinConfidence, DEFAULT_CONFIG.taskMinConfidence, 0, 1),
		taskMinMargin: asNumber(r.taskMinMargin, DEFAULT_CONFIG.taskMinMargin, 0, 1),

		normalTaskRole: asRole(r.normalTaskRole, DEFAULT_CONFIG.normalTaskRole),
		deepTaskRole: asRole(r.deepTaskRole, DEFAULT_CONFIG.deepTaskRole),

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

/** Read the merged (global + project-override) plugin settings record. */
export async function loadConfig(cwd: string): Promise<JevRouterConfig> {
	try {
		return normalizeConfig(await getPluginSettings(PLUGIN_NAME, cwd));
	} catch {
		// Loaded outside the plugin manager (e.g. `--extension ./src/index.ts`): defaults apply.
		return normalizeConfig(undefined);
	}
}

/** Drop every stored key, restoring defaults. */
export async function clearStoredConfig(): Promise<void> {
	const manager = new PluginManager();
	const stored = await manager.getPluginSettings(PLUGIN_NAME);
	for (const key of Object.keys(stored)) {
		await manager.deletePluginSetting(PLUGIN_NAME, key);
	}
}
