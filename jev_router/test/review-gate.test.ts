import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ReviewGate } from "../src/review-gate.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";
import { makeSession, registerAsMain, clearRegistry } from "./harness.ts";

afterEach(clearRegistry);
const goal = "Implement release compensation and balance telemetry.";
function fixture() {
  let id = 0;
  const branch: SessionEntry[] = [{ type: "message", id: "user-1", parentId: null, timestamp: "2026-09-26T00:00:00Z", message: { role: "user", content: goal, timestamp: 0 } }];
  const fake = makeSession({ branch });
  Object.assign(fake.session.sessionManager, { appendCustomEntry(customType: string, data: unknown) {
    const entryId = `custom-${++id}`;
    branch.push({ type: "custom", id: entryId, parentId: branch.at(-1)?.id ?? null, timestamp: "2026-09-26T01:00:00Z", customType, data });
    return entryId;
  } });
  registerAsMain(fake.session);
  return { ...fake, branch, gate: new ReviewGate() };
}
const batch = { context: "Independent server subsystems.", tasks: [
  { agent: "task", name: "Compensation", task: "Implement idempotent persistent compensation." },
  { agent: "task", name: "Telemetry", task: "Collect human-only match metrics." },
] };
function addPlan(branch: SessionEntry[], tasks: string[]) {
  branch.push({ type: "custom", id: `plan-${branch.length}`, parentId: null, timestamp: "2026-09-26T02:00:00Z", customType: "user_todo_edit", data: { phases: [{ name: "Release", tasks: tasks.map(content => ({ content, status: "pending" })) }] } });
}
function addFinding(branch: SessionEntry[], note = "No persistence smoke observed") {
  branch.push({ type: "custom_message", id: `audit-${branch.length}`, parentId: null, timestamp: "2026-09-26T03:00:00Z", customType: "advisor", content: note, display: true,
    details: { notes: [{ advisor: AUDITOR_NAME, severity: "blocker", note }] } });
}

