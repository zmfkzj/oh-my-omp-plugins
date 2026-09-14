import type {
  AgentEndEvent,
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionStopEvent,
} from "@oh-my-pi/pi-coding-agent";

import {
  DAYBREAK_MODEL,
  PARENT_MODEL,
  type DelegationRequest,
  type WorkerResult,
  type WorkerRunner,
} from "./contracts.js";
import { buildDelegationRequest, formatWorkerCompletion } from "./handoff.js";
import { runDaybreak } from "./worker.js";

const STATE_ENTRY_TYPE = "daybreak-delegation";
const RESULT_MESSAGE_TYPE = "daybreak-delegation-result";

type DelegationStatus = "admitted" | "completed" | "failed" | "cancelled";
type JobManager = NonNullable<AgentSession["asyncJobManager"]>;

interface StoredDelegationState {
  version: 1;
  requestId: string;
  requestKey: string;
  parentSessionId: string;
  status: DelegationStatus;
  jobId: string;
  childAgentId: string;
  model: typeof DAYBREAK_MODEL;
  artifact?: string;
  note?: string;
  updatedAt: string;
}

interface ActiveDelegation {
  request: DelegationRequest;
  jobId: string;
  ownerId: string;
  manager: JobManager;
  status: DelegationStatus;
}

interface ParentResolution {
  parent: AgentSession;
  manager: JobManager;
  ownerId: string;
}

interface RequestMessageIdentity {
  role?: string;
  content?: unknown;
  synthetic?: boolean;
  attribution?: string;
  timestamp?: number;
}

function isRealUserMessage(
  message: RequestMessageIdentity,
): message is RequestMessageIdentity & { role: "user" } {
  return (
    message.role === "user" &&
    message.synthetic !== true &&
    message.attribution !== "agent"
  );
}

function latestRealUserMessage<Message extends RequestMessageIdentity>(
  messages: readonly Message[],
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isRealUserMessage(message)) return message;
  }
  return undefined;
}

function latestBranchRealUserMessage(
  ctx: ExtensionContext,
): RequestMessageIdentity | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]!;
    if (entry.type === "message" && isRealUserMessage(entry.message))
      return entry.message;
  }
  return undefined;
}

function isSameUserRequest(
  left: RequestMessageIdentity,
  right: RequestMessageIdentity,
): boolean {
  if (left === right) return true;
  if (typeof left.timestamp !== "number" || left.timestamp !== right.timestamp)
    return false;
  try {
    return JSON.stringify(left.content) === JSON.stringify(right.content);
  } catch {
    return false;
  }
}

function parseStoredState(value: unknown): StoredDelegationState | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (
    !("version" in value) ||
    value.version !== 1 ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("requestKey" in value) ||
    typeof value.requestKey !== "string" ||
    !("parentSessionId" in value) ||
    typeof value.parentSessionId !== "string" ||
    !("status" in value) ||
    (value.status !== "admitted" &&
      value.status !== "completed" &&
      value.status !== "failed" &&
      value.status !== "cancelled") ||
    !("jobId" in value) ||
    typeof value.jobId !== "string" ||
    !("childAgentId" in value) ||
    typeof value.childAgentId !== "string" ||
    !("model" in value) ||
    value.model !== DAYBREAK_MODEL ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  const artifact = "artifact" in value ? value.artifact : undefined;
  const note = "note" in value ? value.note : undefined;
  if (artifact !== undefined && typeof artifact !== "string") return undefined;
  if (note !== undefined && typeof note !== "string") return undefined;
  return {
    version: 1,
    requestId: value.requestId,
    requestKey: value.requestKey,
    parentSessionId: value.parentSessionId,
    status: value.status,
    jobId: value.jobId,
    childAgentId: value.childAgentId,
    model: DAYBREAK_MODEL,
    artifact,
    note,
    updatedAt: value.updatedAt,
  };
}

function storedStates(ctx: ExtensionContext): StoredDelegationState[] {
  const states: StoredDelegationState[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE)
      continue;
    const state = parseStoredState(entry.data);
    if (state) states.push(state);
  }
  return states;
}

function appendState(
  pi: ExtensionAPI,
  request: Pick<DelegationRequest, "id" | "requestKey" | "parentSessionId">,
  jobId: string,
  status: DelegationStatus,
  options?: { artifact?: string; note?: string },
): StoredDelegationState {
  const state: StoredDelegationState = {
    version: 1,
    requestId: request.id,
    requestKey: request.requestKey,
    parentSessionId: request.parentSessionId,
    status,
    jobId,
    childAgentId: request.id,
    model: DAYBREAK_MODEL,
    artifact: options?.artifact,
    note: options?.note,
    updatedAt: new Date().toISOString(),
  };
  pi.appendEntry(STATE_ENTRY_TYPE, state);
  return state;
}

function publishVisibleStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error",
  details?: Record<string, unknown>,
): void {
  pi.sendMessage(
    {
      customType: RESULT_MESSAGE_TYPE,
      content: message,
      display: true,
      attribution: "agent",
      details,
    },
    { triggerTurn: false, deliverAs: "nextTurn" },
  );
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function resolveParent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  expectedSessionId: string,
  requireAstra: boolean,
): ParentResolution | string {
  const currentSessionId = ctx.sessionManager.getSessionId();
  if (currentSessionId !== expectedSessionId) {
    return "The active session changed before Daybreak delegation could be admitted.";
  }

  const matches = pi.pi.AgentRegistry.global()
    .list()
    .filter((ref) => {
      const session = ref.session;
      return (
        ref.kind === "main" &&
        session !== null &&
        session.sessionId === expectedSessionId &&
        session.sessionManager.getSessionId() === expectedSessionId
      );
    });
  if (matches.length !== 1) {
    return `Daybreak delegation requires one uniquely matched live parent session; found ${matches.length}.`;
  }

  const ref = matches[0]!;
  const parent = ref.session!;
  const ownerId = parent.getAgentId();
  if (!ownerId || ownerId !== ref.id) {
    return "The matched parent has no uniquely verified registry owner identity.";
  }
  if (
    requireAstra &&
    (!parent.model ||
      `${parent.model.provider}/${parent.model.id}` !== PARENT_MODEL)
  ) {
    return `Daybreak delegation was not started because the parent is no longer using ${PARENT_MODEL}.`;
  }
  const manager = parent.asyncJobManager;
  if (!manager) {
    return "Daybreak delegation requires the parent session managed-job runtime, but it is unavailable.";
  }
  return { parent, manager, ownerId };
}

function safeDiagnostic(value: string, limit: number): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g,
      "[REDACTED PRIVATE MATERIAL]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, limit);
}

function failureText(request: DelegationRequest, result: WorkerResult): string {
  const rawError =
    result.error ??
    result.output ??
    "The Daybreak worker did not provide an error.";
  return `Daybreak delegation ${request.id} ${result.status}: ${safeDiagnostic(rawError, 2_000)}`;
}

