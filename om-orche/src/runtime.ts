/**
 * Shared runtime state: configuration, the execution-policy router and
 * telemetry. One instance per loaded extension; event handlers and commands
 * both read it. A main session reads the stored configuration when it starts
 * and again before each of its user turns (`syncConfig`), so a change made with
 * `omp plugin config set` takes effect on the next turn without a restart.
 *
 * Generic workers are OMP's native `task` agent; this runtime never rewrites
 * or aliases them, and nothing here needs credentials or network access.
 */
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, normalizeConfig, type OrcheConfig, type SettingsReader } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import { RouteLogger } from "./logging.ts";
import { OrchestrationRouter } from "./orchestration.ts";
import { providerUsageOf, Telemetry } from "./telemetry.ts";
import { GENERIC_TASK_AGENT } from "./worker-usage.ts";

export interface RuntimeOptions {
	/** Where stored settings come from; OMP's plugin settings loader unless a test supplies its own. */
	readSettings?: SettingsReader;
}

/**
 * The id of the top-level session whose configuration governs `ctx`'s session: the session itself when it is a main
 * one, else the nearest main session above a subagent. Undefined when the registry cannot say.
 */
function topLevelSessionOf(ctx: ExtensionContext, main: boolean): string | undefined {
	if (main) return ctx.agent?.id ?? MAIN_AGENT_ID;
	const registry = AgentRegistry.global();
	const seen = new Set<string>();
	let id = ctx.agent?.parentId;
	while (id !== undefined && !seen.has(id)) {
		seen.add(id);
		const ref = registry.get(id);
		if (ref === undefined) return undefined;
		if (ref.kind === "main") return ref.id;
		id = ref.parentId;
	}
	return undefined;
}

export class OrcheRuntime {
	readonly telemetry: Telemetry;
	readonly logger: RouteLogger;
	readonly orchestration: OrchestrationRouter;
	readonly stateDir: string;

	#config: OrcheConfig = normalizeConfig(undefined);
	#retiredConfigKeys: readonly string[] = [];
	/** A read of the stored settings has succeeded. */
	#everRead = false;
	/** Why the last read of the stored settings failed; cleared by the next one that succeeds. */
	#configError: string | undefined;
	/** The top-level session whose telemetry choice governs the frames on this session's bus; unknown until the first read. */
	#telemetrySession: string | undefined;
	readonly #readSettings: SettingsReader | undefined;

	/**
	 * `stateDir` defaults to the plugin's directory under OMP's agent directory,
	 * which keeps its historical name across the public package rename.
	 */
	constructor(pi: ExtensionAPI, stateDir: string = path.join(getAgentDir(), "jev-router"), options: RuntimeOptions = {}) {
		this.stateDir = stateDir;
		this.logger = new RouteLogger(pi.logger);
		this.telemetry = Telemetry.shared(this.stateDir, { logger: this.logger });
		this.orchestration = new OrchestrationRouter({ logger: this.logger, config: () => this.#config });
		this.#readSettings = options.readSettings;
	}

	get config(): OrcheConfig {
		return this.#config;
	}

	/** Retired tier- and Jev-routing keys still stored for this plugin; they have no effect. */
	get retiredConfigKeys(): readonly string[] {
		return this.#retiredConfigKeys;
	}

	/** Why the stored settings could not be read the last time, when that is still so; the settings in effect are then the last good read's. */
	get configError(): string | undefined {
		return this.#configError;
	}

	/**
	 * Whether the worker frames on this session's bus are recorded. That is the telemetry choice of the top-level
	 * session the session belongs to: a main session follows its own configuration, and a subagent follows the main
	 * session above it, not its own working directory (an isolated worktree has no project override). Sessions of
	 * one process share one telemetry writer, but none of them can switch another's choice.
	 */
	recordsTelemetry(): boolean {
		return this.telemetry.recordsFor(this.#telemetrySession);
	}

	/**
	 * Count one finished assistant message: what the provider reported for it goes into the main session's counters
	 * when it is the main session's own, or into the generic `task` worker's row when it is a worker session's. Every
	 * session runs its own extension, so `ctx` says whose message it is; other subagents, `/tan` clones and
	 * advisors are not counted. The message is read structurally and only its token counts and cost are kept. Like the
	 * worker frames, it follows the telemetry choice of the session's top-level session.
	 */
	recordProviderUsage(ctx: ExtensionContext, message: unknown): void {
		if (!this.recordsTelemetry()) return;
		const usage = providerUsageOf(message);
		if (!usage) return;
		if (mainSessionOf(ctx) !== undefined) {
			this.telemetry.observeMainRequest(usage);
		} else if (ctx.agent?.kind === "sub" && ctx.agent.name === GENERIC_TASK_AGENT) {
			this.telemetry.observeWorkerRequest(GENERIC_TASK_AGENT, usage);
		}
	}

	/**
	 * Read the configuration stored for `ctx`'s working directory. A main session also publishes its
	 * `telemetryEnabled` as its own telemetry choice; a subagent's read never does. A read that fails keeps
	 * the settings already in effect (the defaults, before the first good read) and is warned about once: a
	 * store that is half-written or unreadable must not flip settings, a disabled plugin back on included.
	 */
	async reloadConfig(ctx: ExtensionContext): Promise<OrcheConfig> {
		const main = mainSessionOf(ctx) !== undefined;
		const session = topLevelSessionOf(ctx, main);
		this.#telemetrySession = session;
		const loaded = await loadConfig(ctx.cwd, this.#readSettings);
		if (loaded.error !== undefined) {
			this.#warnUnreadable(loaded.error);
			return this.#config;
		}
		this.#everRead = true;
		this.#configError = undefined;
		this.#config = loaded.config;
		this.#retiredConfigKeys = loaded.retiredKeys;
		this.logger.setEnabled(this.#config.debugLogging);
		if (main && session !== undefined) this.telemetry.setEnabled(this.#config.telemetryEnabled, session);
		return this.#config;
	}

	/**
	 * Pick up settings changed since the last read, as a main session's user turn does before anything else, so that
	 * `omp plugin config set` reaches a running session on its next turn. Any other session keeps what it read
	 * at its start. Cheap enough for every turn: the stored settings are one small file.
	 */
	async syncConfig(ctx: ExtensionContext): Promise<void> {
		if (mainSessionOf(ctx) === undefined) return;
		await this.reloadConfig(ctx);
	}

	#warnUnreadable(error: unknown): void {
		const detail = this.logger.describeError(error);
		if (detail === this.#configError) return;
		this.#configError = detail;
		this.logger.warn(
			`could not read the stored settings (${detail}); ${this.#everRead ? "the settings read last stay in effect" : "the defaults apply"}`,
		);
	}
}
