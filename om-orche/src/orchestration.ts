/**
 * Attaches this plugin's execution policy to governed main-session turns.
 *
 * Exactly one provider-context-only policy notice is chosen per turn, without any
 * network call, credential lookup or todo-triggered reclassification:
 *   1. the current turn's native workflow notice   -> `workflow` (supplement only);
 *   2. else its native orchestrate notice          -> `orchestrate` (replaces it in place);
 *   3. else the `task` tool is enabled             -> `default` (Judgment/Production policy);
 *   4. else                                        -> no notice.
 * The policy of the last governed user turn stays in force for the autonomous turns that
 * follow it (OMP starts them without `before_agent_start` when a worker result or message
 * arrives on an idle session) until the next user turn replaces or clears it.
 * Notices are never persisted and history is never mutated; tools, permissions
 * and the primary model are never changed.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { OrcheConfig } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import type { RouteLogger } from "./logging.ts";
import {
	buildPolicyNotice,
	currentTurnNotices,
	isTurnStartEntry,
	isTurnUserMessage,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	policyModeOf,
	type PolicyMode,
} from "./orchestration-policy.ts";

/** Identifies one persisted native notice even after later user messages move it out of the turn prefix. */
function noticeKey(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== NATIVE_ORCHESTRATE_NOTICE_TYPE) return undefined;
	return `${message.timestamp}\u0000${JSON.stringify(message.content)}`;
}

/** The notice precedes the current user message; end of context when that message was compacted away. */
function noticeInsertIndex(messages: readonly AgentMessage[]): number {
	let userIndex = messages.length - 1;
	while (userIndex >= 0 && !isTurnUserMessage(messages[userIndex])) userIndex--;
	return userIndex < 0 ? messages.length : userIndex;
}

type Gate =
	| { ok: true; session: AgentSession }
	| { ok: false; reason: string };

/** Everything that decides whether the plugin governs this request, from the prompt and session alone. */
export function gateRequest(ctx: ExtensionContext, prompt: string, config: OrcheConfig): Gate {
	if (!config.enabled) return { ok: false, reason: "disabled" };

	// Recursion guard: a subagent must never re-enter the front door.
	const session = mainSessionOf(ctx);
	if (!session) return { ok: false, reason: "not-main-session" };

	const text = prompt.trim();
	if (!text) return { ok: false, reason: "empty-prompt" };
	// Commands never reach `before_agent_start`: extension and custom commands run inside
	// `AgentSession.prompt` (agent-session.ts `#dispatchPrompt`) and built-ins in the interactive
	// input controller. A prompt still starting with "/" is text OMP hands the model (an unknown
	// command, a path), so it is an ordinary request.
	if (text.startsWith("<system-")) return { ok: false, reason: "synthetic-notice" };
	if (session.getPlanModeState?.()?.enabled === true) return { ok: false, reason: "plan-mode" };
	return { ok: true, session };
}

export interface OrchestrationRouterDeps {
	logger: RouteLogger;
	config: () => OrcheConfig;
}

interface TurnState {
	prompt: string;
	session: AgentSession;
	/** Last committed user entry before preparation; retries precede delivery of the new input. */
	preparedAfterUserId: string | undefined;
	/** Keys of this turn's native orchestrate notices, replaced wherever they appear. */
	natives: string[];
	/** OMP's workflow notice was seen in this turn; it governs execution for the rest of the turn. */
	workflow: boolean;
	/** One stable notice per policy mode, created on first use and reused on every request. */
	notices: Partial<Record<PolicyMode, AgentMessage>>;
	/** The last mode logged for this turn (`none` when no notice applied). */
	logged: PolicyMode | "none" | undefined;
}

export class OrchestrationRouter {
	#turn: TurnState | undefined;
	/** The latest governed prompt while it is unconfirmed as a user turn, with the turn it displaced. */
	#pending: { prompt: string; previous: TurnState | undefined } | undefined;
	readonly #deps: OrchestrationRouterDeps;

