/**
 * Front-door orchestration router.
 *
 * One Jev choice per user request decides DEFAULT, SLOW, or ORCHESTRATE.
 * `before_agent_start` makes the decision and switches the main model before
 * dispatch (the agent loop captures its model before the `context` hook).
 * Policy-preparation retries reuse the decision for the same prompt. At
 * `context`, an ORCHESTRATE decision injects OMP's native hidden notice unless
 * the user's explicit orchestrate keyword already did; UNCERTAIN adds a short
 * hint. The user's prompt is never modified, and notices are not persisted.
 * At settled `agent_end`, a temporary model switch is restored unless another
 * actor changed the model during the turn.
 */
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { JevRouterConfig } from "./config.ts";
import { mainSessionOf, orchestrateKeywordEnabled, sameModel, type RoleSelection } from "./host.ts";
import { PRIOR_REQUEST_COUNT, type JevDecider, type OrchestrationRoute } from "./jev.ts";
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
	model?: string;
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

type Gate = { ok: true; session: AgentSession; orchestrationAllowed: boolean } | { ok: false; reason: string };

/** Everything that can be decided from the prompt alone, before any network work. */
export function gateRequest(ctx: ExtensionContext, prompt: string, config: JevRouterConfig): Gate {
	if (!config.enabled) return { ok: false, reason: "disabled" };

	// Recursion guard: a subagent must never re-enter the front door.
	const session = mainSessionOf(ctx);
	if (!session) return { ok: false, reason: "not-main-session" };

	const text = prompt.trim();
	if (!text) return { ok: false, reason: "empty-prompt" };
	if (text.startsWith("/")) return { ok: false, reason: "slash-command" };
	if (text.startsWith("<system-")) return { ok: false, reason: "synthetic-notice" };
	if (session.getPlanModeState?.()?.enabled === true) return { ok: false, reason: "plan-mode" };

	const taskAvailable = session.getEnabledToolNames().includes("task");
	const keywordEnabled = orchestrateKeywordEnabled(session);
	const orchestrationAllowed = config.orchestrationRoutingEnabled && taskAvailable && keywordEnabled;
	if (!orchestrationAllowed && !config.mainModelRoutingEnabled) {
		const reason = !config.orchestrationRoutingEnabled
			? "orchestration-routing-disabled"
			: !taskAvailable
				? "task-tool-unavailable"
				: "orchestrate-keyword-disabled";
		return { ok: false, reason };
	}
	return { ok: true, session, orchestrationAllowed };
}

export interface OrchestrationRouterDeps {
	engine: JevDecider;
	logger: RouteLogger;
	telemetry: Telemetry;
	credential: () => Promise<string | undefined>;
	config: () => JevRouterConfig;
	resolveRole: (ctx: ExtensionContext, role: string) => RoleSelection | undefined;
}

interface TurnState {
	prompt: string;
	session: AgentSession;
	orchestrationAllowed: boolean;
	explicitLogged: boolean;
	record?: OrchestrationRecord;
	notice?: AgentMessage;
	pending?: Promise<void>;
}

