/**
 * Shared runtime state: configuration, credential, alias agents, routers and
 * telemetry. One instance per loaded extension; event handlers and commands
 * both read it, so a `/jev-router setup` takes effect on the next route
 * without a restart.
 */
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type JevRouterConfig, loadConfig, normalizeConfig } from "./config.ts";
import { type ResolvedCredential, resolveCredential } from "./credentials.ts";
import {
	type MaterializeResult,
	materializeTierAgents,
	readInheritedAgentBehavior,
	requiredTierAgents,
	type TierAgentSpec,
} from "./deep-agent.ts";
import { resolveRole, resolveRoleModel } from "./host.ts";
import { JevEngine } from "./jev.ts";
import { RouteLogger } from "./logging.ts";
import { OrchestrationRouter } from "./orchestration.ts";
import { GENERIC_TASK_AGENT, TaskRouter } from "./task-routing.ts";
import { Telemetry } from "./telemetry.ts";

/** Re-resolve the credential at most this often; setup and 401s invalidate early. */
const CREDENTIAL_TTL_MS = 60_000;

/**
 * Process-level survey memo. Sessions in one OMP process share a working
 * directory and a plugin install, so the alias materialization and agent
 * discovery behind a survey are identical for all of them.
 */
const surveyCache = new Map<string, Promise<AgentSurvey>>();

export interface AgentSurvey {
	/** True when the name `task` still resolves to OMP's bundled generic worker. */
	genericTaskIsBundled: boolean;
	/** Tier aliases confirmed discoverable by OMP. */
	discoveredAliases: Set<string>;
	/** Tier aliases written or already present on disk. */
	materialized: MaterializeResult;
}

export class JevRouterRuntime {
	readonly telemetry: Telemetry;
	readonly logger: RouteLogger;
	readonly engine = new JevEngine();
	readonly orchestration: OrchestrationRouter;
	readonly task: TaskRouter;
	readonly packageRoot: string;
	readonly stateDir: string;

