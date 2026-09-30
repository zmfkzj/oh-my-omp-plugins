/**
 * Fake sessions with an identity in the process's agent registry, as the host gives them. `harness.ts` registers one
 * main session under `Main`; these keep every session they register, so a test can run several main sessions (an ACP
 * host runs one per client, as `acp:<id>`) and the subagents of each. Clear the registry between tests.
 */
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { makeSession } from "./harness.ts";
import path from "node:path";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";

/**
 * A session registered under `id`, working in `cwd`: a main session, or, with `parentId`, a subagent of the
 * session registered under that id. The context carries the identity a handler reads from `ctx.agent`.
 */
export function registeredSession(id: string, cwd: string, parentId?: string): ExtensionCommandContext {
	const fake = makeSession();
	// Main sessions now keep their mandatory auditor live even when the master flag starts off.
	let advisorsEnabled = false;
	let advisors: AdvisorConfig[] = [];
	Object.assign(fake.session.sessionManager, { getCwd: () => cwd });
	Object.assign(fake.session.settings, { getAgentDir: () => path.join(cwd, ".omp") });
	Object.assign(fake.session, {
		isAdvisorEnabled: () => advisorsEnabled,
		setAdvisorEnabled: (enabled: boolean) => { advisorsEnabled = enabled; },
		applyAdvisorConfigs: (configs: AdvisorConfig[]) => { advisors = configs; },
		getAdvisorStats: () => ({
			advisors: advisors.map(advisor => ({ name: advisor.name, status: advisor.enabled === false ? "paused" : "running" })),
		}),
	});
	const kind = parentId === undefined ? "main" : "sub";
	AgentRegistry.global().register({ id, displayName: id, kind, parentId, session: fake.session });
	const agent = { kind, id, name: kind === "main" ? "main" : "task", depth: kind === "main" ? 0 : 1, parentId };
	return { ...fake.ctx, cwd, agent, ui: { notify() {} } } as unknown as ExtensionCommandContext;
}
