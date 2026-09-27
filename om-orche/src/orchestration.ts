/**
 * Front-door routing chooses whether to attach this plugin's orchestration policy.
 * A successful todo init/append can promote a direct turn after its committed
 * plan reveals independent work. Once a turn is orchestrated its route is final,
 * so a changed plan triggers no further Jev request. Without a decision (no
 * credential, failed request) the turn keeps the DEFAULT guidance.
 *
 * Guidance precedence for the current turn: OMP's workflow notice, then OMP's
 * explicit orchestrate notice, then an automatic ORCHESTRATE route, then DEFAULT.
 * The explicit notice is replaced in place by this plugin's policy notice; the
 * workflow notice is kept and only receives an auxiliary supplement. Notices are
 * provider-context only: history is never persisted or mutated, and the primary
 * model never changes.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { JevRouterConfig } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import type { JevDecider, OrchestrationDecision, OrchestrationRoute } from "./jev.ts";
import type { RouteLogger } from "./logging.ts";
import {
	buildPolicyNotice,
	currentTurnNotices,
	isTurnUserMessage,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	policyModeOf,
	type PolicyMode,
} from "./orchestration-policy.ts";
import { buildRoutingContext, formatTodoPlan, isTodoPlan, latestCommittedTodoPlan, visibleText } from "./routing-context.ts";
import type { Telemetry } from "./telemetry.ts";

export type OrchestrationOutcome = OrchestrationRoute | "SKIP" | "ERROR";

export interface OrchestrationRecord {
	outcome: OrchestrationOutcome;
	confidence?: number;
	margin?: number;
	reason?: string;
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
	while (userIndex >= 0 && !isTurnUserMessage(messages[userIndex])) userIndex--;
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

/**
 * Match the assistant's actual todo call to this user's turn. A late result
 * from a prior turn must not act on the next request, even in one session.
 * Agent-injected steering does not refresh before_agent_start; real user
 * steering does, so only the former is skipped when finding the turn boundary.
 */
function turnOwnsTodoCall(session: AgentSession, prompt: string, toolCallId: string): boolean {
	const branch = session.sessionManager.getBranch();
	let userIndex = branch.length - 1;
	while (userIndex >= 0) {
		const entry = branch[userIndex];
		if (entry?.type === "message" && isTurnUserMessage(entry.message)) break;
		userIndex--;
	}
	const currentUser = branch[userIndex];
	if (currentUser?.type !== "message" || currentUser.message.role !== "user" ||
		visibleText(currentUser.message.content) !== prompt.trim()) return false;
	return branch.slice(userIndex + 1).some(entry => entry.type === "message" &&
		entry.message.role === "assistant" && entry.message.content.some(part =>
			part.type === "toolCall" && part.id === toolCallId && part.name === "todo"));
}

