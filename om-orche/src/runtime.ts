/**
 * Shared runtime state: configuration, the execution-policy router and
 * telemetry. One instance per loaded extension; event handlers and commands
 * both read it, so a settings change takes effect on the next turn without a
 * restart.
 *
 * Generic workers are OMP's native `task` agent; this runtime never rewrites
 * or aliases them, and nothing here needs credentials or network access.
 */
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, normalizeConfig, type OrcheConfig } from "./config.ts";
import { RouteLogger } from "./logging.ts";
import { OrchestrationRouter } from "./orchestration.ts";
import { Telemetry } from "./telemetry.ts";

export class OrcheRuntime {
	readonly telemetry: Telemetry;
	readonly logger: RouteLogger;
	readonly orchestration: OrchestrationRouter;
	readonly stateDir: string;

	#config: OrcheConfig = normalizeConfig(undefined);
	#retiredConfigKeys: readonly string[] = [];

	/**
	 * `stateDir` defaults to the plugin's directory under OMP's agent directory,
	 * which keeps its historical name across the public package rename.
	 */
	constructor(pi: ExtensionAPI, stateDir: string = path.join(getAgentDir(), "jev-router")) {
		this.stateDir = stateDir;
		this.telemetry = Telemetry.shared(this.stateDir);
		this.logger = new RouteLogger(pi.logger);
		this.orchestration = new OrchestrationRouter({ logger: this.logger, config: () => this.#config });
	}

	get config(): OrcheConfig {
		return this.#config;
	}

	/** Retired tier- and Jev-routing keys still stored for this plugin; they have no effect. */
	get retiredConfigKeys(): readonly string[] {
		return this.#retiredConfigKeys;
	}

	/**
	 * Re-read the configuration stored for `cwd`. Telemetry follows its
	 * `telemetryEnabled` unless `drivesTelemetry` is false: every session in the
	 * process shares one telemetry writer, so only the main session's project
	 * configuration may switch it. A subagent's working directory can differ (an
	 * isolated worktree has no project override) and must not switch it back.
	 */
	async reloadConfig(cwd: string, { drivesTelemetry = true } = {}): Promise<OrcheConfig> {
		const loaded = await loadConfig(cwd);
		this.#config = loaded.config;
		this.#retiredConfigKeys = loaded.retiredKeys;
		this.logger.setEnabled(this.#config.debugLogging);
		if (drivesTelemetry) this.telemetry.setEnabled(this.#config.telemetryEnabled);
		return this.#config;
	}
}
