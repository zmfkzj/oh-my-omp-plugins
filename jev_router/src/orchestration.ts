/**
 * Front-door orchestration router.
 *
 * One Jev choice per user request decides whether OMP's *native* orchestration
 * contract should apply to that turn. The plugin implements no orchestration of
 * its own: on ORCHESTRATE it injects the very notice OMP's `orchestrate` magic
 * keyword injects — `renderOrchestrateNotice`, `customType: "orchestrate-notice"`,
 * hidden, user-attributed — and nothing else. The user's typed prompt is never
 * modified, and no synthetic keyword is appended to it.
 *
 * Delivery runs in two phases:
 *
 *   `before_agent_start` captures the request text for the turn. It performs no
 *   network work, so OMP's policy-preparation retries are free.
 *
 *   `context` makes and applies the decision against the messages actually
 *   about to be sent. That seam is what lets the router ask OMP whether the
 *   keyword already fired instead of re-implementing its prose matcher: a
 *   native notice sits in the hidden custom-message run immediately before the
 *   turn's user message (`prependMessages` in `AgentSession.#dispatchPrompt`),
 *   and `@oh-my-pi/pi-tui/prompt/orchestrate` is unreachable from an extension
 *   (pi-tui subpaths do not resolve inside the compiled binary; only the
 *   package root does, and it does not re-export `containsOrchestrate`).
 *   Injecting here also keeps the notice out of the transcript, so an
 *   automatically orchestrated turn leaves no residue for the next one.
 *
 * DIRECT adds nothing at all — no "never delegate" instruction — so the primary
 * agent can still delegate through OMP's normal mechanisms when evidence turns
 * up mid-turn. UNCERTAIN adds one short hidden line instead of a second
 * expensive routing call.
 */
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { JevRouterConfig } from "./config.ts";
import { mainSessionOf, orchestrateKeywordEnabled } from "./host.ts";
import type { JevDecider, OrchestrationRoute } from "./jev.ts";
import type { RouteLogger } from "./logging.ts";
import type { Telemetry } from "./telemetry.ts";

/** OMP's own notice type; reusing it keeps renderers and other extensions working. */
export const ORCHESTRATE_NOTICE_TYPE = "orchestrate-notice";
export const UNCERTAIN_NOTICE_TYPE = "jev-router-orchestration-uncertain";

/**
 * Deliberately short: this is the cheap substitute for a second routing call,
 * not a planning prompt. It must not read as an instruction to orchestrate.
 */
export const UNCERTAIN_NOTICE = `<system-notice>
Jev could not confidently determine whether native orchestration is worthwhile for this request.

While scoping — not as a separate step, and without an extra planning round-trip — decide whether
independent delegation would materially reduce context duplication or enable genuinely parallel
work. If it would, delegate through the normal task mechanism. Otherwise execute directly.
</system-notice>`;

export type OrchestrationOutcome = OrchestrationRoute | "UNCERTAIN" | "SKIP" | "ERROR";

export interface OrchestrationRecord {
	outcome: OrchestrationOutcome;
	confidence?: number;
	margin?: number;
	reason?: string;
	at: number;
}

/**
 * Whether OMP already attached its own orchestrate notice to the turn whose
 * user message is last in `messages`.
 *
 * Magic-keyword notices are prepended, so they land in the contiguous run of
 * hidden custom messages directly before that user message, alongside the
 * todo/task preludes and attachment companions. Scanning only that run keeps an
 * older turn's notice — which, with native keyword use, stays in history — from
 * being mistaken for this turn's.
 */
export function turnHasNativeOrchestrateNotice(messages: readonly AgentMessage[]): boolean {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "user") index--;
	if (index < 0) return false;
	for (let cursor = index - 1; cursor >= 0; cursor--) {
		const message = messages[cursor];
		if (message?.role !== "custom") return false;
		if (message.customType === ORCHESTRATE_NOTICE_TYPE) return true;
	}
	return false;
}

/** Index at which a turn-scoped notice mirrors OMP's own placement. */
export function noticeInsertIndex(messages: readonly AgentMessage[]): number {
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.role !== "user") index--;
	return index < 0 ? messages.length : index;
}

type Gate = { ok: true; session: AgentSession } | { ok: false; reason: string };

/** Everything that can be decided from the prompt alone, before any network work. */
export function gateRequest(ctx: ExtensionContext, prompt: string, config: JevRouterConfig): Gate {
	if (!config.enabled) return { ok: false, reason: "disabled" };
	if (!config.orchestrationRoutingEnabled) return { ok: false, reason: "orchestration-routing-disabled" };

	// Recursion guard: a subagent must never re-enter the front door, or an
	// ORCHESTRATE decision inside a child would fan out another tree.
	const session = mainSessionOf(ctx);
	if (!session) return { ok: false, reason: "not-main-session" };

	const text = prompt.trim();
	if (!text) return { ok: false, reason: "empty-prompt" };
	// An unexpanded leading slash is a command OMP did not resolve, not a request.
	if (text.startsWith("/")) return { ok: false, reason: "slash-command" };
	// Agent-authored notices arrive already wrapped; they are not user requests.
	if (text.startsWith("<system-")) return { ok: false, reason: "synthetic-notice" };

	if (session.getPlanModeState?.()?.enabled === true) return { ok: false, reason: "plan-mode" };
	if (!session.getEnabledToolNames().includes("task")) return { ok: false, reason: "task-tool-unavailable" };
	// If the operator turned the keyword off, the router must not force its notice.
	if (!orchestrateKeywordEnabled(session)) return { ok: false, reason: "orchestrate-keyword-disabled" };

	return { ok: true, session };
}

