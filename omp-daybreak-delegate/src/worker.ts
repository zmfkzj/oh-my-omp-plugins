import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

import {
  DAYBREAK_MODEL,
  type DelegationRequest,
  type WorkerResult,
  type WorkerRunner,
} from "./contracts.js";

const DAYBREAK_PROVIDER = "openai-codex";
const DAYBREAK_MODEL_ID = "gpt-daybreak-blue-latest";
const CHILD_FORBIDDEN_TOOLS: Record<string, true> = { hub: true, task: true };
const APPROVAL_MODES: Record<string, true> = {
  "always-ask": true,
  write: true,
  yolo: true,
};
const CHILD_SYSTEM_PROMPT = `You are a bounded continuation worker for one authorized parent request.
Complete only the remaining work in the supplied task. Respect its stated scope, prior completed side effects, project instructions, and approval policy. Do not repeat completed tool calls. Do not delegate, spawn, or recruit other agents. Do not change models or credentials. If the requested Daybreak model or an approval is unavailable, stop and report the actual failure. Use only visible task context; never claim access to hidden reasoning.`;

class WorkerCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCancelledError";
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? String(error);
  } catch {
    return String(error);
  }
}

function cancellationText(signal: AbortSignal): string {
  return signal.reason === undefined
    ? "Daybreak delegation was cancelled."
    : errorText(signal.reason);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkerCancelledError(cancellationText(signal));
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfCancelled(signal);

  let rejectCancellation: ((reason: WorkerCancelledError) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = (): void => {
    rejectCancellation?.(new WorkerCancelledError(cancellationText(signal)));
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter(
      (
        part,
      ): part is Extract<(typeof message.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isRequestedModel<T extends { provider: string; id: string }>(
  model: T | undefined,
): model is T {
  return (
    model?.provider === DAYBREAK_PROVIDER && model.id === DAYBREAK_MODEL_ID
  );
}

function safeProgress(onProgress: (text: string) => void, text: string): void {
  const progress = text.trim();
  if (!progress) return;
  try {
    onProgress(progress);
  } catch {
    // Progress is advisory; a closed display must not terminate authorized work.
  }
}

async function settleChildWork(
  session: AgentSession,
  parent: AgentSession,
  childId: string,
  signal: AbortSignal,
  pendingExtensionActions: Set<Promise<unknown>>,
): Promise<void> {
  const manager = parent.asyncJobManager;
  if (!manager)
    throw new Error("The parent session has no managed async job manager.");

  for (;;) {
    throwIfCancelled(signal);
    await abortable(session.waitForIdle(), signal);

    if (pendingExtensionActions.size > 0) {
      await abortable(
        Promise.allSettled([...pendingExtensionActions]).then(() => undefined),
        signal,
      );
      continue;
    }

    if (session.hasPendingAsyncWork()) {
      await abortable(session.settleAsyncWork(), signal);
      continue;
    }

    await abortable(
      manager.waitForOwnerJobs(childId).then(() => undefined),
      signal,
    );
    await abortable(session.waitForIdle(), signal);

    if (
      pendingExtensionActions.size === 0 &&
      !session.hasPendingAsyncWork() &&
      manager.getRunningJobs({ ownerId: childId }).length === 0 &&
      !session.hasPostPromptWork
    ) {
      return;
    }

    await abortable(
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
      signal,
    );
  }
}

export const runDaybreak: WorkerRunner = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parent: AgentSession,
  request: DelegationRequest,
  signal: AbortSignal,
  onProgress: (text: string) => void,
): Promise<WorkerResult> => {
  if (signal.aborted) {
    return { status: "cancelled", output: "", error: cancellationText(signal) };
  }
  if (parent.sessionId !== request.parentSessionId) {
    return {
      status: "cancelled",
      output: "",
      error:
        "The parent session changed before Daybreak delegation could start.",
    };
  }
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(request.id)) {
    return {
      status: "failed",
      output: "",
      error:
        "The Daybreak delegation id is not a safe registered-agent identifier.",
    };
  }

  const parentAgentId = parent.getAgentId();
  if (!parentAgentId) {
    return {
      status: "failed",
      output: "",
      error: "The parent session has no registered agent identity.",
    };
  }
  const manager = parent.asyncJobManager;
  if (!manager) {
    return {
      status: "failed",
      output: "",
      error: "The parent session has no managed async job manager.",
    };
  }

  const artifactsDir = parent.sessionManager.getArtifactsDir();
  const artifactManager = parent.sessionManager.getArtifactManager();
  if (!artifactsDir || !artifactManager) {
    return {
      status: "failed",
      output: "",
      error:
        "The parent session has no persistent artifact store for the Daybreak transcript.",
    };
  }

  const parentChanged = new AbortController();
  const unregisterParentChange = parent.registerSessionChangeCallback(() => {
    parentChanged.abort(
      new WorkerCancelledError(
        "The parent session changed during Daybreak delegation.",
      ),
    );
  });
  const lifetimeSignal = AbortSignal.any([signal, parentChanged.signal]);

  let session: AgentSession | undefined;
  let sessionManager: SessionManager | undefined;
  let sessionFile: string | undefined;
  let unsubscribeEvents: (() => void) | undefined;
  let unsubscribeExtensionErrors: (() => void) | undefined;
  let unsubscribeToolGate: (() => void) | undefined;
  let abortSessionWork: Promise<void> | undefined;
  let requestSessionAbort: (() => void) | undefined;
  let executionError: string | undefined;
  let cleanupError: string | undefined;
  let extensionShutdownError: string | undefined;
  let lastAssistant: AssistantMessage | undefined;
  const pendingExtensionActions = new Set<Promise<unknown>>();

  const trackExtensionAction = (work: Promise<unknown>): void => {
    const tracked = work.catch((error) => {
      safeProgress(
        onProgress,
        `Daybreak extension action failed: ${errorText(error)}`,
      );
    });
    pendingExtensionActions.add(tracked);
    void tracked.finally(() => pendingExtensionActions.delete(tracked));
  };

  try {
    await abortable(ctx.modelRegistry.awaitBackgroundRefresh(), lifetimeSignal);
    throwIfCancelled(lifetimeSignal);

    const model = ctx.models.resolve(DAYBREAK_MODEL);
    if (
      !isRequestedModel(model) ||
      !ctx.modelRegistry.hasConfiguredAuth(model)
    ) {
      throw new Error(
        `The exact approved model ${DAYBREAK_MODEL} is unavailable or has no configured credentials.`,
      );
    }

    const parentApprovalMode = parent.settings.get("tools.approvalMode");
    if (APPROVAL_MODES[parentApprovalMode] !== true) {
      throw new Error(
        "The parent session has no valid tool approval mode to preserve.",
      );
    }
    const childSettings = pi.pi.createSubagentSettings(
      parent.settings,
      {
        "tools.approvalMode": parentApprovalMode,
        "retry.enabled": false,
        "retry.maxRetries": 0,
        "retry.waitForUsageReset": false,
        "retry.modelFallback": false,
        "retry.usageAwareFallback": false,
        "retry.fallbackChains": {},
        "retry.fallbackRevertPolicy": "never",
        "contextPromotion.enabled": false,
        "prewalk.enabled": false,
        "advisor.enabled": false,
        "task.maxRecursionDepth": 1,
      },
      parent.serviceTierByFamily,
    );

    const allowedTools = [...new Set(parent.getEnabledToolNames())].filter(
      (name) => CHILD_FORBIDDEN_TOOLS[name] !== true,
    );
    const allowedToolSet = new Set(allowedTools);
    const parentPreparedExtensions = parent.preparedExtensions;
    const parentExtensionPaths = parent.extensionPaths;

    await abortable(mkdir(artifactsDir, { recursive: true }), lifetimeSignal);
    sessionFile = join(artifactsDir, `${request.id}.jsonl`);
    const openSessionPromise = pi.pi.SessionManager.open(
      sessionFile,
      artifactsDir,
      undefined,
      {
        initialCwd: request.cwd,
        suppressBreadcrumb: true,
      },
    );
    let openedSessionManager: SessionManager;
    try {
      openedSessionManager = await abortable(
        openSessionPromise,
        lifetimeSignal,
      );
    } catch (error) {
      if (lifetimeSignal.aborted) {
        try {
          const lateSessionManager = await openSessionPromise;
          await lateSessionManager.close();
        } catch {
          // SessionManager.open either failed itself or its cleanup was best effort.
        }
      }
      throw error;
    }
    sessionManager = openedSessionManager;
    sessionManager.adoptArtifactManager(artifactManager);
    throwIfCancelled(lifetimeSignal);
    const createPromise = pi.pi.createAgentSession({
      cwd: request.cwd,
      authStorage: ctx.modelRegistry.authStorage,
      modelRegistry: ctx.modelRegistry,
      model,
      rebindModelAfterDiscovery: false,
      scopedModels: [{ model }],
      settings: childSettings,
      sessionManager,
      toolNames: allowedTools,
      spawns: "",
      taskDepth: 1,
      parentTaskPrefix: request.id,
      parentAgentId,
      agentId: request.id,
      agentDisplayName: "daybreak",
      agentName: "daybreak",
      expectedAgentRef: null,
      providerSessionId: `daybreak:${request.id}`,
      appendSystemPrompt: CHILD_SYSTEM_PROMPT,
      preloadedPreparedExtensions:
        parentPreparedExtensions && parentPreparedExtensions.length > 0
          ? parentPreparedExtensions
          : undefined,
      preloadedExtensionPaths:
        parentPreparedExtensions && parentPreparedExtensions.length > 0
          ? undefined
          : parentExtensionPaths
            ? [...parentExtensionPaths]
            : undefined,
      extensionRoots: () => parent.effectiveExtensionRoots,
      enableIrc: false,
      enableMCP: parent.getSelectedMCPToolNames().length > 0,
      enableLsp: allowedToolSet.has("lsp"),
      skipPythonPreflight: !allowedToolSet.has("eval"),
      requireYieldTool: false,
      hasUI: ctx.hasUI,
      interactivePrompts: ctx.hasUI,
      autoApprove: false,
    });

    let created: Awaited<typeof createPromise>;
    try {
      created = await abortable(createPromise, lifetimeSignal);
    } catch (error) {
      if (!lifetimeSignal.aborted) throw error;
      try {
        const lateCreated = await createPromise;
        session = lateCreated.session;
        session.beginDispose();
        await session.dispose();
      } catch {
        // createAgentSession owns cleanup when startup itself fails.
      }
      throw error;
    }

    session = created.session;
    if (!isRequestedModel(session.model)) {
      throw new Error(
        `Child startup did not retain the exact approved model ${DAYBREAK_MODEL}.`,
      );
    }

    created.setToolUIContext(ctx.ui, ctx.hasUI);

    requestSessionAbort = (): void => {
      abortSessionWork ??= session!.abort({
        reason: cancellationText(lifetimeSignal),
      });
    };
    lifetimeSignal.addEventListener("abort", requestSessionAbort, {
      once: true,
    });
    if (lifetimeSignal.aborted) requestSessionAbort();

    let progressText = "";
    const flushProgressText = (): void => {
      if (!progressText.trim()) return;
      safeProgress(onProgress, progressText);
      progressText = "";
    };
    unsubscribeEvents = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        progressText += event.assistantMessageEvent.delta;
        if (progressText.includes("\n") || progressText.length >= 240)
          flushProgressText();
        return;
      }
      if (event.type === "tool_execution_start") {
        flushProgressText();
        safeProgress(onProgress, `Daybreak is running ${event.toolName}.`);
      } else if (event.type === "notice" && event.level !== "info") {
        flushProgressText();
        safeProgress(onProgress, `Daybreak ${event.level}: ${event.message}`);
      }
    });

    await abortable(session.setActiveToolsByName(allowedTools), lifetimeSignal);

    const extensionRunner = session.extensionRunner;
    if (extensionRunner) {
      unsubscribeToolGate = extensionRunner.onToolRegistered(async () => {
        const retained = session!
          .getEnabledToolNames()
          .filter((name) => allowedToolSet.has(name));
        await session!.setActiveToolsByName(retained);
      });
      extensionRunner.initialize(
        {
          sendMessage: (message, options) => {
            trackExtensionAction(session!.sendCustomMessage(message, options));
          },
          sendUserMessage: (content, options) => {
            trackExtensionAction(session!.sendUserMessage(content, options));
          },
          appendEntry: (customType, data) => {
            session!.sessionManager.appendCustomEntry(customType, data);
          },
          setLabel: (targetId, label) => {
            session!.sessionManager.appendLabelChange(targetId, label);
          },
          getActiveTools: () => session!.getEnabledToolNames(),
          getAllTools: () => session!.getAllToolInfos(),
          setActiveTools: async (names) => {
            await session!.setActiveToolsByName(
              names.filter((name) => allowedToolSet.has(name)),
            );
          },
          getCommands: () => [],
          setModel: async (candidate) => isRequestedModel(candidate),
          getThinkingLevel: () => session!.thinkingLevel,
          setThinkingLevel: (level, persist) =>
            session!.setThinkingLevel(level, persist),
          getServiceTiers: () => session!.serviceTierByFamily,
          setServiceTier: (family, tier) =>
            session!.setServiceTierFamily(family, tier),
          getSessionName: () => session!.sessionManager.getSessionName(),
          setSessionName: async (name) => {
            await session!.sessionManager.setSessionName(name, "user");
          },
        },
        {
          getModel: () => session!.model,
          isIdle: () => !session!.isStreaming,
          abort: () => {
            void session!.abort({
              reason: "Daybreak extension requested abort.",
            });
          },
          hasPendingMessages: () => session!.queuedMessageCount > 0,
          shutdown: () => {
            extensionShutdownError = "A child extension requested shutdown.";
            void session!.abort({ reason: extensionShutdownError });
          },
          getContextUsage: () => session!.getContextUsage(),
          compact: async (instructionsOrOptions) => {
            if (
              typeof instructionsOrOptions === "string" ||
              instructionsOrOptions === undefined
            ) {
              await session!.compact(instructionsOrOptions);
            } else {
              await session!.compact(undefined, instructionsOrOptions);
            }
          },
          getSystemPrompt: () => session!.systemPrompt,
        },
        undefined,
        ctx.ui,
        ctx.mode,
      );
      unsubscribeExtensionErrors = extensionRunner.onError((error) => {
        safeProgress(
          onProgress,
          `Daybreak extension error (${error.event}): ${error.error}`,
        );
      });
      await abortable(
        extensionRunner.emit({ type: "session_start" }),
        lifetimeSignal,
      );
    }

    await abortable(
      Promise.allSettled([...pendingExtensionActions]).then(() => undefined),
      lifetimeSignal,
    );
    await abortable(session.setActiveToolsByName(allowedTools), lifetimeSignal);
    const broadenedTools = session
      .getEnabledToolNames()
      .filter((name) => !allowedToolSet.has(name));
    if (broadenedTools.length > 0) {
      throw new Error(
        `Child tool policy could not remove unapproved tools: ${broadenedTools.join(", ")}`,
      );
    }

    session.sessionManager.appendSessionInit({
      systemPrompt: session.systemPrompt.join("\n\n"),
      task: request.prompt,
      tools: session.getEnabledToolNames(),
      agent: "daybreak",
      resolvedModel: DAYBREAK_MODEL,
      readOnly: false,
      spawns: "",
    });

    safeProgress(
      onProgress,
      `Daybreak child ${request.id} started with ${DAYBREAK_MODEL}.`,
    );
    throwIfCancelled(lifetimeSignal);
    const forwarded = await abortable(
      session.prompt(request.prompt, {
        attribution: "agent",
        userInitiated: false,
      }),
      lifetimeSignal,
    );
    if (!forwarded)
      throw new Error(
        "The delegated task was handled locally and never reached Daybreak.",
      );

    await settleChildWork(
      session,
      parent,
      request.id,
      lifetimeSignal,
      pendingExtensionActions,
    );
    flushProgressText();
    throwIfCancelled(lifetimeSignal);
    if (extensionShutdownError) throw new Error(extensionShutdownError);

    lastAssistant = session.getLastAssistantMessage();
    await abortable(session.settleInFlightMessagePersistence(), lifetimeSignal);
  } catch (error) {
    executionError = errorText(error);
  } finally {
    if (requestSessionAbort)
      lifetimeSignal.removeEventListener("abort", requestSessionAbort);
    unsubscribeEvents?.();
    unsubscribeExtensionErrors?.();
    unsubscribeToolGate?.();

    if (session) {
      try {
        session.beginDispose();
        if (session.isStreaming || lifetimeSignal.aborted) {
          abortSessionWork ??= session.abort({
            reason: cancellationText(lifetimeSignal),
          });
        }
        await abortSessionWork;
        const reaped = await manager.cancelAndReapOwnerJobs(
          request.id,
          Number.POSITIVE_INFINITY,
        );
        await reaped.completion;
        try {
          await session.dispose();
        } finally {
          const finalReap = await manager.cancelAndReapOwnerJobs(
            request.id,
            Number.POSITIVE_INFINITY,
          );
          await finalReap.completion;
        }
      } catch (error) {
        cleanupError = errorText(error);
      }
    } else if (sessionManager) {
      try {
        await sessionManager.close();
      } catch (error) {
        cleanupError = errorText(error);
      }
    }

    unregisterParentChange();
  }

  const output = assistantText(lastAssistant);
  if (lifetimeSignal.aborted) {
    return {
      status: "cancelled",
      output,
      error: cleanupError
        ? `${cancellationText(lifetimeSignal)} Cleanup failed: ${cleanupError}`
        : cancellationText(lifetimeSignal),
      sessionFile,
    };
  }
  if (executionError || cleanupError) {
    const errors = [
      executionError,
      cleanupError && `Cleanup failed: ${cleanupError}`,
    ]
      .filter(Boolean)
      .join(" ");
    return { status: "failed", output, error: errors, sessionFile };
  }
  if (!lastAssistant) {
    return {
      status: "failed",
      output: "",
      error: "Daybreak completed without an assistant result.",
      sessionFile,
    };
  }
  if (
    !isRequestedModel({
      provider: lastAssistant.provider,
      id: lastAssistant.model,
    })
  ) {
    return {
      status: "failed",
      output,
      error: `Daybreak returned output from an unexpected model: ${lastAssistant.provider}/${lastAssistant.model}.`,
      sessionFile,
    };
  }
  if (lastAssistant.stopReason === "aborted") {
    return {
      status: "failed",
      output,
      error:
        lastAssistant.errorMessage?.trim() ||
        "The Daybreak child aborted before completion.",
      sessionFile,
    };
  }
  if (
    lastAssistant.stopReason === "error" ||
    lastAssistant.stopDetails?.type === "refusal"
  ) {
    return {
      status: "failed",
      output,
      error:
        lastAssistant.errorMessage?.trim() ||
        lastAssistant.stopDetails?.explanation?.trim() ||
        "The Daybreak model refused or failed the delegated task.",
      sessionFile,
    };
  }
  if (lastAssistant.stopReason !== "stop" || !output) {
    return {
      status: "failed",
      output,
      error: `Daybreak ended without a complete final response (stop reason: ${lastAssistant.stopReason}).`,
      sessionFile,
    };
  }

  try {
    await access(sessionFile!);
  } catch (error) {
    return {
      status: "failed",
      output,
      error: `The Daybreak transcript was not persisted: ${errorText(error)}`,
      sessionFile,
    };
  }

  safeProgress(onProgress, `Daybreak child ${request.id} completed.`);
  return { status: "completed", output, sessionFile };
};
