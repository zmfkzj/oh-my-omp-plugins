import { afterEach, describe, expect, test } from "bun:test";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ReviewGate } from "../src/review-gate.ts";
import { prepareDispatch } from "../src/task-contract.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain } from "./harness.ts";

afterEach(clearRegistry);
const goal = "Implement release compensation and balance telemetry.";
function fixture(options: { asyncExecution?: boolean } = {}) {
  let id = 0;
  const branch: SessionEntry[] = [{ type: "message", id: "user-1", parentId: null, timestamp: "2026-09-26T00:00:00Z", message: { role: "user", content: goal, timestamp: 0 } }];
  const fake = makeSession({ branch });
  Object.assign(fake.session.sessionManager, { appendCustomEntry(customType: string, data: unknown) {
    const entryId = `custom-${++id}`;
    branch.push({ type: "custom", id: entryId, parentId: branch.at(-1)?.id ?? null, timestamp: "2026-09-26T01:00:00Z", customType, data });
    return entryId;
  } });
  // OMP's `async.enabled` decides whether task spawn ids are preallocated.
  if (options.asyncExecution === false) Object.assign(fake.session, { settings: Settings.isolated({ "async.enabled": false }) });
  // The session's job snapshot lists queued and running task jobs under their allocated agent id.
  const jobs: string[] = [];
  Object.assign(fake.ctx, { getAsyncJobSnapshot: () => ({
    running: jobs.map(agentId => ({ id: agentId, type: "task", status: "running", label: agentId, startTime: 0, agentId })),
    recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] },
  }) });
  registerAsMain(fake.session);
  const api = makeApi();
  const liveGate = () => new ReviewGate(() => true, input => prepareDispatch(api.pi, input));
  return { ...fake, branch, api, jobs, liveGate, gate: liveGate() };
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
function spawn(spawnKey: string | undefined, agent = "task") {
  return { type: "before_subagent_spawn" as const, agent, invocationKind: "task" as const, patterns: [], spawnKey };
}
/** What OMP's agent loop hands `tool_call`: the intent stripped, the rest validated against the live task schema. */
function hostArgs(pi: ExtensionAPI, raw: Record<string, unknown>): Record<string, unknown> {
  const args = { ...raw };
  delete args.i;
  const tool = pi.getAllTools().find(candidate => candidate.name === "task")!;
  return validateToolArguments(tool, { type: "toolCall", id: "host", name: "task", arguments: args });
}
/**
 * A task `tool_result` as OMP reports it. An async return carries `details.async`
 * and lists each item's allocated output id in `details.progress`; sync completion does not.
 */
function taskResult(toolCallId: string, outcome: "sync" | "error" | { queued: string[] } = "sync") {
  const queued = typeof outcome === "object" ? outcome.queued : undefined;
  return { type: "tool_result" as const, toolName: "task", toolCallId, input: {}, isError: outcome === "error",
    content: [{ type: "text" as const, text: outcome === "error" ? "Task failed" : "Task finished" }],
    details: { projectAgentsDir: null, results: [], totalDurationMs: 0,
      ...(queued ? { progress: queued.map((id, index) => ({ index, id, agent: "task", status: "pending" })), async: { state: "running", jobId: queued[0], type: "task" } } : {}) } };
}

