/**
 * omp-jev-router — two bounded routing decisions for OMP.
 *
 *   1. Front door: should OMP's *native* orchestration contract be activated
 *      for this user request, or should the primary agent just run it?
 *   2. Tier: once OMP has chosen its generic `task` worker, should that spawn
 *      resolve through `@task` or through `@task_hard`?
 *
 * OMP's own SMOL vs TASK decision, its specialized agents, and every explicit
 * user choice are left exactly as they are.
 */
import path from "node:path";
import { registerCommands } from "./commands.ts";
import { TYPESAFE_PROVIDER } from "./credentials.ts";
import { sessionOf } from "./host.ts";
import { JevRouterRuntime } from "./runtime.ts";
import { harvestTaskUsage } from "./usage-harvest.ts";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const TASK_TOOL = "task";

export function registerJevRouter(pi: ExtensionAPI, packageRoot: string): JevRouterRuntime {
	const runtime = new JevRouterRuntime(pi, packageRoot);
	pi.setLabel("Jev Router");
	registerCommands(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		runtime.bindContext(ctx);
		await runtime.reloadConfig(ctx.cwd);
		await runtime.telemetry.load();
		// Materialize + verify the tier aliases before the first `task` call.
		await runtime.surveyAgents(ctx.cwd, sessionOf(ctx)?.settings);
		runtime.checkTierRoles(ctx);
	});

	// Front door, phase 1: scope the turn. No network work here, so OMP's
	// policy-preparation retries cost nothing. Main-session-only guards live in
	// the router; a subagent that reaches this handler is rejected there, so
	// orchestration can never nest.
	pi.on("before_agent_start", (event, ctx) => {
		runtime.bindContext(ctx);
		runtime.orchestration.beginTurn(ctx, event.prompt);
	});

	// Front door, phase 2: decide once against the messages actually going out,
	// and attach OMP's own orchestrate notice for this turn only.
	pi.on("context", async (event, ctx) => {
		runtime.bindContext(ctx);
		const messages = await runtime.orchestration.applyToContext(ctx, event.messages);
		return messages ? { messages } : undefined;
	});

	// A settled agent loop ends the turn scope: the next request routes fresh,
	// with no carry-over from an automatically orchestrated previous turn.
	pi.on("agent_end", event => {
		if (event.willContinue !== true) runtime.orchestration.endTurn();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== TASK_TOOL) return undefined;
		runtime.bindContext(ctx);
		return await runtime.task.route(pi, event.toolCallId, event.input);
	});

	pi.on("tool_result", event => {
		if (event.toolName !== TASK_TOOL) return;
		for (const spawn of harvestTaskUsage(event.details)) {
			runtime.telemetry.recordWorkerUsage(spawn.agent, spawn.usage, spawn.durationMs);
		}
	});

	// A rotated or rejected key must not be reused from the short-lived cache.
	pi.on("credential_disabled", event => {
		if (event.provider === TYPESAFE_PROVIDER) runtime.invalidateCredential();
	});

	pi.on("session_shutdown", async () => {
		await runtime.telemetry.flush();
	});

	return runtime;
}

export default function jevRouterExtension(pi: ExtensionAPI): void {
	// `agents/` beside this module's parent is what OMP's discovery scans.
	registerJevRouter(pi, path.resolve(import.meta.dir, ".."));
}
