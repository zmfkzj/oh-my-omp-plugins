import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizeConfig } from "../src/config.ts";
import { RouteLogger } from "../src/logging.ts";
import { OrchestrationRouter } from "../src/orchestration.ts";
import { NATIVE_ORCHESTRATE_NOTICE_TYPE, NATIVE_WORKFLOW_NOTICE_TYPE, policyModeOf } from "../src/orchestration-policy.ts";
import { POLICY_EXPOSURE_ENTRY_TYPE, POLICY_REVISION, type PolicyExposure } from "../src/policy-exposure.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain } from "./harness.ts";

afterEach(clearRegistry);

function host(manager = SessionManager.inMemory("/tmp/policy-observation")) {
	const fake = makeSession();
	const tools = ["task", "read", "write", "bash", "todo"];
	let plan = false;
	let system = ["base containing synthetic-private-value"];
	Object.assign(fake.session, { sessionManager: manager, getEnabledToolNames: () => tools, getPlanModeState: () => ({ enabled: plan }) });
	Object.assign(fake.ctx, { sessionManager: manager, getSystemPrompt: () => system });
	registerAsMain(fake.session);
	const config = normalizeConfig(undefined);
	const router = new OrchestrationRouter({ config: () => config, logger: new RouteLogger(makeApi().pi.logger) });
	return {
		...fake, manager, tools, config, router,
		setPlan(value: boolean) { plan = value; },
		prepare() { system = router.withPolicy(fake.ctx, ["base containing synthetic-private-value"]) ?? ["base containing synthetic-private-value"]; },
		rebuild() { system = ["base containing synthetic-private-value"]; },
		request(messages: AgentMessage[] = []) { return router.applyToContext(fake.ctx, messages) ?? messages; },
		observations() { return manager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === POLICY_EXPOSURE_ENTRY_TYPE ? [entry.data as PolicyExposure] : []); },
		get system() { return system; },
	};
}
function hash(section: string): string {
	return createHash("sha256").update(`${Buffer.byteLength(section, "utf8")}:`).update(section).digest("hex");
}
function native(customType: string, timestamp = 1): AgentMessage {
	return { role: "custom", customType, content: "native", display: false, timestamp } as AgentMessage;
}

test("preparation is not recorded; context observation hashes only actual sections and preserves messages", () => {
	const t = host();
	t.prepare();
	expect(t.observations()).toEqual([]);
	t.manager.appendMessage({ role: "user", content: "synthetic-private-task", timestamp: 0 });
	const contextBefore = structuredClone(t.manager.buildSessionContext());
	const messages = t.manager.buildSessionContext().messages;
	const before = structuredClone(messages);
	expect(t.request(messages)).toBe(messages);
	expect(messages).toEqual(before);
	expect(t.observations()).toEqual([{
		schema: 1, policy: POLICY_REVISION, phase: "orchestration-context-view", governance: "governed",
		sections: { system: hash(t.system[1]!), orchestrate: null, workflow: null },
	}]);
	expect(t.manager.buildSessionContext()).toEqual(contextBefore);
	expect(JSON.stringify(t.observations())).not.toContain("synthetic-private");
	expect(t.manager.getBranch().map(entry => entry.type)).toEqual(["message", "custom"]);
});

test("unchanged tool-loop and autonomous contexts deduplicate; relevant rendered prompt changes record", () => {
	const t = host();
	t.prepare();
	t.request();
	t.request([native("async-result")]);
	t.tools.push("irrelevant-tool");
	t.prepare();
	t.request();
	expect(t.observations()).toHaveLength(1);
	t.tools.splice(t.tools.indexOf("write"), 1);
	t.prepare();
	t.request();
	const firstHash = t.observations()[0]!.sections.system;
	expect(t.observations().map(record => record.sections.system)).toEqual([firstHash, hash(t.system[1]!)]);
	expect(t.observations()[0]!.sections.system).not.toBe(t.observations()[1]!.sections.system);
	t.rebuild();
	t.request([native("async-result")]);
	expect(t.observations().at(-1)!.sections.system).toBeNull();
});

