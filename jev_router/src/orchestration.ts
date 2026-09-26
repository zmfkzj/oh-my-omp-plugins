/**
 * Front-door routing chooses only whether to attach native orchestration guidance.
 * A successful todo init/append can promote a direct turn after its committed
 * plan reveals independent work; provider context notices are never persisted.
 */
import { renderOrchestrateNotice } from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { JevRouterConfig } from "./config.ts";
import { mainSessionOf, orchestrateKeywordEnabled } from "./host.ts";
import type { JevDecider, OrchestrationRoute } from "./jev.ts";
import type { RouteLogger } from "./logging.ts";
import { buildRoutingContext, formatTodoPlan, isTodoPlan, latestCommittedTodoPlan, visibleText } from "./routing-context.ts";
import type { Telemetry } from "./telemetry.ts";

/** OMP's own notice type; reusing it keeps renderers and other extensions working. */
export const ORCHESTRATE_NOTICE_TYPE = "orchestrate-notice";

export type OrchestrationOutcome = OrchestrationRoute | "SKIP" | "ERROR";

export interface OrchestrationRecord {
	outcome: OrchestrationOutcome;
	confidence?: number;
	margin?: number;
	reason?: string;
	at: number;
}

/**
 * Native keyword notices are prepended immediately before the current user's
 * message. A historical notice belongs to its own earlier user turn.
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

function turnHasOwnNotice(messages: readonly AgentMessage[], notice: AgentMessage): boolean {
	return messages.some(message => message === notice || (message.role === "custom" &&
		notice.role === "custom" && message.customType === ORCHESTRATE_NOTICE_TYPE &&
		message.timestamp === notice.timestamp && message.content === notice.content));
}

/** Initial notices precede the current user; promotions follow their own todo result. */
export function noticeInsertIndex(messages: readonly AgentMessage[], todoToolCallId?: string): number {
	let userIndex = messages.length - 1;
	while (userIndex >= 0 && messages[userIndex]?.role !== "user") userIndex--;
	if (todoToolCallId) {
		for (let index = userIndex + 1; index < messages.length; index++) {
			const message = messages[index];
			if (message?.role === "toolResult" && message.toolName === "todo" &&
				message.toolCallId === todoToolCallId) {
				// Keep the producing assistant's tool-result group contiguous.
				let after = index + 1;
				while (messages[after]?.role === "toolResult") after++;
				return after;
			}
		}
		return -1; // Wait for the originating todo result to reach provider context.
	}
	return userIndex < 0 ? messages.length : userIndex;
}

