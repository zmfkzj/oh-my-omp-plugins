/**
 * The Jev decision engine.
 *
 * Two bounded decisions, nothing else:
 *   - front door: DEFAULT vs SLOW vs ORCHESTRATE for one user request;
 *   - task tier: TASK_NORMAL vs TASK_DEEP for each generic `task` spawn.
 *
 * Both are TypeSafe `choice` questions over a minimal state. A `task.batch`
 * call is one request carrying one question per item, so a fan-out of six
 * subagents still costs a single Jev call. The front door sends the request and
 * up to two clipped prior user requests to interpret short follow-ups; task
 * routing sends only the subtask instructions and optional shared context.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChoiceQuestion, Questions, SystemOneResult } from "@typesafe-ai/sdk";

export type OrchestrationRoute = "DEFAULT" | "SLOW" | "ORCHESTRATE";
export type TaskRoute = "TASK_NORMAL" | "TASK_DEEP";
export const PRIOR_REQUEST_COUNT = 2;
export const PRIOR_REQUEST_CHARS = 500;

export interface GateOutcome<Label extends string> {
	/** Highest-probability label, regardless of whether the gate accepted it. */
	top: Label;
	/** `max(probabilities)` — the spec's confidence, not the model's own concentration score. */
	confidence: number;
	/** `top1 - top2`. */
	margin: number;
	/** True when both thresholds are met. */
	confident: boolean;
	/** Finite per-label probabilities the gate ranked; empty when Jev returned none. */
	probabilities: Readonly<Record<string, number>>;
}

export interface OrchestrationDecision extends GateOutcome<OrchestrationRoute> {
	latencyMs: number;
}

export interface TaskTierDecision extends GateOutcome<TaskRoute> {
	id: string;
}

export interface TaskTierBatch {
	decisions: TaskTierDecision[];
	latencyMs: number;
}

export interface JevSubtask {
	id: string;
	instruction: string;
}

export interface EngineOptions {
	apiKey: string;
	/** Empty string keeps the SDK default (`jev-latest`) or `TYPESAFE_DEFAULT_MODEL`. */
	model: string;
	timeoutMs: number;
}

const ORCHESTRATION_INSTRUCTIONS =
	"A user has sent `request` to a single, very capable primary coding agent that can read, edit, run commands, and optionally delegate to subagents. `prior_requests`, when present, are the user's previous requests in this session, oldest first; use them only to interpret a short follow-up such as 'do that' or 'continue'. Choose how the primary should handle this request. DEFAULT: execute directly on the standard model. SLOW: execute directly on a markedly stronger, slower, more expensive reasoning model. ORCHESTRATE: split the work across independent parallel subagents. Decide on expected total cost and risk: SLOW only wins when stronger reasoning materially reduces the chance of a wrong call, rework, or repeated attempts; ORCHESTRATE only wins when its benefit exceeds the coordination cost plus the cost of duplicating context into every subagent. Difficulty alone, file count alone, subagent availability alone, and a general preference for parallelism are NOT reasons to orchestrate; length alone is NOT a reason for SLOW.";

const ORCHESTRATION_CRITERIA = {
	DEFAULT:
		"A capable standard model suffices: one coherent code path, clear specification, localized bug fix, single feature, localized refactor, mechanical migration, clear CRUD, well-defined TODO, a question with a direct answer, or a short follow-up continuing already-settled work.",
	SLOW:
		"Stronger reasoning materially lowers the risk of a wrong call on one sequential body of work: root-cause debugging, architecture or design decisions, ambiguous requirements, trade-offs between plausible solutions, cross-module semantic reasoning, concurrency or race conditions, security-sensitive change, state consistency, data-migration reasoning, public API redesign, or a retry of work that already failed.",
	ORCHESTRATE:
		"Two or more genuinely independent workstreams that can run at the same time, each with good context locality in a different subsystem, area, or file set. " +
		"Independent investigation or verification that is actually useful on its own. " +
		"Splitting is clearly better than one agent reading every area.",
} as const;

const TASK_TIER_INSTRUCTIONS_PREFIX =
	"A primary coding agent has already decided to delegate this subtask to a capable coding subagent; that decision is settled and is not in question. " +
	"Choose only the reasoning tier for the subtask identified as ";

const TASK_TIER_INSTRUCTIONS_SUFFIX =
	" in `subtasks`. The question is narrow: would running it on a markedly stronger reasoning model materially reduce the chance of incorrect judgment, rework, or repeated attempts?";

const TASK_TIER_CRITERIA = {
	TASK_NORMAL:
		"A capable coding worker suffices and expensive high-level reasoning is unlikely to reduce rework. " +
		"Implementation of a design the primary agent already settled, a clear specification, a well-scoped feature, localized modification, adapter, clear test addition, " +
		"integration whose API usage is already decided, ordinary refactoring, boilerplate-heavy implementation, mechanical migration, clear CRUD, or a well-defined TODO.",
	TASK_DEEP:
		"Stronger reasoning materially lowers the risk of a wrong call. " +
		"Root-cause debugging, architecture or design decisions, ambiguous requirements, trade-offs between plausible solutions, cross-module semantic reasoning, " +
		"concurrency, race conditions, security-sensitive change, authentication or authorization, state consistency, complex distributed behavior, data-migration reasoning, " +
		"public API redesign, large ambiguous refactor, complex integration failure, work whose success condition must itself be interpreted, or a retry of a subtask a normal worker already failed.",
} as const;

