/**
 * Fake sessions with an identity in the process's agent registry, as the host gives them. `harness.ts` registers one
 * main session under `Main`; these keep every session they register, so a test can run several main sessions (an ACP
 * host runs one per client, as `acp:<id>`) and the subagents of each. Clear the registry between tests.
 */
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { makeSession } from "./harness.ts";

/**
 * A session registered under `id`, working in `cwd`: a main session, or, with `parentId`, a subagent of the
 * session registered under that id. The context carries the identity a handler reads from `ctx.agent`.
 */
export function registeredSession(id: string, cwd: string, parentId?: string): ExtensionCommandContext {
	const fake = makeSession();
	Object.assign(fake.session, { isAdvisorEnabled: () => false });
	const kind = parentId === undefined ? "main" : "sub";
	AgentRegistry.global().register({ id, displayName: id, kind, parentId, session: fake.session });
	const agent = { kind, id, name: kind === "main" ? "main" : "task", depth: kind === "main" ? 0 : 1, parentId };
	return { ...fake.ctx, cwd, agent, ui: { notify() {} } } as unknown as ExtensionCommandContext;
}
