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
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** The live main session when `ctx` belongs to it, otherwise `undefined`. */
export function mainSessionOf(ctx: ExtensionContext): AgentSession | undefined {
	const main = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
	return main?.sessionManager === ctx.sessionManager ? main : undefined;
}
