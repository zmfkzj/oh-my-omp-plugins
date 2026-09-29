import { afterEach, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mainSessionOf } from "../src/host.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";

afterEach(clearRegistry);

const withAgent = (ctx: ExtensionContext, agent: { kind: "main" | "sub"; id: string }) =>
	({ ...ctx, agent }) as unknown as ExtensionContext;

test("an ACP top-level session, registered as acp:<id> with no Main entry, is the primary", () => {
	const { session, ctx } = makeSession();
	clearRegistry();
	AgentRegistry.global().register({ id: "acp:session-1", displayName: "main", kind: "main", session });
	expect(mainSessionOf(withAgent(ctx, { kind: "main", id: "acp:session-1" }))).toBe(session);
});

test("a subagent is never the primary, even when it shares the main session's manager", () => {
	const { session, ctx } = makeSession();
	registerAsMain(session);
	expect(mainSessionOf(withAgent(ctx, { kind: "sub", id: "0-Worker" }))).toBeUndefined();
});

test("a session that is not registered as a main agent is not the primary", () => {
	const main = makeSession();
	registerAsMain(main.session);
	const child = makeSession();
	AgentRegistry.global().register({ id: "0-Worker", displayName: "sub", kind: "sub", session: child.session });
	expect(mainSessionOf(withAgent(child.ctx, { kind: "main", id: "0-Worker" }))).toBeUndefined();
	expect(mainSessionOf(child.ctx)).toBeUndefined();
	expect(mainSessionOf(main.ctx)).toBe(main.session);
});
