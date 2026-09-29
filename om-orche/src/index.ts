/**
 * om-orche — plugin-owned coordination over OMP's native `task` worker.
 *
 *   1. One execution policy notice, persisted as a hidden message with the prompt that
 *      needs it and kept in force until compaction or a tool change replaces it:
 *      Judgment (the main analyzes) and Production (workers build), chosen by the main
 *      per stage. It needs no network and no credentials, and the primary model never
 *      changes.
 *   2. Generic workers stay OMP's native `task` agent: it uses the user's `@task`
 *      role when set, else the main session's active model. Task calls are never
 *      classified or rewritten.
 *
 * Specialized and custom agents, and every explicit user choice, are left
 * exactly as they are.
 */
import { registerOrcheAdvisor } from "./orche-advisor.ts";
import { type HostSetupStore, pluginSetupStore, runOmpSetup } from "./omp-setup.ts";
import { registerCommands } from "./commands.ts";
import { PLUGIN_NAME } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import { registerFindingTools } from "./findings.ts";
import { OrcheRuntime } from "./runtime.ts";
import { trackWorkerUsage } from "./worker-usage.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** `setupStore` and `stateDir` default to the host's own; tests substitute theirs. */
export function registerOmOrche(
	pi: ExtensionAPI,
	setupStore: HostSetupStore = pluginSetupStore(),
	stateDir?: string,
): OrcheRuntime {
	const runtime = new OrcheRuntime(pi, stateDir);
	pi.setLabel(PLUGIN_NAME);
	registerCommands(pi, runtime);
	registerFindingTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		// Every session in the process runs this handler, but they share one telemetry writer, not one
		// telemetry choice: only a main session's own configuration decides whether its workers are
		// recorded (a subagent follows the main session above it), and only a main session loads the file.
		// A subagent's start must not flip the main's setting or migrate and write a file the main left alone.
		const main = mainSessionOf(ctx) !== undefined;
		await runtime.reloadConfig(ctx);
		// One-time OMP setup. It must finish before the auditor installer registered by
		// `registerOrcheAdvisor` runs in this same session_start, so OMP's live
		// `advisor.enabled` toggle can start the auditor in the first session.
		await runOmpSetup(ctx, { enabled: runtime.config.enabled, store: setupStore, logger: runtime.logger });
		if (main) await runtime.telemetry.load();
	});
	// Live usage covers workers named `task`, whichever native path spawned them.
	const stopUsageTracking = trackWorkerUsage(pi.events, runtime.telemetry, { enabled: () => runtime.recordsTelemetry() });

	// Persist the execution policy (hidden, once per context) with the prompt that needs it.
	pi.on("before_agent_start", async (event, ctx) => {
		// A stored `omp plugin config set` change applies from this turn on.
		await runtime.syncConfig(ctx);
		const message = runtime.orchestration.noticeToPersist(ctx, event.prompt);
		return message && { message };
	});

	// Adapt what the provider reads of the transcript, without editing it: OMP's `orchestrate`
	// notice gives way to the policy, and the plugin's notices are withheld whenever it does not
	// govern the request (see `orchestration.ts`).
	pi.on("context", (event, ctx) => {
		const messages = runtime.orchestration.applyToContext(ctx, event.messages);
		return messages ? { messages } : undefined;
	});

	pi.on("session_shutdown", async () => {
		stopUsageTracking();
		await runtime.telemetry.flush();
	});
	// Add optional plan-advice guidance after the policy notice.
	registerOrcheAdvisor(pi, undefined, () => runtime.config.enabled);

	return runtime;
}

export default function omOrcheExtension(pi: ExtensionAPI): void {
	registerOmOrche(pi);
}
