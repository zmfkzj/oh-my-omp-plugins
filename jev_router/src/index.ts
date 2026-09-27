/**
 * omp-jev-router — plugin-owned coordination over OMP's native `task` worker.
 *
 *   1. DEFAULT or ORCHESTRATE plus an independent review requirement; the
 *      primary model never changes.
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
import { mainSessionOf } from "./host.ts";
import { registerFindingTools } from "./findings.ts";
import { JevRouterRuntime } from "./runtime.ts";
import { trackWorkerUsage } from "./worker-usage.ts";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export function registerJevRouter(pi: ExtensionAPI): JevRouterRuntime {
	const runtime = new JevRouterRuntime(pi);
	pi.setLabel("Jev Router");
	registerCommands(pi, runtime);
	runtime.reviewGate.registerCommands(pi);
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
		const reviewed = runtime.reviewGate.applyGuidance(ctx, messages);
		if (reviewed) return { messages: reviewed };
		return messages !== event.messages ? { messages } : undefined;
	});

	pi.on("agent_end", (event) => {
		if (event.willContinue !== true) runtime.orchestration.endTurn();
	});

	// Settle review permits for the finished call; reconsider orchestration after a plan commit.
	pi.on("tool_result", async (event, ctx) => {
		runtime.bindContext(ctx);
		runtime.reviewGate.observeToolResult(ctx, event);
		if (event.toolName === "todo") await runtime.orchestration.onTodoResult(ctx, event);
	});

	// Review enforcement only: the native task input is never rewritten.
	pi.on("tool_call", (event, ctx) => {
		runtime.bindContext(ctx);
		return runtime.reviewGate.beforeTool(ctx, event.toolName, { ...event.input }, event.toolCallId);
	});

	// Shared preflight covers actual task dispatch and eval agent()/workpool.
	pi.on("before_subagent_spawn", (event, ctx) => runtime.reviewGate.beforeSpawn(ctx, event));

	// A rotated or rejected key must not be reused from the short-lived cache.
	pi.on("credential_disabled", event => {
		if (event.provider === TYPESAFE_PROVIDER) runtime.invalidateCredential();
	});

	// Unconsumed spawn permits never survive session navigation or shutdown.
	const clearPermits = (_event: unknown, ctx: ExtensionContext) =>
		runtime.reviewGate.clearSession(ctx.sessionManager.getSessionId());
	pi.on("session_switch", clearPermits);
	pi.on("session_branch", clearPermits);
	pi.on("session_tree", clearPermits);
	pi.on("session_shutdown", async (_event, ctx) => {
		stopUsageTracking();
		runtime.reviewGate.clearSession(ctx.sessionManager.getSessionId());
		await runtime.telemetry.flush();
	});
	// Run after our context hook so new orchestration notices get review guidance immediately.
	registerOrcheAdvisor(pi, runtime.reviewGate, undefined, () => runtime.config.enabled);

	return runtime;
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	registerJevRouter(pi);
}