type Gate = { ok: true; session: AgentSession } | { ok: false; reason: string };

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
	if (!orchestrationAllowed) {
		const reason = !config.orchestrationRoutingEnabled
			? "orchestration-routing-disabled"
			: !taskAvailable
				? "task-tool-unavailable"
				: "orchestrate-keyword-disabled";
		return { ok: false, reason };
	}
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
	explicitLogged: boolean;
	notice?: AgentMessage;
	noticeAnchor?: string;
	pending?: Promise<void>;
	seenPlans: Set<string>;
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

	/** Decide before dispatch; policy retries with the same prompt reuse the decision. */
	async beginTurn(ctx: ExtensionContext, prompt: string): Promise<void> {
		const gate = gateRequest(ctx, prompt, this.#deps.config());
		if (!gate.ok) {
			this.#turn = undefined;
			this.#last = { outcome: "SKIP", reason: gate.reason, at: Date.now() };
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: gate.reason });
			return;
		}
		if (this.#turn?.prompt === prompt && this.#turn.session === gate.session) {
			await this.#turn.pending;
			return;
		}
		const priorPlan = latestCommittedTodoPlan(gate.session.sessionManager.getBranch());
		const turn: TurnState = {
			prompt, session: gate.session,
			explicitLogged: false, seenPlans: new Set(priorPlan ? [JSON.stringify(priorPlan)] : []),
		};
		this.#turn = turn;
		turn.pending = this.#decide(ctx, turn);
		await turn.pending;
	}

	/** Called when the agent loop settles: never change the user's chosen model. */
	endTurn(): void {
		this.#turn = undefined;
	}

	/** Reconsider only successful committed plan creation/expansion, once per new plan. */
	async onTodoResult(ctx: ExtensionContext, event: ToolResultEvent): Promise<void> {
		const turn = this.#turn;
		if (!turn || turn.notice || turn.explicitLogged || turn.session !== mainSessionOf(ctx) ||
			!gateRequest(ctx, turn.prompt, this.#deps.config()).ok ||
			event.toolName !== "todo" || event.isError ||
			(event.input.op !== "init" && event.input.op !== "append")) return;
		const details = event.details as { op?: unknown; phases?: unknown } | undefined;
		if (details?.op !== event.input.op || !isTodoPlan(details.phases)) return;
		const branch = turn.session.sessionManager.getBranch();
		// Match the assistant's actual tool call to this user's turn. A late result
		// from a prior turn must not promote the next request, even in one session.
		let userIndex = branch.length - 1;
		while (userIndex >= 0) {
			const entry = branch[userIndex];
			if (entry?.type === "message" && entry.message.role === "user") break;
			userIndex--;
		}
		const currentUser = branch[userIndex];
		if (currentUser?.type !== "message" || currentUser.message.role !== "user" ||
			visibleText(currentUser.message.content) !== turn.prompt.trim()) return;
		const hasCall = branch.slice(userIndex + 1).some(entry => entry.type === "message" &&
			entry.message.role === "assistant" && entry.message.content.some(part =>
				part.type === "toolCall" && part.id === event.toolCallId && part.name === "todo"));
		if (!hasCall) return;
		const phases = details.phases as TodoPhase[];
		const fingerprint = JSON.stringify(phases);
		if (turn.seenPlans.has(fingerprint)) return;
		turn.seenPlans.add(fingerprint);
		turn.pending = (turn.pending ?? Promise.resolve()).then(async () => {
			if (this.#turn !== turn || turn.notice || turn.explicitLogged ||
				!gateRequest(ctx, turn.prompt, this.#deps.config()).ok) return;
			await this.#decide(ctx, turn, phases, event.toolCallId);
		});
		await turn.pending;
	}

	/** Attach the turn's decided notice to each provider request, if needed. */
	async applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const turn = this.#turn;
		if (!turn || !mainSessionOf(ctx)) return undefined;

		if (turn.notice && turnHasOwnNotice(messages, turn.notice)) return undefined;
		if (turnHasNativeOrchestrateNotice(messages)) {
			if (!turn.explicitLogged) {
				this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "explicit-orchestrate" });
				turn.explicitLogged = true;
			}
			return undefined;
		}
		if (!turn.notice) return undefined;
		const index = noticeInsertIndex(messages, turn.noticeAnchor);
		if (index < 0) return undefined;
		const next = [...messages];
		next.splice(index, 0, turn.notice);
		return next;
	}

	async #decide(ctx: ExtensionContext, turn: TurnState, phases?: readonly TodoPhase[], todoToolCallId?: string): Promise<void> {
		if (this.#turn !== turn) return;
		const config = this.#deps.config();
		const apiKey = await this.#deps.credential();
		if (this.#turn !== turn) return;
		if (!apiKey) {
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "credential-missing" });
			this.#last = { outcome: "SKIP", reason: "credential-missing", at: Date.now() };
			return;
		}

		try {
			const context = buildRoutingContext(turn.session.sessionManager.getBranch(), turn.prompt);
			if (phases) context.plan = formatTodoPlan(phases);
			const decision = await this.#deps.engine.decideOrchestration(
				turn.prompt,
				context,
				{ apiKey, model: config.jevModel, timeoutMs: config.routingTimeoutMs },
				{ minConfidence: config.orchestrationMinConfidence, minMargin: config.orchestrationMinMargin },
				config.maxRoutingInputChars,
			);
			if (this.#turn !== turn || (phases && (turn.explicitLogged ||
				!gateRequest(ctx, turn.prompt, this.#deps.config()).ok))) return;
			const outcome: OrchestrationRoute = decision.confident ? decision.top : "DEFAULT";
			this.#deps.telemetry.recordOrchestration(outcome, decision.confidence, decision.margin, decision.latencyMs);
			this.#deps.telemetry.appendDecision({
				kind: "orchestration",
				route: outcome,
				top: decision.top,
				probabilities: decision.probabilities,
				confidence: decision.confidence,
				margin: decision.margin,
				confident: decision.confident,
				latencyMs: decision.latencyMs,
			});
			this.#deps.logger.route("jev.orchestration", {
				route: outcome,
				confidence: decision.confidence,
				margin: decision.margin,
				latencyMs: decision.latencyMs,
			});
			this.#last = { outcome, confidence: decision.confidence, margin: decision.margin, at: Date.now() };
			if (outcome === "ORCHESTRATE") {
				turn.notice = this.#buildNotice(turn.session);
				turn.noticeAnchor = todoToolCallId;
			}
		} catch (error) {
			if (this.#turn !== turn) return;
			const reason = this.#deps.logger.describeError(error);
			const timedOut = /timeout|abort/i.test(reason);
			this.#deps.telemetry.recordFailure("orchestration", timedOut);
			this.#deps.telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut });
			this.#deps.logger.route("jev.orchestration", { route: "ERROR", reason });
			this.#last = { outcome: "ERROR", reason, at: Date.now() };
		}
	}

	#buildNotice(session: AgentSession): AgentMessage {
		return {
			role: "custom",
			customType: ORCHESTRATE_NOTICE_TYPE,
			content: renderOrchestrateNotice({ tools: session.getEnabledToolNames() }),
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		} as AgentMessage;
	}
}
