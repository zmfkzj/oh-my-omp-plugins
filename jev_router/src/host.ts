/**
 * Host-session helpers.
 *
 * Extensions load in subagent sessions too (a restricted child keeps its
 * parent's loaded extensions), so every main-session-only behavior has to test
 * identity rather than assume it. The registry holds the process's `Main`
 * agent; comparing its session manager against the handler's context is the
 * same check OMP's own primary-only extensions use.
 */
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { cfgMagicKeyword, cfgMagicKeywordsEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** The live main session when `ctx` belongs to it, otherwise `undefined`. */
export function mainSessionOf(ctx: ExtensionContext): AgentSession | undefined {
	const main = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	return main?.sessionManager === ctx.sessionManager ? main : undefined;
}

/** The session backing `ctx` — main or subagent — when the registry knows it. */
export function sessionOf(ctx: ExtensionContext): AgentSession | undefined {
	for (const ref of AgentRegistry.global().list()) {
		if (ref.session?.sessionManager === ctx.sessionManager) return ref.session;
	}
	return undefined;
}

/**
 * Agent names the `task` tool is currently advertising.
 *
 * The tool renders one ``- `<name>` `` bullet per agent that survives the live
 * spawn policy and `task.disabledAgents` (`# Available Agents` in
 * `src/prompts/tools/task.md`), so this is an exact, policy-accurate spawnability
 * check — not a guess about what a restricted parent allows. A name absent
 * here would be rejected at preflight, so the router must not route to it.
 */
export function spawnableTaskAgents(pi: ExtensionAPI): Set<string> {
	const names = new Set<string>();
	const description = pi.getAllTools().find(tool => tool.name === "task")?.description;
	if (!description) return names;
	const listing = description.split("# Available Agents")[1];
	if (!listing) return names;
	for (const line of listing.split("\n")) {
		const match = /^- `([A-Za-z0-9_-]+)`/.exec(line);
		if (match?.[1]) names.add(match[1]);
	}
	return names;
}

/** Whether OMP would honor a typed `orchestrate` keyword in this session. */
export function orchestrateKeywordEnabled(session: AgentSession): boolean {
	const orchestrate = cfgMagicKeyword.orchestrate;
	return cfgMagicKeywordsEnabled.get(session) && orchestrate !== undefined && orchestrate.get(session);
}

export interface RoleResolution {
	role: string;
	alias: string;
	modelId?: string;
	label: string;
}

/** Resolve `@role` through OMP's own alias machinery for display and preflight. */
export function resolveRole(ctx: ExtensionContext, role: string): RoleResolution {
	const alias = `@${role}`;
	const model = ctx.models.resolve(alias);
	if (!model) return { role, alias, label: "unresolved" };
	return { role, alias, modelId: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` };
}

