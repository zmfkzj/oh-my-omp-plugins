/**
 * om-orche — plugin-owned coordination over OMP's native `task` worker.
 *
 *   1. DEFAULT or ORCHESTRATE routing; plan advice never gates execution,
 *      and the primary model never changes.
 *   2. Generic workers stay OMP's native `task` agent. Its model comes from the
 *      user's `@task` role; task calls are never classified or rewritten.
 *
 * Specialized and custom agents, and every explicit user choice, are left
 * exactly as they are.
 */
import { registerOrcheAdvisor } from "./orche-advisor.ts";
import { AUDITOR_ROLE } from "./verification-auditor.ts";
import { registerCommands } from "./commands.ts";
import { TYPESAFE_PROVIDER } from "./credentials.ts";
import { PLUGIN_NAME } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import { registerFindingTools } from "./findings.ts";
import { JevRouterRuntime } from "./runtime.ts";
import { trackWorkerUsage } from "./worker-usage.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function registerJevRouter(pi: ExtensionAPI): JevRouterRuntime {
	const runtime = new JevRouterRuntime(pi);
	pi.setLabel(PLUGIN_NAME);
	registerCommands(pi, runtime);
	registerFindingTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		runtime.bindContext(ctx);
		await runtime.reloadConfig(ctx.cwd);
		// Register the auditor role without changing user assignments.
		// Child sessions inherit settings and must not write global configuration.
		const settings = mainSessionOf(ctx)?.settings;
		if (settings && settings.getModelRole(AUDITOR_ROLE) === undefined) {
			settings.setModelRole(AUDITOR_ROLE, "@smol");
			await settings.flush();
		}
		await runtime.telemetry.load();
	});
	// Live usage covers workers named `task`, whichever native path spawned them.
	const stopUsageTracking = trackWorkerUsage(pi.events, runtime.telemetry);

	// Initial classification sees bounded visible history and the committed plan.
	pi.on("before_agent_start", async (event, ctx) => {
		runtime.bindContext(ctx);
		await runtime.orchestration.beginTurn(ctx, event.prompt);
	});

	// Attach the decided notice for this turn, without persisting it.
	pi.on("context", async (event, ctx) => {
		runtime.bindContext(ctx);
		const messages = await runtime.orchestration.applyToContext(ctx, event.messages) ?? event.messages;
		return messages !== event.messages ? { messages } : undefined;
	});

	pi.on("agent_end", (event) => {
		if (event.willContinue !== true) runtime.orchestration.endTurn();
	});

	// Reconsider orchestration only after a committed plan changes.
	pi.on("tool_result", async (event, ctx) => {
		runtime.bindContext(ctx);
		if (event.toolName === "todo") await runtime.orchestration.onTodoResult(ctx, event);
	});

	// A rotated or rejected key must not be reused from the short-lived cache.
	pi.on("credential_disabled", event => {
		if (event.provider === TYPESAFE_PROVIDER) runtime.invalidateCredential();
	});

	pi.on("session_shutdown", async () => {
		stopUsageTracking();
		await runtime.telemetry.flush();
	});
	// Add optional plan-advice guidance after the routing policy notice.
	registerOrcheAdvisor(pi, undefined, () => runtime.config.enabled);

	return runtime;
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	registerJevRouter(pi);
}