export function registerDaybreakDelegate(
  pi: ExtensionAPI,
  runWorker: WorkerRunner = runDaybreak,
): void {
  let generation = 0;
  let active: ActiveDelegation | undefined;
  const admissionKeys = new Set<string>();

  const isFresh = (
    ctx: ExtensionContext,
    request: DelegationRequest,
    admittedGeneration: number,
    signal?: AbortSignal,
  ): boolean =>
    signal?.aborted !== true &&
    generation === admittedGeneration &&
    ctx.sessionManager.getSessionId() === request.parentSessionId &&
    active?.request.id === request.id &&
    active.status === "admitted";

  const cancelActive = (
    ctx: ExtensionContext,
    note: string,
    notify: boolean,
  ): boolean => {
    const sessionId = ctx.sessionManager.getSessionId();
    generation += 1;

    let requestId: string | undefined;
    let requestKey: string | undefined;
    let jobId: string | undefined;
    let manager: JobManager | undefined;
    let ownerId: string | undefined;

    if (
      active?.request.parentSessionId === sessionId &&
      active.status === "admitted"
    ) {
      requestId = active.request.id;
      requestKey = active.request.requestKey;
      jobId = active.jobId;
      manager = active.manager;
      ownerId = active.ownerId;
    } else {
      const latest = storedStates(ctx)
        .filter((state) => state.parentSessionId === sessionId)
        .at(-1);
      if (latest?.status === "admitted") {
        const resolution = resolveParent(pi, ctx, sessionId, false);
        if (typeof resolution !== "string") {
          requestId = latest.requestId;
          requestKey = latest.requestKey;
          jobId = latest.jobId;
          manager = resolution.manager;
          ownerId = resolution.ownerId;
        }
      }
    }

    active = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATE_ENTRY_TYPE, undefined);
    if (!requestId || !requestKey || !jobId || !manager || !ownerId)
      return false;

    manager.acknowledgeDeliveries([jobId]);
    const job = manager.getJob(jobId);
    if (!job || job.status !== "running") return false;
    const cancelled = manager.cancel(jobId, { ownerId });
    if (!cancelled) return false;

    appendState(
      pi,
      { id: requestId, requestKey, parentSessionId: sessionId },
      jobId,
      "cancelled",
      { note },
    );
    if (notify) {
      publishVisibleStatus(
        pi,
        ctx,
        `Cancelled Daybreak delegation ${requestId}.`,
        "warning",
        {
          requestId,
          jobId,
          status: "cancelled",
        },
      );
    }
    return true;
  };

  const admit = (event: SessionStopEvent, ctx: ExtensionContext): void => {
    const request = buildDelegationRequest(event, ctx);
    if (!request) return;

    const admissionKey = `${request.parentSessionId}\u0000${request.requestKey}`;
    if (admissionKeys.has(admissionKey)) return;
    if (
      storedStates(ctx).some((state) => state.requestKey === request.requestKey)
    )
      return;
    if (active?.request.requestKey === request.requestKey) return;
    admissionKeys.add(admissionKey);

    if (ctx.mode === "print" || ctx.mode === "json") {
      publishVisibleStatus(
        pi,
        ctx,
        "Daybreak delegation was not started: print/json mode disposes its session after the prompt, so it cannot safely own a long-running child. Use a long-lived TUI or RPC session.",
        "error",
        { requestKey: request.requestKey, status: "not-started" },
      );
      return;
    }

    const resolution = resolveParent(pi, ctx, event.session_id, true);
    if (typeof resolution === "string") {
      publishVisibleStatus(pi, ctx, resolution, "error", {
        requestKey: request.requestKey,
        status: "not-started",
      });
      return;
    }

    const admittedGeneration = generation;
    const { parent, manager, ownerId } = resolution;
    let jobId: string;
    try {
      jobId = manager.register(
        "task",
        `Daybreak delegate ${request.id}`,
        async ({ jobId: managedJobId, signal, reportProgress }) => {
          await Promise.resolve();
          try {
            if (!isFresh(ctx, request, admittedGeneration, signal)) {
              manager.acknowledgeDeliveries([managedJobId]);
              throw new Error(
                "Daybreak delegation became stale before its worker started.",
              );
            }

            let result: WorkerResult;
            try {
              result = await runWorker(
                pi,
                ctx,
                parent,
                request,
                signal,
                (text) => {
                  if (!isFresh(ctx, request, admittedGeneration, signal))
                    return;
                  void reportProgress(safeDiagnostic(text, 1_000));
                },
              );
            } catch (error) {
              manager.acknowledgeDeliveries([managedJobId]);
              if (!isFresh(ctx, request, admittedGeneration, signal)) {
                throw new Error(
                  "Daybreak delegation stopped after its parent task became stale.",
                );
              }
              if (ctx.hasUI) ctx.ui.setStatus(STATE_ENTRY_TYPE, undefined);

              const message =
                error instanceof Error ? error.message : String(error);
              const failedResult: WorkerResult = {
                status: "failed",
                output: "",
                error: message,
              };
              appendState(pi, request, managedJobId, "failed", {
                note: "Worker execution failed.",
              });
              active!.status = "failed";
              publishVisibleStatus(
                pi,
                ctx,
                failureText(request, failedResult),
                "error",
                {
                  requestId: request.id,
                  jobId: managedJobId,
                  status: "failed",
                },
              );
              throw new Error(failureText(request, failedResult));
            }

            if (!isFresh(ctx, request, admittedGeneration, signal)) {
              manager.acknowledgeDeliveries([managedJobId]);
              throw new Error(
                "Daybreak delegation completed after its parent task became stale.",
              );
            }

            if (result.status !== "completed") {
              manager.acknowledgeDeliveries([managedJobId]);
              if (result.status === "cancelled")
                manager.cancel(managedJobId, { ownerId });
              appendState(pi, request, managedJobId, result.status, {
                artifact: result.sessionFile,
                note:
                  result.status === "cancelled"
                    ? "Worker cancelled."
                    : "Worker reported failure.",
              });
              active!.status = result.status;
              publishVisibleStatus(
                pi,
                ctx,
                failureText(request, result),
                result.status === "failed" ? "error" : "warning",
                {
                  requestId: request.id,
                  jobId: managedJobId,
                  status: result.status,
                  artifact: result.sessionFile,
                },
              );
              if (ctx.hasUI) ctx.ui.setStatus(STATE_ENTRY_TYPE, undefined);
              throw new Error(failureText(request, result));
            }

            appendState(pi, request, managedJobId, "completed", {
              artifact: result.sessionFile,
              note: "Worker completed; native managed delivery pending.",
            });
            active!.status = "completed";
            if (ctx.hasUI) ctx.ui.setStatus(STATE_ENTRY_TYPE, undefined);
            return formatWorkerCompletion(request, result);
          } catch (error) {
            manager.acknowledgeDeliveries([managedJobId]);
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              generation === admittedGeneration &&
              ctx.sessionManager.getSessionId() === request.parentSessionId &&
              active?.request.id === request.id &&
              active.status === "admitted" &&
              ctx.hasUI
            ) {
              ctx.ui.setStatus(STATE_ENTRY_TYPE, undefined);
              ctx.ui.notify(
                `Daybreak delegation ${request.id} failed: ${safeDiagnostic(message, 2_000)}`,
                "error",
              );
            }
            throw new Error(safeDiagnostic(message, 2_000));
          }
        },
        {
          id: request.id,
          ownerId,
          agentId: request.id,
          onProgress: (text) => {
            if (
              active?.request.id !== request.id ||
              active.status !== "admitted"
            )
              return;
            if (ctx.hasUI)
              ctx.ui.setStatus(STATE_ENTRY_TYPE, text.slice(0, 160));
          },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publishVisibleStatus(
        pi,
        ctx,
        `Daybreak delegation could not be admitted: ${message}`,
        "error",
        {
          requestKey: request.requestKey,
          status: "not-started",
        },
      );
      return;
    }

    active = {
      request,
      jobId,
      ownerId,
      manager,
      status: "admitted",
    };
    appendState(pi, request, jobId, "admitted", {
      note: "Managed Daybreak worker admitted.",
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Delegated remaining work to ${DAYBREAK_MODEL} as managed job ${jobId}.`,
        "info",
      );
      ctx.ui.setStatus(STATE_ENTRY_TYPE, `Daybreak ${jobId} running`);
    }
  };
  pi.on("session_stop", admit);

  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
    if (
      event.willContinue === true ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    )
      return;

    let terminalIndex = -1;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      if (event.messages[index]!.role !== "assistant") continue;
      terminalIndex = index;
      break;
    }
    if (terminalIndex < 0) return;
    const terminal = event.messages[terminalIndex]!;
    const eventUser = latestRealUserMessage(event.messages);
    const branchUser = latestBranchRealUserMessage(ctx);
    if (
      !eventUser ||
      event.messages.lastIndexOf(eventUser) > terminalIndex ||
      !branchUser ||
      !isSameUserRequest(eventUser, branchUser)
    )
      return;

    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const fallbackEvent: SessionStopEvent = {
      type: "session_stop",
      messages: event.messages,
      turn_id: 0,
      last_assistant_message: terminal,
      session_id: sessionId,
      ...(sessionFile === undefined ? {} : { session_file: sessionFile }),
      stop_hook_active: false,
      signal: new AbortController().signal,
    };
    admit(fallbackEvent, ctx);
  });

  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (
      message.role === "user" &&
      message.synthetic !== true &&
      message.attribution !== "agent"
    ) {
      cancelActive(ctx, "Superseded by a new real-user request.", false);
    }
  });

  pi.on("session_before_switch", (_event, ctx) => {
    cancelActive(ctx, "Parent session switched.", false);
  });
  pi.on("session_before_branch", (_event, ctx) => {
    cancelActive(ctx, "Parent session branched.", false);
  });
  pi.on("session_before_tree", (_event, ctx) => {
    cancelActive(ctx, "Parent session tree position changed.", false);
  });
  pi.on("session_switch", () => {
    generation += 1;
    active = undefined;
  });
  pi.on("session_branch", () => {
    generation += 1;
    active = undefined;
  });
  pi.on("session_tree", () => {
    generation += 1;
    active = undefined;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    cancelActive(ctx, "Parent session shut down.", false);
    if (ctx.hasUI) ctx.ui.setStatus(STATE_ENTRY_TYPE, undefined);
  });

  pi.registerCommand("daybreak-delegate", {
    description: "Show or cancel the current Daybreak delegation",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "cancel") {
        if (
          !cancelActive(ctx, "Cancelled by /daybreak-delegate cancel.", true)
        ) {
          ctx.ui.notify(
            "No running Daybreak delegation belongs to this session.",
            "info",
          );
        }
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /daybreak-delegate [status|cancel]", "warning");
        return;
      }

      const states = storedStates(ctx);
      const latest = states.at(-1);
      if (!latest) {
        ctx.ui.notify(
          `Daybreak delegate: state=idle model=${DAYBREAK_MODEL} job=none artifact=none`,
          "info",
        );
        return;
      }

      const resolution = resolveParent(
        pi,
        ctx,
        ctx.sessionManager.getSessionId(),
        false,
      );
      const jobStatus =
        typeof resolution === "string"
          ? "unavailable"
          : (resolution.manager.getJob(latest.jobId)?.status ?? "not-live");
      ctx.ui.notify(
        `Daybreak delegate: state=${latest.status} model=${latest.model} job=${latest.jobId} (${jobStatus}) artifact=${latest.artifact ?? "pending"} history=history://${latest.childAgentId}`,
        latest.status === "failed"
          ? "error"
          : latest.status === "cancelled"
            ? "warning"
            : "info",
      );
    },
  });
}

export default function daybreakDelegateExtension(pi: ExtensionAPI): void {
  registerDaybreakDelegate(pi);
}
