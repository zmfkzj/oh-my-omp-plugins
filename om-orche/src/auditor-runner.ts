import path from "node:path";
import { realpath, stat, readFile } from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { completeSimple, type Context, type Tool } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { mainSessionOf } from "./host.ts";
import { admittedSeverity, type AuditorSeverity } from "./auditor-contract.ts";
import { sanitizeErrorMessage } from "./advisor-review.ts";
import { AUDIT_MESSAGE_TYPE, AUDITOR_INSTRUCTIONS, AUDITOR_NAME, AUDITOR_ROLE } from "./verification-auditor.ts";
export interface AuditNote { note: string; severity: AuditorSeverity; advisor: string }
export interface AuditInput { request: string; transcript: string; finalAnswer: string; cwd: string }
export interface AuditDiagnostics { model: string; steps: number; withheld: number }
export type AuditRunner = (input: AuditInput, ctx: ExtensionContext, signal: AbortSignal, onComplete?: (details: AuditDiagnostics) => void) => Promise<AuditNote[]>;

const tools: Tool[] = [
  { name: "read", description: "Read a UTF-8 file in the session cwd, with line numbers. No URLs or outside paths.", parameters: type({ path: "string", "offset?": "number", "limit?": "number" }) },
  { name: "grep", description: "Search a literal string in files under the session cwd. Returns file:line and matching text.", parameters: type({ pattern: "string", "path?": "string" }) },
  { name: "glob", description: "List files matching a glob under the session cwd. No URLs or outside paths.", parameters: type({ "pattern?": "string" }) },
];

/** Real paths, including symlink targets, must stay inside the run's cwd. */
async function confined(cwd: string, input: string): Promise<string> {
  if (/^[\w-]+:\/\//.test(input)) throw new Error("Auditor tools accept local paths only.");
  const root = await realpath(cwd);
  const resolved = await realpath(path.resolve(root, input));
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Auditor tools cannot access paths outside the session cwd.");
  }
  return resolved;
}

async function fileText(cwd: string, input: string): Promise<string> {
  const file = await confined(cwd, input);
  const info = await stat(file);
  if (!info.isFile() || info.size > 1_048_576) throw new Error("Auditor reads require a file no larger than 1 MiB.");
  return readFile(file, "utf8");
}

export async function executeAuditTool(cwd: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  cwd = await realpath(cwd);
  if (name === "read") {
    if (typeof args.path !== "string") throw new Error("read requires path.");
    const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 200;
    return (await fileText(cwd, args.path)).split("\n").slice(offset - 1, offset - 1 + limit)
      .map((line, index) => `${args.path}:${offset + index}: ${line}`).join("\n").slice(0, 16000);
  }
  if (name !== "glob" && name !== "grep") throw new Error(`Unknown auditor tool: ${name}`);
  if (name === "grep" && typeof args.pattern !== "string") throw new Error("grep requires a literal pattern.");
  const root = await confined(cwd, typeof args.path === "string" ? args.path : ".");
  const pattern = name === "glob" && typeof args.pattern === "string" ? args.pattern : "**/*";
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..") || pattern.includes("://")) throw new Error("Glob must stay inside the session cwd.");
  const candidates = (await stat(root)).isFile() ? [root] : new Bun.Glob(pattern).scan({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false });
  const output: string[] = [];
  let visited = 0;
  let size = 0;
  for await (const file of candidates) {
    signal.throwIfAborted();
    if (++visited > 2000 || output.length >= 200 || size >= 16000) break;
    let text: string;
    try {
      await confined(cwd, file);
      if (name === "glob") text = path.relative(cwd, file);
      else {
        text = (await fileText(cwd, file)).split("\n").flatMap((line, index) => line.includes(args.pattern as string) ? [`${path.relative(cwd, file)}:${index + 1}: ${line}`] : []).slice(0, 50).join("\n");
      }
    } catch { continue; }
    if (text) { output.push(text); size += text.length; }
  }
  return output.join("\n").slice(0, 16000) || "No matches.";
}

