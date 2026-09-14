import type {
  ExtensionContext,
  SessionEntry,
  SessionStopEvent,
} from "@oh-my-pi/pi-coding-agent";

import {
  DAYBREAK_MODEL,
  PARENT_MODEL,
  type DelegationRequest,
  type WorkerResult,
} from "./contracts.js";

const MAX_USER_CHARS = 12_000;
const MAX_PRIOR_USER_CHARS = 6_000;
const MAX_PRIOR_USER_ITEMS = 2;
const MAX_PRIOR_ASSISTANT_CHARS = 1_500;
const MAX_PRIOR_ASSISTANT_ITEMS = 8;
const MAX_TOOL_ARGUMENT_CHARS = 600;
const MAX_TOOL_OUTPUT_CHARS = 2_200;
const MAX_TOOL_CONTEXT_CHARS = 24_000;
const MAX_TOOL_OUTCOMES = 32;
const MAX_PROGRESS_CHARS = 6_000;
const MAX_PROGRESS_ITEMS = 8;
const MAX_ERROR_CHARS = 2_000;
const CYBER_POLICY_CODE =
  /(?:["']?(?:code|type)["']?\s*[:=]\s*)(?:"cyber_policy"|'cyber_policy'|cyber_policy(?=$|[\s,;:.!?)}\]]))/i;

interface MessageLike {
  role?: string;
  content?: unknown;
  synthetic?: boolean;
  attribution?: string;
  timestamp?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  errorClassificationMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface ToolCallLike {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface ReferencedMessage {
  message: MessageLike;
  reference: string;
}

function messageFromEntry(entry: SessionEntry): MessageLike | undefined {
  if (entry.type !== "message") return undefined;
  const message: MessageLike = entry.message;
  return message;
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (
      part === null ||
      typeof part !== "object" ||
      !("type" in part) ||
      part.type !== "text" ||
      !("text" in part) ||
      typeof part.text !== "string"
    ) {
      continue;
    }
    parts.push(part.text);
  }
  return parts.join("\n");
}

function assistantToolCalls(content: unknown): ToolCallLike[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallLike[] = [];
  for (const part of content) {
    if (
      part === null ||
      typeof part !== "object" ||
      !("type" in part) ||
      part.type !== "toolCall" ||
      !("id" in part) ||
      typeof part.id !== "string" ||
      !("name" in part) ||
      typeof part.name !== "string"
    ) {
      continue;
    }
    calls.push({
      type: "toolCall",
      id: part.id,
      name: part.name,
      arguments: "arguments" in part ? part.arguments : undefined,
    });
  }
  return calls;
}

function redactSensitiveText(value: string): string {
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
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function boundedText(
  value: string,
  limit: number,
  reference: string,
  label: string,
): string {
  const safe = redactSensitiveText(value).trim();
  if (safe.length <= limit) return safe;
  const omitted = safe.length - limit;
  return `${safe.slice(0, limit)}\n[${omitted} ${label} characters omitted; source reference: ${reference}]`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function isRealUserMessage(message: MessageLike): boolean {
  return (
    message.role === "user" &&
    message.synthetic !== true &&
    message.attribution !== "agent"
  );
}

interface PriorVisibleContext {
  text: string;
  startIndex: number;
}

function priorVisibleContext(
  messages: ReferencedMessage[],
  userIndex: number,
): PriorVisibleContext {
  const previousUsers: Array<{
    index: number;
    reference: string;
    text: string;
  }> = [];
  for (let index = 0; index < userIndex; index += 1) {
    const { message, reference } = messages[index]!;
    if (!isRealUserMessage(message)) continue;
    const text = visibleText(message.content).trim();
    if (!text) continue;
    previousUsers.push({
      index,
      reference,
      text: boundedText(
        text,
        MAX_PRIOR_USER_CHARS,
        reference,
        "prior-user-request",
      ),
    });
  }

  const selectedUsers = previousUsers.slice(-MAX_PRIOR_USER_ITEMS);
  const startIndex = selectedUsers[0]?.index ?? userIndex;
  const assistants: Array<{
    index: number;
    reference: string;
    text: string;
  }> = [];
  for (let index = startIndex; index < userIndex; index += 1) {
    const { message, reference } = messages[index]!;
    if (message.role !== "assistant" || message.stopReason === "error")
      continue;
    const text = visibleText(message.content).trim();
    if (!text) continue;
    assistants.push({
      index,
      reference,
      text: boundedText(
        text,
        MAX_PRIOR_ASSISTANT_CHARS,
        reference,
        "prior-visible-assistant",
      ),
    });
  }

  const selectedAssistants = assistants.slice(-MAX_PRIOR_ASSISTANT_ITEMS);
  const selected = [
    ...selectedUsers.map((item) => ({
      ...item,
      label: "Prior real-user request",
    })),
    ...selectedAssistants.map((item) => ({
      ...item,
      label: "Visible assistant update",
    })),
  ].sort((left, right) => left.index - right.index);
  if (selected.length === 0) {
    return {
      text: "- No earlier visible task context was recorded.",
      startIndex: userIndex,
    };
  }

  const lines = selected.map(
    ({ label, reference, text }) =>
      `- ${label} (entry ${reference}): ${text.replace(/\n/g, "\n  ")}`,
  );
  const omitted =
    previousUsers.length -
    selectedUsers.length +
    assistants.length -
    selectedAssistants.length;
  if (omitted > 0) {
    lines.unshift(
      `[${omitted} earlier visible task-context entries omitted from inline context; use the parent transcript reference below.]`,
    );
  }
  return { text: lines.join("\n"), startIndex };
}

function sourceMessages(
  event: SessionStopEvent,
  ctx: ExtensionContext,
):
  | { messages: ReferencedMessage[]; userIndex: number; userReference: string }
  | undefined {
  const branch = ctx.sessionManager.getBranch();
  const branchMessages: ReferencedMessage[] = [];
  let branchUserIndex = -1;

  for (const entry of branch) {
    const message = messageFromEntry(entry);
    if (!message) continue;
    branchMessages.push({ message, reference: entry.id });
    if (isRealUserMessage(message)) branchUserIndex = branchMessages.length - 1;
  }

  if (branchUserIndex >= 0) {
    return {
      messages: branchMessages,
      userIndex: branchUserIndex,
      userReference: branchMessages[branchUserIndex]!.reference,
    };
  }

  const eventMessages: ReferencedMessage[] = event.messages.map(
    (message, index) => ({
      message,
      reference: `event-message-${index + 1}`,
    }),
  );
  let eventUserIndex = -1;
  for (let index = 0; index < eventMessages.length; index += 1) {
    if (isRealUserMessage(eventMessages[index]!.message))
      eventUserIndex = index;
  }
  if (eventUserIndex < 0) return undefined;

  return {
    messages: eventMessages,
    userIndex: eventUserIndex,
    userReference: eventMessages[eventUserIndex]!.reference,
  };
}

function toolOutcomeContext(
  messages: ReferencedMessage[],
  startIndex: number,
): string {
  const calls = new Map<string, ToolCallLike>();
  const outcomes: Array<{ reference: string; text: string }> = [];

  for (const { message, reference } of messages.slice(startIndex + 1)) {
    if (message.role === "assistant") {
      for (const call of assistantToolCalls(message.content))
        calls.set(call.id!, call);
      continue;
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string")
      continue;

    const call = calls.get(message.toolCallId);
    const toolName = call?.name ?? message.toolName ?? "unknown-tool";
    let serializedArguments = "(arguments unavailable)";
    if (call?.arguments !== undefined) {
      try {
        serializedArguments =
          JSON.stringify(call.arguments) ??
          "(arguments could not be serialized)";
      } catch {
        serializedArguments = "(arguments could not be serialized)";
      }
    }
    const argumentsText = boundedText(
      serializedArguments,
      MAX_TOOL_ARGUMENT_CHARS,
      reference,
      "tool-argument",
    );
    const rawOutput = visibleText(message.content) || "(no textual output)";
    const output = boundedText(
      rawOutput,
      MAX_TOOL_OUTPUT_CHARS,
      reference,
      "tool-output",
    );
    outcomes.push({
      reference,
      text: [
        `- ${toolName} (${message.isError === true ? "failed" : "completed"}; entry ${reference})`,
        `  invocation: ${argumentsText}`,
        `  outcome: ${output.replace(/\n/g, "\n  ")}`,
      ].join("\n"),
    });
  }

  if (outcomes.length === 0)
    return "- No completed tool invocations were recorded in the retained task context.";

  const included: typeof outcomes = [];
  let usedChars = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index]!;
    if (
      included.length >= MAX_TOOL_OUTCOMES ||
      usedChars + outcome.text.length > MAX_TOOL_CONTEXT_CHARS
    )
      break;
    included.push(outcome);
    usedChars += outcome.text.length;
  }
  included.reverse();

  const omitted = outcomes.length - included.length;
  const sections: string[] = [];
  if (omitted > 0) {
    const omittedRefs = outcomes
      .slice(0, omitted)
      .map(({ reference }) => reference)
      .join(", ");
    sections.push(
      `[${omitted} earlier completed tool outcomes omitted from inline context; source entries: ${boundedText(
        omittedRefs,
        2_000,
        `${outcomes[0]!.reference}..${outcomes[omitted - 1]!.reference}`,
        "reference-list",
      )}]`,
    );
  }
  sections.push(...included.map(({ text }) => text));
  return sections.join("\n");
}

function visibleProgressContext(
  messages: ReferencedMessage[],
  userIndex: number,
): string {
  const progress: Array<{ reference: string; text: string }> = [];
  for (const { message, reference } of messages.slice(userIndex + 1)) {
    if (message.role !== "assistant" || message.stopReason === "error")
      continue;
    const text = visibleText(message.content).trim();
    if (!text) continue;
    progress.push({
      reference,
      text: boundedText(text, 1_500, reference, "assistant-progress"),
    });
  }
  if (progress.length === 0)
    return "- No visible assistant progress text was recorded.";

  const included: typeof progress = [];
  let usedChars = 0;
  for (let index = progress.length - 1; index >= 0; index -= 1) {
    const item = progress[index]!;
    if (
      included.length >= MAX_PROGRESS_ITEMS ||
      usedChars + item.text.length > MAX_PROGRESS_CHARS
    )
      break;
    included.push(item);
    usedChars += item.text.length;
  }
  included.reverse();

  const omitted = progress.length - included.length;
  const lines = included.map(
    ({ reference, text }) =>
      `- Entry ${reference}: ${text.replace(/\n/g, "\n  ")}`,
  );
  if (omitted > 0) {
    lines.unshift(
      `[${omitted} earlier visible progress entries omitted; source entries ${progress[0]!.reference}..${progress[omitted - 1]!.reference}]`,
    );
  }
  return lines.join("\n");
}

function cyberPolicyErrorText(message: MessageLike): string | undefined {
  if (
    message.role !== "assistant" ||
    message.provider !== "openai-codex" ||
    message.model !== "gpt-6-astra" ||
    message.stopReason !== "error"
  ) {
    return undefined;
  }
  for (const candidate of [
    message.errorClassificationMessage,
    message.errorMessage,
  ]) {
    if (typeof candidate === "string" && CYBER_POLICY_CODE.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function buildDelegationRequest(
  event: SessionStopEvent,
  ctx: ExtensionContext,
): DelegationRequest | undefined {
  if (event.signal.aborted) return undefined;
  if (event.session_id !== ctx.sessionManager.getSessionId()) return undefined;
  if (
    event.session_file &&
    event.session_file !== ctx.sessionManager.getSessionFile()
  )
    return undefined;
  if (ctx.model?.provider !== "openai-codex" || ctx.model.id !== "gpt-6-astra")
    return undefined;

  const terminal: MessageLike | undefined = event.last_assistant_message;
  if (!terminal) return undefined;
  const sourceError = cyberPolicyErrorText(terminal);
  if (!sourceError) return undefined;

  const source = sourceMessages(event, ctx);
  if (!source) return undefined;
  const userMessage = source.messages[source.userIndex]!.message;
  const userText = visibleText(userMessage.content).trim();
  if (!userText) return undefined;

  const requestKey = source.userReference.startsWith("event-message-")
    ? `fallback-${stableHash(
        `${event.session_id}\u0000${userMessage.timestamp ?? 0}\u0000${visibleText(userMessage.content)}`,
      )}`
    : source.userReference;
  const requestId = `daybreak-${Date.now().toString(36)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const boundedUserText = boundedText(
    userText,
    MAX_USER_CHARS,
    source.userReference,
    "user-request",
  );
  const priorContext = priorVisibleContext(source.messages, source.userIndex);
  const toolContext = toolOutcomeContext(
    source.messages,
    priorContext.startIndex,
  );
  const progressContext = visibleProgressContext(
    source.messages,
    source.userIndex,
  );

  const prompt = [
    "# Delegated task",
    `Complete only the remaining authorized work for parent request ${requestKey}. Use exactly ${DAYBREAK_MODEL}.`,
    "Do not broaden the request, relax approval/tool policy, change credentials, or alter the parent model/settings.",
    "Treat every completed invocation below as an already-performed side effect. Do not repeat it unless its recorded outcome explicitly failed and a retry is necessary to complete the original scope.",
    "",
    "## Latest real-user message",
    boundedUserText,
    "",
    "## Prior visible task context",
    priorContext.text,
    "",
    "## Completed tool invocations and outcomes",
    toolContext,
    "",
    "## Visible progress from the parent",
    progressContext,
    "",
    "## Parent transcript reference",
    event.session_file ??
      ctx.sessionManager.getSessionFile() ??
      "(No persisted parent transcript path is available.)",
    "Inline omission markers refer to entries in this parent transcript. Consult only omitted context needed to resolve the latest message, and do not replay completed tool calls.",
    "",
    "## Remaining-work rule",
    "Infer only the unfinished portion from the latest real-user message, prior visible task context, visible progress, and concrete tool outcomes above. Finish that portion end to end, report exactly what changed and what remains blocked, and do not claim unobserved work.",
    "No hidden reasoning or thinking content is included in this handoff.",
  ].join("\n");

  return {
    id: requestId,
    requestKey,
    prompt,
    cwd: ctx.cwd,
    sourceModel: PARENT_MODEL,
    sourceError: boundedText(
      sourceError,
      MAX_ERROR_CHARS,
      "terminal-assistant-error",
      "provider-error",
    ),
    parentSessionId: event.session_id,
  };
}

export function formatWorkerCompletion(
  request: DelegationRequest,
  result: WorkerResult,
): string {
  const output =
    redactSensitiveText(result.output).trim() ||
    "(The worker returned no textual summary.)";
  const transcript = result.sessionFile ?? `history://${request.id}`;
  return [
    `Daybreak delegation ${request.id} completed for parent request ${request.requestKey}.`,
    `Worker model: ${DAYBREAK_MODEL}`,
    `Worker transcript artifact: ${transcript}`,
    `Worker history: history://${request.id}`,
    "",
    "Worker result:",
    output,
    "",
    "Resume the original parent task from this result. Do not repeat security work or tool calls already recorded as completed in the handoff; verify only new remaining work and then answer the user.",
  ].join("\n");
}
