/**
 * `/om-orche` slash command.
 *
 * Subcommands: status, stats, reset. No subcommand prints status.
 */
import path from "node:path";
import { clearStoredConfig, DEFAULT_CONFIG, PLUGIN_NAME } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import { HOST_SETUP_VERSION, type HostSetupStore, pluginSetupStore } from "./omp-setup.ts";
import { POLICY_NOTICE_TYPE } from "./orchestration-policy.ts";
import {
	type HistoricalJevRouting,
	type HistoricalTelemetry,
	historySnapshotName,
	type OrchestrationCounters,
	type Telemetry,
	type TelemetrySnapshot,
	type TelemetryState,
} from "./telemetry.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { OrcheRuntime } from "./runtime.ts";

export const COMMAND_NAME = PLUGIN_NAME;
const SUBCOMMANDS = ["status", "stats", "reset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const PAD = 23;

/** OMP's bundled generic worker agent, whose model the native `@task` role picks. */
const GENERIC_TASK_AGENT = "task";

function row(label: string, value: string): string {
	return `${label.padEnd(PAD)}${value}`;
}

/** Whether the one-time OMP setup has run, from its marker. An unreadable marker counts as not run. */
async function ompSetupStatus(enabled: boolean, store: HostSetupStore): Promise<string> {
	const version = await store.version().catch(() => undefined);
	if (version !== undefined && version >= HOST_SETUP_VERSION) return `applied (v${version})`;
	return enabled ? "pending — applies at the next main session start" : "skipped — plugin disabled";
}

/** Model roles the retired tier router created; user-owned, never deleted or read. */
const RETIRED_TIER_ROLES = ["task_easy", "task_hard", "task_challenge"] as const;

export async function renderStatus(
	pi: ExtensionAPI,
	runtime: OrcheRuntime,
	ctx: ExtensionCommandContext,
	setupStore: HostSetupStore = pluginSetupStore(),
): Promise<string> {
	const config = runtime.config;
	const session = mainSessionOf(ctx);
	const taskModel = ctx.models.resolve(`@${GENERIC_TASK_AGENT}`);
	const taskTool = pi.getAllTools().some(tool => tool.name === "task");
	const taskEnabled = session?.getEnabledToolNames().includes("task");

	const lines = [
		row(PLUGIN_NAME, config.enabled ? "enabled" : "disabled"),
		row("Execution policy", config.enabled ? `judgment/production (${POLICY_NOTICE_TYPE})` : "native (plugin disabled)"),
		row("Primary model", "unchanged — no model switching"),
		row("OMP setup", await ompSetupStatus(config.enabled, setupStore)),
		"",
		row(
			"Task worker",
			!taskTool ? "task tool not registered" : taskEnabled === false ? "task tool disabled in this session" : "native `task` agent",
		),
		row(`  @${GENERIC_TASK_AGENT} role`, taskModel ? `${taskModel.provider}/${taskModel.id}` : "unresolved"),
	];
	if (!taskModel) {
		lines.push(
			`  @${GENERIC_TASK_AGENT} does not resolve in this session; task workers use the main session's active model.`,
		);
	}

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

function isoOf(ms: number): string {
	const date = new Date(ms);
	return ms > 0 && !Number.isNaN(date.getTime()) ? date.toISOString() : "an unknown time";
}

const indent = (lines: readonly string[], depth: number): string[] => lines.map(line => `${"  ".repeat(depth)}${line}`);

/** Where the preserved original of a read-only section is, or that it is still the active, unmigrated file. */
function sourceLine(telemetry: Telemetry, source: HistoricalTelemetry["source"], state: TelemetryState): string {
	const unmigrated =
		state.kind === "deferred"
			? "not migrated while telemetry is disabled"
			: state.kind === "suspended" && state.reason === "migration-failed"
				? "not migrated: the migration failed"
				: undefined;
	// The unmigrated file is still the active telemetry.json; no backup of it exists yet.
	if (unmigrated && "sha256" in state && state.version === source.version && state.sha256 === source.sha256) {
		return `Source: ${telemetry.file} (${unmigrated})`;
	}
	return `Source snapshot: ${path.join(telemetry.historyDir, historySnapshotName(source.version, source.sha256))}`;
}

/** Front-door routing counters of a read-only era, as they were recorded. */
function routingDecisionRows(counters: OrchestrationCounters & { legacyDecisions?: number }): string[] {
	const avg = counters.latencyCount === 0 ? "—" : `${Math.round(counters.latencySumMs / counters.latencyCount)}ms`;
	const histogram = (buckets: readonly number[]) =>
		buckets.map((count, index) => `${(index / 10).toFixed(1)}:${count}`).join(" ");
	return [
		row("Routing decisions", String(counters.requests)),
		...(counters.legacyDecisions ? [row("  retired labels", String(counters.legacyDecisions))] : []),
		row("  DEFAULT", String(counters.DEFAULT)),
		row("  ORCHESTRATE", String(counters.ORCHESTRATE)),
		row("  errors / timeouts", `${counters.errors} / ${counters.timeouts}`),
		row("  avg latency", avg),
		row("  confidence", histogram(counters.confidence)),
		row("  margin", histogram(counters.margin)),
	];
}

/** The live epoch: per worker agent, how many workers and turns were observed and what the settled turns measured. */
function liveWorkerLines(snapshot: Readonly<TelemetrySnapshot>, recording: boolean): string[] {
	const epoch = `epoch ${snapshot.epoch.id} since ${isoOf(snapshot.epoch.startedAt)}`;
	const lines = [
		recording
			? `Task workers — live ${epoch}`
			: `Task workers — recording is off (telemetryEnabled=false); ${snapshot.updatedAt > 0 ? `the state file holds ${epoch}` : "nothing recorded"}`,
	];
	const workers = Object.entries(snapshot.workers);
	if (workers.length === 0) lines.push("  none observed");
	for (const [agent, counters] of workers) {
		const settled = counters.completed + counters.failed + counters.aborted;
		const coverage = settled === 0 ? "—" : `${Math.round((counters.usageSamples / settled) * 100)}%`;
		const perTurn = (sum: number) =>
			counters.usageSamples === 0 ? "—" : Math.round(sum / counters.usageSamples).toLocaleString();
		const perCompleted =
			counters.usageSamplesCompleted === 0 ? "—" : `$${(counters.costUsd / counters.usageSamplesCompleted).toFixed(4)}`;
		lines.push(
			`  ${agent}`,
			...indent(
				[
					row("workers started", `${counters.startedObserved} observed`),
					row("follow-up turns", `${counters.followUpTurns} observed`),
					row("settled turns", `${counters.completed} completed / ${counters.failed} failed / ${counters.aborted} cancelled`),
					row("usage coverage", `${counters.usageSamples} measured / ${counters.usageUnknown} unknown (${coverage} of settled turns)`),
					row("measured usage", `${counters.tokens.toLocaleString()} tokens / $${counters.costUsd.toFixed(4)}`),
					row("avg per measured turn", `${perTurn(counters.tokens)} tokens / ${perTurn(counters.durationMs)}ms`),
					row("cost per completed", `${perCompleted} (all measured spend, failed and cancelled turns included, per measured completion)`),
				],
				2,
			),
		);
	}
	lines.push(
		"  Only OMP's generic `task` worker is measured; the task tool, eval agent() and workpool are not told apart.",
		"  Every turn of a worker — its first run and each follow-up — settles and is measured on its own.",
		"  completed = the turn finished, not acceptance of its result.",
		"  Not observed: turns of a worker OMP revives from disk after a restart.",
	);
	return lines;
}

/** The v5 live epoch: routing decisions, and workers counted once each, without follow-up turns. */
function jevRoutingLines(era: HistoricalJevRouting, telemetry: Telemetry, state: TelemetryState): string[] {
	const epoch = `epoch ${era.epoch.id === "" ? "(unnamed)" : era.epoch.id}, ${isoOf(era.epoch.startedAt)} to ${isoOf(era.updatedAt)}`;
	const lines = [`Jev routing era (v${era.source.version}): ${epoch}`, ...indent(routingDecisionRows(era.orchestration), 1)];
	for (const [agent, counters] of Object.entries(era.workers)) {
		lines.push(
			`  ${row("worker", `${agent}: ${counters.startedObserved} started / ${counters.completed} completed / ${counters.failed} failed / ${counters.aborted} cancelled`)}`,
			`  ${row("", `${counters.usageSamples} measured, ${counters.usageUnknown} unknown / ${counters.tokens.toLocaleString()} tokens / $${counters.costUsd.toFixed(4)} (per worker; follow-up turns were not counted)`)}`,
		);
	}
	lines.push(
		`  ${sourceLine(telemetry, era.source, state)}`,
		`  Decision log (if present): ${path.join(path.dirname(telemetry.file), "decisions.jsonl")} — no longer written; /om-orche reset removes it.`,
	);
	return lines;
}

/** The tier-routing era of pre-v5 files. */
function tierRoutingLines(era: HistoricalTelemetry, telemetry: Telemetry, state: TelemetryState): string[] {
	const tier = era.taskRouting;
	const lines = [
		`Tier routing era (pre-v5, v${era.source.version})`,
		...indent(routingDecisionRows(era.orchestration), 1),
		...indent(
			[
				row("Tier batches", `${tier.batches} (EASY ${tier.TASK_EASY} / HARD ${tier.TASK_HARD} / CHALLENGE ${tier.TASK_CHALLENGE}; ${tier.fallbackChallenge} gate fallbacks)`),
				row("  errors / timeouts", `${tier.errors} / ${tier.timeouts}`),
			],
			1,
		),
	];
	for (const [agent, counters] of Object.entries(era.workers)) {
		lines.push(
			`  ${row("worker", `${agent}: ${counters.spawns} routed / ${counters.results} settled / ${counters.completed} completed / ${counters.tokens.toLocaleString()} tokens / $${counters.costUsd.toFixed(4)}`)}`,
		);
	}
	lines.push(`  ${sourceLine(telemetry, era.source, state)}`);
	return lines;
}

export function renderStats(runtime: OrcheRuntime): string {
	const telemetry = runtime.telemetry;
	const snapshot = telemetry.snapshot();
	const state = telemetry.state();
	const lines: string[] = [];
	const note = telemetryStateNote(state);
	if (note) lines.push(note, "");

	if (state.kind === "deferred" || state.kind === "suspended") {
		lines.push("Task workers — not recording");
	} else {
		lines.push(...liveWorkerLines(snapshot, runtime.config.telemetryEnabled));
	}

	const eras = [
		...(snapshot.jevRouting ? [jevRoutingLines(snapshot.jevRouting, telemetry, state)] : []),
		...(snapshot.historical ? [tierRoutingLines(snapshot.historical, telemetry, state)] : []),
	];
	if (eras.length > 0) {
		lines.push("", "Historical — read-only, never added to live numbers");
		for (const era of eras) lines.push(...indent(era, 1));
	}
	lines.push("", `State file: ${telemetry.file}`);
	return lines.join("\n");
}

async function runReset(runtime: OrcheRuntime, ctx: ExtensionCommandContext): Promise<string> {
	let telemetryLine: string;
	try {
		const removed = await runtime.telemetry.reset();
		telemetryLine = `Telemetry cleared (${removed.length} owned file(s) removed).`;
	} catch (error) {
		// Some owned files survived; say so rather than claiming a clean slate.
		telemetryLine = `Telemetry reset incomplete: ${error instanceof Error ? error.message : String(error)}`;
	}
	// OMP has no API for a project's `plugin-overrides.json`, so what it sets survives the reset and is reported.
	const overridden = await clearStoredConfig(ctx.cwd);
	await runtime.reloadConfig(ctx.cwd);
	return [
		telemetryLine,
		overridden.length === 0
			? `Configuration reset to defaults (${Object.keys(DEFAULT_CONFIG).length} keys; retired keys removed too).`
			: `Stored configuration cleared, but this project's plugin-overrides.json still sets ${overridden.join(", ")} and stays in effect here; OMP cannot edit that file, so remove ${overridden.length === 1 ? "that key" : "those keys"} from it to reach the defaults.`,
	].join("\n");
}

export function registerCommands(pi: ExtensionAPI, runtime: OrcheRuntime): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Judgment/production execution policy: status | stats | reset",
		getArgumentCompletions: prefix => {
			const matches = SUBCOMMANDS.filter(name => name.startsWith(prefix.trim()));
			return matches.length > 0 ? matches.map(name => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim().split(/\s+/)[0] ?? "";
			const sub = (requested === "" ? "status" : requested) as Subcommand;
			if (!SUBCOMMANDS.includes(sub)) {
				ctx.ui.notify(`Unknown subcommand "${requested}". Use: ${SUBCOMMANDS.join(", ")}.`, "warning");
				return;
			}
			await runtime.reloadConfig(ctx.cwd);
			try {
				switch (sub) {
					case "status":
						ctx.ui.notify(await renderStatus(pi, runtime, ctx), "info");
						return;
					case "stats":
						// The file may have changed under this process: another process wrote or reset it, or telemetry was
						// just turned on over an older one, which the first load migrates.
						await runtime.telemetry.refresh();
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
