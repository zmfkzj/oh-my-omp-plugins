/**
 * Runs the plugin's configuration handling against OMP's real plugin settings store and prints what happened as JSON.
 *
 * The store lives under the home directory, which Bun fixes when a process starts, so `config.test.ts` spawns this
 * script with a temporary `HOME` instead of redirecting anything in its own process. Usage:
 * `<mode> <project cwd> <state dir>`; the caller may have put a `plugin-overrides.json` in the project.
 *
 * - `reset`: the configuration reset, once through `clearStoredConfig` and once through `/om-orche reset`.
 * - `live`: a running main session over a store that changes, and then breaks, underneath it.
 * - `corrupt`: a session that starts over a corrupt store, and one over a store that does not exist.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { registerCommands } from "../src/commands.ts";
import { clearStoredConfig, HOST_SETUP_KEY, PLUGIN_NAME } from "../src/config.ts";
import { HOST_SETUP_VERSION, pluginSetupStore } from "../src/omp-setup.ts";
import { OrcheRuntime } from "../src/runtime.ts";
import { makeSession, registerAsMain } from "./harness.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const [mode, cwd, stateDir] = process.argv.slice(2) as [string, string, string];

/** What a user who tuned the plugin globally has stored. */
async function storeGlobalSettings(): Promise<void> {
	const manager = new PluginManager();
	await manager.setPluginSetting(PLUGIN_NAME, "debugLogging", true);
	await manager.setPluginSetting(PLUGIN_NAME, "telemetryEnabled", false);
	await manager.setPluginSetting(PLUGIN_NAME, HOST_SETUP_KEY, HOST_SETUP_VERSION);
}

/** The globally stored settings alone: a project with no override has nothing to merge in. */
async function globalSettings(): Promise<Record<string, unknown>> {
	return new PluginManager(path.join(cwd, "no-project-override")).getPluginSettings(PLUGIN_NAME);
}

/** An extension API whose logger keeps the warnings. */
function loggedApi(warnings: string[]): ExtensionAPI {
	return {
		logger: { debug() {}, info() {}, error() {}, warn: (message: string) => void warnings.push(message) },
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
}

/** The store's own lock file, which OMP keeps the settings map in. */
async function writeStore(content: string): Promise<void> {
	await mkdir(path.dirname(getPluginsLockfile()), { recursive: true });
	await writeFile(getPluginsLockfile(), content);
}

const storeWith = (settings: Record<string, unknown>) => JSON.stringify({ plugins: {}, settings: { [PLUGIN_NAME]: settings } });

async function reset(): Promise<object> {
	await storeGlobalSettings();
	const cleared = await clearStoredConfig(cwd);
	const globalAfterClear = await globalSettings();

	// The same reset through the command a user runs.
	await storeGlobalSettings();
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		logger: { debug() {}, warn() {}, info() {}, error() {} },
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	const runtime = new OrcheRuntime(pi, stateDir);
	registerCommands(pi, runtime);
	const notes: string[] = [];
	const ctx = { cwd, ui: { notify: (message: string) => void notes.push(message) } } as unknown as ExtensionCommandContext;
	await handler?.("reset", ctx);
	return {
		cleared,
		globalAfterClear,
		notes,
		config: runtime.config,
		globalAfterCommand: await globalSettings(),
		setupMarker: await pluginSetupStore().version(),
	};
}

/** The main session of `cwd`, registered as the host does. */
function mainSession(): ExtensionContext {
	const fake = makeSession();
	registerAsMain(fake.session);
	return { ...fake.ctx, cwd } as ExtensionContext;
}

async function live(): Promise<object> {
	const warnings: string[] = [];
	const runtime = new OrcheRuntime(loggedApi(warnings), stateDir);
	const ctx = mainSession();
	const manager = new PluginManager();

	await runtime.reloadConfig(ctx);
	const atStart = { ...runtime.config };

	await manager.setPluginSetting(PLUGIN_NAME, "enabled", false);
	await manager.setPluginSetting(PLUGIN_NAME, "telemetryEnabled", false);
	await runtime.syncConfig(ctx);
	const afterChange = { ...runtime.config, recordsTelemetry: runtime.recordsTelemetry() };

	// A subagent's turn never re-reads: it keeps what it read at its own start.
	await manager.setPluginSetting(PLUGIN_NAME, "enabled", true);
	const subagent = { ...ctx, agent: { kind: "sub", id: "1-worker", name: "task", depth: 1, parentId: "Main" } } as ExtensionContext;
	await runtime.syncConfig(subagent);
	const afterSubagentTurn = { ...runtime.config };

	await runtime.syncConfig(ctx);
	const afterMainTurn = { ...runtime.config };

	// The store breaks mid-session: what is in effect stays, and the failure is reported once.
	await writeStore("{ half a wri");
	await runtime.syncConfig(ctx);
	await runtime.syncConfig(ctx);
	const whileCorrupt = { config: { ...runtime.config }, error: runtime.configError, warnings: [...warnings] };

	await writeStore(storeWith({ enabled: false }));
	await runtime.syncConfig(ctx);
	const afterRepair = { config: { ...runtime.config }, error: runtime.configError ?? null, warnings: [...warnings] };

	return { atStart, afterChange, afterSubagentTurn, afterMainTurn, whileCorrupt, afterRepair };
}

async function corrupt(): Promise<object> {
	const warnings: string[] = [];
	const runtime = new OrcheRuntime(loggedApi(warnings), stateDir);
	const ctx = mainSession();

	await writeStore("{ half a wri");
	await runtime.reloadConfig(ctx);
	const overCorruptStore = { config: { ...runtime.config }, error: runtime.configError, warnings: [...warnings] };

	// No store at all is what a plugin loaded outside the plugin manager sees: defaults, and not a problem.
	await writeStore(storeWith({ enabled: false }));
	await runtime.reloadConfig(ctx);
	const afterRepair = { config: { ...runtime.config }, error: runtime.configError ?? null };

	const missing = new OrcheRuntime(loggedApi(warnings), stateDir);
	const before = warnings.length;
	await rm(getPluginsLockfile());
	await missing.reloadConfig(ctx);
	const overMissingStore = { config: { ...missing.config }, error: missing.configError ?? null, newWarnings: warnings.length - before };

	return { overCorruptStore, afterRepair, overMissingStore };
}

const modes: Record<string, () => Promise<object>> = { reset, live, corrupt };
const run = modes[mode];
if (!run) throw new Error(`unknown probe mode ${mode}`);
console.log(JSON.stringify(await run()));
