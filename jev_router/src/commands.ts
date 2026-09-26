/**
 * `/jev-router` slash command.
 *
 * Subcommands: setup, status, test, stats, reset. No subcommand prints status.
 * Secrets are never rendered: the credential is reported by provenance only.
 */
import { clearStoredConfig, DEFAULT_CONFIG } from "./config.ts";
import {
	clearStoredCredential,
	hasStoredCredential,
	storeCredential,
	TYPESAFE_ENV_VAR,
	validateCredential,
} from "./credentials.ts";
import { EASY_AGENT_NAME, HARD_AGENT_NAME, CHALLENGE_AGENT_NAME } from "./deep-agent.ts";
import { resolveRole, spawnableTaskAgents } from "./host.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { JevRouterRuntime } from "./runtime.ts";

export const COMMAND_NAME = "jev-router";
const SUBCOMMANDS = ["setup", "status", "test", "stats", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const PAD = 23;

function row(label: string, value: string): string {
	return `${label.padEnd(PAD)}${value}`;
}

/** Fixed probes for `/jev-router test`; they exercise both routers end to end. */
const TEST_REQUEST =
	"Rename the `retryCount` field to `attempts` in the HTTP client and update its two call sites.";
const TEST_PARALLEL_REQUEST =
	"Implement three independently specified features in disjoint subsystems: CLI export, database retention, and dashboard filtering. Each has its own tests and no shared interfaces; coordinate independent workers and integrate their results.";
const TEST_SUBTASKS = [
	{ id: "t0", instruction: "Rename the local variable retryCount to attempts in one function without changing behavior." },
	{
		id: "t1",
		instruction:
			"Users intermittently see stale balances after a concurrent transfer. Find the root cause across the ledger and cache layers and decide how to make reads consistent.",
	},
	{ id: "t2", instruction: "Implement paginated CLI output using the existing endpoint and pagination contract, including regression coverage." },
];

function formatCredential(runtime: JevRouterRuntime, stored: boolean, source: string | undefined): string {
	if (source === "env") return `configured (${TYPESAFE_ENV_VAR}, not persisted)`;
	if (source === "omp-credential-store") return "configured (OMP credential store)";
	if (stored) return "stored but unreadable";
	return runtime.config.enabled ? "not configured — run /jev-router setup" : "not configured";
}

export async function renderStatus(
	pi: ExtensionAPI,
	runtime: JevRouterRuntime,
	ctx: ExtensionCommandContext,
): Promise<string> {
	const config = runtime.config;
	const credential = await runtime.credential();
	const easy = resolveRole(ctx, config.easyTaskRole);
	const hard = resolveRole(ctx, config.hardTaskRole);
	const challenge = resolveRole(ctx, config.challengeTaskRole);
	const survey = runtime.survey;
	// Spawnability, not mere existence: this is what the router actually gates on.
	const spawnable = spawnableTaskAgents(pi);
	const aliasState = (name: string) =>
		spawnable.has(name)
			? `${name} — discoverable and spawnable`
			: survey.discoveredAliases.has(name)
				? `${name} — on disk but NOT spawnable in this session`
				: `${name} — MISSING`;

	const lines = [
		row("Jev Router", config.enabled ? "enabled" : "disabled"),
		row("Credential", formatCredential(runtime, hasStoredCredential(ctx), credential?.source)),
		"",
		row("Orchestration routing", config.orchestrationRoutingEnabled ? "enabled" : "disabled"),
		row("Primary model", "unchanged — no model switching"),
		row("Model", config.jevModel || "jev-latest (default)"),
		row("Gate", `confidence ≥ ${config.orchestrationMinConfidence}, margin ≥ ${config.orchestrationMinMargin}`),
		"",
		row("TASK tier routing", config.taskRoutingEnabled ? "enabled" : "disabled"),
		row("TASK_EASY", `${easy.alias} → ${easy.label}`),
		row("TASK_HARD", `${hard.alias} → ${hard.label}`),
		row("TASK_CHALLENGE", `${challenge.alias} → ${challenge.label}`),
		row("Gate", `confidence ≥ ${config.taskMinConfidence}, margin ≥ ${config.taskMinMargin}`),
		row("Easy tier agent", aliasState(EASY_AGENT_NAME)),
		row("Hard tier agent", aliasState(HARD_AGENT_NAME)),
		row("Challenge tier agent", aliasState(CHALLENGE_AGENT_NAME)),
	];

	const orchestration = runtime.orchestration.lastDecision;
	const task = runtime.task.lastDecision;
	lines.push(
		"",
		row(
			"Last orchestration",
			orchestration
				? `${orchestration.outcome}${orchestration.confidence === undefined ? "" : ` ${orchestration.confidence.toFixed(2)}`}`
				: "none this session",
		),
		row("Last TASK route", task ? `${task.route} ${task.confidence.toFixed(2)}` : "none this session"),
	);

	const tiers = [easy, hard, challenge];
	if (tiers.every(role => role.modelId) && new Set(tiers.map(role => role.modelId)).size < tiers.length) {
		lines.push("", "Some worker tiers resolve to the same model; check role assignments for cost differentiation.");
	}
	const unresolved = tiers.filter(role => !role.modelId).map(role => role.alias);
	if (unresolved.length > 0) {
		lines.push(
			"",
			`Unresolved role(s): ${unresolved.join(", ")}.`,
			"Set them with `omp config set modelRoles.<role> <provider/model>` or the /model Roles view.",
		);
	}
	if (!survey.genericTaskIsBundled) {
		lines.push(
			"",
			"An agent named `task` shadows OMP's bundled worker; tier routing is disabled so your definition is not replaced.",
		);
	}
	if (survey.materialized.failed.length > 0) {
		lines.push("", `Tier agent files could not be written: ${survey.materialized.failed.join(", ")}.`);
	}
	return lines.join("\n");
}

export function renderStats(runtime: JevRouterRuntime): string {
	const snapshot = runtime.telemetry.snapshot();
	const orchestration = snapshot.orchestration;
	const task = snapshot.task;
	const avg = (sum: number, count: number) => (count === 0 ? "—" : `${Math.round(sum / count)}ms`);
	const histogram = (buckets: readonly number[]) =>
		buckets.map((count, index) => `${(index / 10).toFixed(1)}:${count}`).join(" ");

	const lines = [
		row("Orchestration decisions", String(orchestration.requests)),
		...(orchestration.legacyDecisions > 0 ? [row("  retired labels", String(orchestration.legacyDecisions))] : []),
		row("  DEFAULT", String(orchestration.DEFAULT)),
		row("  ORCHESTRATE", String(orchestration.ORCHESTRATE)),
		row("  errors / timeouts", `${orchestration.errors} / ${orchestration.timeouts}`),
		row("  avg latency", avg(orchestration.latencySumMs, orchestration.latencyCount)),
		row("  confidence", histogram(orchestration.confidence)),
		row("  margin", histogram(orchestration.margin)),
		"",
		row("TASK batches", String(task.batches)),
		row("  TASK_EASY", String(task.TASK_EASY)),
		row("  TASK_HARD", String(task.TASK_HARD)),
		row("  TASK_CHALLENGE", String(task.TASK_CHALLENGE)),
		row("  gate fallbacks", String(task.fallbackChallenge)),
		...(task.legacyDecisions > 0 ? [row("  retired labels", String(task.legacyDecisions))] : []),
		...(task.legacyFallbacks > 0 ? [row("  retired fallbacks", String(task.legacyFallbacks))] : []),
		row("  errors / timeouts", `${task.errors} / ${task.timeouts}`),
		row("  avg latency", avg(task.latencySumMs, task.latencyCount)),
		row("  confidence", histogram(task.confidence)),
		row("  margin", histogram(task.margin)),
	];

	const workers = Object.entries(snapshot.workers);
	if (workers.length > 0) {
		lines.push(
			"",
			"Worker cost by tier agent (settled spawns observed in this process)",
			row("  agent", "spawns / settled / completed / tokens / cost / cost-per-completed"),
		);
		for (const [agent, counters] of workers) {
			// The North Star metric: spend per successfully completed delegated task.
			const perCompleted = counters.completed === 0 ? "—" : `$${(counters.costUsd / counters.completed).toFixed(4)}`;
			lines.push(
				row(
					`  ${agent}`,
					`${counters.spawns} / ${counters.results} / ${counters.completed} / ${counters.tokens.toLocaleString()} / $${counters.costUsd.toFixed(4)} / ${perCompleted}`,
				),
			);
		}
	}
	lines.push("", `State file: ${runtime.telemetry.file}`, `Decision log: ${runtime.telemetry.decisionsFile}`);
	return lines.join("\n");
}

async function runSetup(runtime: JevRouterRuntime, ctx: ExtensionCommandContext): Promise<string> {
	const current = await runtime.credential();
	if (current?.source === "env") {
		return [
			`${TYPESAFE_ENV_VAR} is set; the router uses it directly and never copies it to disk.`,
			"Unset it if you would rather store a key in OMP's credential store.",
		].join("\n");
	}

	if (!ctx.hasUI) {
		return [
			"No interactive UI in this mode. Provide a credential with either:",
			`  export ${TYPESAFE_ENV_VAR}=...`,
			"  omp login typesafe",
		].join("\n");
	}

	const stored = hasStoredCredential(ctx);
	const options = [
		{
			label: "Use OMP's native login (masked input)",
			description: "Run /login typesafe — OMP hides the key while you type it.",
		},
		{
			label: "Paste a key here",
			description: "This dialog does NOT mask input; the key is visible while typing.",
		},
	];
	if (stored) options.push({ label: "Remove the stored key", description: "Deletes the typesafe credential from OMP." });

	const choice = await ctx.ui.select("TypeSafe credential", options);
	if (!choice) return "Setup cancelled.";

	if (choice === options[0]?.label) {
		return "Run `/login typesafe` and paste your key there; the router picks it up automatically.";
	}
	if (stored && choice === options[2]?.label) {
		await clearStoredCredential(ctx);
		runtime.invalidateCredential();
		return "Stored TypeSafe credential removed.";
	}

	const key = (await ctx.ui.input("TypeSafe API key (visible while typing)", "ts_..."))?.trim();
	if (!key) return "Setup cancelled.";

	const validation = await validateCredential(key, Math.max(runtime.config.routingTimeoutMs, 10_000));
	if (!validation.ok) return `Key rejected, nothing stored: ${validation.error}.`;

	await storeCredential(ctx, key);
	runtime.invalidateCredential();
	const models = validation.models?.length ? ` Models available: ${validation.models.join(", ")}.` : "";
	return `Key validated and stored in OMP's credential store.${models}`;
}

async function runTest(runtime: JevRouterRuntime): Promise<string> {
	const apiKey = await runtime.apiKey();
	if (!apiKey) return "No TypeSafe credential. Run /jev-router setup first.";
	const config = runtime.config;
	const options = { apiKey, model: config.jevModel, timeoutMs: Math.max(config.routingTimeoutMs, 10_000) };
	const lines: string[] = [row("Jev model", runtime.engine.modelFor(options))];

	for (const [index, request, expected] of [
		[1, TEST_REQUEST, "DEFAULT — a localized two-call-site rename"],
		[2, TEST_PARALLEL_REQUEST, "ORCHESTRATE — independent subsystem workstreams"],
	] as const) {
		try {
			const decision = await runtime.engine.decideOrchestration(
				request,
				{ recentMessages: [] },
				options,
				{ minConfidence: config.orchestrationMinConfidence, minMargin: config.orchestrationMinMargin },
				config.maxRoutingInputChars,
			);
			lines.push(
				row(
					`Front-door probe ${index}/2`,
					`${decision.confident ? decision.top : "DEFAULT (gate)"} confidence=${decision.confidence.toFixed(2)} margin=${decision.margin.toFixed(2)} ${Math.round(decision.latencyMs)}ms`,
				),
				row("  (expected)", expected),
			);
		} catch (error) {
			lines.push(row(`Front-door probe ${index}/2`, `failed: ${runtime.logger.describeError(error)}`));
		}
	}

	try {
		const batch = await runtime.engine.decideTaskTiers(
			TEST_SUBTASKS,
			"Probe from /jev-router test.",
			options,
			{ minConfidence: config.taskMinConfidence, minMargin: config.taskMinMargin },
			config.maxRoutingInputChars,
		);
		for (const [index, decision] of batch.decisions.entries()) {
			lines.push(
				row(
					`TASK probe ${index + 1}`,
					`${decision.confident ? decision.top : "TASK_CHALLENGE (gate)"} confidence=${decision.confidence.toFixed(2)} margin=${decision.margin.toFixed(2)}`,
				),
			);
		}
		lines.push(
			row("  (expected)", "1 = TASK_EASY (mechanical), 2 = TASK_CHALLENGE (root cause), 3 = TASK_HARD (implementation)"),
			row("  batch latency", `${Math.round(batch.latencyMs)}ms for ${batch.decisions.length} decisions in 1 request`),
		);
	} catch (error) {
		lines.push(row("TASK probe", `failed: ${runtime.logger.describeError(error)}`));
	}
	return lines.join("\n");
}

async function runReset(runtime: JevRouterRuntime, ctx: ExtensionCommandContext): Promise<string> {
	await runtime.telemetry.reset();
	await clearStoredConfig();
	await runtime.reloadConfig(ctx.cwd);
	const done = ["Telemetry cleared.", `Configuration reset to defaults (${Object.keys(DEFAULT_CONFIG).length} keys).`];

	if (hasStoredCredential(ctx)) {
		const remove = ctx.hasUI
			? await ctx.ui.confirm("Remove credential?", "Also delete the stored TypeSafe key from OMP's credential store?")
			: false;
		if (remove) {
			await clearStoredCredential(ctx);
			runtime.invalidateCredential();
			done.push("Stored TypeSafe credential removed.");
		} else {
			done.push("Stored TypeSafe credential kept.");
		}
	}
	return done.join("\n");
}

export function registerCommands(pi: ExtensionAPI, runtime: JevRouterRuntime): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Jev routing: setup | status | test | stats | reset",
		getArgumentCompletions: prefix => {
			const matches = SUBCOMMANDS.filter(name => name.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map(name => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			runtime.bindContext(ctx);
			const requested = args.trim().split(/\s+/)[0] ?? "";
			const sub = (requested === "" ? "status" : requested) as Subcommand;
			if (!SUBCOMMANDS.includes(sub)) {
				ctx.ui.notify(`Unknown subcommand "${requested}". Use: ${SUBCOMMANDS.join(", ")}.`, "warning");
				return;
			}
			await runtime.reloadConfig(ctx.cwd);
			try {
				switch (sub) {
					case "setup":
						ctx.ui.notify(await runSetup(runtime, ctx), "info");
						return;
					case "status":
						ctx.ui.notify(await renderStatus(pi, runtime, ctx), "info");
						return;
					case "test":
						ctx.ui.notify(await runTest(runtime), "info");
						return;
					case "stats":
						ctx.ui.notify(renderStats(runtime), "info");
						return;
					case "reset":
						ctx.ui.notify(await runReset(runtime, ctx), "info");
						return;
				}
			} catch (error) {
				ctx.ui.notify(`/${COMMAND_NAME} ${sub} failed: ${runtime.logger.describeError(error)}`, "error");
			}
		},
	});
}
