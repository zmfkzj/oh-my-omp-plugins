/**
 * Host-session helpers.
 *
 * Extensions load in subagent sessions too (a restricted child keeps its
 * parent's loaded extensions), so every main-session-only behavior has to test
 * identity rather than assume it. A top-level session is registered as a
 * `main` agent under an id the entry point picks: `Main` for the TUI, print and
 * RPC modes, `acp:<sessionId>` for each ACP session. The check therefore looks
 * for a `main` registry entry whose session manager is the handler's own,
 * which is the identity test OMP's primary-only extensions rely on.
 */
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** The live top-level session when `ctx` belongs to it, otherwise `undefined`. */
export function mainSessionOf(ctx: ExtensionContext): AgentSession | undefined {
	// `/tan` clones share a depth of 0 with the main session; the host reports them as "sub".
	if (ctx.agent?.kind === "sub") return undefined;
	return AgentRegistry.global()
		.list()
		.find(ref => ref.kind === "main" && ref.session?.sessionManager === ctx.sessionManager)?.session ?? undefined;
}