describe("scope-bound review enforcement", () => {
  test("two implementers cannot start until their exact dispatch has a successful receipt", () => {
    const { gate, ctx } = fixture();
    expect(gate.beforeTool(ctx, "task", batch)?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, { type: "before_subagent_spawn", agent: "task-challenge", invocationKind: "task", patterns: [], spawnKey: "Compensation" })?.block).toBe(true);
    const captured = gate.scope(ctx);
    gate.complete(ctx, captured, true, "review-1");
    expect(gate.beforeTool(ctx, "task", batch)).toBeUndefined();
    expect(gate.beforeSpawn(ctx, { type: "before_subagent_spawn", agent: "task-challenge", invocationKind: "task", patterns: [], spawnKey: "Compensation" })).toBeUndefined();
  });
  test("DEFAULT risk requirement blocks single worker and inline execution, not scoping", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "Persistent compensation needs review", goal);
    expect(gate.beforeTool(ctx, "task", { tasks: [batch.tasks[0]] })?.block).toBe(true);
    for (const name of ["edit", "write", "bash", "eval", "mcp_mutating_tool"]) expect(gate.beforeTool(ctx, name, {})?.block).toBe(true);
    for (const name of ["read", "grep", "find", "todo", "orche_advisor", "review_findings"]) expect(gate.beforeTool(ctx, name, {})).toBeUndefined();
    expect(gate.beforeTool(ctx, "task", { tasks: [{ agent: "scout", task: "Locate persistence entry points" }] })).toBeUndefined();
  });
  test("routine single worker gets one native spawn permit without requiring a review", () => {
    const { gate, ctx } = fixture();
    expect(gate.beforeTool(ctx, "task", { tasks: [{ agent: "task", task: "Rename local variable" }] })).toBeUndefined();
    const event = { type: "before_subagent_spawn" as const, agent: "task-easy", invocationKind: "task" as const, patterns: [], spawnKey: "Rename" };
    expect(gate.beforeSpawn(ctx, event)).toBeUndefined();
    expect(gate.beforeSpawn(ctx, { ...event, spawnKey: "Unstaged" })?.block).toBe(true);
  });
  test("eval implementation spawning hits the shared gate and survives reload", () => {
    const { gate, ctx } = fixture();
    const event = { type: "before_subagent_spawn" as const, agent: "task", invocationKind: "eval" as const, patterns: ["@task"], spawnKey: "StableWorker" };
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    gate.complete(ctx, gate.scope(ctx), true);
    const reloaded = new ReviewGate();
    expect(reloaded.beforeSpawn(ctx, event)).toBeUndefined();
    expect(reloaded.beforeSpawn(ctx, { ...event, spawnKey: "AdditionalWorker" })?.block).toBe(true);
  });
  test("predeclared dispatch permits one review to cover both plan and fan-out", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    gate.stageDispatch(ctx, batch);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeTool(ctx, "task", batch)).toBeUndefined();
    const changed = { ...batch, tasks: [{ ...batch.tasks[0], task: "Change compensation semantics" }, batch.tasks[1]] };
    expect(gate.beforeTool(ctx, "task", changed)?.block).toBe(true);
  });
  test("withdrawal invalidates old parent and worker receipts and survives reload", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const parent = gate.scope(ctx);
    gate.complete(ctx, parent, true);
    gate.stageDispatch(ctx, batch);
    const workers = gate.scope(ctx);
    gate.complete(ctx, workers, true);
    gate.stageDispatch(ctx, null);
    const withdrawn = gate.scope(ctx);
    expect(withdrawn).toMatchObject({ required: true, checkpoint: "replan", satisfied: false, dispatchSummary: [] });
    expect(withdrawn.key).not.toBe(parent.key);
    expect(withdrawn.key).not.toBe(workers.key);
    const reloaded = new ReviewGate();
    expect(reloaded.scope(ctx)).toEqual(withdrawn);
    reloaded.stageDispatch(ctx, null);
    expect(reloaded.scope(ctx)).toEqual(withdrawn);
    expect(reloaded.beforeTool(ctx, "edit", {})?.block).toBe(true);
    reloaded.complete(ctx, workers, true);
    expect(reloaded.beforeTool(ctx, "edit", {})?.block).toBe(true);
    reloaded.complete(ctx, withdrawn, true);
    expect(reloaded.beforeTool(ctx, "edit", {})).toBeUndefined();
    expect(reloaded.beforeTool(ctx, "task", batch)?.block).toBe(true);
    expect(reloaded.scope(ctx).key).not.toBe(workers.key);
  });
  test("empty batches cannot silently withdraw, and repeated withdrawal cannot erase rejection", () => {
    const { gate, ctx } = fixture();
    gate.stageDispatch(ctx, batch);
    const staged = gate.scope(ctx);
    expect(() => gate.stageDispatch(ctx, { context: "withdraw", tasks: [] })).toThrow();
    expect(gate.scope(ctx)).toEqual(staged);
    gate.complete(ctx, staged, false);
    gate.stageDispatch(ctx, null);
    const withdrawn = gate.scope(ctx);
    expect(withdrawn).toMatchObject({ failed: false, satisfied: false, dispatchSummary: [] });
    gate.complete(ctx, withdrawn, false);
    gate.stageDispatch(ctx, null);
    expect(gate.scope(ctx)).toMatchObject({ key: withdrawn.key, failed: true, satisfied: false });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("plan edits and new finding evidence invalidate completed reviews", () => {
    const { gate, ctx, branch } = fixture();
    addPlan(branch, ["Persistent compensation"]);
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
    addPlan(branch, ["Persistent compensation", "Human telemetry"]);
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
    gate.complete(ctx, gate.scope(ctx), true);
    addFinding(branch);
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("a finding arriving during review cannot be approved by that stale result", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const captured = gate.scope(ctx);
    addFinding(branch);
    gate.complete(ctx, captured, true);
    expect(gate.scope(ctx).satisfied).toBe(false);
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("failure is not permission, and status reports it without retrying", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    gate.complete(ctx, gate.scope(ctx), false);
    expect(gate.scope(ctx)).toMatchObject({ failed: true, satisfied: false });
    expect(gate.beforeTool(ctx, "task", batch)?.block).toBe(true);
  });
  test("phase boundary invalidates the prior-phase receipt even for the same plan", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    gate.complete(ctx, gate.scope(ctx), true);
    gate.noteDecision(ctx, true, "phase-boundary", "implementation phase verified", goal);
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("user waiver requires the exact scope key and is invalidated by changed scope", async () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    gate.registerCommands({ registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); } } as unknown as ExtensionAPI);
    const commandCtx = Object.assign(ctx, { ui: { notify() {} } }) as unknown as ExtensionCommandContext;
    await commands.get("review-waive")!.handler("wrong-key accept risk", commandCtx);
    expect(gate.scope(ctx).satisfied).toBe(false);
    await commands.get("review-waive")!.handler(`${gate.scope(ctx).key} Explicitly accept risk`, commandCtx);
    expect(gate.scope(ctx).satisfied).toBe(true);
    addFinding(branch);
    expect(gate.scope(ctx).satisfied).toBe(false);
  });
  test("rewinding off a receipt does not preserve a process-global approval", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const before = branch.length;
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.scope(ctx).satisfied).toBe(true);
    branch.splice(before);
    expect(gate.scope(ctx).satisfied).toBe(false);
  });
  test("synthetic user messages cannot reset an outstanding review requirement", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    branch.push({ type: "message", id: "synthetic", parentId: null, timestamp: "2026-09-26T04:00:00Z",
      message: { role: "user", content: "worker completed", timestamp: 1, synthetic: true, attribution: "agent" } });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("two matching execution failures require a new review only once per problem", () => {
    const { gate, ctx, branch } = fixture();
    const content = [{ type: "text" as const, text: "Migration failed: duplicate ledger key" }];
    const event = { type: "tool_result" as const, toolName: "bash", toolCallId: "second", input: {}, content, isError: true, details: undefined };
    gate.observeToolResult(ctx, event);
    expect(gate.scope(ctx).required).toBe(false);
    branch.push({ type: "message", id: "error", parentId: null, timestamp: "2026-09-26T04:00:00Z",
      message: { role: "toolResult", toolName: "bash", toolCallId: "first", content, isError: true, timestamp: 1 } });
    gate.observeToolResult(ctx, event);
    expect(gate.scope(ctx)).toMatchObject({ required: true, checkpoint: "repeated-failure", satisfied: false });
    gate.complete(ctx, gate.scope(ctx), true);
    gate.observeToolResult(ctx, { ...event, toolCallId: "third" });
    expect(gate.scope(ctx).satisfied).toBe(true);
  });
  test("persistence failure never lets execution proceed without a receipt", () => {
    const { gate, ctx, session } = fixture();
    Object.assign(session.sessionManager, { appendCustomEntry() { throw new Error("storage unavailable"); } });
    expect(() => gate.noteDecision(ctx, true, "initial-plan", "release", goal)).toThrow("storage unavailable");
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("user-authorized retry creates one new scope but never authorizes execution itself", async () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const failed = gate.scope(ctx);
    gate.complete(ctx, failed, false);
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    gate.registerCommands({ registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); } } as unknown as ExtensionAPI);
    const commandCtx = Object.assign(ctx, { ui: { notify() {} } }) as unknown as ExtensionCommandContext;
    await commands.get("review-retry")!.handler(`${failed.key} Credentials repaired`, commandCtx);
    expect(gate.scope(ctx).key).not.toBe(failed.key);
    expect(gate.scope(ctx)).toMatchObject({ required: true, failed: false, satisfied: false });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("changed eval source cannot reuse the same worker-name receipt", () => {
    const { gate, ctx, branch } = fixture();
    const call = (code: string): SessionEntry => ({
      type: "message", id: `eval-${branch.length}`, parentId: null, timestamp: "2026-09-26T04:00:00Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: `call-${branch.length}`, name: "eval", arguments: { language: "py", code } }] },
    } as unknown as SessionEntry);
    const event = { type: "before_subagent_spawn" as const, agent: "task", invocationKind: "eval" as const, patterns: [], spawnKey: "Worker" };
    branch.push(call("await agent(task='Implement compensation')"));
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeSpawn(ctx, event)).toBeUndefined();
    branch.push(call("await agent(task='Redesign payment storage')"));
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
  });
  test("optional continuation retains the reviewed plan and dispatch across user turns", () => {
    const { gate, ctx, branch } = fixture();
    gate.beforeTool(ctx, "task", batch);
    gate.complete(ctx, gate.scope(ctx), true);
    const reviewed = gate.scope(ctx).key;
    branch.push({ type: "message", id: "followup", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: "Continue the same work", timestamp: 2 } });
    gate.noteDecision(ctx, false, "initial-plan", "review-optional", "Continue the same work", "CONTINUE");
    expect(gate.scope(ctx).key).toBe(reviewed);
    expect(gate.beforeTool(ctx, "task", batch)).toBeUndefined();
    expect(gate.guidance(ctx)).toBeUndefined();
  });
  test("diagnostic follow-up does not demand a proactive review but new findings still block mutation", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    gate.complete(ctx, gate.scope(ctx), true);
    addFinding(branch);
    branch.push({ type: "message", id: "status", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: "What is the status?", timestamp: 2 } });
    gate.noteDecision(ctx, false, "initial-plan", "review-optional", "What is the status?", "CONTINUE");
    expect(gate.guidance(ctx)).toBeUndefined();
    expect(gate.beforeTool(ctx, "read", {})).toBeUndefined();
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("new required user scope cannot reuse a prior receipt with unchanged todo", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    gate.complete(ctx, gate.scope(ctx), true);
    const request = "Also migrate payment storage";
    branch.push({ type: "message", id: "new-work", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: request, timestamp: 2 } });
    gate.noteDecision(ctx, true, "initial-plan", "review-required", request);
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("known observation devices do not require review just because their transport is write", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    for (const device of ["list_roblox_studios", "get_studio_state", "get_console_output"]) {
      expect(gate.beforeTool(ctx, "write", { path: `xd://mcp__roblox_studio_${device}`, content: "{}" })).toBeUndefined();
    }
    expect(gate.beforeTool(ctx, "write", { path: "xd://mcp__roblox_studio_execute_luau", content: "{}" })?.block).toBe(true);
    expect(gate.beforeTool(ctx, "write", { path: "/tmp/project.ts", content: "change" })?.block).toBe(true);
  });
  for (const reason of ["review-required", "review-uncertain"]) {
    test(`${reason} follow-up never prompts or changes generation before execution`, () => {
      const { gate, ctx, branch } = fixture();
      gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
      gate.complete(ctx, gate.scope(ctx), true);
      const key = gate.scope(ctx).key;
      const request = "I opened Studio; what now?";
      branch.push({ type: "message", id: "follow", parentId: null, timestamp: "2026-09-27T00:00:00Z",
        message: { role: "user", content: request, timestamp: 2 } });
      gate.noteDecision(ctx, true, "initial-plan", reason, request, "CONTINUE");
      expect(gate.scope(ctx).key).toBe(key);
      expect(gate.guidance(ctx)).toBeUndefined();
      addFinding(branch, "Studio discovery has no open place");
      expect(gate.guidance(ctx)).toBeUndefined();
      expect(gate.beforeTool(ctx, "read", {})).toBeUndefined();
      expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
      expect(gate.guidance(ctx)).toBeDefined();
    });
  }
  test("new finding after an executed review is silent until the next mutation", () => {
    const { gate, ctx, branch } = fixture();
    gate.beforeTool(ctx, "task", batch);
    gate.complete(ctx, gate.scope(ctx), true);
    addFinding(branch, "New evidence needs checking");
    expect(gate.guidance(ctx)).toBeUndefined();
    expect(gate.beforeTool(ctx, "read", {})).toBeUndefined();
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
    expect(gate.guidance(ctx)).toBeDefined();
  });
  test("rejection blocks execution until the committed plan is revised and approved", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    const rejected = gate.scope(ctx);
    gate.complete(ctx, rejected, false, "rejected", "review_rejected");
    expect(gate.scope(ctx)).toMatchObject({ failed: true, unavailable: false, satisfied: false });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
    addPlan(branch, ["Address the rejected compensation design"]);
    expect(gate.scope(ctx)).toMatchObject({ failed: false, satisfied: false });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
  });
  test("unavailable review survives reload and continuation without poisoning the scope", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    const scope = gate.scope(ctx);
    gate.complete(ctx, scope, false, "outage", "provider_error");
    const resumed = new ReviewGate();
    resumed.noteDecision(ctx, true, "initial-plan", "review-required", "Continue", "CONTINUE");
    expect(resumed.scope(ctx)).toMatchObject({ key: scope.key, failed: false, unavailable: true, satisfied: false });
    expect(resumed.beforeTool(ctx, "edit", {})?.block).toBe(true);
    expect(resumed.beforeTool(ctx, "orche_advisor", {})).toBeUndefined();
    resumed.complete(ctx, resumed.scope(ctx), true);
    expect(resumed.scope(ctx)).toMatchObject({ key: scope.key, satisfied: true, unavailable: false });
    expect(resumed.beforeTool(ctx, "edit", {})).toBeUndefined();
    addFinding(branch);
    expect(resumed.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("historical untyped infrastructure failure remains reviewable, never approved", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    const scope = gate.scope(ctx);
    branch.push({ type: "custom", id: "old-failure", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      customType: "jev-review-failure", data: { scopeKey: scope.key, success: false } });
    expect(new ReviewGate().scope(ctx)).toMatchObject({ key: scope.key, failed: false, unavailable: true, satisfied: false });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("waiving new risk uses the same scope key as its first execution", async () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    gate.beforeTool(ctx, "edit", {});
    gate.complete(ctx, gate.scope(ctx), true);
    const request = "Migrate a new payment store";
    branch.push({ type: "message", id: "payment-request", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: request, timestamp: 2 } });
    gate.noteDecision(ctx, true, "initial-plan", "review-required", request);
    const newScope = gate.scope(ctx);
    expect(newScope.satisfied).toBe(false);
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    gate.registerCommands({ registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); } } as unknown as ExtensionAPI);
    const commandCtx = Object.assign(ctx, { ui: { notify() {} } }) as unknown as ExtensionCommandContext;
    await commands.get("review-waive")!.handler(`${newScope.key} Accept this specific migration risk`, commandCtx);
    expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
    expect(gate.scope(ctx).key).toBe(newScope.key);
  });
  test("unrelated optional work is isolated and resuming an old scope restores its obligation", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal, "NEW");
    gate.beforeTool(ctx, "task", batch);
    const old = gate.scope(ctx);
    const request = "Rename a local variable in an unrelated demo";
    branch.push({ type: "message", id: "demo", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: request, timestamp: 2 } });
    gate.noteDecision(ctx, false, "initial-plan", "review-optional", request, "NEW");
    expect(gate.scope(ctx)).toMatchObject({ required: false, dispatchSummary: [] });
    expect(gate.scope(ctx).workId).not.toBe(old.workId);
    expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
    gate.noteDecision(ctx, false, "initial-plan", "review-optional", "Resume the release", old.workId);
    expect(gate.scope(ctx)).toMatchObject({ required: true, workId: old.workId, dispatchSummary: old.dispatchSummary });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("same-scope REQUIRED continuation reuses approval for actual edit and dispatch", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal, "NEW");
    gate.beforeTool(ctx, "task", batch);
    const reviewed = gate.scope(ctx);
    gate.complete(ctx, reviewed, true);
    branch.push({ type: "message", id: "continue", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: "Continue the accepted plan", timestamp: 2 } });
    gate.noteDecision(ctx, true, "initial-plan", "review-required", "Continue the accepted plan", reviewed.workId);
    expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
    expect(gate.beforeTool(ctx, "task", batch)).toBeUndefined();
    expect(gate.scope(ctx).key).toBe(reviewed.key);
  });
  test("late old review never changes the currently selected task", () => {
    const { gate, ctx, branch } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal, "NEW");
    const old = gate.scope(ctx);
    branch.push({ type: "message", id: "new", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: "Unrelated question", timestamp: 2 } });
    gate.noteDecision(ctx, false, "initial-plan", "review-optional", "Unrelated question", "NEW");
    const current = gate.scope(ctx);
    gate.complete(ctx, old, false);
    expect(gate.scope(ctx)).toEqual(current);
    expect(gate.guidance(ctx)).toBeUndefined();
  });
});
