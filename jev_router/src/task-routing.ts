/**
 * TASK tier router.
 *
 * OMP decides whether to spawn a generic worker; this router only selects
 * its easy, hard, or challenge model role via derived worker aliases.
 * Specialists, explicit agents, and custom generic overrides pass untouched.
 *
 * Two facts make this exact rather than heuristic:
 *
 *  - `tool_call` fires from the agent loop's prepare phase with **validated**
 *    arguments (`prepareToolCallDispatch` in `pi-agent-core/src/agent-loop.ts`
 *    passes `effectiveArgs`), and the task schema declares
 *    `agent: "string = '<spawn-policy default>'"`. So `input.agent` is always
 *    the session's authoritative effective agent — no need to re-derive the
 *    default, and a restricted session whose default is `sonic` never looks
 *    like a generic task spawn.
 *  - The task tool advertises exactly the agents the live spawn policy allows,
 *    so routing only to an advertised alias cannot produce a preflight denial.
 *
 * A `task.batch` call is classified in one Jev request, and every field other
 * than `agent` is preserved verbatim.
 */
import type { ExtensionAPI, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { JevRouterConfig } from "./config.ts";
import { CHALLENGE_AGENT_NAME, EASY_AGENT_NAME, HARD_AGENT_NAME } from "./deep-agent.ts";
import { spawnableTaskAgents } from "./host.ts";
import { clip, type JevDecider, type TaskRoute } from "./jev.ts";
import type { RouteLogger } from "./logging.ts";
import type { Telemetry } from "./telemetry.ts";

/** The bundled generic worker. Anything else is a deliberate agent choice. */
export const GENERIC_TASK_AGENT = "task";

const MAX_DEDUPE_ENTRIES = 256;

export interface TaskRouteRecord {
	route: TaskRoute;
	confidence: number;
	margin: number;
	confident: boolean;
	at: number;
}

interface RoutableItem {
	index: number;
	instruction: string;
}

export interface NormalizedCall {
	batch: boolean;
	context?: string;
	items: Record<string, unknown>[];
}

/** Split a `task` tool input into its item list without losing any field. */
export function normalizeCall(input: Record<string, unknown>): NormalizedCall | undefined {
	const tasks = input.tasks;
	if (Array.isArray(tasks)) {
		const items = tasks.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
		if (items.length === 0 || items.length !== tasks.length) return undefined;
		return { batch: true, context: typeof input.context === "string" ? input.context : undefined, items };
	}
	if (typeof input.task === "string") return { batch: false, items: [input] };
	return undefined;
}

/**
 * Items eligible for tier routing: an explicit, validated `agent` naming the
 * generic worker and a non-empty instruction. An absent `agent` means the
 * arguments did not pass through the task schema (a direct internal dispatch),
 * so the effective default is unknown and the item is left native.
 */
export function routableItems(items: readonly Record<string, unknown>[]): RoutableItem[] {
	const routable: RoutableItem[] = [];
	for (const [index, item] of items.entries()) {
		if (typeof item.agent !== "string" || item.agent.trim() !== GENERIC_TASK_AGENT) continue;
		const instruction = typeof item.task === "string" ? item.task : "";
		if (!instruction.trim()) continue;
		routable.push({ index, instruction });
	}
	return routable;
}

export interface TaskRouterDeps {
	engine: JevDecider;
	logger: RouteLogger;
	telemetry: Telemetry;
	credential: () => Promise<string | undefined>;
	config: () => JevRouterConfig;
	/** False when a project/user/plugin agent shadows the bundled `task` definition. */
	genericTaskIsBundled: () => boolean;
	/** Optional bounded task context from the active branch (including its plan). */
	routingContext?: () => string | undefined;
	/** Successfully materialized aliases; excludes stale read-only definitions. */
	availableTierAgents?: () => ReadonlySet<string>;
}

export class TaskRouter {
	#seen = new Map<string, ToolCallEventResult | undefined>();
	#last: TaskRouteRecord | undefined;
	readonly #deps: TaskRouterDeps;

	constructor(deps: TaskRouterDeps) {
		this.#deps = deps;
	}

	get lastDecision(): TaskRouteRecord | undefined {
		return this.#last;
	}

	/** Tier for each generic-task item in one `task` call, or `undefined` to leave it native. */
	async route(
		pi: ExtensionAPI,
		toolCallId: string,
		input: Record<string, unknown>,
	): Promise<ToolCallEventResult | undefined> {
		if (this.#seen.has(toolCallId)) return this.#seen.get(toolCallId);
		const result = await this.#routeUncached(pi, input);
		this.#remember(toolCallId, result);
		return result;
	}

	#remember(toolCallId: string, result: ToolCallEventResult | undefined): void {
		this.#seen.set(toolCallId, result);
		if (this.#seen.size <= MAX_DEDUPE_ENTRIES) return;
		const oldest = this.#seen.keys().next();
		if (!oldest.done) this.#seen.delete(oldest.value);
	}

	async #routeUncached(pi: ExtensionAPI, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> {
		const config = this.#deps.config();
		if (!config.enabled || !config.taskRoutingEnabled) return undefined;
		if (!this.#deps.genericTaskIsBundled()) {
			this.#deps.logger.route("jev.task", { route: "SKIP", reason: "generic-task-overridden" });
			return undefined;
		}

		const call = normalizeCall(input);
		if (!call) return undefined;
		const routable = routableItems(call.items);
		if (routable.length === 0) {
			this.#deps.logger.route("jev.task", { route: "SKIP", reason: "no-generic-task-items" });
			return undefined;
		}

		// An unavailable or stale alias is never sent to spawn preflight.
		const spawnable = spawnableTaskAgents(pi);
		const available = this.#deps.availableTierAgents?.();
		const targets: Record<TaskRoute, string> = {
			TASK_EASY: EASY_AGENT_NAME,
			TASK_HARD: HARD_AGENT_NAME,
			TASK_CHALLENGE: CHALLENGE_AGENT_NAME,
		};
		if (!spawnable.has(CHALLENGE_AGENT_NAME) || (available && !available.has(CHALLENGE_AGENT_NAME))) {
			this.#deps.logger.route("jev.task", { route: "SKIP", reason: "challenge-alias-unspawnable" });
			return undefined;
		}

		const routes = await this.#classify(routable, call.context, config);
		let changed = false;
		const items = call.items.map((item, index) => {
			const route = routes.get(index);
			if (!route) return item;
			const target = targets[route];
			if (!spawnable.has(target) || (available && !available.has(target))) return item;
			this.#deps.telemetry.recordSpawn(target);
			if (target === item.agent) return item;
			changed = true;
			return { ...item, agent: target };
		});
		if (!changed) return undefined;

		return { input: call.batch ? { ...input, tasks: items } : (items[0] ?? input) };
	}

	/** One Jev request for the whole call; failures degrade every item to TASK_CHALLENGE. */
	async #classify(
		routable: readonly RoutableItem[],
		sharedContext: string | undefined,
		config: JevRouterConfig,
	): Promise<Map<number, TaskRoute>> {
		const routes = new Map<number, TaskRoute>();
		try {
			const apiKey = await this.#deps.credential();
			if (!apiKey) {
				this.#deps.logger.route("jev.task", {
					route: "TASK_CHALLENGE",
					reason: "credential-missing",
					items: routable.length,
				});
				for (const item of routable) routes.set(item.index, "TASK_CHALLENGE");
				return routes;
			}

			const extraContext = this.#deps.routingContext?.();
			const sharedBudget = Math.floor(config.maxRoutingInputChars / 3);
			const halfBudget = Math.max(0, Math.floor((sharedBudget - 2) / 2));
			const context = extraContext
				? sharedContext
					? `${clip(sharedContext, halfBudget)}\n\n${clip(extraContext, halfBudget)}`
					: extraContext
				: sharedContext;
			const batch = await this.#deps.engine.decideTaskTiers(
				routable.map(item => ({ id: `t${item.index}`, instruction: item.instruction })),
				context,
				{ apiKey, model: config.jevModel, timeoutMs: config.routingTimeoutMs },
				{ minConfidence: config.taskMinConfidence, minMargin: config.taskMinMargin },
				config.maxRoutingInputChars,
			);
			this.#deps.telemetry.recordTaskBatch(batch.latencyMs);
			for (const decision of batch.decisions) {
				if (!/^t\d+$/.test(decision.id)) continue;
				const index = Number(decision.id.slice(1));
				if (!routable.some(item => item.index === index)) continue;
				// Uncertainty fails quality-safe: a wrong cheap worker costs a retry,
				// which is more expensive than one stronger run.
				const route: TaskRoute = decision.confident ? decision.top : "TASK_CHALLENGE";
				routes.set(index, route);
				this.#deps.telemetry.recordTaskDecision(route, decision.confidence, decision.margin, decision.confident);
				this.#deps.telemetry.appendDecision({
					kind: "task",
					route,
					top: decision.top,
					probabilities: decision.probabilities,
					confidence: decision.confidence,
					margin: decision.margin,
					confident: decision.confident,
					latencyMs: batch.latencyMs,
					batchSize: routable.length,
				});
				this.#last = {
					route,
					confidence: decision.confidence,
					margin: decision.margin,
					confident: decision.confident,
					at: Date.now(),
				};
				this.#deps.logger.route("jev.task", {
					route,
					confidence: decision.confidence,
					margin: decision.margin,
					latencyMs: batch.latencyMs,
					...(decision.confident ? {} : { reason: "below-gate" }),
				});
			}
			for (const item of routable) {
				if (!routes.has(item.index)) routes.set(item.index, "TASK_CHALLENGE");
			}
			return routes;
		} catch (error) {
			const reason = this.#deps.logger.describeError(error);
			const timedOut = /timeout|abort/i.test(reason);
			this.#deps.telemetry.recordFailure("task", timedOut);
			this.#deps.telemetry.appendDecision({ kind: "task", route: "ERROR", timedOut, items: routable.length });
			this.#deps.logger.route("jev.task", { route: "TASK_CHALLENGE", reason, items: routable.length });
			this.#last = { route: "TASK_CHALLENGE", confidence: 0, margin: 0, confident: false, at: Date.now() };
			for (const item of routable) routes.set(item.index, "TASK_CHALLENGE");
			return routes;
		}
	}
}
