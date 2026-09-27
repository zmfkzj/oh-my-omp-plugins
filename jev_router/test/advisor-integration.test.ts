import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import example from "../examples/initial-plan.json";
import { prepareReviewInput, runReview, ROLE, TOOL, type ReviewSelection } from "../src/advisor-review.ts";
import { registerJevRouter } from "../src/index.ts";
import { AUDITOR_NAME, VERIFICATION_AUDITOR } from "../src/verification-auditor.ts";
import { ORCHESTRATE_GUIDANCE, registerOrcheAdvisor } from "../src/orche-advisor.ts";
import {
  NATIVE_ORCHESTRATE_NOTICE_TYPE,
  NATIVE_WORKFLOW_NOTICE_TYPE,
  policyModeOf,
} from "../src/orchestration-policy.ts";
import { ReviewGate } from "../src/review-gate.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain, ScriptedDecider } from "./harness.ts";
import type { ScriptedOrchestration } from "./harness.ts";
import { findingRevision } from "../src/findings.ts";
import { prepareDispatch } from "../src/task-contract.ts";

/** A gate validating declarations against the live native `task` schema, as the runtime wires it. */
function liveGate(): ReviewGate {
  return new ReviewGate(() => true, input => prepareDispatch(makeApi().pi, input));
}

afterEach(clearRegistry);