export interface OrchestrationRouterDeps {
	engine: JevDecider;
	logger: RouteLogger;
	telemetry: Telemetry;
	credential: () => Promise<string | undefined>;
	config: () => JevRouterConfig;
}

interface TurnState {
	prompt: string;
	session: AgentSession;
	record?: OrchestrationRecord;
	notice?: AgentMessage;
	pending?: Promise<void>;
}

export class OrchestrationRouter {
	#turn: TurnState | undefined;
	#last: OrchestrationRecord | undefined;
	readonly #deps: OrchestrationRouterDeps;

	constructor(deps: OrchestrationRouterDeps) {
		this.#deps = deps;
	}

	get lastDecision(): OrchestrationRecord | undefined {
		return this.#last;
	}

	/** Scope a new turn. Re-entry with the same text (policy retry) is a no-op. */
	beginTurn(ctx: ExtensionContext, prompt: string): void {
		const gate = gateRequest(ctx, prompt, this.#deps.config());
		if (!gate.ok) {
			this.#turn = undefined;
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: gate.reason });
			return;
		}
		if (this.#turn?.prompt === prompt) return;
		this.#turn = { prompt, session: gate.session };
	}

	/** Called when the agent loop settles: the next request routes fresh. */
	endTurn(): void {
		this.#turn = undefined;
	}

	/**
	 * Decide once per turn, then keep the notice attached to every provider
	 * request in that turn. Returns replacement messages, or `undefined` to
	 * leave the context untouched.
	 */
	async applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const turn = this.#turn;
		if (!turn || !mainSessionOf(ctx)) return undefined;

		if (turnHasNativeOrchestrateNotice(messages)) {
			// Explicit user control outranks the router in both directions.
			if (!turn.record) {
				this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "explicit-orchestrate" });
				turn.record = { outcome: "SKIP", reason: "explicit-orchestrate", at: Date.now() };
			}
			return undefined;
		}

		if (!turn.record) {
			turn.pending ??= this.#decide(turn);
			await turn.pending;
		}
		if (!turn.notice) return undefined;

		const next = [...messages];
		next.splice(noticeInsertIndex(next), 0, turn.notice);
		return next;
	}

	async #decide(turn: TurnState): Promise<void> {
		const config = this.#deps.config();
		const apiKey = await this.#deps.credential();
		if (!apiKey) {
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "credential-missing" });
			turn.record = { outcome: "SKIP", reason: "credential-missing", at: Date.now() };
			return;
		}

		try {
			const decision = await this.#deps.engine.decideOrchestration(
				turn.prompt,
				{ apiKey, model: config.jevModel, timeoutMs: config.routingTimeoutMs },
				{ minConfidence: config.orchestrationMinConfidence, minMargin: config.orchestrationMinMargin },
				config.maxRoutingInputChars,
			);
			const outcome: "DIRECT" | "ORCHESTRATE" | "UNCERTAIN" = decision.confident ? decision.top : "UNCERTAIN";
			this.#deps.telemetry.recordOrchestration(outcome, decision.confidence, decision.margin, decision.latencyMs);
			this.#deps.logger.route("jev.orchestration", {
				route: outcome,
				confidence: decision.confidence,
				margin: decision.margin,
				latencyMs: decision.latencyMs,
			});
			turn.record = { outcome, confidence: decision.confidence, margin: decision.margin, at: Date.now() };
			this.#last = turn.record;
			turn.notice = this.#buildNotice(outcome, turn.session);
		} catch (error) {
			// Front-door failure means no automatic orchestration: the request runs
			// exactly as OMP would run it without this plugin.
			const reason = this.#deps.logger.describeError(error);
			this.#deps.telemetry.recordFailure("orchestration", /timeout|abort/i.test(reason));
			this.#deps.logger.route("jev.orchestration", { route: "ERROR", reason });
			turn.record = { outcome: "ERROR", reason, at: Date.now() };
			this.#last = turn.record;
		}
	}

	#buildNotice(
		outcome: "DIRECT" | "ORCHESTRATE" | "UNCERTAIN",
		session: AgentSession,
	): AgentMessage | undefined {
		if (outcome === "DIRECT") return undefined;
		const content =
			outcome === "ORCHESTRATE"
				? renderOrchestrateNotice({ tools: session.getEnabledToolNames() })
				: UNCERTAIN_NOTICE;
		return {
			role: "custom",
			customType: outcome === "ORCHESTRATE" ? ORCHESTRATE_NOTICE_TYPE : UNCERTAIN_NOTICE_TYPE,
			content,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		} as AgentMessage;
	}
}
