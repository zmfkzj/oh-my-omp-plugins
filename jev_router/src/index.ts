/**
 * omp-jev-router — two bounded routing decisions for OMP.
 *
 *   1. Front door: DEFAULT, SLOW, or OMP's native ORCHESTRATE contract
 *      for this user request.
 *   2. Tier: once OMP has chosen its generic `task` worker, should that spawn
 *      resolve through `@task` or through `@task_hard`?
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
import { DEEP_AGENT_NAME, NORMAL_AGENT_NAME } from "./deep-agent.ts";
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
			if (runtime.config.deepTaskRole === "task_hard" && settings.getModelRole("task_hard") === undefined) {
				settings.setModelRole("task_hard", "@slow");
				changed = true;
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
	registerOrcheAdvisor(pi);
	const stopUsageTracking = trackWorkerUsage(
		pi.events,
		runtime.telemetry,
		new Set([GENERIC_TASK_AGENT, NORMAL_AGENT_NAME, DEEP_AGENT_NAME]),
	);

	// One Jev call per prompt, memoized across policy-preparation retries.
	// The model must be set here: agent-loop.ts captures it before `context`.
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

	// A settled turn restores the model unless another actor changed it.
	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue !== true) await runtime.orchestration.endTurn(ctx.model);
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

	return runtime;
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	// `agents/` beside this module's parent is what OMP's discovery scans.
	registerJevRouter(pi, path.resolve(import.meta.dir, ".."));
}