test("one extension registers the checkpoint tool and an independent auditor role", async () => {
  const handlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  let checkpointTool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const { session, ctx } = makeSession();
  const branch: SessionEntry[] = [];
  Object.assign(session.sessionManager, {
    getBranch: () => branch,
    appendCustomEntry(customType: string, data: unknown) {
      const id = `state-${branch.length}`;
      branch.push({ type: "custom", id, parentId: null, timestamp: "2026-09-26T00:00:00Z", customType, data });
      return id;
    },
  });
  const roles = new Map<string, string>([["advisor", "existing-advisor-model"]]);
  let flushes = 0;
  Object.assign(session.settings, {
    getModelRole: (role: string) => roles.get(role),
    setModelRole: (role: string, model: string) => roles.set(role, model),
    flush: async () => { flushes++; },
  });
  registerAsMain(session);
  Object.assign(session, { isAdvisorEnabled: () => false });
  const pi = {
    zod: z,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    setLabel() {},
    events: { on: () => () => {} },
    registerCommand() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { checkpointTool = tool; },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (event === "session_start") handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  const runtime = registerJevRouter(pi);
  runtime.reloadConfig = async () => runtime.config;
  runtime.telemetry.load = async () => {};

  for (const handler of handlers) await handler({}, ctx);
  expect(checkpointTool?.name).toBe(TOOL);
  expect(roles.get("verification-auditor")).toBe("@smol");
  expect(VERIFICATION_AUDITOR.model).toBe("@verification-auditor");
  expect(roles.get("advisor")).toBe("existing-advisor-model");
  expect(flushes).toBe(1);

  roles.set("verification-auditor", "custom-auditor-model");
  for (const handler of handlers) await handler({}, ctx);
  expect(roles.get("verification-auditor")).toBe("custom-auditor-model");
  expect(flushes).toBe(1);

  const snapshotHash = prepareReviewInput(example).snapshotHash;
  branch.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: TOOL,
      isError: false,
      details: { role: ROLE, snapshotHash, model: "review-model", scopeKey: runtime.reviewGate.scope(ctx).key, findingRevision: findingRevision(branch) },
      content: [{ type: "text", text: "VERDICT: KEEP" }],
    },
  } as SessionEntry);
  const result = await checkpointTool!.execute("review-call", example, new AbortController().signal, () => {}, ctx);
  expect(result.content).toContainEqual({ type: "text", text: "VERDICT: KEEP" });
  expect(result.details).toMatchObject({ role: ROLE, reused: true, findingsForwarded: 0 });

  // A persisted auditor finding must invalidate the otherwise identical cached review.
  const finding: SessionEntry = {
    type: "custom_message", id: "fresh-audit", parentId: null, timestamp: "2026-09-26T00:00:00Z",
    customType: "advisor", content: "Evidence missing", display: true,
    details: { notes: [{ advisor: AUDITOR_NAME, severity: "blocker", note: "Claimed smoke has no run output" }] },
  };
  branch.push(finding);
  Object.assign(session.settings, { reloadFromDisk: async () => {} });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [] });
  // No reviewer configured: attempting a new review must fail, never reuse stale KEEP.
  await expect(checkpointTool!.execute("review-call-2", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Configure modelRoles.orche-advisor");
  const unavailableScope = runtime.reviewGate.scope(ctx);
  expect(unavailableScope).toMatchObject({ failed: false, unavailable: true, satisfied: false });
  let reloaded = false;
  Object.assign(session.settings, { reloadFromDisk: async () => { reloaded = true; } });
  await expect(checkpointTool!.execute("review-call-3", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Configure modelRoles.orche-advisor");
  expect(reloaded).toBe(true);
  expect(runtime.reviewGate.scope(ctx).key).toBe(unavailableScope.key);
  expect(runtime.reviewGate.beforeTool(ctx, "edit", {})?.block).toBe(true);
});

test("new required work cannot reuse an identical old snapshot and erase its risk", async () => {
  const branch: SessionEntry[] = [{
    type: "message", id: "old-user", parentId: null, timestamp: "2026-09-27T00:00:00Z",
    message: { role: "user", content: "Old release plan", timestamp: 0 },
  }];
  const { session, ctx } = makeSession({ branch });
  Object.assign(session.sessionManager, {
    appendCustomEntry(customType: string, data: unknown) {
      const id = `state-${branch.length}`;
      branch.push({ type: "custom", id, parentId: null, timestamp: "2026-09-27T01:00:00Z", customType, data });
      return id;
    },
  });
  registerAsMain(session);
  const gate = new ReviewGate();
  gate.noteDecision(ctx, true, "initial-plan", "review-required", "Old release plan");
  gate.beforeTool(ctx, "edit", {});
  const oldScope = gate.scope(ctx);
  gate.complete(ctx, oldScope, true);
  branch.push({
    type: "message", id: "cached-review", parentId: null, timestamp: "2026-09-27T01:01:00Z",
    message: { role: "toolResult", toolCallId: "prior", toolName: TOOL, isError: false, timestamp: 1,
      content: [{ type: "text", text: "VERDICT: KEEP" }],
      details: { role: ROLE, snapshotHash: prepareReviewInput(example).snapshotHash, scopeKey: oldScope.key, findingRevision: findingRevision(branch), model: "old-model" } },
  });
  branch.push({ type: "message", id: "new-user", parentId: null, timestamp: "2026-09-27T02:00:00Z",
    message: { role: "user", content: "New payment migration", timestamp: 2 } });
  gate.noteDecision(ctx, true, "initial-plan", "review-required", "New payment migration");
  let reviewer: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  registerOrcheAdvisor({
    zod: z, on() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { reviewer = tool; },
  } as unknown as ExtensionAPI, gate);
  Object.assign(session.settings, { reloadFromDisk: async () => {} });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [] });
  // A new review requires a configured model; stale cache reuse would incorrectly succeed.
  await expect(reviewer!.execute("new-review", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Configure modelRoles.orche-advisor");
  expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
});

test("tool retains omitted dispatch, withdraws explicitly, and re-reviews a revised rejected plan", async () => {
  const branch: SessionEntry[] = [];
  const { session, ctx } = makeSession({ branch });
  Object.assign(session.sessionManager, {
    appendCustomEntry(customType: string, data: unknown) {
      const id = `state-${branch.length}`;
      branch.push({ type: "custom", id, parentId: null, timestamp: "2026-09-27T00:00:00Z", customType, data });
      return id;
    },
  });
  registerAsMain(session);
  const gate = liveGate();
  gate.stageDispatch(ctx, { context: "Preview feature", tasks: [{ task: "Implement preview", name: "Preview" }] });
  const staged = gate.scope(ctx);
  gate.complete(ctx, staged, false, "rejection", "review_rejected");
  let reviewer: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  registerOrcheAdvisor({ zod: z, on() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { reviewer = tool; },
  } as unknown as ExtensionAPI, gate);
  Object.assign(session.settings, { reloadFromDisk: async () => {} });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [] });
  const execute = (params: unknown) => reviewer!.execute("review", params as typeof example,
    new AbortController().signal, () => {}, ctx);
  await expect(execute(example)).rejects.toThrow("This exact plan was rejected");
  expect(gate.scope(ctx).key).toBe(staged.key);
  // Exercise the public schema as well as the handler: null must reach staging.
  const withdrawnInput = (reviewer!.parameters as unknown as z.ZodType).parse({ ...example, dispatch: null });
  await expect(execute(withdrawnInput)).rejects.toThrow("Configure modelRoles.orche-advisor");
  const withdrawn = gate.scope(ctx);
  expect(withdrawn).toMatchObject({ failed: false, unavailable: true, dispatchSummary: [], satisfied: false });
  expect(withdrawn.key).not.toBe(staged.key);
  expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  gate.complete(ctx, withdrawn, false, "parent-rejected", "review_rejected");
  await expect(execute(withdrawnInput)).rejects.toThrow("This exact plan was rejected");
  // A semantic committed-plan revision changes the scope, unlike snapshot prose.
  branch.push({ type: "custom", id: "revised-plan", parentId: null, timestamp: "2026-09-27T01:00:00Z",
    customType: "user_todo_edit", data: { phases: [{ name: "Integration",
      tasks: [{ content: "Address rejected integration ordering", status: "pending" }] }] } });
  await expect(execute(example)).rejects.toThrow("Configure modelRoles.orche-advisor");
  expect(gate.scope(ctx)).toMatchObject({ failed: false, unavailable: true, satisfied: false });
  expect(gate.scope(ctx).key).not.toBe(withdrawn.key);
});

