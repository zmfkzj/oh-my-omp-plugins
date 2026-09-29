/**
 * Runs the plugin's configuration reset against OMP's real plugin settings store and prints what happened as JSON.
 *
 * The store lives under the home directory, which Bun fixes when a process starts, so `config.test.ts` spawns this
 * script with a temporary `HOME` instead of redirecting anything in its own process. Usage: `<project cwd> <state dir>`;
 * the caller may have put a `plugin-overrides.json` in the project.
 */
import path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerCommands } from "../src/commands.ts";
import { clearStoredConfig, PLUGIN_NAME } from "../src/config.ts";
import { OrcheRuntime } from "../src/runtime.ts";

const [cwd, stateDir] = process.argv.slice(2) as [string, string];

/** What a user who tuned the plugin globally has stored. */
async function storeGlobalSettings(): Promise<void> {
	const manager = new PluginManager();
	await manager.setPluginSetting(PLUGIN_NAME, "debugLogging", true);
	await manager.setPluginSetting(PLUGIN_NAME, "telemetryEnabled", false);
	await manager.setPluginSetting(PLUGIN_NAME, "hostSetupVersion", 1);
}

/** The globally stored settings alone: a project with no override has nothing to merge in. */
async function globalSettings(): Promise<Record<string, unknown>> {
	return new PluginManager(path.join(cwd, "no-project-override")).getPluginSettings(PLUGIN_NAME);
}

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

console.log(
	JSON.stringify({ cleared, globalAfterClear, notes, config: runtime.config, globalAfterCommand: await globalSettings() }),
);
