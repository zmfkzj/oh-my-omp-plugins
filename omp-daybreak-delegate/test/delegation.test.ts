import { describe, expect, test } from "bun:test";
import type {
  AgentEndEvent,
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  SessionStopEvent,
} from "@oh-my-pi/pi-coding-agent";
import { buildDelegationRequest } from "../src/handoff";
import { registerDaybreakDelegate } from "../src/index";
import {
  DAYBREAK_MODEL,
  type WorkerResult,
  type WorkerRunner,
} from "../src/contracts";

const POLICY_ERROR = 'Request rejected: {"code":"cyber_policy"}';
const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function userMessage(content: string, synthetic = false) {
  return { role: "user", content, synthetic, timestamp: 1 };
}

function assistantError(
  errorMessage = POLICY_ERROR,
  overrides: Record<string, unknown> = {},
) {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-6-astra",
    usage: USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: 2,
    ...overrides,
  };
}

function messageEntry(
  id: string,
  message: unknown,
  parentId: string | null = null,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    message,
  };
}

function stopEvent(
  messages: unknown[],
  lastAssistant: unknown,
): SessionStopEvent {
  const event = {
    type: "session_stop",
    messages,
    last_assistant_message: lastAssistant,
    session_id: "session-1",
    session_file: "/sessions/session-1.jsonl",
    turn_id: 1,
    stop_hook_active: true,
    signal: new AbortController().signal,
  };
  return event as unknown as SessionStopEvent;
}

function agentEndEvent(
  messages: unknown[],
  willContinue?: boolean,
): AgentEndEvent {
  return {
    type: "agent_end",
    messages,
    willContinue,
  } as unknown as AgentEndEvent;
}