export class OrchestrationRouter {
	#turn: TurnState | undefined;
	#applied: {
		session: AgentSession;
		from: Model;
		fromThinking: AgentSession["thinkingLevel"];
		to: Model;
		normalRole: string;
	} | undefined;
	#last: OrchestrationRecord | undefined;
	readonly #deps: OrchestrationRouterDeps;

	constructor(deps: OrchestrationRouterDeps) {
		this.#deps = deps;
	}

	get lastDecision(): OrchestrationRecord | undefined {
		return this.#last;
	}

	/** Decide before dispatch; policy retries with the same prompt await the same decision. */
	async beginTurn(ctx: ExtensionContext, prompt: string): Promise<void> {
		const gate = gateRequest(ctx, prompt, this.#deps.config());
		if (!gate.ok) {
			this.#turn = undefined;
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: gate.reason });
			return;
		}
		if (this.#turn?.prompt === prompt) {
			await this.#turn.pending;
			return;
		}
		const turn: TurnState = { prompt, session: gate.session, orchestrationAllowed: gate.orchestrationAllowed, explicitLogged: false };
		this.#turn = turn;
		turn.pending = this.#decide(ctx, turn);
		await turn.pending;
	}

	/** Called when the agent loop settles: the next request routes fresh. */
	async endTurn(current: Model | undefined): Promise<void> {
		this.#turn = undefined;
		await this.#restore(current);
	}

	/** Attach the turn's decided notice to each provider request, if needed. */
	async applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const turn = this.#turn;
		if (!turn || !mainSessionOf(ctx)) return undefined;

		if (turnHasNativeOrchestrateNotice(messages)) {
			if (!turn.explicitLogged) {
				this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "explicit-orchestrate" });
				turn.explicitLogged = true;
			}
			return undefined;
		}
		if (!turn.notice) return undefined;

		const next = [...messages];
		next.splice(noticeInsertIndex(next), 0, turn.notice);
		return next;
	}

	async #decide(ctx: ExtensionContext, turn: TurnState): Promise<void> {
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
				priorUserRequests(turn.session.sessionManager.getBranch(), turn.prompt, PRIOR_REQUEST_COUNT),
				{ apiKey, model: config.jevModel, timeoutMs: config.routingTimeoutMs },
				{ minConfidence: config.orchestrationMinConfidence, minMargin: config.orchestrationMinMargin },
				config.maxRoutingInputChars,
			);
			const outcome: OrchestrationRoute | "UNCERTAIN" = decision.confident ? decision.top : "UNCERTAIN";
			const model = await this.#applyMainModel(ctx, turn, outcome);
			this.#deps.telemetry.recordOrchestration(outcome, decision.confidence, decision.margin, decision.latencyMs);
			this.#deps.logger.route("jev.orchestration", {
				route: outcome,
				confidence: decision.confidence,
				margin: decision.margin,
				latencyMs: decision.latencyMs,
				model,
			});
			turn.record = { outcome, confidence: decision.confidence, margin: decision.margin, model, at: Date.now() };
			this.#last = turn.record;
			if (turn.orchestrationAllowed) turn.notice = this.#buildNotice(outcome, turn.session);
		} catch (error) {
			// Failure leaves the model and native orchestration behavior untouched.
			const reason = this.#deps.logger.describeError(error);
			this.#deps.telemetry.recordFailure("orchestration", /timeout|abort/i.test(reason));
			this.#deps.logger.route("jev.orchestration", { route: "ERROR", reason });
			turn.record = { outcome: "ERROR", reason, at: Date.now() };
			this.#last = turn.record;
		}
	}

	async #applyMainModel(ctx: ExtensionContext, turn: TurnState, outcome: OrchestrationRoute | "UNCERTAIN"): Promise<string> {
		const config = this.#deps.config();
		if (!config.mainModelRoutingEnabled) return "skip:routing-disabled";
		const wantDeep = outcome === "SLOW" || outcome === "UNCERTAIN";
		const defaults = this.#deps.resolveRole(ctx, config.mainNormalRole);
		if (!defaults) return "skip:default-role-unresolved";
		const current = ctx.model;
		if (!current) return "skip:no-current-model";
		// OMP's `--model` rewrites the default role at runtime; matching its new
		// value alone would misclassify an explicit CLI choice as the baseline.
		if (turn.session.settings.getModelRoleProvenance(config.mainNormalRole) === "runtime") return "skip:explicit-model";
		const baseline = this.#applied && sameModel(current, this.#applied.to) ? this.#applied.from : current;
		if (!sameModel(baseline, defaults.model)) return "skip:explicit-model";
		if (!wantDeep) {
			if (this.#applied) await this.#restore(current);
			return "kept";
		}
		const deep = this.#deps.resolveRole(ctx, config.mainDeepRole);
		if (!deep) return "skip:deep-role-unresolved";
		if (sameModel(deep.model, defaults.model)) return "skip:same-model";
		if (this.#applied && sameModel(current, deep.model)) return `@${config.mainDeepRole}`;

		const fromThinking = turn.session.thinkingLevel;
		try {
			await turn.session.setModelTemporary(deep.model, deep.thinkingLevel, { ephemeral: true });
		} catch (error) {
			this.#deps.logger.warn(this.#deps.logger.describeError(error));
			return "skip:model-auth-missing";
		}
		this.#applied = { session: turn.session, from: baseline, fromThinking, to: deep.model, normalRole: config.mainNormalRole };
		return `@${config.mainDeepRole}`;
	}
	async #restore(current: Model | undefined): Promise<void> {
		const applied = this.#applied;
		if (!applied) return;
		this.#applied = undefined;
		if (
			applied.session.settings.getModelRoleProvenance(applied.normalRole) === "runtime" ||
			!current || !sameModel(current, applied.to)
		) {
			this.#deps.logger.note("main model left as is: changed during the turn");
			return;
		}
		try {
			await applied.session.setModelTemporary(applied.from, applied.fromThinking, { ephemeral: true });
		} catch (error) {
			this.#deps.logger.warn(this.#deps.logger.describeError(error));
		}
	}

	#buildNotice(outcome: OrchestrationRoute | "UNCERTAIN", session: AgentSession): AgentMessage | undefined {
		if (outcome === "DEFAULT" || outcome === "SLOW") return undefined;
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

/** Recent real user requests, oldest first; the current prompt is not prior context. */
export function priorUserRequests(branch: readonly SessionEntry[], prompt: string, count: number): string[] {
	const prior: string[] = [];
	const currentPrompt = prompt.trim();
	for (let index = branch.length - 1; index >= 0 && prior.length < count; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content.filter(part => part.type === "text").map(part => part.text).join("");
		const trimmed = text.trim();
		if (!trimmed || trimmed === currentPrompt || trimmed.startsWith("/") || trimmed.startsWith("<system-")) continue;
		prior.push(text);
	}
	return prior.reverse();
}