/** Tool-using pi-ai loop; role resolution and authorized credentials mirror runReview. */
export async function runVerificationAudit(input: AuditInput, ctx: ExtensionContext, signal: AbortSignal, completion: typeof completeSimple = completeSimple, onComplete?: (details: AuditDiagnostics) => void): Promise<AuditNote[]> {
  const primary = mainSessionOf(ctx);
  if (!primary) throw new Error("Verification audit is primary-only.");
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  await primary.settings.reloadFromDisk();
  requestSignal.throwIfAborted();
  const selection = resolveRoleSelection([AUDITOR_ROLE], primary.settings, ctx.modelRegistry.getAvailable());
  if (!selection) throw new Error("Configure modelRoles.verification-auditor with an available model; no DEFAULT fallback is used.");
  const requestId = Bun.randomUUIDv7();
  const apiKey = await ctx.modelRegistry.getApiKey(selection.model, requestId, { signal: requestSignal });
  requestSignal.throwIfAborted();
  if (!apiKey) throw new Error(`No request credential authorized for ${selection.model.provider}.`);
  const context: Context = {
    systemPrompt: [AUDITOR_INSTRUCTIONS],
    messages: [{ role: "user", content: JSON.stringify(input), timestamp: Date.now() }],
    tools,
  };
  let retried = false;
  for (let step = 0; step < 16; step++) {
    requestSignal.throwIfAborted();
    let result;
    try {
      result = await completion(selection.model, context, {
        apiKey, sessionId: requestId, signal: requestSignal, maxTokens: 4096,
        reasoning: selection.thinkingLevel === "auto" || selection.thinkingLevel === "off" || selection.thinkingLevel === "inherit" ? undefined : selection.thinkingLevel,
        disableReasoning: selection.thinkingLevel === "off",
      });
    } catch (error) {
      requestSignal.throwIfAborted();
      if (!retried) { retried = true; continue; }
      throw new Error(sanitizeErrorMessage(error, apiKey) ?? "provider error");
    }
    requestSignal.throwIfAborted();
    if (result.stopReason === "error") {
      if (!retried) { retried = true; continue; }
      throw new Error(sanitizeErrorMessage(result.errorMessage, apiKey) ?? "provider error");
    }
    if (result.stopReason === "aborted" || result.stopReason === "length") throw new Error(`Auditor output ${result.stopReason}.`);
    const calls = result.content.filter(part => part.type === "toolCall");
    if (calls.length > 0) {
      context.messages.push(result);
      for (const call of calls) {
        let text: string;
        let isError = false;
        try { text = await executeAuditTool(input.cwd, call.name, call.arguments, requestSignal); }
        catch (error) { requestSignal.throwIfAborted(); text = error instanceof Error ? error.message : String(error); isError = true; }
        context.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: Date.now() });
      }
      continue;
    }
    if (result.stopReason !== "stop") throw new Error(`Unexpected auditor stop: ${result.stopReason}.`);
    const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    let output: unknown;
    try { output = JSON.parse(text); } catch { throw new Error("Invalid auditor output: expected JSON notes."); }
    if (!output || typeof output !== "object" || !("notes" in output) || !Array.isArray(output.notes) || output.notes.length > 20) throw new Error("Invalid auditor output: expected notes array (maximum 20).");
    const notes: AuditNote[] = [];
    for (const raw of output.notes as unknown[]) {
      if (!raw || typeof raw !== "object" || !("note" in raw) || typeof raw.note !== "string" || !raw.note.trim() || raw.note.length > 4000 || !("severity" in raw) || (raw.severity !== "concern" && raw.severity !== "blocker")) throw new Error("Invalid auditor note.");
      const severity = admittedSeverity(raw.note, raw.severity);
      if (severity) notes.push({ note: raw.note, severity, advisor: AUDITOR_NAME });
    }
    onComplete?.({ model: `${result.provider}/${result.model}`, steps: step + 1, withheld: output.notes.length - notes.length });
    return notes;
  }
  throw new Error("Auditor exceeded its 16-step tool budget.");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => part.type === "text" ? part.text : part.type === "toolCall" ? JSON.stringify(part) : "[image]").join("\n");
}