/** `orchestrationAllowed` only governs automatic promotion; an explicit native request is handled regardless. */
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
	/** Last committed user entry before preparation; retries precede delivery of the new input. */
	preparedAfterUserId: string | undefined;
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
	/** The promotion result reached provider context; compaction must not make us await it again. */
	noticeAnchorSeen: boolean;
	/** One stable notice per policy mode, created on first use and reused on every request. */
	notices: Partial<Record<PolicyMode, AgentMessage>>;
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

	/** Decide before delivery; reuse only retries prepared after the same committed user entry. */
	async beginTurn(ctx: ExtensionContext, prompt: string): Promise<void> {
		const gate = gateRequest(ctx, prompt, this.#deps.config());
		if (!gate.ok) {
			this.#turn = undefined;
			this.#last = { outcome: "SKIP", reason: gate.reason, at: Date.now() };
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: gate.reason });
			return;
		}
		const branch = gate.session.sessionManager.getBranch();
		const preparedAfterUserId = branch.findLast(entry =>
			entry.type === "message" && isTurnUserMessage(entry.message))?.id;
		if (this.#turn?.prompt === prompt && this.#turn.session === gate.session &&
			this.#turn.preparedAfterUserId === preparedAfterUserId) {
			await this.#turn.pending;
			return;
		}
		const priorPlan = latestCommittedTodoPlan(branch);
		const turn: TurnState = {
			prompt, session: gate.session, preparedAfterUserId,
			explicitLogged: false, natives: [], workflow: false, orchestrated: false, notices: {},
			noticeAnchorSeen: false,
			seenPlans: new Set(priorPlan ? [JSON.stringify(priorPlan)] : []),
		};
		this.#turn = turn;
		const decided = this.#decide(ctx, turn);
		turn.pending = decided.catch(() => undefined);
		await decided;
	}

	/** Called when the agent loop settles: never change the user's chosen model. */
	endTurn(): void {
		this.#turn = undefined;
	}

	/**
	 * Act only on successful committed results of this turn's own todo calls: a new
	 * plan from init/append is reclassified unless the turn is already orchestrated.
	 * An unchanged plan and other todo ops are ignored.
	 */
	async onTodoResult(ctx: ExtensionContext, event: ToolResultEvent): Promise<void> {
		const turn = this.#turn;
		if (!turn || turn.session !== mainSessionOf(ctx) ||
			!gateRequest(ctx, turn.prompt, this.#deps.config()).ok ||
			event.toolName !== "todo" || event.isError) return;
		const details = event.details as { op?: unknown; phases?: unknown } | undefined;
		const op = details?.op;
		const phases = details?.phases;
		if ((op !== "init" && op !== "append") || op !== event.input.op || !isTodoPlan(phases) ||
			!turnOwnsTodoCall(turn.session, turn.prompt, event.toolCallId)) return;
		const fingerprint = JSON.stringify(phases);
		if (turn.seenPlans.has(fingerprint)) return;
		turn.seenPlans.add(fingerprint);
		const run = (turn.pending ?? Promise.resolve()).then(async () => {
			if (this.#turn !== turn || !gateRequest(ctx, turn.prompt, this.#deps.config()).ok) return;
			await this.#decide(ctx, turn, phases, event.toolCallId);
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
			let index = noticeInsertIndex(next, anchor);
			if (anchor && index >= 0) turn.noticeAnchorSeen = true;
			// Once delivered, restore the stable policy even if compaction removed its result.
			if (index < 0 && turn.noticeAnchorSeen) index = noticeInsertIndex(next);
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
		phases?: readonly TodoPhase[],
		todoToolCallId?: string,
	): Promise<void> {
		// An orchestrated route is final for the turn; this includes native guidance seen meanwhile.
		if (this.#turn !== turn || turn.orchestrated || turn.explicitLogged) return;
		const decision = await this.#classify(turn, phases);
		if (!decision || this.#turn !== turn || turn.orchestrated || turn.explicitLogged) return;
		const gate = gateRequest(ctx, turn.prompt, this.#deps.config());
		if (!gate.ok) return;
		// Unavailable orchestration withholds the route; the turn keeps DEFAULT guidance.
		const outcome: OrchestrationRoute = decision.confident && gate.orchestrationAllowed ? decision.top : "DEFAULT";
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
			...(gate.reason ? { reason: gate.reason } : {}),
		});
		this.#last = {
			outcome,
			confidence: decision.confidence,
			margin: decision.margin,
			...(gate.reason ? { reason: gate.reason } : {}),
			at: Date.now(),
		};
		if (outcome === "ORCHESTRATE") {
			turn.orchestrated = true;
			turn.noticeAnchor = todoToolCallId;
		}
	}

	/** One bounded Jev request; failures are recorded here. Undefined when none exists or the turn is superseded. */
	async #classify(turn: TurnState, phases?: readonly TodoPhase[]): Promise<OrchestrationDecision | undefined> {
		const config = this.#deps.config();
		const apiKey = await this.#deps.credential();
		if (this.#turn !== turn) return undefined;
		if (!apiKey) {
			this.#deps.logger.route("jev.orchestration", { route: "SKIP", reason: "credential-missing" });
			this.#last = { outcome: "SKIP", reason: "credential-missing", at: Date.now() };
			return undefined;
		}
		try {
			const context = buildRoutingContext(turn.session.sessionManager.getBranch(), turn.prompt);
			if (phases) context.plan = formatTodoPlan(phases);
			return await this.#deps.engine.decideOrchestration(
				turn.prompt,
				context,
				{ apiKey, model: config.jevModel, timeoutMs: config.routingTimeoutMs },
				{ minConfidence: config.orchestrationMinConfidence, minMargin: config.orchestrationMinMargin },
				config.maxRoutingInputChars,
			);
		} catch (error) {
			if (this.#turn !== turn) return undefined;
			const reason = this.#deps.logger.describeError(error);
			const timedOut = /timeout|abort/i.test(reason);
			this.#deps.telemetry.recordFailure("orchestration", timedOut);
			this.#deps.telemetry.appendDecision({ kind: "orchestration", route: "ERROR", timedOut });
			this.#deps.logger.route("jev.orchestration", { route: "ERROR", reason });
			this.#last = { outcome: "ERROR", reason, at: Date.now() };
			return undefined;
		}
	}
}
