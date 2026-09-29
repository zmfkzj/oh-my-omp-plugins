/**
 * Debug logging.
 *
 * Every line is a fixed-shape metric record: the policy mode chosen for a turn or
 * the reason the plugin stayed out of it. Prompts, task bodies, source code and
 * transcripts never reach the log. `debugLogging` gates emission; the file sink
 * is OMP's own logger. `info` and `warn` are always on and reserved for rare
 * one-time events (the OMP setup report, a failure).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { PolicyMode } from "./orchestration-policy.ts";

/** A governed turn's policy mode, or a bounded reason (`disabled`, `plan-mode`, …) for staying out. */
export type PolicyLogRecord = { mode: PolicyMode } | { skip: string };

export class RouteLogger {
	#enabled = false;
	readonly #logger: ExtensionAPI["logger"];

	constructor(logger: ExtensionAPI["logger"]) {
		this.#logger = logger;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	/** A short description of a thrown value. */
	describeError(error: unknown): string {
		const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		return raw.slice(0, 200);
	}

	policy(record: PolicyLogRecord): void {
		if (!this.#enabled) return;
		this.#logger.debug(`om-orche.policy ${"mode" in record ? `mode=${record.mode}` : `skip=${record.skip}`}`);
	}

	/** A rare always-on notice (a one-time event), never emitted per turn. */
	info(message: string): void {
		this.#logger.info(`om-orche ${message}`);
	}

	warn(message: string): void {
		this.#logger.warn(`om-orche ${message}`);
	}
}
