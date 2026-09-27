/**
 * Shared runtime state: configuration, credential, the orchestration router
 * and telemetry. One instance per loaded extension; event
 * handlers and commands both read it, so a `/om-orche setup` takes effect on
 * the next decision without a restart.
 *
 * Generic workers are OMP's native `task` agent; this runtime never classifies,
 * rewrites or aliases them.
 */
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type JevRouterConfig, loadConfig, normalizeConfig } from "./config.ts";
import { type ResolvedCredential, resolveCredential } from "./credentials.ts";
import { JevEngine } from "./jev.ts";
import { RouteLogger } from "./logging.ts";
import { OrchestrationRouter } from "./orchestration.ts";
import { Telemetry } from "./telemetry.ts";

/** Re-resolve the credential at most this often; setup and 401s invalidate early. */
const CREDENTIAL_TTL_MS = 60_000;

export class JevRouterRuntime {
	readonly telemetry: Telemetry;
	readonly logger: RouteLogger;
	readonly engine = new JevEngine();
	readonly orchestration: OrchestrationRouter;
	readonly stateDir: string;

	#config: JevRouterConfig = normalizeConfig(undefined);
	#retiredConfigKeys: readonly string[] = [];
	#credential: { value: ResolvedCredential | undefined; at: number } | undefined;
	#ctx: ExtensionContext | undefined;

	constructor(pi: ExtensionAPI) {
		// Keep the existing data directory across the public package rename.
		this.stateDir = path.join(getAgentDir(), "jev-router");
		this.telemetry = Telemetry.shared(this.stateDir);
		this.logger = new RouteLogger(pi.logger);
		this.orchestration = new OrchestrationRouter({
			engine: this.engine,
			logger: this.logger,
			telemetry: this.telemetry,
			credential: () => this.apiKey(),
			config: () => this.#config,
		});
	}

	get config(): JevRouterConfig {
		return this.#config;
	}

	/** Retired tier-routing keys still stored for this plugin; they have no effect. */
	get retiredConfigKeys(): readonly string[] {
		return this.#retiredConfigKeys;
	}

	bindContext(ctx: ExtensionContext): void {
		this.#ctx = ctx;
	}

	async reloadConfig(cwd: string): Promise<JevRouterConfig> {
		const loaded = await loadConfig(cwd);
		this.#config = loaded.config;
		this.#retiredConfigKeys = loaded.retiredKeys;
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
}
