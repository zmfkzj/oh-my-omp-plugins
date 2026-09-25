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
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	EngineOptions,
	GateThresholds,
	JevDecider,
	JevSubtask,
	OrchestrationDecision,
	OrchestrationRoute,
	TaskTierBatch,
	TaskRoute,
} from "../src/jev.ts";

export interface FakeSessionOptions {
	enabledTools?: string[];
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

/** Minimal `ExtensionAPI` exposing the tool catalogue and logger the routers use. */
export function makeApi(taskAgents: string[] = ["scout", "reviewer", "security-reviewer", "task", "sonic", "task-deep"]): {
	pi: ExtensionAPI;
	logs: string[];
} {
	const logs: string[] = [];
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
		getAllTools: () => [{ name: "task", description, parameters: {}, sourceInfo: {} }],
	} as unknown as ExtensionAPI;
	return { pi, logs };
}

export interface ScriptedOrchestration {
	top: OrchestrationRoute;
	confidence: number;
	margin: number;
	confident: boolean;
}

/** A `JevDecider` returning canned answers and counting requests. */
export class ScriptedDecider implements JevDecider {
	orchestrationCalls = 0;
	taskCalls = 0;
	lastSubtasks: readonly JevSubtask[] = [];
	lastOptions: EngineOptions | undefined;
	lastPriorRequests: readonly string[] = [];
	#orchestrationQueue: (ScriptedOrchestration | Error)[];

	constructor(
		orchestration: ScriptedOrchestration | Error | (ScriptedOrchestration | Error)[],
		private readonly tiers: Record<string, { top: TaskRoute; confidence: number; margin: number }> | Error = {},
	) {
		this.#orchestrationQueue = Array.isArray(orchestration) ? [...orchestration] : [orchestration];
	}

	async decideOrchestration(
		_request: string,
		priorRequests: readonly string[],
		options: EngineOptions,
		gates: GateThresholds,
		_maxChars: number,
	): Promise<OrchestrationDecision> {
		this.orchestrationCalls++;
		this.lastOptions = options;
		this.lastPriorRequests = priorRequests;
		const next =
			this.#orchestrationQueue.length > 1 ? this.#orchestrationQueue.shift()! : this.#orchestrationQueue[0]!;
		if (next instanceof Error) throw next;
		const { top, confidence, margin } = next;
		return {
			top,
			confidence,
			margin,
			confident: confidence >= gates.minConfidence && margin >= gates.minMargin,
			probabilities: { [top]: confidence },
			latencyMs: 7,
		};
	}

	async decideTaskTiers(
		subtasks: readonly JevSubtask[],
		_sharedContext: string | undefined,
		options: EngineOptions,
		gates: GateThresholds,
		_maxChars: number,
	): Promise<TaskTierBatch> {
		this.taskCalls++;
		this.lastSubtasks = subtasks;
		this.lastOptions = options;
		if (this.tiers instanceof Error) throw this.tiers;
		const table = this.tiers;
		return {
			latencyMs: 9,
			decisions: subtasks.map(subtask => {
				const answer = table[subtask.id] ?? { top: "TASK_NORMAL" as TaskRoute, confidence: 0.95, margin: 0.9 };
				return {
					id: subtask.id,
					top: answer.top,
					confidence: answer.confidence,
					margin: answer.margin,
					confident: answer.confidence >= gates.minConfidence && answer.margin >= gates.minMargin,
					probabilities: { [answer.top]: answer.confidence },
				};
			}),
		};
	}
}

export function fakeModel(provider: string, id: string): Model {
	return { provider, id, name: id } as unknown as Model;
}
