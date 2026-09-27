import { createHash } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BeforeSubagentSpawnEvent, BeforeSubagentSpawnEventResult, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Checkpoint } from "./advisor-review.ts";
import { mainSessionOf } from "./host.ts";
import { latestCommittedTodoPlan, visibleText } from "./routing-context.ts";
import { findingRevision } from "./findings.ts";
import { normalizeCall } from "./task-routing.ts";

const STATE = "jev-review-requirement";
const RECEIPT = "jev-review-receipt";
const WAIVER = "jev-review-waiver";

// write is the device transport, not necessarily a mutation.
// Arbitrary execution and unrecognized devices remain gated.
const OBSERVATION_DEVICES: Record<string, true> = {
  "xd://mcp__codegraph_explore": true,
  "xd://mcp__roblox_studio_list_roblox_studios": true,
  "xd://mcp__roblox_studio_get_studio_state": true,
  "xd://mcp__roblox_studio_get_console_output": true,
  "xd://mcp__roblox_studio_inspect_instance": true,
  "xd://mcp__roblox_studio_script_read": true,
  "xd://mcp__roblox_studio_script_search": true,
  "xd://mcp__roblox_studio_script_grep": true,
  "xd://mcp__roblox_studio_search_game_tree": true,
};
const FAILURE = "jev-review-failure";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => key !== "i").map(key => [key, canonical(value[key])]));
}
function workerName(value: unknown): string {
  return typeof value === "string" && !["task-easy", "task-hard", "task-challenge"].includes(value) ? value : "task";
}
function requestText(branch: readonly SessionEntry[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    if (entry.message.synthetic || entry.message.attribution === "agent") continue;
    const text = visibleText(entry.message.content);
    if (text && !text.startsWith("<system-") && !text.startsWith("/")) return text;
  }
  return "";
}
interface Requirement {
  requestHash: string;
  workId: string;
  goal: string;
  required: boolean;
  checkpoint: Checkpoint;
  reason: string;
  generation: number;
  /** Latest assessment controls prompting, not outstanding execution protection. */
  promptReview?: boolean;
  dispatches: { key: string; summary: string }[];
}
export interface ReviewScope {
  key: string;
  requestHash: string;
  workId: string;
  planHash: string;
  findingRevision: string;
  checkpoint: Checkpoint;
  required: boolean;
  reason: string;
  dispatchSummary: string[];
  satisfied: boolean;
  failed: boolean;
}
const CHECKPOINTS: readonly string[] = ["initial-plan", "fan-out", "repeated-failure", "replan", "phase-boundary", "scope-expansion", "escalation"];

/** Receipts are branch-local facts, not a process-wide "review happened" flag. */
export class ReviewGate {
  private readonly nativePermits = new Map<string, number>();
  private persistenceFault = false;
  private readonly noticeAnchors = new Map<string, { index: number; timestamp: number }>();
  constructor(private readonly enabled: () => boolean = () => true) {}