/** Clip text to a character budget, marking the cut so Jev sees the input is partial. */
export function clip(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}\n…[truncated]`;
}

/**
 * Apply the two-threshold gate from the routing spec:
 * `confidence = max(p)` and `margin = p(top1) - p(top2)` must BOTH clear.
 */
export function gate<Label extends string>(
	probabilities: Readonly<Record<string, number>>,
	fallback: Label,
	minConfidence: number,
	minMargin: number,
): GateOutcome<Label> {
	const ranked = Object.entries(probabilities)
		.filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
		.sort((a, b) => b[1] - a[1]);
	const first = ranked[0];
	if (!first) return { top: fallback, confidence: 0, margin: 0, confident: false, probabilities: {} };
	const confidence = first[1];
	const margin = confidence - (ranked[1]?.[1] ?? 0);
	return {
		top: first[0] as Label,
		confidence,
		margin,
		confident: confidence >= minConfidence && margin >= minMargin,
		probabilities: Object.fromEntries(ranked),
	};
}

function choiceQuestion(instructions: string, criteria: Record<string, string>): ChoiceQuestion {
	return { type: "choice", instructions, criteria };
}

export interface GateThresholds {
	minConfidence: number;
	minMargin: number;
}

/** The decision surface the routers depend on; `JevEngine` is the live implementation. */
export interface JevDecider {
	decideOrchestration(
		request: string,
		priorRequests: readonly string[],
		options: EngineOptions,
		gates: GateThresholds,
		maxChars: number,
	): Promise<OrchestrationDecision>;
	decideTaskTiers(
		subtasks: readonly JevSubtask[],
		sharedContext: string | undefined,
		options: EngineOptions,
		gates: GateThresholds,
		maxChars: number,
	): Promise<TaskTierBatch>;
}

/** Owns one TypeSafe client, rebuilt whenever the credential or model changes. */
export class JevEngine implements JevDecider {
	#client: TypeSafeClient | undefined;
	#signature = "";

	/** Rebuild the client if `options` differ from the cached ones. Throws on invalid options. */
	#clientFor(options: EngineOptions): TypeSafeClient {
		const signature = `${options.model}\u0000${options.timeoutMs}\u0000${options.apiKey}`;
		if (this.#client && this.#signature === signature) return this.#client;
		this.#client = new TypeSafeClient({
			apiKey: options.apiKey,
			...(options.model ? { defaultModel: options.model } : {}),
			timeout: options.timeoutMs,
			// One bounded attempt: a router that retries costs more than the routing saves.
			retry: { maxRetries: 0 },
			logLevel: "off",
		});
		this.#signature = signature;
		return this.#client;
	}

	/** Drop the cached client so the next call re-reads the credential. */
	invalidate(): void {
		this.#client = undefined;
		this.#signature = "";
	}

	/** The model id requests actually use. */
	modelFor(options: EngineOptions): string {
		return this.#clientFor(options).defaultModel;
	}

	async decideOrchestration(
		request: string,
		priorRequests: readonly string[],
		options: EngineOptions,
		gates: { minConfidence: number; minMargin: number },
		maxChars: number,
	): Promise<OrchestrationDecision> {
		const started = performance.now();
		const questions = {
			route: choiceQuestion(ORCHESTRATION_INSTRUCTIONS, { ...ORCHESTRATION_CRITERIA }),
		} satisfies Questions;
		const response = (await this.#clientFor(options).systemOne(
			{
				state: {
					request: clip(request, maxChars),
					...(priorRequests.length > 0
						? { prior_requests: priorRequests.map(text => clip(text, PRIOR_REQUEST_CHARS)) }
						: {}),
				},
				questions,
			},
			{ signal: AbortSignal.timeout(options.timeoutMs) },
		)) as SystemOneResult<typeof questions>;
		const outcome = gate<OrchestrationRoute>(
			response.answers.route.probabilities,
			"DEFAULT",
			gates.minConfidence,
			gates.minMargin,
		);
		return { ...outcome, latencyMs: performance.now() - started };
	}

	/**
	 * One request, one question per subtask. Every question sees the same state,
	 * so each instruction names the subtask id it is about.
	 */
	async decideTaskTiers(
		subtasks: readonly JevSubtask[],
		sharedContext: string | undefined,
		options: EngineOptions,
		gates: { minConfidence: number; minMargin: number },
		maxChars: number,
	): Promise<TaskTierBatch> {
		const started = performance.now();
		const perItemBudget = Math.max(200, Math.floor(maxChars / Math.max(1, subtasks.length)));
		const questions: Questions = {};
		for (const subtask of subtasks) {
			questions[subtask.id] = choiceQuestion(
				`${TASK_TIER_INSTRUCTIONS_PREFIX}"${subtask.id}"${TASK_TIER_INSTRUCTIONS_SUFFIX}`,
				{ ...TASK_TIER_CRITERIA },
			);
		}
		const state = {
			...(sharedContext ? { shared_context: clip(sharedContext, maxChars) } : {}),
			subtasks: subtasks.map(subtask => ({ id: subtask.id, instruction: clip(subtask.instruction, perItemBudget) })),
		};
		const response = await this.#clientFor(options).systemOne(
			{ state, questions },
			{ signal: AbortSignal.timeout(options.timeoutMs) },
		);
		const decisions: TaskTierDecision[] = [];
		for (const subtask of subtasks) {
			const answer = response.answers[subtask.id];
			if (!answer || answer.type !== "choice") {
				decisions.push({ id: subtask.id, top: "TASK_DEEP", confidence: 0, margin: 0, confident: false, probabilities: {} });
				continue;
			}
			decisions.push({
				id: subtask.id,
				...gate<TaskRoute>(answer.probabilities, "TASK_DEEP", gates.minConfidence, gates.minMargin),
			});
		}
		return { decisions, latencyMs: performance.now() - started };
	}
}