/** Mark every omitted suffix so absence in bounded input is not mistaken for negative evidence. */
function boundedText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[remaining text omitted]`;
}

/** Run in the background after the host's terminal agent_end, never at turn_end. */
export function registerVerificationAuditor(pi: ExtensionAPI, enabled: () => boolean, runner: AuditRunner = (input, ctx, signal, onComplete) => runVerificationAudit(input, ctx, signal, completeSimple, onComplete)): void {
  let controller: AbortController | undefined;
  let request = "";
  let runRequest = "";
  let pendingFollowUp = false;
  let followUpRun = false;
  let audited = true;
  let generation = 0;
  const cancel = () => { generation++; controller?.abort(); controller = undefined; };
  pi.on("before_agent_start", (event, ctx) => {
    if (!mainSessionOf(ctx)) return;
    cancel();
    request = event.prompt;
    pendingFollowUp = false; // Only a real user-containing request fires this hook.
    followUpRun = false;
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!mainSessionOf(ctx)) return;
    cancel();
    followUpRun = pendingFollowUp || followUpRun;
    pendingFollowUp = false;
    runRequest = request;
    audited = false;
  });
  pi.on("agent_end", (event, ctx) => {
    const primary = mainSessionOf(ctx);
    if (!primary) return;
    const skip = !enabled() ? "disabled" : event.willContinue ? "willContinue" : audited ? "already-audited" : undefined;
    if (skip) {
      pi.logger.debug(`om-orche.audit skipped reason=${skip}`);
      return;
    }
    const final = event.messages.findLast((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
    if (!final || final.stopReason !== "stop" || final.content.some(part => part.type === "toolCall")) {
      pi.logger.debug("om-orche.audit skipped reason=not-terminal");
      return;
    }
    const finalAnswer = textOf(final.content).trim();
    if (!finalAnswer) {
      pi.logger.debug("om-orche.audit skipped reason=no-text");
      return;
    }
    audited = true;
    const userIndex = event.messages.findLastIndex(message => message.role === "user" && !message.synthetic && message.attribution !== "agent");
    const transcript = event.messages.slice(Math.max(0, userIndex)).map(message => `${message.role}${message.role === "toolResult" ? ` ${message.toolName}` : ""}: ${boundedText(textOf("content" in message ? message.content : "[summary]"), 8000)}`).join("\n\n");
    const input: AuditInput = { request: boundedText(runRequest, 16000), transcript: transcript.length > 64000 ? `[earlier transcript omitted]\n${transcript.slice(-64000)}` : transcript, finalAnswer: boundedText(finalAnswer, 16000), cwd: primary.sessionManager.getCwd() };
    const ownGeneration = generation;
    const allowFollowUp = !followUpRun;
    controller = new AbortController();
    const signal = controller.signal;
    pi.logger.debug(`om-orche.audit started followUp=${followUpRun} allowFollowUp=${allowFollowUp}`);
    let diagnostics: AuditDiagnostics | undefined;
    const discardReason = () => signal.aborted ? "aborted" : ownGeneration !== generation ? "stale" : !enabled() ? "disabled" : undefined;
    void runner(input, ctx, signal, details => { diagnostics = details; }).then(notes => {
      const reason = discardReason();
      if (reason) {
        pi.logger.debug(`om-orche.audit discarded reason=${reason}`);
        return;
      }
      controller = undefined;
      const triggerFollowUp = notes.length > 0 && allowFollowUp;
      pi.logger.debug(`om-orche.audit finished model=${diagnostics?.model ?? "unknown"} steps=${diagnostics?.steps ?? "unknown"} admitted=${notes.length} withheld=${diagnostics?.withheld ?? "unknown"} followUpTriggered=${triggerFollowUp}`);
      if (notes.length === 0) return;
      pendingFollowUp = allowFollowUp;
      pi.sendMessage({ customType: AUDIT_MESSAGE_TYPE, content: notes.map(note => `[${note.severity}] ${note.note}`).join("\n\n"), display: true, details: { notes } }, { triggerTurn: allowFollowUp });
    }).catch(error => {
      const reason = discardReason();
      if (reason) {
        pi.logger.debug(`om-orche.audit discarded reason=${reason}`);
        return;
      }
      controller = undefined;
      const why = (sanitizeErrorMessage(error, undefined) ?? "unknown error").slice(0, 300);
      pi.logger.warn(`om-orche.audit failed reason=${why}`);
      pi.sendMessage({ customType: "orche-verification-audit-failed", content: `Verification audit failed: ${why}`, display: true }, { triggerTurn: false });
    });
  });
  const reset = () => { cancel(); pendingFollowUp = false; audited = true; };
  pi.on("session_shutdown", reset);
  pi.on("session_switch", reset);
  pi.on("session_branch", reset);
  pi.on("session_tree", reset);
}
