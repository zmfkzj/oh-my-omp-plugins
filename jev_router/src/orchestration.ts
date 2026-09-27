/**
 * Front-door routing chooses whether to attach this plugin's orchestration policy
 * and, independently, whether the turn's plan requires checkpoint review. Review
 * is assessed even when orchestration is unavailable; only the guidance changes.
 * A successful todo init/append can promote a direct turn after its committed
 * plan reveals independent work. Once a turn is orchestrated its route is final,
 * so a changed plan requires review without another Jev request. Once a turn
 * requires review, each newly finished phase requires a phase-boundary review.
 * Without a risk assessment (no credential, failed request) review is required.
 *
 * Guidance precedence for the current turn: OMP's workflow notice, then OMP's
 * explicit orchestrate notice, then an automatic ORCHESTRATE route, then DEFAULT.
 * The explicit notice is replaced in place by this plugin's policy notice; the
 * workflow notice is kept and only receives an auxiliary supplement. Notices are
 * provider-context only: history is never persisted or mutated, requirements
 * leave through `onReviewDecision`, and the primary model never changes.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { JevRouterConfig } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import type {
	GateOutcome,
	JevDecider,
	OrchestrationDecision,
	OrchestrationRoute,
	ReviewRequirement,
} from "./jev.ts";
import type { RouteLogger } from "./logging.ts";
import {
	buildPolicyNotice,
	currentTurnNotices,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	policyModeOf,
	type PolicyMode,
} from "./orchestration-policy.ts";
import { buildRoutingContext, formatTodoPlan, isTodoPlan, latestCommittedTodoPlan, visibleText } from "./routing-context.ts";
import type { Telemetry } from "./telemetry.ts";

export type OrchestrationOutcome = OrchestrationRoute | "SKIP" | "ERROR";

/** The point in a turn a review requirement applies to. */
export type ReviewCheckpoint = "initial-plan" | "scope-expansion" | "phase-boundary";

export interface OrchestrationRecord {
	outcome: OrchestrationOutcome;
	confidence?: number;
	margin?: number;
	reason?: string;
	/** Whether this decision requires checkpoint review; absent when the front door skipped the turn. */
	reviewRequired?: boolean;
	/** The independent review answer, when Jev returned a decision. */
	review?: GateOutcome<ReviewRequirement>;
	at: number;
}

/** Identifies one persisted native notice even after later user messages move it out of the turn prefix. */
function noticeKey(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== NATIVE_ORCHESTRATE_NOTICE_TYPE) return undefined;
	return `${message.timestamp}\u0000${JSON.stringify(message.content)}`;
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

/** Every task closed and at least one completed; a wholly abandoned phase is dropped scope, not a boundary. */
function phaseFinished(phase: TodoPhase): boolean {
	return phase.tasks.some(task => task.status === "completed") &&
		phase.tasks.every(task => task.status === "completed" || task.status === "abandoned");
}

/**
 * Match the assistant's actual todo call to this user's turn. A late result
 * from a prior turn must not act on the next request, even in one session.
 */
function turnOwnsTodoCall(session: AgentSession, prompt: string, toolCallId: string): boolean {
	const branch = session.sessionManager.getBranch();
	let userIndex = branch.length - 1;
	while (userIndex >= 0) {
		const entry = branch[userIndex];
		if (entry?.type === "message" && entry.message.role === "user") break;
		userIndex--;
	}
	const currentUser = branch[userIndex];
	if (currentUser?.type !== "message" || currentUser.message.role !== "user" ||
		visibleText(currentUser.message.content) !== prompt.trim()) return false;
	return branch.slice(userIndex + 1).some(entry => entry.type === "message" &&
		entry.message.role === "assistant" && entry.message.content.some(part =>
			part.type === "toolCall" && part.id === toolCallId && part.name === "todo"));
}

/**
 * A gated-in request always has its review assessed. `orchestrationAllowed` only
 * governs automatic promotion; an explicit native request is handled regardless.
 */
type Gate =
	| { ok: true; session: AgentSession; orchestrationAllowed: boolean; reason?: string }
	| { ok: false; reason: string };

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

	// OMP's keyword settings only decide whether an explicit notice can appear; they never gate automatic routing.
	const taskAvailable = session.getEnabledToolNames().includes("task");
	const orchestrationAllowed = config.orchestrationRoutingEnabled && taskAvailable;
	if (!orchestrationAllowed) {
		const reason = !config.orchestrationRoutingEnabled ? "orchestration-routing-disabled" : "task-tool-unavailable";
		return { ok: true, session, orchestrationAllowed, reason };
	}
	return { ok: true, session, orchestrationAllowed };
}

