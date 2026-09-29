/**
 * om-orche — plugin-owned coordination over OMP's native `task` worker.
 *
 *   1. One execution policy in the main session's system prompt: Judgment (the main
 *      analyzes) and Production (workers build), chosen by the main per stage. It is
 *      appended to every governed prompt alike, so the cached request prefix stays
 *      stable; it needs no network and no credentials, and the primary model never
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
	// The provider's own numbers for each finished assistant message: the main session's, and the generic workers'.
	pi.on("message_end", (event, ctx) => {
		runtime.recordProviderUsage(ctx, event.message);
	});

	// Append the execution policy to the system prompt of every governed prompt. This handler is
	// registered before the advisor's (see `registerOrcheAdvisor` below), and the host chains
	// `systemPrompt` through one extension's handlers in registration order, so the policy always
	// comes first and the advisor guidance after it.
	pi.on("before_agent_start", async (event, ctx) => {
		// A stored `omp plugin config set` change applies from this prompt on.
		await runtime.syncConfig(ctx);
		const systemPrompt = runtime.orchestration.withPolicy(ctx, event.systemPrompt);
		return systemPrompt && { systemPrompt };
	});

	// Adapt what the provider reads of the transcript, without editing it: OMP's keyword notices get
	// their counterparts, and the plugin's own messages are withheld whenever it does not govern the
	// request (see `orchestration.ts`).
	pi.on("context", (event, ctx) => {
		const messages = runtime.orchestration.applyToContext(ctx, event.messages);
		return messages ? { messages } : undefined;
	});

	pi.on("session_shutdown", async () => {
		stopUsageTracking();
		await runtime.telemetry.flush();
	});
	// Optional plan-advice guidance, appended to the system prompt after the policy.
	registerOrcheAdvisor(pi, undefined, () => runtime.config.enabled);

	return runtime;
}

export default function omOrcheExtension(pi: ExtensionAPI): void {
	registerOmOrche(pi);
}