function handoffContext(branch: unknown[]): ExtensionContext {
  return {
    cwd: "/workspace",
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/sessions/session-1.jsonl",
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
}

type JobRun = (context: {
  jobId: string;
  signal: AbortSignal;
  reportProgress: (text: string, details?: unknown) => Promise<void>;
  markRunning: () => void;
}) => Promise<string | { text: string }>;

type JobOptions = {
  id?: string;
  ownerId?: string;
  agentId?: string;
  onProgress?: (text: string, details?: unknown) => void | Promise<void>;
};

interface ManagedJob {
  id: string;
  type: string;
  label: string;
  ownerId?: string;
  agentId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  controller: AbortController;
  progress: string[];
  completion: Promise<void>;
  resultText?: string;
  errorText?: string;
}

class ManagedJobsFixture {
  readonly jobs: ManagedJob[] = [];
  readonly deliveries: Array<{ jobId: string; text: string }> = [];
  readonly acknowledged = new Set<string>();
  readonly cancelCalls: Array<{ id: string; ownerId?: string }> = [];

  register(
    type: string,
    label: string,
    run: JobRun,
    options: JobOptions = {},
  ): string {
    const id = options.id ?? `job-${this.jobs.length + 1}`;
    const controller = new AbortController();
    const job: ManagedJob = {
      id,
      type,
      label,
      ownerId: options.ownerId,
      agentId: options.agentId,
      status: "running",
      controller,
      progress: [],
      completion: Promise.resolve(),
    };
    this.jobs.push(job);
    job.completion = (async () => {
      try {
        const outcome = await run({
          jobId: id,
          signal: controller.signal,
          reportProgress: async (text, details) => {
            job.progress.push(text);
            await options.onProgress?.(text, details);
          },
          markRunning: () => {},
        });
        const text = typeof outcome === "string" ? outcome : outcome.text;
        job.resultText = text;
        if (job.status !== "cancelled") job.status = "completed";
        if (job.status === "completed" && !this.acknowledged.has(id)) {
          this.deliveries.push({ jobId: id, text });
        }
      } catch (error) {
        job.errorText = error instanceof Error ? error.message : String(error);
        if (job.status !== "cancelled") job.status = "failed";
        if (job.status === "failed" && !this.acknowledged.has(id)) {
          this.deliveries.push({ jobId: id, text: job.errorText });
        }
      }
    })();
    return id;
  }

  cancel(id: string, filter?: { ownerId?: string }): boolean {
    this.cancelCalls.push({ id, ownerId: filter?.ownerId });
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.status !== "running") return false;
    if (filter?.ownerId && filter.ownerId !== job.ownerId) return false;
    job.status = "cancelled";
    job.controller.abort();
    return true;
  }

  acknowledgeDeliveries(ids: string[]): number {
    for (const id of ids) this.acknowledged.add(id);
    const before = this.deliveries.length;
    for (let index = this.deliveries.length - 1; index >= 0; index -= 1) {
      if (this.acknowledged.has(this.deliveries[index]!.jobId)) {
        this.deliveries.splice(index, 1);
      }
    }
    return before - this.deliveries.length;
  }

  getJob(id: string): ManagedJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  getRunningJobs(filter?: { ownerId?: string }): ManagedJob[] {
    return this.jobs.filter(
      (job) =>
        job.status === "running" &&
        (!filter?.ownerId || job.ownerId === filter.ownerId),
    );
  }

  getRecentJobs(limit = 10, filter?: { ownerId?: string }): ManagedJob[] {
    return this.jobs
      .filter(
        (job) =>
          job.status !== "running" &&
          (!filter?.ownerId || job.ownerId === filter.ownerId),
      )
      .slice(-limit)
      .reverse();
  }
}
type TestHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface TestCommand {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function lifecycleFixture(runWorker: WorkerRunner, error = assistantError()) {
  const user = userMessage("Finish the authorized migration.");
  const messages = [user, error];
  const branch: Array<Record<string, unknown>> = [
    messageEntry("user-entry-1", user),
    messageEntry("error-entry-1", error, "user-entry-1"),
  ];
  const handlers = new Map<string, TestHandler[]>();
  const commands = new Map<string, TestCommand>();
  const sentMessages: Array<{
    message: unknown;
    options?: Record<string, unknown>;
  }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const jobs = new ManagedJobsFixture();
  let sessionId = "session-1";
  let entrySequence = 0;

  const model = Object.freeze({
    provider: "openai-codex",
    id: "gpt-6-astra",
  }) as NonNullable<AgentSession["model"]>;
  const settings = Object.freeze({
    get: (key: string) => (key === "approvalMode" ? "ask" : undefined),
  });
  const parent = {
    sessionId,
    sessionManager: { getSessionId: () => sessionId },
    asyncJobManager: jobs,
    getAgentId: () => "Main",
    model,
    settings,
  } as unknown as AgentSession;

  const api = {
    on(event: string, handler: TestHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name: string, command: TestCommand) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entrySequence += 1;
      const previousEntry = branch.at(-1);
      branch.push({
        type: "custom",
        id: `custom-${entrySequence}`,
        parentId:
          typeof previousEntry?.id === "string" ? previousEntry.id : null,
        timestamp: new Date(entrySequence).toISOString(),
        customType,
        data,
      });
    },
    sendMessage(message: unknown, options?: Record<string, unknown>) {
      sentMessages.push({ message, options });
    },
    pi: {
      AgentRegistry: {
        global: () => ({
          list: () => [
            {
              id: "Main",
              displayName: "Main",
              kind: "main",
              status: "idle",
              session: parent,
              sessionFile: "/sessions/session-1.jsonl",
              createdAt: 0,
              lastActivity: 0,
            },
          ],
        }),
      },
    },
  } as unknown as ExtensionAPI;

  const context = {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    model,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getBranch: () => branch,
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      setStatus() {},
    },
  } as unknown as ExtensionContext;

  registerDaybreakDelegate(api, runWorker);

  return {
    api,
    branch,
    commands,
    context,
    error,
    handlers,
    jobs,
    messages,
    model,
    notifications,
    parent,
    sentMessages,
    settings,
    setSessionId(next: string) {
      sessionId = next;
    },
    async emit(event: string, payload: unknown) {
      const registered = handlers.get(event) ?? [];
      return Promise.all(
        registered.map((handler) => handler(payload, context)),
      );
    },
  };
}