  private branch(ctx: ExtensionContext): readonly SessionEntry[] {
    return ctx.sessionManager.getBranch();
  }
  private persist(ctx: ExtensionContext, type: string, data: unknown): void {
    const primary = mainSessionOf(ctx);
    if (!primary) throw new Error("Review gate is primary-only.");
    try {
      primary.sessionManager.appendCustomEntry(type, data);
      this.persistenceFault = false;
    } catch (error) {
      this.persistenceFault = true;
      throw error;
    }
  }
  private requirement(branch: readonly SessionEntry[], requestHash: string): Requirement {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type !== "custom" || entry.customType !== STATE || !record(entry.data)) continue;
      const d = entry.data;
      if (typeof d.requestHash !== "string" || typeof d.required !== "boolean" || typeof d.checkpoint !== "string" || !CHECKPOINTS.includes(d.checkpoint) ||
          typeof d.reason !== "string" || typeof d.generation !== "number" || !Array.isArray(d.dispatches)) continue;
      if (!d.dispatches.every(item => record(item) && typeof item.key === "string" && typeof item.summary === "string")) continue;
      return { ...d, workId: typeof d.workId === "string" ? d.workId : hash(entry.id),
        goal: typeof d.goal === "string" ? d.goal : "Historical task" } as unknown as Requirement;
    }
    return { workId: hash(["unassigned", requestHash]), goal: "", requestHash, required: false, checkpoint: "initial-plan", reason: "No mandatory review for this request.", generation: 0, dispatches: [] };
  }
  scope(ctx: ExtensionContext): ReviewScope {
    const branch = this.branch(ctx);
    const requestHash = hash(requestText(branch));
    const state = this.requirement(branch, requestHash);
    const phases = latestCommittedTodoPlan(branch) ?? [];
    // Routine status changes do not invalidate a reviewed plan. Phase boundaries
    // and actual scope edits are tracked separately by the requirement generation.
    const planHash = hash(phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(task => ({
      content: task.content,
      blocked: task.status === "blocked" ? task.blocker ?? "blocked" : undefined,
      abandoned: task.status === "abandoned" || undefined,
    })) })));
    const revision = findingRevision(branch);
    const key = hash({ version: 3, workId: state.workId, planHash, generation: state.generation, dispatches: state.dispatches.map(d => d.key).sort(), revision });
    let satisfied = false;
    let failed = false;
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e?.type !== "custom" || !record(e.data) || e.data.scopeKey !== key) continue;
      if (e.customType === RECEIPT && e.data.success === true) { satisfied = true; break; }
      if (e.customType === WAIVER && e.data.author === "user" && typeof e.data.reason === "string") { satisfied = true; break; }
      if (e.customType === FAILURE) { failed = true; break; }
    }
    return { key, requestHash, workId: state.workId, planHash, findingRevision: revision, checkpoint: state.checkpoint,
      required: state.required, reason: state.reason, dispatchSummary: state.dispatches.map(d => d.summary), satisfied, failed };
  }
  noteDecision(ctx: ExtensionContext, required: boolean, checkpoint: Checkpoint, reason: string, request: string, workScope?: string): boolean | undefined {
    if (!this.enabled() || !mainSessionOf(ctx)) return;
    const branch = this.branch(ctx);
    const requestHash = hash(request.trim());
    const active = this.requirement(branch, requestHash);
    let before = active;
    if (workScope && workScope !== "NEW" && workScope !== "CONTINUE") {
      const index = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === STATE &&
        record(entry.data) && entry.data.workId === workScope);
      if (index >= 0) before = this.requirement(branch.slice(0, index + 1), requestHash);
      else workScope = "NEW"; // Unknown or off-branch scopes cannot inherit approval.
    }
    const fresh = workScope === "NEW" ||
      (!workScope && checkpoint === "initial-plan" && active.requestHash !== requestHash);
    if (fresh) {
      before = { workId: hash({ requestHash, parent: branch.at(-1)?.id ?? null }),
        goal: request.trim().slice(0, 600), requestHash, required: false, checkpoint: "initial-plan",
        reason: "New work scope", generation: 0, dispatches: [] };
    }
    const deferred = checkpoint === "initial-plan";
    const generation = before.generation +
      (required && ["phase-boundary", "repeated-failure", "replan"].includes(checkpoint) ? 1 : 0);
    const next: Requirement = { ...before, requestHash, required: required || before.required,
      goal: before.goal || request.trim().slice(0, 600),
      promptReview: required && !deferred, checkpoint: required ? checkpoint : before.checkpoint,
      reason: required ? reason.slice(0, 500) : before.reason, generation };
    if (JSON.stringify(next) !== JSON.stringify(active)) this.persist(ctx, STATE, next);
    return next.required;
  }
  observeToolResult(ctx: ExtensionContext, event: ToolResultEvent): void {
    if (!this.enabled() || !mainSessionOf(ctx) || !event.isError ||
        !["task", "edit", "write", "bash", "eval"].includes(event.toolName)) return;
    const text = visibleText(event.content).slice(0, 500);
    if (!text || text.includes("Review required BEFORE execution")) return;
    const branch = this.branch(ctx);
    const request = requestText(branch);
    const problemHash = hash({ request, tool: event.toolName, text });
    if (branch.some(e => e.type === "custom" && e.customType === "jev-reviewed-failure-trigger" &&
        record(e.data) && e.data.problemHash === problemHash)) return;
    for (let index = branch.length - 1; index >= 0; index--) {
      const e = branch[index];
      if (e?.type !== "message") continue;
      if (e.message.role === "user") break;
      if (e.message.role === "toolResult" && e.message.toolCallId !== event.toolCallId &&
          e.message.toolName === event.toolName && e.message.isError &&
          visibleText(e.message.content).slice(0, 500) === text) {
        this.noteDecision(ctx, true, "repeated-failure", "Two matching execution failures in this request; review the approach before another attempt.", request);
        this.persist(ctx, "jev-reviewed-failure-trigger", { problemHash });
        return;
      }
    }
  }
  private stage(ctx: ExtensionContext, key: string, summary: string, checkpoint: Checkpoint, reason: string, accumulate = false): void {
    const scope = this.scope(ctx);
    const state = this.requirement(this.branch(ctx), scope.requestHash);
    const exists = state.dispatches.some(d => d.key === key);
    const dispatches = exists ? state.dispatches : accumulate
      ? [...state.dispatches, { key, summary: summary.slice(0, 1600) }]
      : [{ key, summary: summary.slice(0, 1600) }];
    const next = { ...state, required: true, promptReview: true, checkpoint, reason, dispatches };
    if (JSON.stringify(next) !== JSON.stringify(state)) this.persist(ctx, STATE, next);
  }
  private denial(scope: ReviewScope): ToolCallEventResult {
    return { block: true, reason: `Review required BEFORE execution (${scope.checkpoint}); scope ${scope.key}. ${scope.reason} ` +
      (scope.failed ? "The last review failed. Report that failure; do not loop on retries. " : "") +
      `Call orche_advisor with checkpoint '${scope.checkpoint}' and the seven-field snapshot, read its result, then retry the same operation. ` +
      "A changed plan, dispatch, or finding state needs a fresh review. Only the user can waive via /review-waive <scope-key> <reason>." };
  }
  beforeTool(ctx: ExtensionContext, name: string, input: Record<string, unknown>): ToolCallEventResult | undefined {
    if (!this.enabled() || !mainSessionOf(ctx)) return undefined;
    if (this.persistenceFault && !["read", "grep", "glob", "find", "ask", "orche_advisor", "review_findings"].includes(name)) {
      return { block: true, reason: "Review state could not be persisted. Restore session storage and obtain a successful review before execution." };
    }
    // Initial risk is only an assessment. Read-only work must not turn it into
    // a mandatory review, even when new findings invalidate an old receipt.
    if (["read", "grep", "glob", "find", "web_search", "ask", "todo", "wait", "orche_advisor", "review_findings"].includes(name)) return undefined;
    if (name === "write" && typeof input.path === "string" && Object.hasOwn(OBSERVATION_DEVICES, input.path)) return undefined;
    if (name === "task") {
      const call = normalizeCall(input);
      if (call && call.items.every(item => ["scout", "librarian"].includes(String(item.agent)))) return undefined;
    }
    this.activateExecution(ctx);
    let scope = this.scope(ctx);
    if (name === "task") {
      const call = normalizeCall(input);
      if (!call) return undefined;
      // Bounded read-only scouting remains available while the plan is formed.
      const implementations = call.items.filter(item => !["scout", "librarian"].includes(String(item.agent)));
      if (implementations.length === 0) return undefined;
      if (implementations.length >= 2 || scope.required) {
        const dispatch = { context: call.context ?? "", tasks: call.items.map(item => ({ ...item, agent: workerName(item.agent) })) };
        this.stage(ctx, hash(canonical(dispatch)), call.items.map(item => `${String(item.name ?? "worker")} (${workerName(item.agent)}): ${String(item.task ?? "").slice(0, 450)}`).join("\n"),
          scope.required ? scope.checkpoint : "fan-out", implementations.length >= 2 ? "Multiple implementation workers require a scope-bound pre-dispatch review." : scope.reason);
        scope = this.scope(ctx);
      }
      if (!scope.required) {
        for (const item of implementations) {
          const key = `${ctx.sessionManager.getSessionId()}:${scope.workId}:${workerName(item.agent)}`;
          this.nativePermits.set(key, (this.nativePermits.get(key) ?? 0) + 1);
        }
      }
    }
    if (!scope.required || scope.satisfied) return undefined;
    // Arbitrary execution can mutate files or dispatch agents. Unknown tools
    // are not assumed read-only; shell/eval strings are never regex-classified.
    if (["read", "grep", "glob", "find", "web_search", "ask", "todo", "wait", "orche_advisor", "review_findings"].includes(name)) return undefined;
    if (name === "write" && typeof input.path === "string" && Object.hasOwn(OBSERVATION_DEVICES, input.path)) return undefined;
    return this.denial(scope);
  }
  private activateExecution(ctx: ExtensionContext): void {
    const scope = this.scope(ctx);
    const state = this.requirement(this.branch(ctx), scope.requestHash);
    if (!state.required) return;
    if (!scope.satisfied && !state.promptReview) {
      this.persist(ctx, STATE, { ...state, promptReview: true });
    }
  }
  beforeSpawn(ctx: ExtensionContext, event: BeforeSubagentSpawnEvent): BeforeSubagentSpawnEventResult | undefined {
    if (!this.enabled() || !mainSessionOf(ctx) || ["scout", "librarian"].includes(event.agent)) return undefined;
    if (this.persistenceFault) return { block: true, reason: "Review state storage failed; worker dispatch remains blocked." };
    this.activateExecution(ctx);
    if (event.invocationKind === "eval") {
      // This shared host hook runs before allocation/execution for eval agent()
      // and workpool too. Its contract exposes identity/model, not task text.
      let invocation: unknown;
      const branch = this.branch(ctx);
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type !== "message") continue;
        if (entry.message.role === "user") break;
        if (entry.message.role !== "assistant") continue;
        const calls = entry.message.content.flatMap(part =>
          part.type === "toolCall" && part.name === "eval" ? [canonical(part.arguments)] : []);
        if (calls.length > 0) {
          invocation = calls;
          break;
        }
      }
      const sourceKey = hash(invocation ?? null);
      const key = hash({ agent: workerName(event.agent), patterns: event.patterns, spawnKey: event.spawnKey ?? "unnamed", sourceKey });
      this.stage(ctx, key, `eval worker ${event.spawnKey ?? "unnamed"} (${event.agent}); caller fingerprint ${sourceKey}; model patterns ${event.patterns.join(", ")}`,
        "fan-out", "Programmatic implementation dispatch must be reviewed before execution. Use stable agent names when retrying.", true);
    } else if (!this.scope(ctx).required) {
      const key = `${ctx.sessionManager.getSessionId()}:${this.scope(ctx).workId}:${workerName(event.agent)}`;
      const permits = this.nativePermits.get(key) ?? 0;
      if (permits > 0) {
        this.nativePermits.set(key, permits - 1);
        return undefined;
      }
      this.stage(ctx, hash({ agent: event.agent, spawnKey: event.spawnKey, patterns: event.patterns }),
        `Unstaged worker ${event.spawnKey ?? "unnamed"} (${event.agent})`, "fan-out",
        "Implementation dispatch bypassed the task preflight; review its scope before spawning.", true);
    }
    const scope = this.scope(ctx);
    return scope.required && !scope.satisfied ? this.denial(scope) : undefined;
  }
  complete(ctx: ExtensionContext, captured: ReviewScope, success: boolean, requestId?: string): void {
    const state = this.requirement(this.branch(ctx), captured.requestHash);
    // A late result cannot clear or promote another task's state.
    if (this.scope(ctx).key === captured.key && state.workId === captured.workId) {
      this.persist(ctx, STATE, { ...state, required: true, promptReview: !success });
    }
    this.persist(ctx, success ? RECEIPT : FAILURE, { scopeKey: captured.key, success, requestId, checkpoint: captured.checkpoint,
      planHash: captured.planHash, findingRevision: captured.findingRevision, at: Date.now() });
  }
  guidance(ctx: ExtensionContext): string | undefined {
    if (!this.enabled() || !mainSessionOf(ctx)) return undefined;
    const scope = this.scope(ctx);
    if (!scope.failed && this.requirement(this.branch(ctx), scope.requestHash).promptReview === false) return undefined;
    if (!scope.required || scope.satisfied) return undefined;
    return `<system-notice>Mandatory orchestration review pending: ${scope.checkpoint}. ${scope.reason}\n` +
      "Read-only scoping and todo planning may continue; implementation and worker dispatch are blocked until a successful scope-bound orche_advisor review. " +
      "For a worker batch, submit task once to stage its exact scope (blocked before execution), then review and retry unchanged; alternatively pass the planned dispatch to orche_advisor. " +
      `Scope: ${scope.key}. ${scope.failed ? "Previous review failed: report the error, do not repeatedly retry." : ""}</system-notice>`;
  }
  applyGuidance(ctx: ExtensionContext, messages: AgentMessage[]): AgentMessage[] | undefined {
    const content = this.guidance(ctx);
    if (!content || messages.some(m => m.role === "custom" && m.customType === "jev-review-required" && m.content === content)) return undefined;
    let anchor = this.noticeAnchors.get(content);
    if (!anchor || anchor.index > messages.length) {
      anchor = { index: messages.length, timestamp: Date.now() };
      this.noticeAnchors.set(content, anchor);
      if (this.noticeAnchors.size > 64) this.noticeAnchors.delete(this.noticeAnchors.keys().next().value!);
    }
    const next = [...messages];
    next.splice(anchor.index, 0, { role: "custom", customType: "jev-review-required",
      content, display: false, attribution: "agent", timestamp: anchor.timestamp });
    return next;
  }
  /** Optionally predeclare exact dispatch so one review covers planning and fan-out. */
  stageDispatch(ctx: ExtensionContext, input: Record<string, unknown>): void {
    const call = normalizeCall(input);
    if (!call) throw new Error("dispatch must contain a task or a non-empty tasks array.");
    if (call.items.some(item => typeof item.task !== "string" || !item.task.trim())) throw new Error("Every planned worker needs task text.");
    const dispatch = { context: call.context ?? "", tasks: call.items.map(item => ({ ...item, agent: workerName(item.agent) })) };
    this.stage(ctx, hash(canonical(dispatch)), call.items.map(item => `${String(item.name ?? "worker")} (${workerName(item.agent)}): ${String(item.task).slice(0, 450)}`).join("\n"), "fan-out", "Review the predeclared worker dispatch before execution.");
  }
  registerCommands(pi: ExtensionAPI): void {
    pi.registerCommand("review-status", {
      description: "Show the current mandatory review scope and receipt state.",
      handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(this.scope(ctx), null, 2), "info"); },
    });
    pi.registerCommand("review-retry", {
      description: "Authorize one retry after failure: /review-retry <full-scope-key> <reason>.",
      handler: async (args, ctx) => {
        const [key, ...words] = args.trim().split(/\s+/);
        const reason = words.join(" ");
        const scope = this.scope(ctx);
        if (!mainSessionOf(ctx) || !scope.failed || key !== scope.key || !reason) {
          ctx.ui.notify("Use /review-status, then /review-retry <failed scope key> <reason>. No retry authorized.", "warning");
          return;
        }
        const state = this.requirement(this.branch(ctx), scope.requestHash);
        this.persist(ctx, STATE, { ...state, required: true, generation: state.generation + 1,
          reason: `User authorized review retry: ${reason.slice(0, 400)}` });
        ctx.ui.notify("One new review attempt authorized. Execution remains blocked until it succeeds.", "info");
      },
    });
    pi.registerCommand("review-waive", {
      description: "Explicit user-only waiver: /review-waive <full-scope-key> <reason>.",
      handler: async (args, ctx) => {
        const [key, ...words] = args.trim().split(/\s+/);
        const reason = words.join(" ");
        const scope = this.scope(ctx);
        if (!mainSessionOf(ctx) || !scope.required || key !== scope.key || !reason) {
          ctx.ui.notify("Use /review-status, then /review-waive <current full scope key> <reason>. No waiver recorded.", "warning");
          return;
        }
        this.persist(ctx, WAIVER, { scopeKey: scope.key, author: "user", reason: reason.slice(0, 1000), at: Date.now() });
        ctx.ui.notify("Review waived for this exact scope only. Findings remain recorded; changed scope requires a new review.", "warning");
      },
    });
  }
}