describe("scope-bound review enforcement", () => {
  test("two implementers cannot start until their exact dispatch has a successful receipt", () => {
    const { gate, ctx } = fixture();
    expect(gate.beforeTool(ctx, "task", batch, "call-1")?.block).toBe(true);
    expect(gate.scope(ctx).dispatchSummary).toHaveLength(2);
    expect(gate.beforeSpawn(ctx, spawn("Compensation"))?.block).toBe(true);
    const captured = gate.scope(ctx);
    gate.complete(ctx, captured, true, "review-1");
    expect(gate.beforeTool(ctx, "task", batch, "call-2")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Compensation"))).toBeUndefined();
  });
  test("DEFAULT risk requirement blocks single worker and inline execution, not scoping", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "Persistent compensation needs review", goal);
    expect(gate.beforeTool(ctx, "task", { context: batch.context, tasks: [batch.tasks[0]] }, "call-1")?.block).toBe(true);
    expect(gate.scope(ctx).dispatchSummary).toHaveLength(1);
    for (const name of ["edit", "write", "bash", "eval", "mcp_mutating_tool"]) expect(gate.beforeTool(ctx, name, {})?.block).toBe(true);
    for (const name of ["read", "grep", "find", "todo", "orche_advisor", "review_findings"]) expect(gate.beforeTool(ctx, name, {})).toBeUndefined();
    expect(gate.beforeTool(ctx, "task", { context: "Scoping", tasks: [{ agent: "scout", task: "Locate persistence entry points" }] }, "call-2")).toBeUndefined();
  });
  test("a routine worker gets exactly one permit for its own spawn identity", () => {
    const { gate, ctx } = fixture();
    expect(gate.beforeTool(ctx, "task", { context: "Local cleanup", tasks: [{ name: "Rename", task: "Rename local variable" }] }, "call-1")).toBeUndefined();
    expect(gate.scope(ctx).required).toBe(false);
    for (const event of [spawn("Unstaged"), spawn("Rename", "sonic"), spawn(undefined)]) expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, spawn("Rename"))).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Rename-2"))?.block).toBe(true);
  });
  test("parent approval never authorizes native workers without task preflight", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "Parent integration", goal);
    gate.complete(ctx, gate.scope(ctx), true);
    const event = spawn("Compensation");
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", batch, "call-1")?.block).toBe(true);
    gate.complete(ctx, gate.scope(ctx), true);
    // A review alone is not a permit: the actual task call must pass preflight.
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", batch, "call-2")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Unreviewed"))?.block).toBe(true);
    // OMP suffixes a repeated output id; the approved worker may start under it once.
    expect(gate.beforeSpawn(ctx, spawn("Compensation-2"))).toBeUndefined();
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, spawn("Telemetry"))).toBeUndefined();
  });
  test("native permits cannot cross findings, withdrawal, or plugin reload", () => {
    const { gate, ctx, branch, liveGate } = fixture();
    gate.stageDispatch(ctx, batch);
    gate.complete(ctx, gate.scope(ctx), true);
    gate.beforeTool(ctx, "task", batch, "call-1");
    const event = spawn("Compensation");
    addFinding(branch);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    gate.beforeTool(ctx, "task", batch, "call-2");
    gate.stageDispatch(ctx, null);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    gate.stageDispatch(ctx, batch);
    gate.complete(ctx, gate.scope(ctx), true);
    gate.beforeTool(ctx, "task", batch, "call-3");
    const reloaded = liveGate();
    expect(reloaded.beforeSpawn(ctx, event)?.block).toBe(true);
    expect(reloaded.beforeTool(ctx, "task", batch, "call-4")).toBeUndefined();
    expect(reloaded.beforeSpawn(ctx, event)).toBeUndefined();
  });
  test("eval implementation spawning hits the shared gate and survives reload", () => {
    const { gate, ctx, liveGate } = fixture();
    const event = { type: "before_subagent_spawn" as const, agent: "task", invocationKind: "eval" as const, patterns: ["@task"], spawnKey: "StableWorker" };
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    gate.complete(ctx, gate.scope(ctx), true);
    const reloaded = liveGate();
    expect(reloaded.beforeSpawn(ctx, event)).toBeUndefined();
    expect(reloaded.beforeSpawn(ctx, { ...event, spawnKey: "AdditionalWorker" })?.block).toBe(true);
  });
  test("predeclared dispatch permits one review to cover both plan and fan-out", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    gate.stageDispatch(ctx, batch);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeTool(ctx, "task", batch, "call-1")).toBeUndefined();
    gate.observeToolResult(ctx, taskResult("call-1"));
    const changed = { ...batch, tasks: [{ ...batch.tasks[0], task: "Change compensation semantics" }, batch.tasks[1]] };
    expect(gate.beforeTool(ctx, "task", changed, "call-2")?.block).toBe(true);
    expect(gate.scope(ctx).satisfied).toBe(false);
  });
  test("withdrawal invalidates old parent and worker receipts and survives reload", () => {
    const { gate, ctx, liveGate } = fixture();
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
    const reloaded = liveGate();
    expect(reloaded.scope(ctx)).toEqual(withdrawn);
    reloaded.stageDispatch(ctx, null);
    expect(reloaded.scope(ctx)).toEqual(withdrawn);
    expect(reloaded.beforeTool(ctx, "edit", {})?.block).toBe(true);
    reloaded.complete(ctx, workers, true);
    expect(reloaded.beforeTool(ctx, "edit", {})?.block).toBe(true);
    reloaded.complete(ctx, withdrawn, true);
    expect(reloaded.beforeTool(ctx, "edit", {})).toBeUndefined();
    expect(reloaded.beforeTool(ctx, "task", batch, "call-1")?.block).toBe(true);
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
    expect(gate.beforeTool(ctx, "task", batch, "call-1")?.block).toBe(true);
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
  test("spawn authorization refuses instead of throwing when review state cannot be written", () => {
    const { gate, ctx, session } = fixture();
    Object.assign(session.sessionManager, { appendCustomEntry() { throw new Error("storage unavailable"); } });
    const event = { type: "before_subagent_spawn" as const, agent: "task", invocationKind: "eval" as const, patterns: [], spawnKey: "Worker" };
    expect(gate.beforeSpawn(ctx, event)?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, spawn("Worker"))?.block).toBe(true);
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
    gate.beforeTool(ctx, "task", batch, "call-1");
    gate.complete(ctx, gate.scope(ctx), true);
    const reviewed = gate.scope(ctx).key;
    branch.push({ type: "message", id: "followup", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: "Continue the same work", timestamp: 2 } });
    gate.noteDecision(ctx, false, "initial-plan", "review-optional", "Continue the same work", "CONTINUE");
    expect(gate.scope(ctx).key).toBe(reviewed);
    expect(gate.beforeTool(ctx, "task", batch, "call-2")).toBeUndefined();
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
    gate.beforeTool(ctx, "task", batch, "call-1");
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
    const { gate, ctx, branch, liveGate } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    const scope = gate.scope(ctx);
    gate.complete(ctx, scope, false, "outage", "provider_error");
    const resumed = liveGate();
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
    const { gate, ctx, branch, liveGate } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "review-required", goal);
    const scope = gate.scope(ctx);
    branch.push({ type: "custom", id: "old-failure", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      customType: "jev-review-failure", data: { scopeKey: scope.key, success: false } });
    expect(liveGate().scope(ctx)).toMatchObject({ key: scope.key, failed: false, unavailable: true, satisfied: false });
    expect(gate.beforeTool(ctx, "edit", {})?.block).toBe(true);
  });
  test("dispatches staged under an earlier contract must be restaged before review", () => {
    const { gate, ctx, branch } = fixture();
    branch.push({ type: "custom", id: "legacy", parentId: null, timestamp: "2026-09-26T02:00:00Z", customType: "jev-review-requirement",
      data: { requestHash: "legacy", workId: "legacy-work", goal, required: true, checkpoint: "fan-out", reason: "Legacy tier dispatch", generation: 0,
        promptReview: true, dispatches: [{ key: "legacy-key", summary: "Compensation (task-challenge): Implement compensation." }], dispatchVersion: 1 } });
    expect(gate.scope(ctx)).toMatchObject({ required: true, dispatchComplete: false, satisfied: false });
    expect(gate.beforeTool(ctx, "task", batch, "call-1")?.block).toBe(true);
    expect(gate.scope(ctx)).toMatchObject({ dispatchComplete: true, satisfied: false,
      dispatchSummary: [expect.stringContaining("Compensation (task):"), expect.stringContaining("Telemetry (task):")] });
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
    gate.beforeTool(ctx, "task", batch, "call-1");
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
    gate.beforeTool(ctx, "task", batch, "call-1");
    const reviewed = gate.scope(ctx);
    gate.complete(ctx, reviewed, true);
    branch.push({ type: "message", id: "continue", parentId: null, timestamp: "2026-09-27T00:00:00Z",
      message: { role: "user", content: "Continue the accepted plan", timestamp: 2 } });
    gate.noteDecision(ctx, true, "initial-plan", "review-required", "Continue the accepted plan", reviewed.workId);
    expect(gate.beforeTool(ctx, "edit", {})).toBeUndefined();
    expect(gate.beforeTool(ctx, "task", batch, "call-2")).toBeUndefined();
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

describe("live task contract", () => {
  for (const shape of ["batch", "flat"] as const) {
    test(`a ${shape} declaration authorizes the call OMP executes from it until the native default changes`, () => {
      const { gate, ctx, api } = fixture();
      api.taskSchema.batchEnabled = shape === "batch";
      gate.noteDecision(ctx, true, "initial-plan", "release", goal);
      // The plan omits agent and carries an intent plus a field the live schema does not declare.
      const worker = { name: "Ledger", task: "Persist compensation", note: "undeclared" };
      const declared = shape === "batch" ? { i: "Release plan", context: "Release", tasks: [worker] } : { i: "Release plan", ...worker };
      gate.stageDispatch(ctx, declared);
      gate.complete(ctx, gate.scope(ctx), true);
      expect(gate.beforeTool(ctx, "task", hostArgs(api.pi, declared), "call-1")).toBeUndefined();
      expect(gate.beforeSpawn(ctx, spawn("Ledger"))).toBeUndefined();
      gate.observeToolResult(ctx, taskResult("call-1"));
      // The same declaration now resolves to another agent, so the reviewed contract no longer applies.
      api.taskSchema.defaultAgent = "sonic";
      expect(gate.beforeTool(ctx, "task", hostArgs(api.pi, declared), "call-2")?.block).toBe(true);
      expect(gate.scope(ctx).satisfied).toBe(false);
    });
  }
  test("a changed output field named i needs a new review", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const call = (type: string) => ({ context: "Release", tasks: [{ name: "Ledger", task: "Persist compensation", outputSchema: { properties: { i: { type } } } }] });
    gate.stageDispatch(ctx, call("string"));
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeTool(ctx, "task", call("number"), "call-1")?.block).toBe(true);
    expect(gate.scope(ctx).satisfied).toBe(false);
  });
  test("a shared call field beside the worker list needs a new review", () => {
    const { gate, ctx, api } = fixture();
    api.taskSchema.isolationEnabled = true;
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    gate.stageDispatch(ctx, batch);
    gate.complete(ctx, gate.scope(ctx), true);
    // OMP keeps a top-level isolated flag and applies it to every item that sets none itself.
    expect(gate.beforeTool(ctx, "task", { ...batch, isolated: true }, "call-1")?.block).toBe(true);
    expect(gate.scope(ctx).satisfied).toBe(false);
  });
  test("input the live schema rejects stages no scope and issues no permit", () => {
    const { gate, ctx } = fixture();
    gate.noteDecision(ctx, true, "initial-plan", "release", goal);
    const before = gate.scope(ctx);
    // task.batch is on, so the flat shape is not a valid call.
    const flat = { name: "Flat", task: "Implement compensation" };
    expect(gate.beforeTool(ctx, "task", flat, "call-1")?.block).toBe(true);
    expect(() => gate.stageDispatch(ctx, flat)).toThrow();
    expect(gate.scope(ctx)).toEqual(before);
  });
  test("a gate without the live task contract fails closed for task declarations", () => {
    const { ctx } = fixture();
    const gate = new ReviewGate();
    expect(gate.beforeTool(ctx, "task", batch, "call-1")?.block).toBe(true);
    expect(() => gate.stageDispatch(ctx, batch)).toThrow();
    expect(gate.scope(ctx).dispatchSummary).toEqual([]);
  });
});

