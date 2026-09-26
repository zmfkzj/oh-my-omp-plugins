/**
 * Tier alias agents derived from OMP's bundled `task` agent.
 *
 * OMP's task wire schema deletes unknown keys (`"+": "delete"` in
 * `src/task/types.ts`), and the only invocation-local model override
 * (`runSubprocess`'s `modelOverride`) is reachable from the eval bridge, not
 * from a tool-call input revision. Routing a spawn to a different model role
 * therefore has to go through the `agent` field, which means a real agent
 * definition must exist on disk.
 *
 * Rather than hand-copying OMP's prompt (which would drift on every OMP
 * upgrade), the alias is *derived at runtime* from the host's own bundled
 * `task` definition: same system prompt, same `spawns`, same thinking level,
 * no tool restrictions — only the model role differs. The file is rewritten
 * only when its content changes, and it lives inside the plugin package, so
 * `omp plugin uninstall` removes it along with the plugin.
 */
import path from "node:path";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { cfgTaskAgentAdvisor, cfgTaskAgentPrewalk, cfgTaskPrewalk } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

/** The bundled generic worker whose per-agent settings the aliases inherit. */
const GENERIC_TASK_AGENT_NAME = "task";

/** Distinct agent aliases for the three generic-worker model roles. */
export const EASY_AGENT_NAME = "task-easy";
export const HARD_AGENT_NAME = "task-hard";
export const CHALLENGE_AGENT_NAME = "task-challenge";

const tierDescription = (tier: string) =>
	`${tier} tier of the generic task worker, selected automatically by omp-jev-router. Do not request it directly; dispatch \`task\` and let the router pick the tier.`;

export interface TierAgentSpec {
	name: string;
	role: string;
	description: string;
	/**
	 * Per-agent behavior OMP keys by agent *name*, mirrored from whatever the
	 * operator configured for the generic `task` worker. Without this, routing a
	 * spawn to the alias would silently drop their `task.agentPrewalk` /
	 * `task.agentAdvisor` (and `task.prewalk`) choices. The plugin never
	 * introduces either on its own.
	 */
	prewalk?: boolean | string;
	advisor?: boolean | string;
}

export interface MaterializeResult {
	/** Alias names whose on-disk definitions match the requested configuration. */
	available: string[];
	/** Alias names that could not be written or whose shipped copy is stale. */
	failed: string[];
	/** Names whose on-disk content was (re)written this run. */
	written: string[];
}

/** Directory scanned by `discoverAgents` for this extension package. */
export function agentsDir(packageRoot: string): string {
	return path.join(packageRoot, "agents");
}

/**
 * Render an agent markdown file that mirrors `base` but resolves through
 * `spec.role`. Field spellings match OMP's own `prompts/agents/frontmatter.md`
 * so `parseAgentFields` reads them identically.
 */
export function renderTierAgent(base: AgentDefinition, spec: TierAgentSpec): string {
	const lines = ["---", `name: ${JSON.stringify(spec.name)}`, `description: ${JSON.stringify(spec.description)}`];
	if (base.spawns !== undefined) {
		lines.push(`spawns: ${JSON.stringify(base.spawns === "*" ? "*" : base.spawns.join(","))}`);
	}
	if (base.tools !== undefined) {
		lines.push(`tools: ${JSON.stringify(base.tools.join(","))}`);
	}
	lines.push(`model: ${JSON.stringify(`@${spec.role}`)}`);
	if (base.thinkingLevel !== undefined) {
		lines.push(`thinking-level: ${JSON.stringify(base.thinkingLevel)}`);
	}
	if (spec.prewalk !== undefined && spec.prewalk !== false) {
		lines.push(`prewalk: ${JSON.stringify(spec.prewalk)}`);
	}
	if (spec.advisor !== undefined && spec.advisor !== false) {
		lines.push(`advisor: ${JSON.stringify(spec.advisor)}`);
	}
	if (base.readSummarize === false) {
		lines.push("read-summarize: false");
	}
	lines.push("---", base.systemPrompt.trimEnd(), "");
	return lines.join("\n");
}

/**
 * Write every requested alias into `<packageRoot>/agents`, skipping files whose
 * content already matches. Returns which aliases a router may safely target.
 */
export async function materializeTierAgents(
	packageRoot: string,
	specs: readonly TierAgentSpec[],
): Promise<MaterializeResult> {
	const base = getBundledAgent("task");
	const result: MaterializeResult = { available: [], failed: [], written: [] };
	if (!base) {
		result.failed.push(...specs.map(spec => spec.name));
		return result;
	}

	const dir = agentsDir(packageRoot);
	for (const spec of specs) {
		const file = path.join(dir, `${spec.name}.md`);
		const desired = renderTierAgent(base, spec);
		const handle = Bun.file(file);
		const current = (await handle.exists()) ? await handle.text() : undefined;
		if (current === desired) {
			result.available.push(spec.name);
			continue;
		}
		try {
			await Bun.write(file, desired);
			result.available.push(spec.name);
			result.written.push(spec.name);
		} catch {
			// An outdated shipped copy is not safe if it cannot be rewritten.
			result.failed.push(spec.name);
		}
	}
	return result;
}

/**
 * Behavior OMP looks up by agent name for the generic `task` worker, so the
 * tier aliases can inherit it instead of silently resetting it.
 */
export interface InheritedAgentBehavior {
	prewalk?: boolean | string;
	advisor?: boolean | string;
}

/** All three model tiers have distinct spawnable aliases, even when roles coincide. */
export function requiredTierAgents(
	easyTaskRole: string,
	hardTaskRole: string,
	challengeTaskRole: string,
	inherited: InheritedAgentBehavior = {},
): TierAgentSpec[] {
	return [
		{ name: EASY_AGENT_NAME, role: easyTaskRole, description: tierDescription("Easy"), ...inherited },
		{ name: HARD_AGENT_NAME, role: hardTaskRole, description: tierDescription("Hard"), ...inherited },
		{ name: CHALLENGE_AGENT_NAME, role: challengeTaskRole, description: tierDescription("Challenge"), ...inherited },
	];
}

/**
 * Read the operator's per-agent `task` settings.
 *
 * `task.agentPrewalk` / `task.agentAdvisor` map an agent name to `"on"`,
 * `"off"`, or a model pattern and override frontmatter; `task.prewalk` arms
 * prewalk for the bundled generic worker. Absent or `"off"` yields nothing, so
 * the plugin never attaches an advisor or a prewalk hand-off by itself.
 */
export function readInheritedAgentBehavior(settings: Settings): InheritedAgentBehavior {
	const record = (map: Readonly<Record<string, string>>): string | undefined => {
		const value = map[GENERIC_TASK_AGENT_NAME];
		return typeof value === "string" && value !== "off" ? value : undefined;
	};
	const normalize = (value: string | undefined): boolean | string | undefined =>
		value === undefined ? undefined : value === "on" ? true : value;

	const prewalkSetting = normalize(record(cfgTaskAgentPrewalk.get(settings)));
	const prewalk = prewalkSetting ?? (cfgTaskPrewalk.get(settings) ? true : undefined);
	const advisor = normalize(record(cfgTaskAgentAdvisor.get(settings)));
	return { ...(prewalk === undefined ? {} : { prewalk }), ...(advisor === undefined ? {} : { advisor }) };
}
