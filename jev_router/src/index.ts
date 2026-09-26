/**
 * omp-jev-router — two bounded routing decisions for OMP.
 *
 *   1. DEFAULT or native ORCHESTRATE; the primary model never changes.
 *   2. EASY, HARD or CHALLENGE for generic `task` workers.
 *
 * OMP's own SMOL vs TASK decision, its specialized agents, and every explicit
 * user choice are left exactly as they are.
 */
import path from "node:path";
import { registerOrcheAdvisor } from "./orche-advisor.ts";
import { AUDITOR_ROLE } from "./verification-auditor.ts";
import { registerCommands } from "./commands.ts";
import { TYPESAFE_PROVIDER } from "./credentials.ts";
import { mainSessionOf, sessionOf } from "./host.ts";
import { JevRouterRuntime } from "./runtime.ts";
import { GENERIC_TASK_AGENT } from "./task-routing.ts";
import { EASY_AGENT_NAME, HARD_AGENT_NAME, CHALLENGE_AGENT_NAME } from "./deep-agent.ts";
import { trackWorkerUsage } from "./worker-usage.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const TASK_TOOL = "task";

export function registerJevRouter(pi: ExtensionAPI, packageRoot: string): JevRouterRuntime {
	const runtime = new JevRouterRuntime(pi, packageRoot);
	pi.setLabel("Jev Router");
	registerCommands(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		runtime.bindContext(ctx);
		await runtime.reloadConfig(ctx.cwd);
		// Register missing custom roles without changing user assignments.
		// Child sessions inherit settings and must not write global configuration.
		const settings = mainSessionOf(ctx)?.settings;
		if (settings) {
			let changed = false;
			for (const [role, fallback] of [
				[runtime.config.easyTaskRole, "@smol"],
				[runtime.config.hardTaskRole, "@task"],
				[runtime.config.challengeTaskRole, "@slow"],
			] as const) {
				if (settings.getModelRole(role) === undefined) {
					settings.setModelRole(role, fallback);
					changed = true;
				}
			}
			if (settings.getModelRole(AUDITOR_ROLE) === undefined) {
				settings.setModelRole(AUDITOR_ROLE, "@smol");
				changed = true;
			}
			if (changed) await settings.flush();
		}
		await runtime.telemetry.load();
		// Materialize + verify the tier aliases before the first `task` call.
		await runtime.surveyAgents(ctx.cwd, sessionOf(ctx)?.settings);
		runtime.checkTierRoles(ctx);
	});
	const stopUsageTracking = trackWorkerUsage(
		pi.events,
		runtime.telemetry,
		new Set([GENERIC_TASK_AGENT, EASY_AGENT_NAME, HARD_AGENT_NAME, CHALLENGE_AGENT_NAME]),
	);

	// Initial classification sees bounded visible history and the committed plan.
	pi.on("before_agent_start", async (event, ctx) => {
		runtime.bindContext(ctx);
		await runtime.orchestration.beginTurn(ctx, event.prompt);
	});

	// Attach the decided notice for this turn, without persisting it.
	pi.on("context", async (event, ctx) => {
		runtime.bindContext(ctx);
		const messages = await runtime.orchestration.applyToContext(ctx, event.messages);
		return messages ? { messages } : undefined;
	});

	pi.on("agent_end", (event) => {
		if (event.willContinue !== true) runtime.orchestration.endTurn();
	});

	// Reconsider orchestration after a successful plan commit, never model selection.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "todo") return;
		runtime.bindContext(ctx);
		await runtime.orchestration.onTodoResult(ctx, event);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== TASK_TOOL) return undefined;
		runtime.bindContext(ctx);
		return await runtime.task.route(pi, event.toolCallId, event.input);
	});

	// A rotated or rejected key must not be reused from the short-lived cache.
	pi.on("credential_disabled", event => {
		if (event.provider === TYPESAFE_PROVIDER) runtime.invalidateCredential();
	});

	pi.on("session_shutdown", async () => {
		stopUsageTracking();
		await runtime.telemetry.flush();
	});
	// Run after our context hook so new orchestration notices get review guidance immediately.
	registerOrcheAdvisor(pi);

	return runtime;
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	// `agents/` beside this module's parent is what OMP's discovery scans.
	registerJevRouter(pi, path.resolve(import.meta.dir, ".."));
}
