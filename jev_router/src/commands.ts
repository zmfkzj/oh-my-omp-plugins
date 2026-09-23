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
import { DEEP_AGENT_NAME, NORMAL_AGENT_NAME } from "./deep-agent.ts";
import { resolveRole, spawnableTaskAgents } from "./host.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { JevRouterRuntime } from "./runtime.ts";
import { GENERIC_TASK_AGENT } from "./task-routing.ts";

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
const TEST_DEEP_REQUEST =
	"Users intermittently see stale balances after a concurrent transfer. Find the root cause across the ledger and cache layers and decide how to make reads consistent.";
const TEST_SUBTASKS = [
	{ id: "t0", instruction: "Add a `--json` flag to the existing `status` CLI command that prints the same fields as JSON." },
	{
		id: "t1",
		instruction:
			"Users intermittently see stale balances after a concurrent transfer. Find the root cause across the ledger and cache layers and decide how to make reads consistent.",
	},
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
	const normal = resolveRole(ctx, config.normalTaskRole);
	const deep = resolveRole(ctx, config.deepTaskRole);
	const mainNormal = resolveRole(ctx, config.mainNormalRole);
	const mainDeep = resolveRole(ctx, config.mainDeepRole);
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
		row("Main model routing", config.mainModelRoutingEnabled ? "enabled" : "disabled"),
		row("MAIN_DEFAULT", `${mainNormal.alias} → ${mainNormal.label}`),
		row("MAIN_SLOW", `${mainDeep.alias} → ${mainDeep.label}`),
		row("Model", config.jevModel || "jev-latest (default)"),
		row("Gate", `confidence ≥ ${config.orchestrationMinConfidence}, margin ≥ ${config.orchestrationMinMargin}`),
		"",
		row("TASK tier routing", config.taskRoutingEnabled ? "enabled" : "disabled"),
		row("TASK_NORMAL", `${normal.alias} → ${normal.label}`),
		row("TASK_DEEP", `${deep.alias} → ${deep.label}`),
		row("Gate", `confidence ≥ ${config.taskMinConfidence}, margin ≥ ${config.taskMinMargin}`),
		row("Tier agent", aliasState(DEEP_AGENT_NAME)),
	];
	if (config.normalTaskRole !== GENERIC_TASK_AGENT) {
		lines.push(row("Normal tier agent", aliasState(NORMAL_AGENT_NAME)));
	}

	const orchestration = runtime.orchestration.lastDecision;
	const task = runtime.task.lastDecision;
	lines.push(
		"",
		row(
			"Last orchestration",
			orchestration
				? `${orchestration.outcome}${orchestration.confidence === undefined ? "" : ` ${orchestration.confidence.toFixed(2)}`}${orchestration.model ? ` model=${orchestration.model}` : ""}`
				: "none this session",
		),
		row("Last TASK route", task ? `${task.route} ${task.confidence.toFixed(2)}` : "none this session"),
	);

	if (normal.modelId && normal.modelId === deep.modelId) {
		lines.push(
			"",
			"TASK_NORMAL and TASK_DEEP currently resolve to the same model.",
			"Tier routing is active but provides no model-cost differentiation.",
		);
	}
	if (config.mainModelRoutingEnabled && mainNormal.modelId && mainNormal.modelId === mainDeep.modelId) {
		lines.push(
			"",
			"MAIN_DEFAULT and MAIN_SLOW currently resolve to the same model. Main-model routing is active but provides no model-cost differentiation.",
		);
	}
	const unresolved = [normal, deep, ...(config.mainModelRoutingEnabled ? [mainNormal, mainDeep] : [])]
		.filter(role => !role.modelId).map(role => role.alias);
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
		row("Routed user turns", String(orchestration.requests)),
		row("  DEFAULT", String(orchestration.DEFAULT)),
		row("  SLOW", String(orchestration.SLOW)),
		row("  ORCHESTRATE", String(orchestration.ORCHESTRATE)),
		row("  UNCERTAIN", String(orchestration.UNCERTAIN)),
		row("  errors / timeouts", `${orchestration.errors} / ${orchestration.timeouts}`),
		row("  avg latency", avg(orchestration.latencySumMs, orchestration.latencyCount)),
		row("  confidence", histogram(orchestration.confidence)),
		row("  margin", histogram(orchestration.margin)),
		"",
		row("TASK batches", String(task.batches)),
		row("  TASK_NORMAL", String(task.TASK_NORMAL)),
		row("  TASK_DEEP", String(task.TASK_DEEP)),
		row("  gate fallbacks", String(task.fallbackDeep)),
		row("  errors / timeouts", `${task.errors} / ${task.timeouts}`),
		row("  avg latency", avg(task.latencySumMs, task.latencyCount)),
		row("  confidence", histogram(task.confidence)),
		row("  margin", histogram(task.margin)),
	];

	const workers = Object.entries(snapshot.workers);
	if (workers.length > 0) {
		lines.push(
			"",
			"Worker cost by tier agent (spawns whose result this session observed)",
			row("  agent", "spawns / results / tokens / cost / cost-per-result"),
		);
		for (const [agent, counters] of workers) {
			const tokens = counters.input + counters.output + counters.cacheRead + counters.cacheWrite;
			// The North Star metric: spend per successfully completed delegated task.
			const perResult = counters.results === 0 ? "—" : `$${(counters.costUsd / counters.results).toFixed(4)}`;
			lines.push(
				row(
					`  ${agent}`,
					`${counters.spawns} / ${counters.results} / ${tokens.toLocaleString()} / $${counters.costUsd.toFixed(4)} / ${perResult}`,
				),
			);
		}
	}
	lines.push("", `State file: ${runtime.telemetry.file}`);
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
		[2, TEST_DEEP_REQUEST, "SLOW — root-cause plus consistency reasoning, one sequential body of work"],
	] as const) {
		try {
			const decision = await runtime.engine.decideOrchestration(
				request,
				[],
				options,
				{ minConfidence: config.orchestrationMinConfidence, minMargin: config.orchestrationMinMargin },
				config.maxRoutingInputChars,
			);
			lines.push(
				row(
					`Front-door probe ${index}/2`,
					`${decision.confident ? decision.top : "UNCERTAIN"} confidence=${decision.confidence.toFixed(2)} margin=${decision.margin.toFixed(2)} ${Math.round(decision.latencyMs)}ms`,
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
					`${decision.confident ? decision.top : "TASK_DEEP (gate)"} confidence=${decision.confidence.toFixed(2)} margin=${decision.margin.toFixed(2)}`,
				),
			);
		}
		lines.push(
			row("  (expected)", "1 = TASK_NORMAL (clear spec), 2 = TASK_DEEP (root-cause + consistency)"),
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
