/**
 * Test doubles.
 *
 * The extension surfaces the routers touch are small and well typed, so the
 * doubles implement exactly those members and are cast at the boundary. The
 * agent registry is the *real* one (`resetGlobalForTests` between cases) so the
 * main-session identity check under test is the production check.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	EngineOptions,
	GateThresholds,
	JevDecider,
	OrchestrationDecision,
	OrchestrationRoute,
	ReviewRequirement,
	RoutingContext,
} from "../src/jev.ts";

export interface FakeSessionOptions {
	enabledTools?: readonly string[];
	magicKeywords?: boolean;
	orchestrateKeyword?: boolean;
	planMode?: boolean;
	currentModel?: Model;
	branch?: SessionEntry[];
	thinkingLevel?: string;
	modelRoleProvenance?: "global" | "runtime";
}

export interface FakeSession {
	session: AgentSession;
	ctx: ExtensionContext;
	sessionManager: object;
	modelCalls: { model: Model; thinkingLevel?: string; ephemeral?: boolean }[];
	setCurrentModel(model: Model): void;
	setModelRoleProvenance(source: "global" | "runtime"): void;
}

/** A session object exposing only what the routers read. */
export function makeSession(options: FakeSessionOptions = {}): FakeSession {
	let currentModel = options.currentModel;
	let thinkingLevel = options.thinkingLevel ?? "medium";
	let roleProvenance = options.modelRoleProvenance ?? "global";
	const modelCalls: FakeSession["modelCalls"] = [];
	const sessionManager = { getSessionId: () => "session-1", getBranch: () => options.branch ?? [] };
	const settings = Settings.isolated({
		"magicKeywords.enabled": options.magicKeywords ?? true,
		"magicKeywords.orchestrate": options.orchestrateKeyword ?? true,
	});
	// Provenance tracks a mutable test knob rather than real layer state.
	settings.getModelRoleProvenance = (_role: string) => roleProvenance;
	const session = {
		sessionManager,
		settings,
		getEnabledToolNames: () => options.enabledTools ?? ["task", "read", "edit", "bash", "todo"],
		get thinkingLevel() { return thinkingLevel; },
		async setModelTemporary(model: Model, level?: string, opts?: { ephemeral?: boolean }) {
			if (model.id === "no-auth") throw new Error("No API key for x/no-auth");
			modelCalls.push({ model, thinkingLevel: level, ephemeral: opts?.ephemeral });
			currentModel = model;
			if (level) thinkingLevel = level;
		},
		getPlanModeState: () => ({ enabled: options.planMode ?? false }),
	} as unknown as AgentSession;

	const ctx = {
		cwd: "/tmp/jev-router-test",
		hasUI: false,
		get model() { return currentModel; },
		sessionManager,
		models: { resolve: () => undefined, list: () => [], current: () => undefined, family: () => "x" },
		modelRegistry: { authStorage: { keys: { get: async () => undefined }, credentials: { has: () => false } } },
	} as unknown as ExtensionContext;

	return {
		session, ctx, sessionManager, modelCalls,
		setCurrentModel(model) { currentModel = model; },
		setModelRoleProvenance(source) { roleProvenance = source; },
	};
}

/** Register `session` as the process main agent, as OMP does for a real session. */
export function registerAsMain(session: AgentSession): void {
	AgentRegistry.resetGlobalForTests();
	AgentRegistry.global().register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session });
}

export function clearRegistry(): void {
	AgentRegistry.resetGlobalForTests();
}

/** The settings OMP's `task` tool derives its live parameter schema from. */
export type TaskSchemaOptions = Parameters<typeof getTaskSchema>[0];

/**
 * Minimal `ExtensionAPI` exposing the tool catalogue and logger the plugin uses.
 *
 * The `task` entry carries OMP's real wire schema, built by the host's own
 * `getTaskSchema` (defaults mirror `task.batch` on, isolation off). The
 * returned `taskSchema` options are live: mutating them changes what the next
 * `getAllTools()` reports, as a mid-session settings change would.
 */
export function makeApi(
	taskAgents: string[] = ["scout", "reviewer", "security-reviewer", "task", "sonic"],
	schema: Partial<TaskSchemaOptions> = {},
): {
	pi: ExtensionAPI;
	logs: string[];
	taskSchema: TaskSchemaOptions;
} {
	const logs: string[] = [];
	const taskSchema: TaskSchemaOptions = { batchEnabled: true, isolationEnabled: false, ...schema };
	const description = [
		"Delegate work to background subagents.",
		"",
		"# Available Agents",
		...taskAgents.map(name => `- \`${name}\`: ${name} description`),
	].join("\n");
	const pi = {
		logger: {
			debug: (message: string) => logs.push(`debug ${message}`),
			warn: (message: string) => logs.push(`warn ${message}`),
			info: (message: string) => logs.push(`info ${message}`),
			error: (message: string) => logs.push(`error ${message}`),
		},
		getAllTools: () => [{ name: "task", description, parameters: getTaskSchema(taskSchema), sourceInfo: {} }],
	} as unknown as ExtensionAPI;
	return { pi, logs, taskSchema };
}

export interface ScriptedReview {
	top: ReviewRequirement;
	confidence: number;
	margin: number;
}

export interface ScriptedOrchestration {
	top: OrchestrationRoute;
	confidence: number;
	margin: number;
	confident: boolean;
	/** The independent review answer; a confident OPTIONAL when omitted, no usable answer when `null`. */
	review?: ScriptedReview | null;
}

const OPTIONAL_REVIEW: ScriptedReview = { top: "OPTIONAL", confidence: 0.95, margin: 0.9 };

/** A `JevDecider` returning canned answers and counting requests. */
export class ScriptedDecider implements JevDecider {
	orchestrationCalls = 0;
	lastOptions: EngineOptions | undefined;
	lastContext: RoutingContext = { recentMessages: [] };
	#orchestrationQueue: (ScriptedOrchestration | Error)[];

	constructor(orchestration: ScriptedOrchestration | Error | (ScriptedOrchestration | Error)[]) {
		this.#orchestrationQueue = Array.isArray(orchestration) ? [...orchestration] : [orchestration];
	}

	async decideOrchestration(
		_request: string,
		context: RoutingContext,
		options: EngineOptions,
		gates: GateThresholds,
		_maxChars: number,
	): Promise<OrchestrationDecision> {
		this.orchestrationCalls++;
		this.lastOptions = options;
		this.lastContext = context;
		const next =
			this.#orchestrationQueue.length > 1 ? this.#orchestrationQueue.shift()! : this.#orchestrationQueue[0]!;
		if (next instanceof Error) throw next;
		const { top, confidence, margin } = next;
		const review = next.review === undefined ? OPTIONAL_REVIEW : next.review;
		return {
			top,
			confidence,
			margin,
			confident: confidence >= gates.minConfidence && margin >= gates.minMargin,
			probabilities: { [top]: confidence },
			latencyMs: 7,
			// A missing answer gates to the engine's empty, unconfident REQUIRED.
			review: review
				? {
						...review,
						confident: review.confidence >= gates.minConfidence && review.margin >= gates.minMargin,
						probabilities: { [review.top]: review.confidence },
					}
				: { top: "REQUIRED", confidence: 0, margin: 0, confident: false, probabilities: {} },
		};
	}
}

export function fakeModel(provider: string, id: string): Model {
	return { provider, id, name: id } as unknown as Model;
}