	#config: JevRouterConfig = normalizeConfig(undefined);
	#credential: { value: ResolvedCredential | undefined; at: number } | undefined;
	#survey: AgentSurvey = {
		genericTaskIsBundled: true,
		discoveredAliases: new Set(),
		materialized: { available: [], failed: [], written: [] },
	};
	#ctx: ExtensionContext | undefined;

	constructor(pi: ExtensionAPI, packageRoot: string) {
		this.packageRoot = packageRoot;
		this.stateDir = path.join(getAgentDir(), "jev-router");
		this.telemetry = Telemetry.shared(this.stateDir);
		this.logger = new RouteLogger(pi.logger);

		const deps = {
			engine: this.engine,
			logger: this.logger,
			telemetry: this.telemetry,
			credential: () => this.apiKey(),
			config: () => this.#config,
			resolveRole: resolveRoleModel,
		};
		this.orchestration = new OrchestrationRouter(deps);
		this.task = new TaskRouter({ ...deps, genericTaskIsBundled: () => this.#survey.genericTaskIsBundled });
	}

	get config(): JevRouterConfig {
		return this.#config;
	}

	get survey(): AgentSurvey {
		return this.#survey;
	}

	/** The context of the session that owns this runtime, once one has been seen. */
	get context(): ExtensionContext | undefined {
		return this.#ctx;
	}

	bindContext(ctx: ExtensionContext): void {
		this.#ctx = ctx;
	}

	async reloadConfig(cwd: string): Promise<JevRouterConfig> {
		this.#config = await loadConfig(cwd);
		this.logger.setEnabled(this.#config.debugLogging);
		this.telemetry.setEnabled(this.#config.telemetryEnabled);
		return this.#config;
	}

	invalidateCredential(): void {
		this.#credential = undefined;
		this.engine.invalidate();
	}

	/** Resolved credential with provenance, cached briefly. */
	async credential(): Promise<ResolvedCredential | undefined> {
		const ctx = this.#ctx;
		if (!ctx) return undefined;
		const now = Date.now();
		if (this.#credential && now - this.#credential.at < CREDENTIAL_TTL_MS) return this.#credential.value;
		let value: ResolvedCredential | undefined;
		try {
			value = await resolveCredential(ctx);
		} catch (error) {
			this.logger.note(`credential resolution failed: ${this.logger.describeError(error)}`);
			value = undefined;
		}
		this.logger.trackSecret(value?.key);
		this.#credential = { value, at: now };
		return value;
	}

	async apiKey(): Promise<string | undefined> {
		return (await this.credential())?.key;
	}

	/**
	 * Startup check that TASK and main-model roles resolve. Missing roles are
	 * non-fatal, but silently collapse a tier or prevent a main-model switch.
	 * Identical resolutions are legal and only informational. No role is written.
	 */
	checkTierRoles(ctx: ExtensionContext): void {
		const normal = resolveRole(ctx, this.#config.normalTaskRole);
		const deep = resolveRole(ctx, this.#config.deepTaskRole);
		const mainNormal = this.#config.mainModelRoutingEnabled ? resolveRole(ctx, this.#config.mainNormalRole) : undefined;
		const mainDeep = this.#config.mainModelRoutingEnabled ? resolveRole(ctx, this.#config.mainDeepRole) : undefined;
		const unresolved = [normal, deep, mainNormal, mainDeep]
			.flatMap(role => role && !role.modelId ? [role.alias] : []);
		if (unresolved.length > 0) {
			this.logger.warn(
				`model role(s) ${unresolved.join(", ")} do not resolve; routing may keep the current model. See /jev-router status.`,
			);
		}
		if (normal.modelId && normal.modelId === deep.modelId) {
			this.logger.note(`TASK_NORMAL and TASK_DEEP both resolve to ${normal.label}; tier routing adds no cost difference`);
		}
		if (mainNormal?.modelId && mainNormal.modelId === mainDeep?.modelId) {
			this.logger.note(`MAIN_DEFAULT and MAIN_SLOW both resolve to ${mainNormal.label}; main-model routing adds no cost difference`);
		}
	}

	/**
	 * Write the tier aliases derived from the host's bundled `task` agent, then
	 * ask OMP's own discovery whether they are visible and whether `task` still
	 * resolves to the bundled definition. `settings` supplies the per-agent
	 * prewalk/advisor choices the operator made for `task`, which OMP keys by
	 * agent name and the aliases must therefore inherit explicitly.
	 *
	 * Memoized per process: every session builds its own runtime, and a deep
	 * spawn tree would otherwise redo the same discovery and file comparison
	 * once per subagent. The key covers everything that changes the answer.
	 */
	async surveyAgents(cwd: string, settings?: { get(key: string): unknown }): Promise<AgentSurvey> {
		const inherited = settings ? readInheritedAgentBehavior(settings) : {};
		const specs = requiredTierAgents(this.#config.normalTaskRole, this.#config.deepTaskRole, inherited);
		const key = JSON.stringify([cwd, this.packageRoot, specs]);
		const cached = surveyCache.get(key);
		this.#survey = await (cached ?? this.#runSurvey(cwd, specs, key));
		return this.#survey;
	}

	async #runSurvey(cwd: string, specs: TierAgentSpec[], key: string): Promise<AgentSurvey> {
		const pending = this.#performSurvey(cwd, specs);
		surveyCache.set(key, pending);
		try {
			return await pending;
		} catch (error) {
			surveyCache.delete(key);
			throw error;
		}
	}

	async #performSurvey(cwd: string, specs: TierAgentSpec[]): Promise<AgentSurvey> {
		const materialized = await materializeTierAgents(this.packageRoot, specs);
		if (materialized.written.length > 0) {
			this.logger.note(`materialized tier agents: ${materialized.written.join(", ")}`);
		}
		if (materialized.failed.length > 0) {
			this.logger.warn(
				`could not materialize tier agents (${materialized.failed.join(", ")}) under ${this.packageRoot}; tier routing stays native`,
			);
		}

		const discoveredAliases = new Set<string>();
		let genericTaskIsBundled = true;
		try {
			const { agents } = await discoverAgents(cwd);
			genericTaskIsBundled = agents.find(agent => agent.name === GENERIC_TASK_AGENT)?.source === "bundled";
			for (const spec of specs) {
				if (agents.some(agent => agent.name === spec.name)) discoveredAliases.add(spec.name);
			}
		} catch (error) {
			this.logger.warn(`agent discovery failed: ${this.logger.describeError(error)}`);
			for (const name of materialized.available) discoveredAliases.add(name);
		}
		return { genericTaskIsBundled, discoveredAliases, materialized };
	}
}
