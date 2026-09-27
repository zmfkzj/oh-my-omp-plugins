import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import example from "../examples/initial-plan.json";
import { prepareReviewInput, ROLE, TOOL } from "../src/advisor-review.ts";
import { registerJevRouter } from "../src/index.ts";
import { AUDITOR_NAME, VERIFICATION_AUDITOR } from "../src/verification-auditor.ts";
import { registerOrcheAdvisor } from "../src/orche-advisor.ts";
import { ReviewGate } from "../src/review-gate.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";
import { findingRevision } from "../src/findings.ts";

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
  const runtime = registerJevRouter(pi, import.meta.dir);
  runtime.reloadConfig = async () => runtime.config;
  runtime.telemetry.load = async () => {};
  runtime.surveyAgents = async () => runtime.survey;
  runtime.checkTierRoles = () => {};

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
  const gate = new ReviewGate();
  gate.stageDispatch(ctx, { tasks: [{ task: "Implement preview", name: "Preview" }] });
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
