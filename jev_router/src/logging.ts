/**
 * Debug logging.
 *
 * Every line is a fixed-shape metric record. Prompts, task bodies, source code,
 * transcripts and credentials never reach the log: only route labels, numbers
 * and sizes. `debugLogging` gates emission; the file sink is OMP's own logger.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type RouteLabel = "DEFAULT" | "ORCHESTRATE" | "TASK_EASY" | "TASK_HARD" | "TASK_CHALLENGE";

export interface RouteLogRecord {
	route: RouteLabel | "SKIP" | "ERROR";
	confidence?: number;
	margin?: number;
	latencyMs?: number;
	/** Bounded, non-sensitive explanation (`credential-missing`, `timeout`, `http-401`, …). */
	reason?: string;
	/** Number of decisions in the batch, when more than one. */
	items?: number;
}

/** Secrets that must never reach a log line, keyed by the value to blank out. */
const REDACTED = "<redacted>";

/** Replace any occurrence of a known secret with a placeholder. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
	let out = text;
	for (const secret of secrets) {
		if (!secret || secret.length < 8) continue;
		out = out.split(secret).join(REDACTED);
	}
	// Defense in depth: blank anything that looks like a bearer token or api key literal.
	return out.replace(/\b(sk|ts|key)[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED);
}

export class RouteLogger {
	#enabled = false;
	#secrets = new Set<string>();
	readonly #logger: ExtensionAPI["logger"];

	constructor(logger: ExtensionAPI["logger"]) {
		this.#logger = logger;
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
	}

	/** Register a live credential so it can be scrubbed from any error text. */
	trackSecret(secret: string | undefined): void {
		if (secret && secret.length >= 8) this.#secrets.add(secret);
	}

	/** Scrub a thrown value into a short, credential-free reason code. */
	describeError(error: unknown): string {
		const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		return redact(raw, [...this.#secrets]).slice(0, 200);
	}

	route(channel: "jev.orchestration" | "jev.task", record: RouteLogRecord): void {
		if (!this.#enabled) return;
		const parts = [`route=${record.route}`];
		if (record.confidence !== undefined) parts.push(`confidence=${record.confidence.toFixed(2)}`);
		if (record.margin !== undefined) parts.push(`margin=${record.margin.toFixed(2)}`);
		if (record.items !== undefined) parts.push(`items=${record.items}`);
		if (record.latencyMs !== undefined) parts.push(`latency=${Math.round(record.latencyMs)}ms`);
		if (record.reason) parts.push(`reason=${redact(record.reason, [...this.#secrets])}`);
		this.#logger.debug(`${channel} ${parts.join(" ")}`);
	}

	note(message: string): void {
		if (!this.#enabled) return;
		this.#logger.debug(`jev.router ${redact(message, [...this.#secrets])}`);
	}

	warn(message: string): void {
		this.#logger.warn(`jev.router ${redact(message, [...this.#secrets])}`);
	}
}
