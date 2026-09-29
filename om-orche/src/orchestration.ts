/**
 * Keeps this plugin's execution policy in front of the main model without breaking the
 * provider's prompt cache.
 *
 * The policy is a hidden custom message OMP persists with the prompt that needs it
 * (`before_agent_start`). It is state of the conversation, not of one request: the latest
 * notice still in the model's context governs, so a new one is persisted only when none is left
 * (compaction summarized it away) or the tools it was rendered for changed. Persisted history is
 * append-only, so each request's context extends the previous one byte for byte. No network call,
 * credential lookup or model call is made, and tools, permissions and the primary model are never
 * changed.
 *
 * The `context` hook does not edit that history, apart from changes that leave a reusable prefix
 * alone:
 *   - rewrites that depend on one message only, so they repeat identically in every later request:
 *     a native `orchestrate` notice gives way to this plugin's policy (it is dropped when the same
 *     keyword prefix carries a `workflow` notice, which keeps choosing the execution method), and a
 *     native `workflow` notice is followed by the plugin's supplement. Neither can be persisted with
 *     the prompt: `before_agent_start` sees only the prompt text, never the keyword notices OMP
 *     builds from it, and cannot tell a user's prompt from a synthetic one;
 *   - the notice itself, appended after the last message when compaction removed it in the middle of
 *     a run. It is not persisted (the next prompt persists it) and, being last, belongs to no prefix
 *     a later request reuses.
 * The plugin's notices are withheld wherever the plugin does not govern the request: it is disabled,
 * the session is a subagent, or plan mode is on. The `default` policy is withheld too when `task`,
 * the tool it directs work through, is not enabled.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, CustomMessage, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { OrcheConfig } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import type { RouteLogger } from "./logging.ts";
import {
	buildPolicyNotice,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	POLICY_NOTICE_TYPE,
	policyModeOf,
	policyNoticePayload,
	prefixHas,
	type PolicyMode,
	type PolicyNoticePayload,
} from "./orchestration-policy.ts";

type Gate =
	| { ok: true; session: AgentSession }
	| { ok: false; reason: string };

/** What can change between two requests: the master switch, the session's identity and plan mode. */
function gateSession(ctx: ExtensionContext, config: OrcheConfig): Gate {
	if (!config.enabled) return { ok: false, reason: "disabled" };

	// Recursion guard: a subagent must never re-enter the front door.
	const session = mainSessionOf(ctx);
	if (!session) return { ok: false, reason: "not-main-session" };
	if (session.getPlanModeState?.()?.enabled === true) return { ok: false, reason: "plan-mode" };
	return { ok: true, session };
}

/** Everything that decides whether a prompt persists a notice, from the prompt and session alone. */
function gatePrompt(ctx: ExtensionContext, prompt: string, config: OrcheConfig): Gate {
	const gate = gateSession(ctx, config);
	if (!gate.ok) return gate;

	const text = prompt.trim();
	if (!text) return { ok: false, reason: "empty-prompt" };
	// Commands never reach `before_agent_start`: extension and custom commands run inside
	// `AgentSession.prompt` (agent-session.ts `#dispatchPrompt`) and built-ins in the interactive
	// input controller. A prompt still starting with "/" is text OMP hands the model (an unknown
	// command, a path), so it is an ordinary request.
	if (text.startsWith("<system-")) return { ok: false, reason: "synthetic-notice" };
	return gate;
}

export interface OrchestrationRouterDeps {
	logger: RouteLogger;
	config: () => OrcheConfig;
}

export class OrchestrationRouter {
	readonly #deps: OrchestrationRouterDeps;
	/** Keyword notices whose plugin counterpart is already logged: one debug line per notice. */
	readonly #logged = new Set<string>();

	constructor(deps: OrchestrationRouterDeps) {
		this.#deps = deps;
	}

	/**
	 * The hidden notice the prompt about to be delivered must carry into the transcript, or
	 * `undefined` when the model's context already holds the current one. Every prompt gets the
	 * same idempotent check: OMP does not say who authored it, and a synthetic continuation
	 * (auto-continue after compaction, a retry) needs the policy as much as a user's prompt.
	 */
	noticeToPersist(ctx: ExtensionContext, prompt: string): PolicyNoticePayload | undefined {
		const gate = gatePrompt(ctx, prompt, this.#deps.config());
		if (!gate.ok) {
			this.#deps.logger.policy({ skip: gate.reason });
			return undefined;
		}
		const tools = gate.session.getEnabledToolNames();
		if (!tools.includes("task")) {
			this.#deps.logger.policy({ skip: "task-tool-unavailable" });
			return undefined;
		}
		this.#deps.logger.policy({ mode: "default" });

		const notice = policyNoticePayload("default", tools);
		// What the model reads now: compaction has already dropped whatever it summarized.
		const current = gate.session.messages.findLast(message => policyModeOf(message) === "default");
		return current?.role === "custom" && current.content === notice.content ? undefined : notice;
	}

	/**
	 * Return the provider-context view of `messages`, or `undefined` when nothing changes. Where
	 * the plugin governs the request, this is the transcript with each native `orchestrate` notice
	 * replaced and each native `workflow` notice supplemented (see the module comment); otherwise
	 * it is the transcript without this plugin's notices. No message object is mutated.
	 */
	applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): AgentMessage[] | undefined {
		const gate = gateSession(ctx, this.#deps.config());
		if (!gate.ok) {
			const kept = messages.filter(message => !(message.role === "custom" && message.customType === POLICY_NOTICE_TYPE));
			return kept.length === messages.length ? undefined : kept;
		}

		const tools = gate.session.getEnabledToolNames();
		const delegating = tools.includes("task");
		const next: AgentMessage[] = [];
		let policyPresent = false;
		let changed = false;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role === "custom" && message.customType === NATIVE_ORCHESTRATE_NOTICE_TYPE) {
				// The native and plugin policies are never shown together.
				changed = true;
				if (!prefixHas(messages, index, NATIVE_WORKFLOW_NOTICE_TYPE)) {
					next.push(this.#keywordNotice("orchestrate", message, tools));
				}
				continue;
			}
			if (policyModeOf(message) === "default") {
				// Delegation guidance would dangle without the tool it directs work through.
				if (!delegating) {
					changed = true;
					continue;
				}
				policyPresent = true;
			}
			next.push(message);
			if (message.role === "custom" && message.customType === NATIVE_WORKFLOW_NOTICE_TYPE &&
				policyModeOf(messages[index + 1]) !== "workflow") {
				next.push(this.#keywordNotice("workflow", message, tools));
				changed = true;
			}
		}
		if (delegating && !policyPresent) {
			// Compaction removed the persisted notice in the middle of a run, or no prompt has
			// persisted one yet: this request carries a copy at the end. It is attributed like the
			// message it follows, so it never changes who initiated the request (GitHub Copilot's
			// `X-Initiator`, and with it the billing, follows the last message).
			const last = messages.at(-1);
			next.push(buildPolicyNotice("default", tools, last?.timestamp ?? 0, last && "attribution" in last ? last.attribution : undefined));
			changed = true;
		}
		return changed ? next : undefined;
	}

	/** The plugin's counterpart of a native keyword notice, dated and attributed like it. */
	#keywordNotice(mode: PolicyMode, native: CustomMessage, tools: readonly string[]): AgentMessage {
		const key = `${native.customType}\u0000${native.timestamp}`;
		if (!this.#logged.has(key)) {
			this.#logged.add(key);
			this.#deps.logger.policy({ mode });
		}
		return buildPolicyNotice(mode, tools, native.timestamp, native.attribution);
	}
}