describe("native spawn permits", () => {
  test("unnamed implementation workers are refused while OMP may preallocate random ids", () => {
    const { gate, ctx } = fixture();
    const unnamed = { context: "Cleanup", tasks: [{ task: "Rename local variable" }] };
    const before = gate.scope(ctx);
    expect(gate.beforeTool(ctx, "task", unnamed, "call-1")?.block).toBe(true);
    expect(() => gate.stageDispatch(ctx, unnamed)).toThrow();
    expect(gate.scope(ctx)).toEqual(before);
    expect(gate.beforeSpawn(ctx, spawn("call-1:0"))?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", { context: "Scoping", tasks: [{ agent: "scout", task: "Map entry points" }] }, "call-2")).toBeUndefined();
  });
  test("without async execution an unnamed worker matches only its own call id and index", () => {
    const { gate, ctx } = fixture({ asyncExecution: false });
    expect(gate.beforeTool(ctx, "task", { context: "Cleanup", tasks: [{ task: "Rename local variable" }] }, "call-7")).toBeUndefined();
    for (const key of ["call-8:0", "call-7:1", "Rename", undefined]) expect(gate.beforeSpawn(ctx, spawn(key))?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, spawn("call-7:0"))).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("call-7:0"))?.block).toBe(true);
  });
  test("workers whose spawn identities could collide are refused before staging or permits", () => {
    const { gate, ctx } = fixture();
    // OMP gives a second "Worker" the id "Worker-2", so that id could belong to either worker.
    const colliding = { context: "Shared", tasks: [{ name: "Worker", task: "a" }, { name: "Worker-2", task: "b" }] };
    const before = gate.scope(ctx);
    expect(gate.beforeTool(ctx, "task", colliding, "call-1")?.block).toBe(true);
    expect(() => gate.stageDispatch(ctx, colliding)).toThrow();
    expect(gate.scope(ctx)).toEqual(before);
    const single = { context: "Shared", tasks: [{ name: "Worker", task: "a" }] };
    expect(gate.beforeTool(ctx, "task", single, "call-2")).toBeUndefined();
    // A same-named call cannot be told apart from the approved worker that has not started.
    expect(gate.beforeTool(ctx, "task", single, "call-3")?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, spawn("Worker"))).toBeUndefined();
    // Once it started, OMP suffixes the next "Worker" and the identity is unambiguous again.
    expect(gate.beforeTool(ctx, "task", single, "call-4")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Worker-2"))).toBeUndefined();
  });
  test("a re-emitted tool_call never adds a permit for the same worker", () => {
    const { gate, ctx } = fixture();
    const call = { context: "Cleanup", tasks: [{ name: "Rename", task: "Rename local variable" }] };
    expect(gate.beforeTool(ctx, "task", call, "call-1")).toBeUndefined();
    expect(gate.beforeTool(ctx, "task", call, "call-1")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Rename"))).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Rename-2"))?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", call, "call-1")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Rename-2"))?.block).toBe(true);
  });
  test("a finished call keeps only the permits of workers queued behind an async return", () => {
    const { gate, ctx, jobs } = fixture();
    const pair = { context: "Independent", tasks: [{ name: "Alpha", task: "a" }, { name: "Beta", task: "b" }] };
    gate.stageDispatch(ctx, pair);
    gate.complete(ctx, gate.scope(ctx), true);
    expect(gate.beforeTool(ctx, "task", pair, "sync")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Alpha"))).toBeUndefined();
    gate.observeToolResult(ctx, taskResult("sync"));
    expect(gate.beforeSpawn(ctx, spawn("Beta"))?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", pair, "async")).toBeUndefined();
    // "Alpha" already ran, so OMP allocated "Alpha-2"; each queued job reports exactly its allocated id.
    jobs.push("Alpha-2", "Beta");
    gate.observeToolResult(ctx, taskResult("async", { queued: ["Alpha-2", "Beta"] }));
    expect(gate.beforeSpawn(ctx, spawn("Alpha-3"))?.block).toBe(true);
    expect(gate.beforeSpawn(ctx, spawn("Alpha-2"))).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Beta"))).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Beta-2"))?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", pair, "failed")).toBeUndefined();
    gate.observeToolResult(ctx, taskResult("failed", "error"));
    expect(gate.beforeSpawn(ctx, spawn("Alpha-3"))?.block).toBe(true);
  });
  test("a queued worker stopped before it spawned frees its name while a live one keeps it", () => {
    const { gate, ctx, jobs } = fixture();
    const call = { context: "Cleanup", tasks: [{ name: "Worker", task: "Rename local variable" }] };
    expect(gate.beforeTool(ctx, "task", call, "call-1")).toBeUndefined();
    jobs.push("Worker");
    gate.observeToolResult(ctx, taskResult("call-1", { queued: ["Worker"] }));
    // While its job waits, a same-named worker cannot be told apart from it.
    expect(gate.beforeTool(ctx, "task", call, "call-2")?.block).toBe(true);
    // Cancelled or failed while queued, the job never spawns: its permit neither authorizes nor reserves anything.
    jobs.length = 0;
    expect(gate.beforeSpawn(ctx, spawn("Worker"))?.block).toBe(true);
    expect(gate.beforeTool(ctx, "task", call, "call-3")).toBeUndefined();
    expect(gate.beforeSpawn(ctx, spawn("Worker-2"))).toBeUndefined();
  });
  test("ending the session discards permits of workers still waiting to start", () => {
    const { gate, ctx, jobs } = fixture();
    expect(gate.beforeTool(ctx, "task", { context: "Cleanup", tasks: [{ name: "Queued", task: "x" }] }, "call-1")).toBeUndefined();
    jobs.push("Queued");
    gate.observeToolResult(ctx, taskResult("call-1", { queued: ["Queued"] }));
    gate.clearSession(ctx.sessionManager.getSessionId());
    expect(gate.beforeSpawn(ctx, spawn("Queued"))?.block).toBe(true);
  });
});