test("keyword section digests observe rewritten view, stay bounded for long history, and change with view", () => {
	const t = host();
	t.prepare();
	const orchestrated = t.request([native(NATIVE_ORCHESTRATE_NOTICE_TYPE)]);
	const orchestrate = orchestrated[0]!;
	if (orchestrate.role !== "custom" || typeof orchestrate.content !== "string") throw new Error("Expected custom notice");
	expect(t.observations().at(-1)!.sections.orchestrate).toBe(hash(orchestrate.content));
	const workflow = t.request([native(NATIVE_WORKFLOW_NOTICE_TYPE)]);
	const supplement = workflow.find(message => policyModeOf(message) === "workflow")!;
	if (supplement.role !== "custom" || typeof supplement.content !== "string") throw new Error("Expected custom supplement");
	expect(t.observations().at(-1)!.sections.workflow).toBe(hash(supplement.content));
	const long = Array.from({ length: 1000 }, (_, index) => native(NATIVE_WORKFLOW_NOTICE_TYPE, index));
	t.request(long);
	const record = t.observations().at(-1)!;
	expect(JSON.stringify(record).length).toBeLessThan(512);
	t.request(long);
	expect(t.observations()).toHaveLength(3);
	t.rebuild();
	t.request(long);
	expect(t.observations().at(-1)!.sections.workflow).not.toBe(record.sections.workflow);
});

test("governance differs from presence; plan/tool gates record unavailable or residual policy, disabled/subagent write nothing", () => {
	const t = host();
	t.setPlan(true);
	t.request();
	expect(t.observations().at(-1)).toMatchObject({ governance: "plan-mode", sections: { system: null } });
	t.setPlan(false);
	t.prepare();
	t.request();
	t.setPlan(true);
	t.request();
	expect(t.observations().at(-1)).toMatchObject({ governance: "plan-mode", sections: { system: hash(t.system[1]!) } });
	t.setPlan(false);
	t.tools.splice(t.tools.indexOf("task"), 1);
	t.request();
	expect(t.observations().at(-1)).toMatchObject({ governance: "task-tool-unavailable", sections: { system: hash(t.system[1]!) } });
	t.prepare();
	t.request();
	expect(t.observations().at(-1)).toMatchObject({ governance: "task-tool-unavailable", sections: { system: null } });
	const before = structuredClone(t.manager.getEntries());
	t.config.enabled = false;
	t.request();
	expect(t.manager.getEntries()).toEqual(before);
	t.config.enabled = true;
	clearRegistry();
	t.request();
	expect(t.manager.getEntries()).toEqual(before);
});

test("deduplication follows active branch and reset boundary, not process or session cache", () => {
	const t = host();
	const root = t.manager.appendMessage({ role: "user", content: "start", timestamp: 0 });
	t.prepare();
	t.request();
	const baseline = t.manager.getLeafId()!;
	// A new router resuming the same branch retains the applicable baseline.
	const resumed = host(t.manager);
	resumed.prepare();
	resumed.request();
	expect(resumed.observations()).toHaveLength(1);
	t.manager.branch(root);
	resumed.request();
	expect(resumed.observations()).toHaveLength(1);
	expect(t.manager.getLeafId()).not.toBe(baseline);
	// A fork carrying the baseline keeps it; a clear requires a fresh observation.
	t.manager.createBranchedSession(t.manager.getLeafId()!);
	resumed.request();
	expect(resumed.observations()).toHaveLength(1);
	t.manager.appendResetBoundary();
	resumed.request();
	expect(resumed.observations()).toHaveLength(2);
	const independent = host();
	independent.prepare();
	independent.request();
	expect(independent.observations()).toHaveLength(1);
});

test("metadata read/write failures never block or change context", () => {
	for (const failAt of ["getBranch", "appendCustomEntry"]) {
		const t = host();
		t.prepare();
		Object.assign(t.manager, { [failAt]: () => { throw new Error("synthetic-private-storage-error"); } });
		const messages = [native("async-result")];
		expect(t.request(messages)).toBe(messages);
	}
});
