/**
 * Keeps this plugin's execution policy in front of the main model without breaking the
 * provider's prompt cache.
 *
 * The policy is one element appended to the main session's system prompt (`before_agent_start`).
 * The system prompt opens every request, so the element is part of the cached prefix. It is decided
 * by session facts alone (plugin enabled, main session, not plan mode, `task` enabled) and by the
 * tools and settings its text names, never by the prompt: user, steering and synthetic prompts
 * (auto-continue, kickoffs, retries) all get the same system prompt, so it does not flip from turn to
 * turn. Nothing enters the transcript. No network call, credential lookup or model call is made, and
 * tools, permissions and the primary model are never changed.
 *
 * OMP applies the returned prompt as a per-turn override and leaves it on the agent when the turn
 * ends (`SessionTools.clearTurnSystemPromptOverride` only drops the override flag), so a turn that
 * starts without `before_agent_start` (an async task result or a worker message reaching an idle main)
 * runs with the same system prompt. Known limit: a rebuild of the base prompt between turns (a tool
 * roster or skill change) resets the agent to the plain base until the next prompt applies the policy
 * again; such a rebuild changes the request prefix anyway.
 *
 * The `context` hook leaves the transcript alone apart from rewrites that depend on one message only,
 * so they repeat identically in every later request and never move a reusable prefix:
 *   - a native `orchestrate` notice gives way to this plugin's counterpart (dropped when the same
 *     keyword prefix carries a `workflow` notice, which keeps choosing the execution method), and a
 *     native `workflow` notice is followed by the plugin's supplement. `before_agent_start` cannot do
 *     this: it sees only the prompt text, never the keyword notices OMP builds from it;
 *   - notices earlier builds persisted under this plugin's type (mode `default`) are dropped, always.
 * When the plugin does not govern the request (disabled, subagent, plan mode) it withholds every one
 * of its own messages and leaves OMP's native notices as OMP built them.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, CustomMessage, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { cfgTaskEnableEffort } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { OrcheConfig } from "./config.ts";
import { mainSessionOf } from "./host.ts";
import type { RouteLogger } from "./logging.ts";
import {
	buildKeywordNotice,
	isPolicySection,
	type KeywordMode,
	NATIVE_ORCHESTRATE_NOTICE_TYPE,
	NATIVE_WORKFLOW_NOTICE_TYPE,
	POLICY_NOTICE_TYPE,
	type PolicyContext,
	type PolicyMode,
	policyModeOf,
	prefixHas,
	renderPolicy,
} from "./orchestration-policy.ts";
import { observePolicyExposure } from "./policy-exposure.ts";

type Gate =
	| { ok: true; session: AgentSession }
	| { ok: false; reason: string };

/** Everything that decides whether the plugin governs a request: the master switch, session identity and plan mode. */
function gateSession(ctx: ExtensionContext, config: OrcheConfig): Gate {
	if (!config.enabled) return { ok: false, reason: "disabled" };

	// Recursion guard: a subagent must never re-enter the front door.
	const session = mainSessionOf(ctx);
	if (!session) return { ok: false, reason: "not-main-session" };
	if (session.getPlanModeState?.()?.enabled === true) return { ok: false, reason: "plan-mode" };
	return { ok: true, session };
}

function policyContext(session: AgentSession): PolicyContext {
	return { tools: session.getEnabledToolNames(), effort: cfgTaskEnableEffort.get(session.settings) };
}

function isKeywordMode(mode: PolicyMode | undefined): mode is KeywordMode {
	return mode === "orchestrate" || mode === "workflow";
}

export interface OrchestrationRouterDeps {
	logger: RouteLogger;
	config: () => OrcheConfig;
}

export class OrchestrationRouter {
	readonly #deps: OrchestrationRouterDeps;
	/** Keyword notices whose counterpart is already logged: one debug line per notice. */
	readonly #logged = new Set<string>();

	constructor(deps: OrchestrationRouterDeps) {
		this.#deps = deps;
	}

	/**
	 * `systemPrompt` with the execution policy appended, or `undefined` where the plugin stays out
	 * and the prompt is left as it is. Called for every prompt that reaches `before_agent_start`.
	 */
	withPolicy(ctx: ExtensionContext, systemPrompt: readonly string[]): string[] | undefined {
		const gate = gateSession(ctx, this.#deps.config());
		if (!gate.ok) {
			this.#deps.logger.policy({ skip: gate.reason });
			return undefined;
		}
		const context = policyContext(gate.session);
		if (!context.tools.includes("task")) {
			this.#deps.logger.policy({ skip: "task-tool-unavailable" });
			return undefined;
		}
		// Another copy of this plugin (or an earlier attempt) already added it: never twice.
		if (systemPrompt.some(isPolicySection)) return undefined;
		this.#deps.logger.policy({ mode: "default" });
		return [...systemPrompt, renderPolicy(context)];
	}

	/**
	 * Return the provider-context view of `messages`, or `undefined` when nothing changes. Where the
	 * plugin governs the request, each native `orchestrate` notice is replaced and each native
	 * `workflow` notice supplemented (see the module comment); otherwise this plugin's messages are
	 * withheld. No message object is mutated.
	 */
	applyToContext(ctx: ExtensionContext, messages: AgentMessage[]): AgentMessage[] | undefined {
		const gate = gateSession(ctx, this.#deps.config());
		const context = gate.ok ? policyContext(gate.session) : undefined;
		// What this very request carries decides how much a supplement has to say itself.
		const policyInPrompt = context !== undefined && ctx.getSystemPrompt().some(isPolicySection);
		const next: AgentMessage[] = [];
		let changed = false;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]!;
			if (message.role === "custom" && message.customType === POLICY_NOTICE_TYPE) {
				// A counterpart an earlier copy of this hook made stays while the plugin governs; whatever else
				// carries the type is what earlier builds persisted.
				if (context && isKeywordMode(policyModeOf(message))) next.push(message);
				else changed = true;
				continue;
			}
			if (!context) {
				next.push(message);
				continue;
			}
			if (message.role === "custom" && message.customType === NATIVE_ORCHESTRATE_NOTICE_TYPE) {
				// The native and plugin policies are never shown together.
				changed = true;
				if (!prefixHas(messages, index, NATIVE_WORKFLOW_NOTICE_TYPE)) {
					next.push(this.#keywordNotice("orchestrate", message, context, policyInPrompt));
				}
				continue;
			}
			next.push(message);
			if (message.role === "custom" && message.customType === NATIVE_WORKFLOW_NOTICE_TYPE &&
				policyModeOf(messages[index + 1]) !== "workflow") {
				next.push(this.#keywordNotice("workflow", message, context, policyInPrompt));
				changed = true;
			}
		}
		// Observe this hook's view, including autonomous continuations and residual system policy
		// after gate changes. This is not provider delivery; subsequent hooks may change the view.
		const session = this.#deps.config().enabled ? mainSessionOf(ctx) : undefined;
		if (session) {
			const governance = !gate.ok ? "plan-mode" :
				context!.tools.includes("task") ? "governed" : "task-tool-unavailable";
			observePolicyExposure(ctx, session, governance, changed ? next : messages);
		}
		return changed ? next : undefined;
	}

	#keywordNotice(mode: KeywordMode, native: CustomMessage, context: PolicyContext, policyInPrompt: boolean): AgentMessage {
		const key = `${native.customType}\u0000${native.timestamp}`;
		if (!this.#logged.has(key)) {
			this.#logged.add(key);
			this.#deps.logger.policy({ mode });
		}
		return buildKeywordNotice(mode, context, policyInPrompt, native);
	}
}
