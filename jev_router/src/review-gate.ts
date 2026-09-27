import { createHash } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import type { BeforeSubagentSpawnEvent, BeforeSubagentSpawnEventResult, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { Checkpoint, ReviewFailureKind } from "./advisor-review.ts";
import { mainSessionOf } from "./host.ts";
import { latestCommittedTodoPlan, visibleText } from "./routing-context.ts";
import { findingRevision } from "./findings.ts";
import type { NormalizedCall } from "./task-contract.ts";

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
/** Scope keys changed meaning with this version; earlier receipts and waivers never match. */
const SCOPE_VERSION = 5;
/** Dispatch keys hash the live-validated native contract from this version on. */
const DISPATCH_VERSION = 2;
const READ_ONLY_TOOLS: Record<string, true> = {
  read: true, grep: true, glob: true, find: true, web_search: true, ask: true, todo: true, wait: true, orche_advisor: true, review_findings: true,
};
const PERSISTENCE_SAFE_TOOLS: Record<string, true> = {
  read: true, grep: true, glob: true, find: true, ask: true, orche_advisor: true, review_findings: true,
};
/** Bounded read-only scouting remains available while the plan is formed. */
const READ_ONLY_AGENTS: Record<string, true> = { scout: true, librarian: true };
/** OMP's collision suffix for a repeated output id: `-2`, `-3`, … */
const COLLISION_SUFFIX = /^(?:[2-9]|[1-9]\d+)$/;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Key-sorted copy, so a hash never depends on property order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
/** Tool arguments without the top-level intent, which the agent loop strips before execution. */
function withoutIntent(args: unknown): unknown {
  if (!record(args)) return args;
  const rest = { ...args };
  delete rest.i;
  return rest;
}
function agentOf(item: Record<string, unknown>): string {
  return typeof item.agent === "string" ? item.agent.trim() : "";
}
/** The failure reason, without the validator's echo of every received argument. */
function failure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n\nReceived arguments")[0] ?? text).replace(/\s+/g, " ").trim().slice(0, 600);
}
/** One key per worker over the whole validated call: shared fields, agents, task text and every execution field. */
function nativeDispatch(call: NormalizedCall): Requirement["dispatches"] {
  const batchKey = hash(canonical(call.input));
  return call.items.map((item, index) => {
    const task = String(item.task ?? "");
    return { key: hash({ batchKey, index }),
      summary: `${String(item.name ?? `worker-${index + 1}`)} (${String(item.agent)}): ${task.slice(0, 450)}${task.length > 450 ? " [task text truncated]" : ""}` };
  });
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

/**
 * The spawn keys OMP 18.3.1 can report in `before_subagent_spawn` for one task
 * item. The event carries no call id, item index or task text, so a permit is
 * matched on this key string and the agent alone:
 *  - sync execution reports `identity.label`, the item's raw `name`, or else
 *    `${toolCallId}:${index}` (`structured-subagent.ts` applySpawnHook);
 *  - async execution preallocates `outputManager.allocate(name.trim() || random)`
 *    and reports that id: the trimmed name, or `name-N` when the session already
 *    used it (`task/index.ts`, `output-manager.ts`).
 * An async return then names each worker's allocated id in `details.progress`
 * (by item index), and its job runs under that `agentId` until it settles.
 */
interface SpawnIdentity {
  index: number;
  agent: string;
  keys: string[];
  /** Base of the `${base}-N` collision ids async allocation may report. */
  suffixBase?: string;
}
interface Permit extends SpawnIdentity {
  toolCallId: string;
  /** The worker started; kept until its call returns so a re-emitted tool_call cannot re-issue it. */
  consumed: boolean;
  /** Its call returned asynchronously and bound it to its allocated id: the job has not spawned yet. */
  returned: boolean;
}
interface PermitLedger {
  scopeKey: string;
  permits: Permit[];
}
function matchesKey(identity: SpawnIdentity, key: string): boolean {
  if (identity.keys.includes(key)) return true;
  const base = identity.suffixBase;
  return base !== undefined && key.startsWith(`${base}-`) && COLLISION_SUFFIX.test(key.slice(base.length + 1));
}
/** Whether one spawn event could match both identities; distinct bases never share a collision id. */
function overlaps(a: SpawnIdentity, b: SpawnIdentity): boolean {
  if (a.agent !== b.agent) return false;
  if (a.suffixBase !== undefined && a.suffixBase === b.suffixBase) return true;
  return a.keys.some(key => matchesKey(b, key)) || b.keys.some(key => matchesKey(a, key));
}
function workerLabel(name: unknown, index: number): string {
  return typeof name === "string" && name.trim() ? `"${name.trim()}"` : `#${index + 1}`;
}
function spawnIdentity(item: Record<string, unknown>, index: number, toolCallId: string | undefined, preallocated: boolean): SpawnIdentity | string {
  const agent = agentOf(item);
  if (!agent) return `Worker ${workerLabel(item.name, index)} has a blank agent; omit agent for OMP's default or name one, then resubmit.`;
  const name = typeof item.name === "string" ? item.name : undefined;
  const base = name?.trim() || undefined;
  if (preallocated && base === undefined) {
    return `Worker ${workerLabel(item.name, index)} needs a unique native \`name\`: with async execution enabled OMP gives unnamed workers random ids that cannot be matched to a reviewed spawn permit. Name it and resubmit.`;
  }
  const keys = name !== undefined ? [name] : toolCallId !== undefined ? [`${toolCallId}:${index}`] : [];
  if (preallocated && base !== undefined && !keys.includes(base)) keys.push(base);
  return { index, agent, keys, ...(preallocated ? { suffixBase: base } : {}) };
}
/** Whether OMP may preallocate spawn ids: its `async.enabled` setting, as `task/index.ts` reads it. */
function preallocatesIds(ctx: ExtensionContext): boolean {
  const settings = mainSessionOf(ctx)?.settings;
  try {
    return settings ? cfgAsyncEnabled.get(settings) : true;
  } catch {
    return true; // Unknown: require names rather than guess.
  }
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
  /** Earlier versions hashed truncated summaries, tier aliases or unvalidated input; they must be restaged. */
  dispatchVersion?: number;
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
  dispatchComplete: boolean;
  satisfied: boolean;
  failed: boolean;
  unavailable: boolean;
}
const CHECKPOINTS: readonly string[] = ["initial-plan", "fan-out", "repeated-failure", "replan", "phase-boundary", "scope-expansion", "escalation"];

/** Receipts are branch-local facts, not a process-wide "review happened" flag. */
export class ReviewGate {
  /** Native spawn permits per session, bound to the scope they were issued under. */
  private readonly permits = new Map<string, PermitLedger>();
  private persistenceFault = false;
  private readonly noticeAnchors = new Map<string, { index: number; timestamp: number }>();
  constructor(
    private readonly enabled: () => boolean = () => true,
    /** Live native task normalization (`prepareDispatch`); without it task declarations fail closed. */
    private readonly prepareInput?: (input: Record<string, unknown>) => NormalizedCall,
  ) {}

  private branch(ctx: ExtensionContext): readonly SessionEntry[] {
    return ctx.sessionManager.getBranch();
  }
  private persist(ctx: ExtensionContext, type: string, data: unknown): void {
    const primary = mainSessionOf(ctx);
    if (!primary) throw new Error("Review gate is primary-only.");
    try {
      primary.sessionManager.appendCustomEntry(type, data);
      const sessionId = ctx.sessionManager.getSessionId();
      const ledger = this.permits.get(sessionId);
      if (ledger && (ledger.scopeKey !== this.scope(ctx).key || type === FAILURE)) {
        this.permits.delete(sessionId);
      }
      this.persistenceFault = false;
    } catch (error) {
      this.persistenceFault = true;
      throw error;
    }
  }
  private prepare(input: Record<string, unknown>): NormalizedCall {
    if (!this.prepareInput) throw new Error("the live native task contract is unavailable to the review gate");
    return this.prepareInput(input);
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
    const key = hash({ version: SCOPE_VERSION, workId: state.workId, planHash, generation: state.generation, dispatches: state.dispatches.map(d => d.key).sort(), revision });
    let satisfied = false;
    let failed = false;
    let unavailable = false;
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e?.type !== "custom" || !record(e.data) || e.data.scopeKey !== key) continue;
      if (e.customType === RECEIPT && e.data.success === true) { satisfied = true; break; }
      if (e.customType === WAIVER && e.data.author === "user" && typeof e.data.reason === "string") { satisfied = true; break; }
      if (e.customType === FAILURE) {
        // Historical untyped failures meant no usable review, not rejection.
        failed = e.data.failureKind === "review_rejected";
        unavailable = !failed;
        break;
      }
    }
    return { key, requestHash, workId: state.workId, planHash, findingRevision: revision, checkpoint: state.checkpoint,
      required: state.required, reason: state.reason, dispatchSummary: state.dispatches.map(d => d.summary),
      dispatchComplete: state.dispatches.length === 0 || state.dispatchVersion === DISPATCH_VERSION, satisfied, failed, unavailable };
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
    if (event.toolName === "task") this.settlePermits(ctx.sessionManager.getSessionId(), event);
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
  /** Discard every spawn permit of a session that shut down or navigated. */
  clearSession(sessionId: string): void {
    this.permits.delete(sessionId);
  }
  /**
   * A finished task call keeps only the permits of workers queued behind its
   * async return, each narrowed to the output id OMP allocated for its item.
   * Sync completion, errors and native preflight refusals leave nothing to
   * start; already spawned workers keep their records.
   */
  private settlePermits(sessionId: string, event: ToolResultEvent): void {
    const ledger = this.permits.get(sessionId);
    if (!ledger) return;
    const details = event.details;
    const queuedReturn = !event.isError && record(details) && record(details.async) ? details : undefined;
    const allocated = new Map<number, string>();
    for (const progress of queuedReturn && Array.isArray(queuedReturn.progress) ? queuedReturn.progress : []) {
      if (record(progress) && typeof progress.index === "number" && typeof progress.id === "string") allocated.set(progress.index, progress.id);
    }
    ledger.permits = ledger.permits.filter(permit => {
      if (permit.toolCallId !== event.toolCallId) return true;
      const id = allocated.get(permit.index);
      // An id outside the derived candidates means the pinned derivation no longer holds.
      if (permit.consumed || id === undefined || !matchesKey(permit, id)) return false;
      permit.keys = [id];
      delete permit.suffixBase;
      permit.returned = true;
      return true;
    });
    if (ledger.permits.length === 0) this.permits.delete(sessionId);
  }
  /**
   * The session's ledger without permits of queued workers whose job stopped
   * before spawning. OMP lists queued and running task jobs among the session's
   * running jobs under their allocated `agentId`; a job cancelled or failed
   * while queued never spawns, so its permit must not keep its name reserved.
   */
  private liveLedger(ctx: ExtensionContext, sessionId: string): PermitLedger | undefined {
    const ledger = this.permits.get(sessionId);
    if (!ledger?.permits.some(permit => permit.returned)) return ledger;
    const running = ctx.getAsyncJobSnapshot?.()?.running;
    if (!running) return ledger; // No job manager to ask: keep them.
    ledger.permits = ledger.permits.filter(permit => !permit.returned ||
      running.some(job => job.agentId !== undefined && matchesKey(permit, job.agentId)));
    if (ledger.permits.length > 0) return ledger;
    this.permits.delete(sessionId);
    return undefined;
  }
  private stage(ctx: ExtensionContext, entries: Requirement["dispatches"], checkpoint: Checkpoint, reason: string, accumulate = false): void {
    const scope = this.scope(ctx);
    const state = this.requirement(this.branch(ctx), scope.requestHash);
    if (accumulate && !scope.dispatchComplete) {
      throw new Error("Staged dispatches predate the current review contract. Restage the exact task input or withdraw with dispatch: null before reviewing.");
    }
    const dispatches = accumulate
      ? [...state.dispatches, ...entries.filter(entry => !state.dispatches.some(d => d.key === entry.key))]
      : entries;
    const next: Requirement = { ...state, required: true, promptReview: true, checkpoint, reason, dispatches, dispatchVersion: DISPATCH_VERSION };
    if (JSON.stringify(next) !== JSON.stringify(state)) this.persist(ctx, STATE, next);
  }
  private denial(scope: ReviewScope): ToolCallEventResult {
    return { block: true, reason: `Review required BEFORE execution (${scope.checkpoint}); scope ${scope.key}. ${scope.reason} ` +
      (scope.failed ? "The plan was rejected. Address the verdict and revise the plan before review. " :
        scope.unavailable ? "The reviewer was unavailable, not a rejection. Restore the reviewer and call orche_advisor again on this same scope; no retry authorization or waiver is needed. " : "") +
      `Call orche_advisor with checkpoint '${scope.checkpoint}' and the seven-field snapshot, read its result, then retry the same operation. ` +
      "A changed plan, dispatch, or finding state needs a fresh review. Only the user can waive via /review-waive <scope-key> <reason>." };
  }
  beforeTool(ctx: ExtensionContext, name: string, input: Record<string, unknown>, toolCallId?: string): ToolCallEventResult | undefined {
    if (!this.enabled() || !mainSessionOf(ctx)) return undefined;
    if (this.persistenceFault && !Object.hasOwn(PERSISTENCE_SAFE_TOOLS, name)) {
      return { block: true, reason: "Review state could not be persisted. Restore session storage and obtain a successful review before execution." };
    }
    // Initial risk is only an assessment. Read-only work must not turn it into
    // a mandatory review, even when new findings invalidate an old receipt.
    if (Object.hasOwn(READ_ONLY_TOOLS, name)) return undefined;
    if (name === "write" && typeof input.path === "string" && Object.hasOwn(OBSERVATION_DEVICES, input.path)) return undefined;
    if (name === "task") return this.beforeTask(ctx, input, toolCallId);
    // Arbitrary execution can mutate files or dispatch agents. Unknown tools
    // are not assumed read-only; shell/eval strings are never regex-classified.
    this.activateExecution(ctx);
    const scope = this.scope(ctx);
    return !scope.required || scope.satisfied ? undefined : this.denial(scope);
  }
  /**
   * Stage, review-gate and permit one task call. Its contract is OMP's own
   * validation of the effective arguments, so an input the live schema rejects
   * (which OMP would still run leniently) never yields a scope or a permit.
   */
  private beforeTask(ctx: ExtensionContext, input: Record<string, unknown>, toolCallId: string | undefined): ToolCallEventResult | undefined {
    let call: NormalizedCall;
    try {
      call = this.prepare(input);
    } catch (error) {
      return { block: true, reason: `Task input could not be validated against OMP's live task contract (${failure(error)}). ` +
        "No review scope or worker permit was recorded; submit a corrected, valid task call." };
    }
    if (call.items.every(item => Object.hasOwn(READ_ONLY_AGENTS, agentOf(item)))) return undefined;
    if (toolCallId === undefined) {
      return { block: true, reason: "Task dispatch arrived without its tool call id, so its workers cannot be matched to spawn permits." };
    }
    const identities = this.identify(ctx, call, toolCallId);
    if (typeof identities === "string") return { block: true, reason: `${identities} No review scope or worker permit was recorded.` };
    this.activateExecution(ctx);
    let scope = this.scope(ctx);
    if (identities.length >= 2 || scope.required) {
      this.stage(ctx, nativeDispatch(call),
        scope.required ? scope.checkpoint : "fan-out", identities.length >= 2 ? "Multiple implementation workers require a scope-bound pre-dispatch review." : scope.reason);
      scope = this.scope(ctx);
    }
    if (scope.required && !scope.satisfied) return this.denial(scope);
    this.issue(ctx.sessionManager.getSessionId(), scope.key, toolCallId, identities);
    return undefined;
  }
  /**
   * Spawn identities of the call's implementation workers, or why they cannot
   * be attributed. Overlapping identities are refused rather than guessed, and
   * with a call id they must also stay apart from workers still waiting to
   * start under the current scope.
   */
  private identify(ctx: ExtensionContext, call: NormalizedCall, toolCallId: string | undefined): SpawnIdentity[] | string {
    const preallocated = preallocatesIds(ctx);
    const identities: SpawnIdentity[] = [];
    for (const [index, item] of call.items.entries()) {
      if (Object.hasOwn(READ_ONLY_AGENTS, agentOf(item))) continue;
      const identity = spawnIdentity(item, index, toolCallId, preallocated);
      if (typeof identity === "string") return identity;
      const twin = identities.find(other => overlaps(other, identity));
      if (twin) {
        return `Workers ${workerLabel(call.items[twin.index]?.name, twin.index)} and ${workerLabel(item.name, index)} share a spawn identity ` +
          "(the same name for one agent, or one name equal to the other's -N collision id), so their permits cannot be told apart. Give each a distinct native name and resubmit.";
      }
      identities.push(identity);
    }
    if (toolCallId === undefined) return identities;
    const ledger = this.liveLedger(ctx, ctx.sessionManager.getSessionId());
    const waiting = ledger?.scopeKey === this.scope(ctx).key ? ledger.permits.filter(permit => !permit.consumed && permit.toolCallId !== toolCallId) : [];
    const clash = identities.find(identity => waiting.some(permit => overlaps(permit, identity)));
    if (clash) {
      return `Worker ${workerLabel(call.items[clash.index]?.name, clash.index)} shares a spawn identity with an approved ${clash.agent} worker that has not started yet, ` +
        "so their permits cannot be told apart. Use a distinct native name and resubmit.";
    }
    return identities;
  }
  private issue(sessionId: string, scopeKey: string, toolCallId: string, identities: readonly SpawnIdentity[]): void {
    const prior = this.permits.get(sessionId);
    const ledger: PermitLedger = prior?.scopeKey === scopeKey ? prior : { scopeKey, permits: [] };
    // A re-emitted tool_call replaces its call's waiting permits and never re-issues a started worker.
    const started = new Set(ledger.permits.filter(permit => permit.toolCallId === toolCallId && permit.consumed).map(permit => permit.index));
    ledger.permits = ledger.permits.filter(permit => permit.toolCallId !== toolCallId || permit.consumed);
    for (const identity of identities) {
      if (!started.has(identity.index)) ledger.permits.push({ ...identity, toolCallId, consumed: false, returned: false });
    }
    if (ledger.permits.length > 0) this.permits.set(sessionId, ledger);
    else this.permits.delete(sessionId);
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
    if (!this.enabled() || !mainSessionOf(ctx) || Object.hasOwn(READ_ONLY_AGENTS, event.agent)) return undefined;
    // OMP proceeds with the spawn when this handler throws, so every internal
    // failure must become an explicit refusal.
    try {
      return this.authorizeSpawn(ctx, event);
    } catch (error) {
      return { block: true, reason: `Review gate could not authorize this worker: ${failure(error)}` };
    }
  }
  private authorizeSpawn(ctx: ExtensionContext, event: BeforeSubagentSpawnEvent): BeforeSubagentSpawnEventResult | undefined {
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
          part.type === "toolCall" && part.name === "eval" ? [canonical(withoutIntent(part.arguments))] : []);
        if (calls.length > 0) {
          invocation = calls;
          break;
        }
      }
      const sourceKey = hash(invocation ?? null);
      const key = hash({ agent: event.agent, patterns: event.patterns, spawnKey: event.spawnKey ?? "unnamed", sourceKey });
      this.stage(ctx, [{ key, summary: `eval worker ${event.spawnKey ?? "unnamed"} (${event.agent}); caller fingerprint ${sourceKey}; model patterns ${event.patterns.join(", ")}` }],
        "fan-out", "Programmatic implementation dispatch must be reviewed before execution. Use stable agent names when retrying.", true);
      const scope = this.scope(ctx);
      return scope.required && !scope.satisfied ? this.denial(scope) : undefined;
    }
    const scope = this.scope(ctx);
    if (scope.required && !scope.satisfied) return this.denial(scope);
    return this.consumePermit(ctx, scope.key, event);
  }
  /** Consume the one waiting permit whose agent and spawn key match; never guess between several. */
  private consumePermit(ctx: ExtensionContext, scopeKey: string, event: BeforeSubagentSpawnEvent): BeforeSubagentSpawnEventResult | undefined {
    const missing = { block: true, reason: "Native worker has no matching task preflight permit for the current scope. Submit the exact task input through task before retrying; a parent-only review does not authorize worker spawning." };
    const sessionId = ctx.sessionManager.getSessionId();
    const ledger = this.liveLedger(ctx, sessionId);
    if (!ledger || ledger.scopeKey !== scopeKey) {
      this.permits.delete(sessionId);
      return missing;
    }
    const key = event.spawnKey;
    if (typeof key !== "string") return missing;
    const matching = ledger.permits.filter(permit => !permit.consumed && permit.agent === event.agent && matchesKey(permit, key));
    const permit = matching[0];
    if (!permit) return missing;
    if (matching.length > 1) {
      return { block: true, reason: "Several approved task workers match this spawn identity, so none can be attributed. Resubmit the task call with distinct native names." };
    }
    if (permit.returned) ledger.permits.splice(ledger.permits.indexOf(permit), 1);
    else permit.consumed = true;
    if (ledger.permits.length === 0) this.permits.delete(sessionId);
    return undefined;
  }
  complete(ctx: ExtensionContext, captured: ReviewScope, success: boolean, requestId?: string, failureKind: ReviewFailureKind = "review_rejected"): void {
    const state = this.requirement(this.branch(ctx), captured.requestHash);
    // A late result cannot clear or promote another task's state.
    if (this.scope(ctx).key === captured.key && state.workId === captured.workId) {
      this.persist(ctx, STATE, { ...state, required: true, promptReview: !success });
    }
    this.persist(ctx, success ? RECEIPT : FAILURE, { scopeKey: captured.key, success, requestId, checkpoint: captured.checkpoint,
      planHash: captured.planHash, findingRevision: captured.findingRevision, ...(success ? {} : { failureKind }), at: Date.now() });
  }
  guidance(ctx: ExtensionContext): string | undefined {
    if (!this.enabled() || !mainSessionOf(ctx)) return undefined;
    const scope = this.scope(ctx);
    if (!scope.failed && !scope.unavailable && this.requirement(this.branch(ctx), scope.requestHash).promptReview === false) return undefined;
    if (!scope.required || scope.satisfied) return undefined;
    return `<system-notice>Mandatory orchestration review pending: ${scope.checkpoint}. ${scope.reason}\n` +
      "Read-only scoping and todo planning may continue; implementation and worker dispatch are blocked until a successful scope-bound orche_advisor review. " +
      "For a worker batch, submit task once to stage its exact scope (blocked before execution), then review and retry unchanged; alternatively pass the planned dispatch to orche_advisor. " +
      "Give every implementation worker a distinct native name. " +
      `Scope: ${scope.key}. ${scope.failed ? "The plan was rejected: address the verdict and revise the plan before review." :
        scope.unavailable ? "Reviewer unavailable: diagnose the error, then review this same scope again without a waiver. Do not loop while the error remains unchanged." : ""}</system-notice>`;
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
  /** Replace planned dispatch, or explicitly withdraw it without approving execution. */
  stageDispatch(ctx: ExtensionContext, input: Record<string, unknown> | null): void {
    if (input === null) {
      const scope = this.scope(ctx);
      const state = this.requirement(this.branch(ctx), scope.requestHash);
      if (state.dispatches.length === 0) return;
      // A new generation prevents withdrawal from resurrecting a receipt for
      // an earlier parent-only plan or for a later re-staging of the old batch.
      this.persist(ctx, STATE, { ...state, dispatches: [], generation: state.generation + 1,
        required: true, promptReview: true, checkpoint: "replan",
        reason: "Worker dispatch withdrawn; review the remaining parent-owned scope before execution." });
      return;
    }
    let call: NormalizedCall;
    try {
      call = this.prepare(input);
    } catch (error) {
      throw new Error(`Planned dispatch could not be validated against OMP's live task contract (${failure(error)}). ` +
        "Use dispatch: null to withdraw staged dispatches; omit dispatch to retain them.");
    }
    if (call.items.some(item => typeof item.task !== "string" || !item.task.trim())) throw new Error("Every planned worker needs task text.");
    const identities = this.identify(ctx, call, undefined);
    if (typeof identities === "string") throw new Error(identities);
    this.stage(ctx, nativeDispatch(call), "fan-out", "Review the predeclared worker dispatch before execution.");
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