describe("buildDelegationRequest", () => {
  test("accepts only a terminal Astra provider cyber_policy error", () => {
    const user = userMessage("Continue the authorized task.");
    const policy = assistantError();
    const branch = [
      messageEntry("user-entry", user),
      messageEntry("assistant-entry", policy, "user-entry"),
    ];
    const context = handoffContext(branch);

    const firstRequest = buildDelegationRequest(
      stopEvent([user, policy], policy),
      context,
    );
    const secondRequest = buildDelegationRequest(
      stopEvent([user, policy], policy),
      context,
    );
    expect(firstRequest).toBeDefined();
    expect(secondRequest).toBeDefined();
    expect(secondRequest!.requestKey).toBe(firstRequest!.requestKey);
    expect(secondRequest!.id).not.toBe(firstRequest!.id);

    const quotedUser = userMessage(
      "A log mentioned cyber_policy, but keep investigating.",
    );
    const genericError = assistantError("socket disconnected");
    expect(
      buildDelegationRequest(
        stopEvent([quotedUser, genericError], genericError),
        context,
      ),
    ).toBeUndefined();

    const quotedTool = {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "fixture text: cyber_policy" }],
      isError: false,
      timestamp: 2,
    };
    expect(
      buildDelegationRequest(
        stopEvent([user, quotedTool, genericError], genericError),
        context,
      ),
    ).toBeUndefined();

    const successfulQuote = assistantError(undefined, {
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "The user quoted cyber_policy." }],
    });
    expect(
      buildDelegationRequest(
        stopEvent([user, successfulQuote], successfulQuote),
        context,
      ),
    ).toBeUndefined();

    const wrongProvider = assistantError(POLICY_ERROR, { provider: "openai" });
    expect(
      buildDelegationRequest(
        stopEvent([user, wrongProvider], wrongProvider),
        context,
      ),
    ).toBeUndefined();

    const wrongModel = assistantError(POLICY_ERROR, {
      model: "gpt-daybreak-blue-latest",
    });
    expect(
      buildDelegationRequest(
        stopEvent([user, wrongModel], wrongModel),
        context,
      ),
    ).toBeUndefined();

    const extendedCode = assistantError(
      'Request rejected: {"code":"cyber_policy_extra"}',
    );
    expect(
      buildDelegationRequest(
        stopEvent([user, extendedCode], extendedCode),
        context,
      ),
    ).toBeUndefined();
  });

  test("preserves prior authorized work across a bounded continuation handoff", () => {
    const user = userMessage(
      "Finish the migration after the completed parser edit.",
    );
    const toolOutcomes = Array.from(
      { length: 160 },
      (_, index) => `COMPLETED-OUTCOME-${index}: ${"x".repeat(700)}`,
    );
    const messages: unknown[] = [user];
    const branch: Array<Record<string, unknown>> = [
      messageEntry("user-entry", user),
    ];
    let parentId = "user-entry";

    for (const [index, outcome] of toolOutcomes.entries()) {
      const call = {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "HIDDEN-REASONING-MUST-NOT-TRANSFER",
          },
          {
            type: "toolCall",
            id: `tool-${index}`,
            name: "write",
            arguments: { path: `/workspace/file-${index}.ts` },
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-6-astra",
        usage: USAGE,
        stopReason: "toolUse",
        timestamp: index * 2 + 2,
      };
      const result = {
        role: "toolResult",
        toolCallId: `tool-${index}`,
        toolName: "write",
        content: [{ type: "text", text: outcome }],
        isError: false,
        timestamp: index * 2 + 3,
      };
      messages.push(call, result);
      const callId = `call-entry-${index}`;
      const resultId = `result-entry-${index}`;
      branch.push(messageEntry(callId, call, parentId));
      branch.push(messageEntry(resultId, result, callId));
      parentId = resultId;
    }

    const continuation = userMessage("continue");
    messages.push(continuation);
    branch.push(messageEntry("continuation-entry", continuation, parentId));
    parentId = "continuation-entry";

    const policy = assistantError(POLICY_ERROR, { timestamp: 10_000 });
    messages.push(policy);
    branch.push(messageEntry("error-entry", policy, parentId));

    const request = buildDelegationRequest(
      stopEvent(messages, policy),
      handoffContext(branch),
    );
    expect(request).toBeDefined();
    expect(request!.prompt).toContain(
      "Finish the migration after the completed parser edit.",
    );
    expect(request!.prompt).toContain("continue");
    expect(request!.prompt).toContain("COMPLETED-OUTCOME-159");
    expect(request!.prompt).not.toContain("HIDDEN-REASONING-MUST-NOT-TRANSFER");

    const missingOutcomes = toolOutcomes.filter(
      (outcome) => !request!.prompt.includes(outcome),
    );
    expect(missingOutcomes.length).toBeGreaterThan(0);
    expect(request!.prompt).toMatch(/omitt/i);
    expect(request!.prompt).toContain("/sessions/session-1.jsonl");
  });
});