/** A Jev decision, or why none exists; a missing assessment never makes review optional. */
type Classification =
	| { ok: true; decision: OrchestrationDecision }
	| { ok: false; reason: "credential-missing" | "classification-timeout" | "classification-error" };

export interface OrchestrationRouterDeps {
	engine: JevDecider;
	logger: RouteLogger;
	telemetry: Telemetry;
	credential: () => Promise<string | undefined>;
	config: () => JevRouterConfig;
	/**
	 * Receives each accepted review requirement of the current main-session turn.
	 * A missing credential or failed classification requires review. A turn the
	 * front-door gate skips (router disabled, subagent, slash, synthetic or empty
	 * prompt, plan mode) reports nothing; unavailable orchestration still reports.
	 * A throwing handler fails the hook that triggered it. `request` is that turn's
	 * prompt: `before_agent_start` runs before the user message is persisted, so
	 * the branch cannot identify the request yet.
	 */
	onReviewDecision?: (
		ctx: ExtensionContext,
		required: boolean,
		checkpoint: ReviewCheckpoint,
		reason: string,
		request: string,
		workScope?: string,
	) => boolean | void;
}

interface TurnState {
	prompt: string;
	session: AgentSession;
	/** OMP's explicit orchestrate notice was seen in this turn; the route is then final. */
	explicitLogged: boolean;
	/** Keys of this turn's native orchestrate notices, replaced wherever they appear. */
	natives: string[];
	/** OMP's workflow notice was seen in this turn; it governs execution for the rest of the turn. */
	workflow: boolean;
	/** Jev routed this turn to ORCHESTRATE; the route is then final. */
	orchestrated: boolean;
	/** The todo call whose committed plan promoted the turn; absent for an initial route. */
	noticeAnchor?: string;
	/** One stable notice per policy mode, created on first use and reused on every request. */
	notices: Partial<Record<PolicyMode, AgentMessage>>;
	pending?: Promise<void>;
	seenPlans: Set<string>;
	/** The latest committed plan this turn has seen; finished phases are measured against it. */
	phases: readonly TodoPhase[];
	/** Some requirement reported this turn was required; each later finished phase then needs review. */
	reviewRequired: boolean;
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
			explicitLogged: false, natives: [], workflow: false, orchestrated: false, notices: {},
			seenPlans: new Set(priorPlan ? [JSON.stringify(priorPlan)] : []),
			phases: priorPlan ?? [], reviewRequired: false,
		};
		this.#turn = turn;
		const decided = this.#decide(ctx, turn, "initial-plan");
		// A failing review handler rejects this caller; later steps of the turn still run.
		turn.pending = decided.catch(() => undefined);
		await decided;
	}

	/** Called when the agent loop settles: never change the user's chosen model. */
	endTurn(): void {
		this.#turn = undefined;
	}

	/**
	 * Act only on successful committed results of this turn's own todo calls. A new
	 * plan from init/append is reclassified, or requires review outright once the
	 * turn is orchestrated. Any other change that newly finishes a phase requires a
	 * phase-boundary review once the turn requires review. Neither an unchanged
	 * plan nor each done counts.
	 */
	async onTodoResult(ctx: ExtensionContext, event: ToolResultEvent): Promise<void> {
		const turn = this.#turn;
		if (!turn || turn.session !== mainSessionOf(ctx) ||
			!gateRequest(ctx, turn.prompt, this.#deps.config()).ok ||
			event.toolName !== "todo" || event.isError) return;
		const details = event.details as { op?: unknown; phases?: unknown } | undefined;
		const op = details?.op;
		const phases = details?.phases;
		if (typeof op !== "string" || op === "view" || op !== event.input.op || !isTodoPlan(phases) ||
			!turnOwnsTodoCall(turn.session, turn.prompt, event.toolCallId)) return;
		const previous = turn.phases;
		turn.phases = phases;
		let step: () => Promise<void> | void;
		if (op === "init" || op === "append") {
			const fingerprint = JSON.stringify(phases);
			if (turn.seenPlans.has(fingerprint)) return;
			turn.seenPlans.add(fingerprint);
			const checkpoint: ReviewCheckpoint = op === "init" ? "initial-plan" : "scope-expansion";
			step = () => this.#decide(ctx, turn, checkpoint, phases, event.toolCallId);
		} else if (phases.some(phase => phaseFinished(phase) &&
			!previous.some(prior => prior.name === phase.name && phaseFinished(prior)))) {
			// Each done is not a checkpoint; only a newly finished phase is, once review is required.
			step = () => {
				if (turn.reviewRequired) this.#notify(ctx, turn, true, "phase-boundary", "phase-completed");
			};
		} else return;
		const run = (turn.pending ?? Promise.resolve()).then(async () => {
			if (this.#turn !== turn || !gateRequest(ctx, turn.prompt, this.#deps.config()).ok) return;
			await step();
		});
		turn.pending = run.catch(() => undefined);
		await run;
	}

	/**
	 * Return a provider-context copy carrying exactly one policy notice for this
	 * turn, or `undefined` when nothing changes. This turn's native orchestrate
	 * notices are replaced in place; historical turns, the workflow notice and
	 * other messages are left untouched, and no message object is mutated.
	 */
	async applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): Promise<AgentMessage[] | undefined> {
		const turn = this.#turn;
		if (!turn || turn.session !== mainSessionOf(ctx) || !gateRequest(ctx, turn.prompt, this.#deps.config()).ok) {
			return undefined;
		}

		// Record this turn's keyword notices while they still precede its user message.
		for (const index of currentTurnNotices(messages, NATIVE_ORCHESTRATE_NOTICE_TYPE)) {
			const key = noticeKey(messages[index]!);
			if (key && !turn.natives.includes(key)) turn.natives.push(key);
		}
		if (currentTurnNotices(messages, NATIVE_WORKFLOW_NOTICE_TYPE).length > 0) turn.workflow = true;
		if (turn.natives.length > 0 && !turn.explicitLogged) {
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "explicit-orchestrate" });
			turn.explicitLogged = true;
			this.#notify(ctx, turn, true, "initial-plan", "explicit-orchestrate");
		}

		const tools = turn.session.getEnabledToolNames();
		const mode: PolicyMode | undefined = turn.workflow
			? "workflow"
			: turn.explicitLogged || turn.orchestrated
				? "orchestrate"
				: tools.includes("task") ? "default" : undefined;
		const isNative = (message: AgentMessage) => {
			const key = noticeKey(message);
			return key !== undefined && turn.natives.includes(key);
		};
		const firstNative = messages.find(isNative);
		// Rendered once per turn and mode, so content and timestamp stay stable across requests.
		const notice = mode && (turn.notices[mode] ??= buildPolicyNotice(mode, tools,
			firstNative?.role === "custom" ? firstNative.timestamp : Date.now()));
		const present = messages.some(message => this.#ownMode(turn, message) === mode);

		const next: AgentMessage[] = [];
		let placed = false;
		let changed = false;
		for (const message of messages) {
			if (isNative(message)) {
				// The native and plugin policies are never shown together.
				changed = true;
				if (notice && !present && !placed) {
					next.push(notice);
					placed = true;
				}
				continue;
			}
			const own = this.#ownMode(turn, message);
			if (own !== undefined) {
				if (own === mode && !placed) {
					next.push(message);
					placed = true;
				} else changed = true; // Superseded by a promotion, or a duplicate.
				continue;
			}
			next.push(message);
		}
		if (notice && !placed) {
			// A promotion stays behind its todo result; every other notice precedes the current user.
			const anchor = mode === "orchestrate" && !turn.explicitLogged ? turn.noticeAnchor : undefined;
			const index = noticeInsertIndex(next, anchor);
			if (index >= 0) {
				next.splice(index, 0, notice);
				changed = true;
			}
		}
		return changed ? next : undefined;
	}

	/** The mode of a notice this turn created, including a copy later hooks extended. */
	#ownMode(turn: TurnState, message: AgentMessage): PolicyMode | undefined {
		const mode = policyModeOf(message);
		const own = mode && turn.notices[mode];
		if (!own || own.role !== "custom" || message.role !== "custom" || message.timestamp !== own.timestamp) return undefined;
		return typeof message.content === "string" && typeof own.content === "string" && message.content.startsWith(own.content)
			? mode
			: undefined;
	}

	async #decide(
		ctx: ExtensionContext,
		turn: TurnState,
		checkpoint: ReviewCheckpoint,
		phases?: readonly TodoPhase[],
		todoToolCallId?: string,
	): Promise<void> {
		if (this.#turn !== turn) return;
		// An orchestrated route is final for the turn, so Jev cannot change its review requirement.
		const result = turn.orchestrated || turn.explicitLogged ? undefined : await this.#classify(turn, phases);
		if (this.#turn !== turn) return;
		const gate = gateRequest(ctx, turn.prompt, this.#deps.config());
		if (!gate.ok) return;
		if (turn.orchestrated || turn.explicitLogged) {
			// Also covers native guidance that arrived while Jev was deciding.
			this.#notify(ctx, turn, true, checkpoint, turn.explicitLogged ? "explicit-orchestrate" : "orchestrate");
			return;
		}
		if (!result) return;
		if (!result.ok) {
			// A missing risk assessment is not evidence that review is optional.
			this.#notify(ctx, turn, true, checkpoint, result.reason, phases ? "CONTINUE" : "NEW");
			return;
		}
		const { decision } = result;
		// Unavailable orchestration withholds only the route; review is still assessed.
		const outcome: OrchestrationRoute = decision.confident && gate.orchestrationAllowed ? decision.top : "DEFAULT";
		// A missing or unconfident review answer requires review.
		const reviewReason = decision.workScopeUncertain
			? "work-scope-uncertain"
			: Object.keys(decision.review.probabilities).length === 0
				? "review-missing"
			: !decision.review.confident
				? "review-uncertain"
				: decision.review.top === "REQUIRED" ? "review-required" : "review-optional";
		const reviewRequired = outcome === "ORCHESTRATE" || reviewReason !== "review-optional";
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
			reviewRequired,
			review: decision.review,
		});
		this.#deps.logger.route("jev.orchestration", {
			route: outcome,
			confidence: decision.confidence,
			margin: decision.margin,
			latencyMs: decision.latencyMs,
			reason: gate.reason ? `${reviewReason} ${gate.reason}` : reviewReason,
		});
		this.#last = {
			outcome,
			confidence: decision.confidence,
			margin: decision.margin,
			...(gate.reason ? { reason: gate.reason } : {}),
			reviewRequired,
			review: decision.review,
			at: Date.now(),
		};
		if (outcome === "ORCHESTRATE") {
			turn.orchestrated = true;
			turn.noticeAnchor = todoToolCallId;
		}
		this.#notify(ctx, turn, reviewRequired, checkpoint, outcome === "ORCHESTRATE" ? "orchestrate" : reviewReason,
			phases ? "CONTINUE" : decision.workScope ?? "NEW");
	}

	/** One bounded Jev request; failures are recorded here. Undefined once the turn is superseded. */
	async #classify(turn: TurnState, phases?: readonly TodoPhase[]): Promise<Classification | undefined> {
		const config = this.#deps.config();
		const apiKey = await this.#deps.credential();
		if (this.#turn !== turn) return undefined;
		if (!apiKey) {
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "credential-missing" });
			this.#last = { outcome: "SKIP", reason: "credential-missing", reviewRequired: true, at: Date.now() };
			return { ok: false, reason: "credential-missing" };
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
			return { ok: true, decision };
		} catch (error) {
			if (this.#turn !== turn) return undefined;
			const reason = this.#deps.logger.describeError(error);
			const timedOut = /timeout|abort/i.test(reason);
			this.#deps.telemetry.recordFailure("orchestration", timedOut);
			this.#deps.telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut });
			this.#deps.logger.route("jev.orchestration", { route: "ERROR", reason });
			this.#last = { outcome: "ERROR", reason, reviewRequired: true, at: Date.now() };
			return { ok: false, reason: timedOut ? "classification-timeout" : "classification-error" };
		}
	}

	/** Handler failures propagate: an unrecorded requirement fails its hook rather than passing as reviewed. */
	#notify(ctx: ExtensionContext, turn: TurnState, required: boolean, checkpoint: ReviewCheckpoint, reason: string, workScope = "CONTINUE"): void {
		if (required) turn.reviewRequired = true;
		const inherited = this.#deps.onReviewDecision?.(ctx, required, checkpoint, reason, turn.prompt, workScope);
		if (inherited === true) turn.reviewRequired = true;
	}
}