function reviewExecutionFixture(verdict: "KEEP" | "REPLAN" = "KEEP") {
  const branch: SessionEntry[] = [];
  const { session, ctx } = makeSession({ branch });
  const storage = { failUsage: false, modelCalls: 0 };
  Object.assign(session.sessionManager, {
    getLeafId: () => branch.at(-1)?.id ?? null,
    appendCustomEntry(customType: string, data: unknown) {
      const id = `state-${branch.length}`;
      branch.push({ type: "custom", id, parentId: null, timestamp: "2026-09-27T00:00:00Z", customType, data });
      return id;
    },
    appendModelUsage() {
      if (storage.failUsage) throw new Error("Usage storage unavailable");
      return undefined;
    },
  });
  registerAsMain(session);
  const model = { id: "review-fixture", provider: "openai", api: "openai-completions",
    name: "Review fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as ReviewSelection["model"];
  session.settings.setModelRole(ROLE, `${model.provider}/${model.id}`);
  Object.assign(session.settings, { reloadFromDisk: async () => {} });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [model], getApiKey: async () => "fixture-key" });
  const gate = liveGate();
  gate.noteDecision(ctx, true, "initial-plan", "Review required", "Integration");
  let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
  registerOrcheAdvisor({ zod: z, on() {},
    registerTool(registered: Parameters<ExtensionAPI["registerTool"]>[0]) { tool = registered; },
  } as unknown as ExtensionAPI, gate, (prepared, selection, registry, signal) =>
    runReview(prepared, selection, registry, signal, async () => {
      storage.modelCalls++;
      return {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
        stopReason: "stop", content: [{ type: "text", text: `VERDICT: ${verdict}\n\nISSUES:\n- None\n\nORCHESTRATION CHANGES:\n- None\n\nAVOID:\n- None` }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    }));
  return { branch, session, ctx, gate, tool, storage };
}

test("failed review bookkeeping withholds approval and recovers on the same scope", async () => {
  const { ctx, gate, tool, storage } = reviewExecutionFixture();
  const scope = gate.scope(ctx);
  storage.failUsage = true;
  await expect(tool.execute("failed", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Usage storage unavailable");
  expect(gate.scope(ctx)).toMatchObject({ key: scope.key, satisfied: false, unavailable: true });
  expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  storage.failUsage = false;
  const result = await tool.execute("recovered", example, new AbortController().signal, () => {}, ctx);
  expect(result.isError).not.toBe(true);
  expect(storage.modelCalls).toBe(2);
  expect(gate.scope(ctx)).toMatchObject({ key: scope.key, satisfied: true });
  expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
});

test("bookkeeping failure cannot downgrade an actual rejection to an unavailable review", async () => {
  const { ctx, gate, tool, storage } = reviewExecutionFixture("REPLAN");
  storage.failUsage = true;
  await expect(tool.execute("rejected", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Usage storage unavailable");
  expect(gate.scope(ctx)).toMatchObject({ satisfied: false, failed: true, unavailable: false });
  storage.failUsage = false;
  await expect(tool.execute("unchanged", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("This exact plan was rejected");
  expect(storage.modelCalls).toBe(1);
});

for (const dispatch of [null, { context: "Contract replacement", tasks: [{ name: "Replacement", task: "Replace existing contract" }] }]) {
  test(`oversized snapshot cannot ${dispatch === null ? "withdraw" : "replace"} an approved dispatch`, async () => {
    const { ctx, gate, tool, branch, storage } = reviewExecutionFixture();
    gate.stageDispatch(ctx, { context: "Original contract", tasks: [{ name: "Original", task: "Preserve this contract" }] });
    gate.complete(ctx, gate.scope(ctx), true);
    const before = gate.scope(ctx);
    const entries = branch.length;
    const snapshot = Object.fromEntries(Object.keys(example.snapshot).map(key => [key, "x".repeat(1500)]));
    const input = (tool.parameters as unknown as z.ZodType).parse({ checkpoint: "replan", dispatch, snapshot });
    await expect(tool.execute("invalid", input, new AbortController().signal, () => {}, ctx)).rejects.toThrow("8000");
    expect(gate.scope(ctx)).toEqual(before);
    expect(branch.length).toBe(entries);
    expect(storage.modelCalls).toBe(0);
  });
}

test("legacy aggregate summaries require restaging or withdrawal before a review", async () => {
  const { ctx, gate, tool, branch, storage } = reviewExecutionFixture();
  const state = branch.findLast(entry => entry.type === "custom" && entry.customType === "jev-review-requirement");
  if (!state || state.type !== "custom") throw new Error("Missing requirement");
  Object.assign(state.data as object, { dispatches: [{ key: "old-batch", summary: "Worker1: truncated batch" }] });
  await expect(tool.execute("legacy", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Legacy dispatch summaries");
  expect(storage.modelCalls).toBe(0);
  const result = await tool.execute("parent-review", { ...example, dispatch: null },
    new AbortController().signal, () => {}, ctx);
  expect(result.isError).not.toBe(true);
  expect(gate.scope(ctx)).toMatchObject({ dispatchComplete: true, dispatchSummary: [], satisfied: true });
});

const PROMPT = "Refactor the ingestion pipeline.";
const DEFAULT_ROUTE: ScriptedOrchestration = { top: "DEFAULT", confidence: 0.92, margin: 0.84, confident: true };
const ORCHESTRATE_ROUTE: ScriptedOrchestration = { top: "ORCHESTRATE", confidence: 0.92, margin: 0.84, confident: true };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}
function keywordNotice(customType: string, timestamp: number, content = customType): AgentMessage {
  return { role: "custom", customType, content, display: false, attribution: "user", timestamp } as AgentMessage;
}
function guidanceCount(message: AgentMessage | undefined): number {
  return message?.role === "custom" && typeof message.content === "string"
    ? message.content.split(ORCHESTRATE_GUIDANCE).length - 1
    : 0;
}
function totalGuidance(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + guidanceCount(message), 0);
}
function ofType(messages: AgentMessage[], customType: string): AgentMessage[] {
  return messages.filter(message => message.role === "custom" && message.customType === customType);
}

/** The whole plugin as OMP loads it, with a scripted Jev decision and no network or disk writes. */
function registeredPlugin(route: ScriptedOrchestration, enabled = true) {
  const branch: SessionEntry[] = [];
  const { session, ctx } = makeSession({ branch });
  Object.assign(session.sessionManager, {
    appendCustomEntry(customType: string, data: unknown) {
      const id = `state-${branch.length}`;
      branch.push({ type: "custom", id, parentId: null, timestamp: "2026-09-28T00:00:00Z", customType, data });
      return id;
    },
  });
  registerAsMain(session);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    zod: z,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    setLabel() {},
    events: { on: () => () => {} },
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => [TOOL],
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const runtime = registerJevRouter(pi);
  runtime.config.enabled = enabled;
  runtime.telemetry.setEnabled(false);
  runtime.apiKey = async () => "ts_test_key";
  const decider = new ScriptedDecider(route);
  Object.assign(runtime.engine, { decideOrchestration: decider.decideOrchestration.bind(decider) });
  return {
    async attemptMutation() {
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ type: "tool_call", toolName: "edit", toolCallId: "pending-edit", input: {} }, ctx);
        if (result) return result;
      }
      return undefined;
    },
    async beginTurn(prompt: string) {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx);
      }
    },
    /** Mirrors `ExtensionRunner.emitContext`: a cloned array flows through handlers in registration order. */
    async context(messages: AgentMessage[]): Promise<AgentMessage[]> {
      let current = structuredClone(messages);
      for (const handler of handlers.get("context") ?? []) {
        const result = await handler({ type: "context", messages: current }, ctx) as { messages?: AgentMessage[] } | undefined;
        if (result?.messages) current = result.messages;
      }
      return current;
    },
  };
}

test("explicit and automatic orchestration compose one policy notice with Advisor guidance once", async () => {
  const plugin = registeredPlugin(ORCHESTRATE_ROUTE);
  await plugin.beginTurn(PROMPT);
  const historical = keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1, "earlier native");
  const persisted = [historical, user("Earlier request"), assistant("done"),
    keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 2), user(PROMPT)];
  const snapshot = structuredClone(persisted);

  const first = await plugin.context(persisted);
  expect(persisted).toEqual(snapshot);
  expect(first[0]).toEqual(historical);
  expect(ofType(first, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([historical]);
  const policy = first.filter(message => policyModeOf(message) !== undefined);
  expect(policy.map(policyModeOf)).toEqual(["orchestrate"]);
  expect(first[3]).toBe(policy[0]!);
  expect(guidanceCount(policy[0])).toBe(1);
  expect(totalGuidance(first)).toBe(1);
  // Initial assessment permits scoping; execution activates the pending-review notice.
  expect(ofType(first, "jev-review-required")).toHaveLength(0);

  // A later provider request re-runs every hook on persisted history, or on an already composed copy.
  expect(await plugin.context(persisted)).toEqual(first);
  expect(await plugin.context(first)).toEqual(first);
  expect(await plugin.attemptMutation()).toMatchObject({ block: true });
  const pending = await plugin.context(persisted);
  expect(ofType(pending, "jev-review-required")).toHaveLength(1);
  expect(totalGuidance(pending)).toBe(1);
});

test("a workflow turn keeps the native workflow notice and gets one guided supplement", async () => {
  for (const [route, explicit] of [
    [DEFAULT_ROUTE, false], [ORCHESTRATE_ROUTE, false], [DEFAULT_ROUTE, true], [ORCHESTRATE_ROUTE, true],
  ] as const) {
    const plugin = registeredPlugin(route);
    await plugin.beginTurn(PROMPT);
    const workflow = keywordNotice(NATIVE_WORKFLOW_NOTICE_TYPE, 3);
    const persisted = [assistant("previous"),
      ...(explicit ? [keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 3)] : []), workflow, user(PROMPT)];
    for (const composed of [await plugin.context(persisted), await plugin.context(persisted)]) {
      expect(ofType(composed, NATIVE_WORKFLOW_NOTICE_TYPE)).toEqual([workflow]);
      expect(ofType(composed, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
      const policy = composed.filter(message => policyModeOf(message) !== undefined);
      expect(policy.map(policyModeOf)).toEqual(["workflow"]);
      expect(guidanceCount(policy[0])).toBe(1);
      expect(totalGuidance(composed)).toBe(1);
    }
  }
});

test("a direct turn carries the default policy without orchestration guidance", async () => {
  const plugin = registeredPlugin(DEFAULT_ROUTE);
  await plugin.beginTurn(PROMPT);
  const composed = await plugin.context([user(PROMPT)]);
  expect(composed.map(message => policyModeOf(message) ?? null).filter(Boolean)).toEqual(["default"]);
  expect(totalGuidance(composed)).toBe(0);
});

test("master disable leaves native guidance unchanged and does not gate execution", async () => {
  const plugin = registeredPlugin(ORCHESTRATE_ROUTE, false);
  await plugin.beginTurn(PROMPT);
  const messages = [keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1), user(PROMPT)];
  expect(await plugin.context(messages)).toEqual(messages);
  expect(await plugin.attemptMutation()).toBeUndefined();
});

test("without a router policy, only the current turn's native notice is guided, by copy", async () => {
  const branch: SessionEntry[] = [];
  const { session, ctx } = makeSession({ branch });
  registerAsMain(session);
  let context: Handler | undefined;
  registerOrcheAdvisor({
    zod: z,
    registerTool() {},
    getActiveTools: () => [TOOL],
    on(event: string, handler: Handler) { if (event === "context") context = handler; },
  } as unknown as ExtensionAPI, new ReviewGate());
  const historical = keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1);
  const current = keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 2);
  const messages = [historical, user("Earlier request"), assistant("done"), current, user(PROMPT)]
    .map(message => Object.freeze(message));
  const snapshot = structuredClone(messages);
  const result = await context!({ type: "context", messages }, ctx) as { messages: AgentMessage[] };
  expect(messages).toEqual(snapshot);
  expect(result.messages[0]).toBe(historical);
  expect(guidanceCount(result.messages[3])).toBe(1);
  expect(totalGuidance(result.messages)).toBe(1);
  expect(await context!({ type: "context", messages: result.messages }, ctx)).toBeUndefined();
  // A workflow notice alone carries no orchestration contract to annotate.
  expect(await context!({ type: "context", messages: [keywordNotice(NATIVE_WORKFLOW_NOTICE_TYPE, 4), user(PROMPT)] }, ctx))
    .toBeUndefined();
});
