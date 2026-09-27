/**
 * `/om-orche` slash command.
 *
 * Subcommands: setup, status, test, stats, reset. No subcommand prints status.
 * Secrets are never rendered: the credential is reported by provenance only.
 */
import path from "node:path";
import { clearStoredConfig, DEFAULT_CONFIG, PLUGIN_NAME } from "./config.ts";
import {
	clearStoredCredential,
	hasStoredCredential,
	storeCredential,
	TYPESAFE_ENV_VAR,
	validateCredential,
} from "./credentials.ts";
import { mainSessionOf } from "./host.ts";
import { JEV_ORCHESTRATE_NOTICE_TYPE } from "./orchestration-policy.ts";
import { historySnapshotName, type OrchestrationCounters, type TelemetryState } from "./telemetry.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { JevRouterRuntime } from "./runtime.ts";

export const COMMAND_NAME = PLUGIN_NAME;
const SUBCOMMANDS = ["setup", "status", "test", "stats", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const PAD = 23;

/** OMP's bundled generic worker agent, whose model the native `@task` role picks. */
const GENERIC_TASK_AGENT = "task";

function row(label: string, value: string): string {
	return `${label.padEnd(PAD)}${value}`;
}

/** Fixed probes for `/om-orche test`; they exercise the front-door classifier end to end. */
const TEST_REQUEST =
	"Rename the `retryCount` field to `attempts` in the HTTP client and update its two call sites.";
const TEST_PARALLEL_REQUEST =
	"Implement three independently specified features in disjoint subsystems: CLI export, database retention, and dashboard filtering. Each has its own tests and no shared interfaces; coordinate independent workers and integrate their results.";

/** Model roles the retired tier router created; user-owned, never deleted or read. */
const RETIRED_TIER_ROLES = ["task_easy", "task_hard", "task_challenge"] as const;

function formatCredential(runtime: JevRouterRuntime, stored: boolean, source: string | undefined): string {
	if (source === "env") return `configured (${TYPESAFE_ENV_VAR}, not persisted)`;
	if (source === "omp-credential-store") return "configured (OMP credential store)";
	if (stored) return "stored but unreadable";
	return runtime.config.enabled ? "not configured — run /om-orche setup" : "not configured";
}

export async function renderStatus(
	pi: ExtensionAPI,
	runtime: JevRouterRuntime,
	ctx: ExtensionCommandContext,
): Promise<string> {
	const config = runtime.config;
	const credential = await runtime.credential();
	const session = mainSessionOf(ctx);
	const taskModel = ctx.models.resolve(`@${GENERIC_TASK_AGENT}`);
	const taskTool = pi.getAllTools().some(tool => tool.name === "task");
	const taskEnabled = session?.getEnabledToolNames().includes("task");

	const lines = [
		row(PLUGIN_NAME, config.enabled ? "enabled" : "disabled"),
		row("Credential", formatCredential(runtime, hasStoredCredential(ctx), credential?.source)),
		"",
		row("Orchestration routing", config.orchestrationRoutingEnabled ? "enabled" : "disabled"),
		row("Primary model", "unchanged — no model switching"),
		row("Model", config.jevModel || "jev-latest (default)"),
		row("Gate", `confidence ≥ ${config.orchestrationMinConfidence}, margin ≥ ${config.orchestrationMinMargin}`),
		row("Coordination guidance", config.enabled ? `plugin-owned (${JEV_ORCHESTRATE_NOTICE_TYPE})` : "native (plugin disabled)"),
		"",
		row(
			"Task worker",
			!taskTool ? "task tool not registered" : taskEnabled === false ? "task tool disabled in this session" : "native `task` agent",
		),
		row(`  @${GENERIC_TASK_AGENT} role`, taskModel ? `${taskModel.provider}/${taskModel.id}` : "unresolved"),
	];
	if (!taskModel) {
		lines.push(
			`  @${GENERIC_TASK_AGENT} does not resolve in this session and no other model is substituted. Set modelRoles.${GENERIC_TASK_AGENT}.`,
		);
	}

	const orchestration = runtime.orchestration.lastDecision;
	lines.push(
		"",
		row(
			"Last orchestration",
			orchestration
				? `${orchestration.outcome}${orchestration.confidence === undefined ? "" : ` ${orchestration.confidence.toFixed(2)}`}`
				: "none this session",
		),
	);

	if (runtime.retiredConfigKeys.length > 0) {
		lines.push(
			"",
			`Retired settings still stored and ignored: ${runtime.retiredConfigKeys.join(", ")}.`,
			`Remove each with \`omp plugin config delete ${PLUGIN_NAME} <key>\` (and any project override).`,
		);
	}
	const legacyRoles = session ? RETIRED_TIER_ROLES.filter(role => session.settings.getModelRole(role) !== undefined) : [];
	if (legacyRoles.length > 0) {
		lines.push(
			"",
			`Model roles ${legacyRoles.map(role => `@${role}`).join(", ")} are no longer used by this plugin and were left as you set them.`,
		);
	}
	return lines.join("\n");
}

/** How the persisted telemetry file is being treated in this process, or nothing when normal. */
function telemetryStateNote(state: TelemetryState): string | undefined {
	switch (state.kind) {
		case "unloaded":
		case "active":
			return undefined;
		case "deferred":
			return `Telemetry is disabled: the v${state.version} file is shown read-only and migrates once telemetryEnabled=true.`;
		case "suspended":
			return state.reason === "future-version"
				? `telemetry.json was written by a newer plugin version (v${state.version}); left untouched, recording suspended.`
				: `Telemetry ${state.reason}: ${state.detail}. Recording suspended; /om-orche reset discards it.`;
	}
}

function orchestrationRows(counters: OrchestrationCounters & { legacyDecisions?: number }): string[] {
	const avg = counters.latencyCount === 0 ? "—" : `${Math.round(counters.latencySumMs / counters.latencyCount)}ms`;
	const histogram = (buckets: readonly number[]) =>
		buckets.map((count, index) => `${(index / 10).toFixed(1)}:${count}`).join(" ");
	return [
		row("Orchestration decisions", String(counters.requests)),
		...(counters.legacyDecisions ? [row("  retired labels", String(counters.legacyDecisions))] : []),
		row("  DEFAULT", String(counters.DEFAULT)),
		row("  ORCHESTRATE", String(counters.ORCHESTRATE)),
		row("  errors / timeouts", `${counters.errors} / ${counters.timeouts}`),
		row("  avg latency", avg),
		row("  confidence", histogram(counters.confidence)),
		row("  margin", histogram(counters.margin)),
	];
}

export function renderStats(runtime: JevRouterRuntime): string {
	const telemetry = runtime.telemetry;
	const snapshot = telemetry.snapshot();
	const lines: string[] = [];
	const state = telemetry.state();
	const note = telemetryStateNote(state);
	if (note) lines.push(note, "");

	lines.push(`Live epoch ${snapshot.epoch.id} since ${new Date(snapshot.epoch.startedAt).toISOString()}`, "");
	lines.push(...orchestrationRows(snapshot.orchestration));

	const workers = Object.entries(snapshot.workers);
	lines.push("", "task workers — invocation path not separated (task tool, eval agent(), workpool)");
	if (workers.length === 0) lines.push("  none observed in this epoch");
	for (const [agent, counters] of workers) {
		const settled = counters.completed + counters.failed + counters.aborted;
		const coverage = settled === 0 ? "—" : `${Math.round((counters.usageSamples / settled) * 100)}%`;
		const perSample = (sum: number) => (counters.usageSamples === 0 ? "—" : Math.round(sum / counters.usageSamples).toLocaleString());
		const perCompleted =
			counters.usageSamplesCompleted === 0 ? "—" : `$${(counters.costUsd / counters.usageSamplesCompleted).toFixed(4)}`;
		lines.push(
			row(`  ${agent} started`, `${counters.startedObserved} observed`),
			row("  settled", `${counters.completed} completed / ${counters.failed} failed / ${counters.aborted} cancelled`),
			row("  usage coverage", `${counters.usageSamples} measured / ${counters.usageUnknown} unknown (${coverage})`),
			row("  measured usage", `${counters.tokens.toLocaleString()} tokens / $${counters.costUsd.toFixed(4)}`),
			row("  avg per sample", `${perSample(counters.tokens)} tokens / ${perSample(counters.durationMs)}ms`),
			row("  cost per completed", `${perCompleted} (measured completions only)`),
		);
	}
	lines.push("  completed = worker run finished, not acceptance of its result.");

	const historical = snapshot.historical;
	if (historical) {
		const tier = historical.taskRouting;
		lines.push(
			"",
			`Historical (pre-v5, v${historical.source.version}; never added to live numbers)`,
			...orchestrationRows(historical.orchestration).map(line => `  ${line}`),
			row("  retired TASK tier batches", String(tier.batches)),
			row("    EASY / HARD / CHALLENGE", `${tier.TASK_EASY} / ${tier.TASK_HARD} / ${tier.TASK_CHALLENGE}`),
			row("    gate fallbacks", String(tier.fallbackChallenge)),
			row("    errors / timeouts", `${tier.errors} / ${tier.timeouts}`),
		);
		for (const [agent, counters] of Object.entries(historical.workers)) {
			lines.push(
				row(
					`  ${agent}`,
					`${counters.spawns} routed / ${counters.results} settled / ${counters.completed} completed / ${counters.tokens.toLocaleString()} tokens / $${counters.costUsd.toFixed(4)}`,
				),
			);
		}
		// A deferred (not yet migrated) file is still the active telemetry.json; no backup exists yet.
		lines.push(
			state.kind === "deferred"
				? `  Source: ${telemetry.file} (not migrated while telemetry is disabled)`
				: `  Source snapshot: ${path.join(telemetry.historyDir, historySnapshotName(historical.source.version, historical.source.sha256))}`,
		);
	}
	lines.push("", `State file: ${telemetry.file}`, `Decision log: ${telemetry.decisionsFile}`);
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
	if (!apiKey) return "No TypeSafe credential. Run /om-orche setup first.";
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
	return lines.join("\n");
}

async function runReset(runtime: JevRouterRuntime, ctx: ExtensionCommandContext): Promise<string> {
	let telemetryLine: string;
	try {
		const removed = await runtime.telemetry.reset();
		telemetryLine = `Telemetry cleared (${removed.length} owned file(s) removed).`;
	} catch (error) {
		// Some owned files survived; say so rather than claiming a clean slate.
		telemetryLine = `Telemetry reset incomplete: ${error instanceof Error ? error.message : String(error)}`;
	}
	await clearStoredConfig();
	await runtime.reloadConfig(ctx.cwd);
	const done = [telemetryLine, `Configuration reset to defaults (${Object.keys(DEFAULT_CONFIG).length} keys; retired keys removed too).`];

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