describe("registerDaybreakDelegate", () => {
  test("returns from the stop hook while the owned worker is still pending", async () => {
    const gate = deferred<WorkerResult>();
    let workerSettled = false;
    const fixture = lifecycleFixture(async () => {
      const result = await gate.promise;
      workerSettled = true;
      return result;
    });
    const event = stopEvent(fixture.messages, fixture.error);
    let hookReturned = false;
    const stopPromise = fixture.emit("session_stop", event);
    void stopPromise.then(() => {
      hookReturned = true;
    });

    for (let turn = 0; turn < 20 && !hookReturned; turn += 1) {
      await Promise.resolve();
    }
    const returnedWhileWorkerPending = hookReturned;

    expect(workerSettled).toBe(false);
    expect(fixture.jobs.jobs).toHaveLength(1);
    expect(fixture.jobs.jobs[0]!.ownerId).toBe("Main");

    fixture.jobs.cancel(fixture.jobs.jobs[0]!.id, { ownerId: "Main" });
    gate.resolve({ status: "cancelled", output: "" });
    await fixture.jobs.jobs[0]!.completion;
    await stopPromise;
    expect(returnedWhileWorkerPending).toBe(true);
  });

  test("admits a terminal tool-call error from agent_end once across both hooks", async () => {
    const terminal = assistantError(POLICY_ERROR, {
      content: [
        {
          type: "toolCall",
          id: "blocked-write",
          name: "write",
          arguments: { path: "/workspace/authorized.ts" },
        },
      ],
    });
    let runs = 0;
    const fixture = lifecycleFixture(async () => {
      runs += 1;
      return {
        status: "completed",
        output: "Finished the authorized edit.",
      };
    }, terminal);
    const notification = agentEndEvent(fixture.messages);

    await fixture.emit("agent_end", notification);
    expect(fixture.jobs.jobs).toHaveLength(1);
    await fixture.jobs.jobs[0]!.completion;

    await fixture.emit("session_stop", stopEvent(fixture.messages, terminal));
    await fixture.emit("agent_end", notification);
    expect(runs).toBe(1);
    expect(fixture.jobs.jobs).toHaveLength(1);
  });

  test("does not admit continuing notifications or stale earlier policy errors", async () => {
    const terminal = assistantError(POLICY_ERROR, {
      content: [
        {
          type: "toolCall",
          id: "blocked-edit",
          name: "edit",
          arguments: { path: "/workspace/authorized.ts" },
        },
      ],
    });
    let runs = 0;
    const fixture = lifecycleFixture(async () => {
      runs += 1;
      return { status: "completed", output: "unexpected delegation" };
    }, terminal);

    await fixture.emit("agent_end", agentEndEvent(fixture.messages, true));
    const nonPolicyTerminal = assistantError("socket disconnected", {
      timestamp: 3,
    });
    await fixture.emit(
      "agent_end",
      agentEndEvent([fixture.messages[0]!, terminal, nonPolicyTerminal]),
    );

    expect(runs).toBe(0);
    expect(fixture.jobs.jobs).toHaveLength(0);
  });

  test("deduplicates repeated stops and a post-completion Astra continuation for one real user request", async () => {
    const gate = deferred<WorkerResult>();
    let runs = 0;
    const fixture = lifecycleFixture(async () => {
      runs += 1;
      return gate.promise;
    });
    const event = stopEvent(fixture.messages, fixture.error);

    await fixture.emit("session_stop", event);
    await fixture.emit("session_stop", event);
    expect(runs).toBe(1);
    expect(fixture.jobs.jobs).toHaveLength(1);

    gate.resolve({
      status: "completed",
      output: "The bounded migration is complete.",
      sessionFile: "/sessions/artifacts/daybreak.jsonl",
    });
    await fixture.jobs.jobs[0]!.completion;
    expect(fixture.jobs.deliveries).toHaveLength(1);
    let reloadedRuns = 0;
    registerDaybreakDelegate(fixture.api, async () => {
      reloadedRuns += 1;
      return { status: "completed", output: "unexpected duplicate" };
    });

    const syntheticContinue = userMessage(
      "Continue from the delivered child result.",
      true,
    );
    const secondPolicyError = assistantError(POLICY_ERROR, { timestamp: 20 });
    const previousEntry = fixture.branch.at(-1);
    fixture.branch.push(
      messageEntry(
        "synthetic-entry",
        syntheticContinue,
        typeof previousEntry?.id === "string" ? previousEntry.id : null,
      ),
    );
    fixture.branch.push(
      messageEntry("second-error-entry", secondPolicyError, "synthetic-entry"),
    );

    await fixture.emit(
      "session_stop",
      stopEvent(
        [...fixture.messages, syntheticContinue, secondPolicyError],
        secondPolicyError,
      ),
    );
    expect(runs).toBe(1);
    expect(reloadedRuns).toBe(0);
    expect(fixture.jobs.jobs).toHaveLength(1);
  });

  test("cancels on session switch and suppresses a stale late completion", async () => {
    const gate = deferred<WorkerResult>();
    const fixture = lifecycleFixture(async () => gate.promise);

    await fixture.emit(
      "session_stop",
      stopEvent(fixture.messages, fixture.error),
    );
    const job = fixture.jobs.jobs[0]!;
    await fixture.emit("session_before_switch", {
      type: "session_before_switch",
      reason: "new",
    });
    fixture.setSessionId("session-2");

    expect(job.controller.signal.aborted).toBe(true);
    expect(fixture.jobs.cancelCalls).toContainEqual({
      id: job.id,
      ownerId: "Main",
    });

    gate.resolve({
      status: "completed",
      output: "This late result belongs to the abandoned session.",
      sessionFile: "/sessions/artifacts/stale.jsonl",
    });
    await job.completion;

    expect(fixture.jobs.deliveries).toHaveLength(0);
    expect(fixture.jobs.acknowledged.has(job.id)).toBe(true);
  });

  test("manual cancellation aborts the owned job and cannot deliver a late result", async () => {
    const gate = deferred<WorkerResult>();
    const fixture = lifecycleFixture(async () => gate.promise);

    await fixture.emit(
      "session_stop",
      stopEvent(fixture.messages, fixture.error),
    );
    const job = fixture.jobs.jobs[0]!;
    const command = fixture.commands.get("daybreak-delegate");
    expect(command).toBeDefined();
    await command!.handler("cancel", fixture.context);

    expect(job.controller.signal.aborted).toBe(true);
    expect(fixture.jobs.cancelCalls).toContainEqual({
      id: job.id,
      ownerId: "Main",
    });

    gate.resolve({ status: "completed", output: "late result" });
    await job.completion;
    expect(fixture.jobs.deliveries).toHaveLength(0);
  });

  test("reports worker failure without triggering the parent or retrying the same request", async () => {
    let runs = 0;
    const fixture = lifecycleFixture(async () => {
      runs += 1;
      return {
        status: "failed",
        output: "",
        error: "Daybreak authorization failed.",
      };
    });
    const event = stopEvent(fixture.messages, fixture.error);

    await fixture.emit("session_stop", event);
    const job = fixture.jobs.jobs[0]!;
    await job.completion;

    expect(fixture.jobs.deliveries).toHaveLength(0);
    expect(fixture.jobs.acknowledged.has(job.id)).toBe(true);
    expect(fixture.sentMessages.length).toBeGreaterThan(0);
    expect(
      fixture.sentMessages.every(
        (message) => message.options?.triggerTurn === false,
      ),
    ).toBe(true);

    await fixture.emit("session_stop", event);
    expect(runs).toBe(1);
    expect(fixture.jobs.jobs).toHaveLength(1);
  });

  test("never mutates the parent model or settings while delivering success", async () => {
    const fixture = lifecycleFixture(async () => ({
      status: "completed",
      output: "Authorized work completed.",
      sessionFile: "/sessions/artifacts/daybreak-success.jsonl",
    }));
    const originalModel = fixture.parent.model;
    const originalSettings = fixture.parent.settings;

    await fixture.emit(
      "session_stop",
      stopEvent(fixture.messages, fixture.error),
    );
    const job = fixture.jobs.jobs[0]!;
    await job.completion;

    expect(fixture.parent.model).toBe(originalModel);
    expect(fixture.parent.settings).toBe(originalSettings);
    expect(fixture.parent.model).toBe(fixture.model);

    const statusCommand = fixture.commands.get("daybreak-delegate");
    expect(statusCommand).toBeDefined();
    await statusCommand!.handler("status", fixture.context);
    const statusReport = fixture.notifications.at(-1)?.message ?? "";
    expect(statusReport).toContain("completed");
    expect(statusReport).toContain(DAYBREAK_MODEL);
    expect(statusReport).toContain(job.id);
    expect(statusReport).toContain(`history://${job.id}`);
    expect(statusReport).toContain(
      "/sessions/artifacts/daybreak-success.jsonl",
    );
  });
});