	constructor(deps: OrchestrationRouterDeps) {
		this.#deps = deps;
	}

	/**
	 * Gate before delivery. A governed prompt starts a new turn (only a retry prepared after the
	 * same committed turn-starting entry reuses one) unless the first request shows it to be a
	 * synthetic prompt (`#settle`); a gated user prompt clears the turn. A synthetic `<system-…`
	 * prompt or a call from another session belongs to no user request: it keeps the ongoing turn,
	 * whose policy also covers autonomous continuations (worker results, worker messages).
	 */
	beginTurn(ctx: ExtensionContext, prompt: string): void {
		const gate = gateRequest(ctx, prompt, this.#deps.config());
		if (!gate.ok) {
			if (gate.reason !== "synthetic-notice" && gate.reason !== "not-main-session") {
				this.#turn = undefined;
				this.#pending = undefined;
			}
			this.#deps.logger.policy({ skip: gate.reason });
			return;
		}
		const preparedAfterUserId = gate.session.sessionManager.getBranch().findLast(isTurnStartEntry)?.id;
		if (this.#turn?.prompt === prompt && this.#turn.session === gate.session &&
			this.#turn.preparedAfterUserId === preparedAfterUserId) return;
		// `before_agent_start` does not say who authored the prompt, so the new turn is provisional
		// until the first request shows the delivered message (see `#settle`).
		this.#pending = {
			prompt,
			previous: this.#pending?.prompt === prompt ? this.#pending.previous : this.#turn,
		};
		this.#turn = {
			prompt, session: gate.session, preparedAfterUserId,
			natives: [], workflow: false, notices: {}, logged: undefined,
		};
	}

	/** Forget the turn, e.g. when the session it belongs to is replaced. */
	resetTurn(): void {
		this.#turn = undefined;
		this.#pending = undefined;
	}

	/**
	 * A prompt that reached `before_agent_start` is synthetic when the message delivered for it,
	 * the newest one whose text is the prompt, is not a turn-starting one (OMP's auto-continue after
	 * compaction, plan-approved, manual-continue and guided-goal prompts are agent-attributed
	 * `developer` messages; hidden next-turn prompts are agent-attributed custom ones). Such a
	 * prompt belongs to no user request: the turn it displaced continues. Anything else, including a
	 * batch of queued user messages whose joined text matches no single message, starts the turn.
	 */
	#settle(messages: readonly AgentMessage[]): void {
		const pending = this.#pending;
		if (!pending) return;
		this.#pending = undefined;
		const delivered = messages.findLast(message => {
			if (message.role !== "user" && message.role !== "developer" && message.role !== "custom") return false;
			const text = typeof message.content === "string"
				? message.content
				: message.content.map(part => part.type === "text" ? part.text : "").join("");
			return text === pending.prompt;
		});
		if (delivered && !isTurnUserMessage(delivered)) this.#turn = pending.previous;
	}

	/**
	 * Return a provider-context copy carrying exactly one policy notice for this
	 * turn, or `undefined` when nothing changes. This turn's native orchestrate
	 * notices are replaced in place; historical turns, the workflow notice and
	 * other messages are left untouched, and no message object is mutated.
	 */
	applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): AgentMessage[] | undefined {
		if (mainSessionOf(ctx)) this.#settle(messages);
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

		const tools = turn.session.getEnabledToolNames();
		const mode: PolicyMode | undefined = turn.workflow
			? "workflow"
			: turn.natives.length > 0
				? "orchestrate"
				: tools.includes("task") ? "default" : undefined;
		if (turn.logged !== (mode ?? "none")) {
			turn.logged = mode ?? "none";
			this.#deps.logger.policy(mode ? { mode } : { skip: "task-tool-unavailable" });
		}

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
				} else changed = true; // A duplicate, or a mode the turn no longer uses.
				continue;
			}
			next.push(message);
		}
		if (notice && !placed) {
			next.splice(noticeInsertIndex(next), 0, notice);
			changed = true;
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
}
