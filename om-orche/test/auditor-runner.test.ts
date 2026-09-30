import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizeCustomMessagePayload, type NormalizedCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { executeAuditTool, registerVerificationAuditor, runVerificationAudit, type AuditInput, type AuditNote, type AuditRunner } from "../src/auditor-runner.ts";
import { AUDIT_MESSAGE_TYPE, AUDITOR_NAME, AUDITOR_ROLE } from "../src/verification-auditor.ts";
import { collectFindings } from "../src/findings.ts";
import { clearRegistry, makeApi, makeSession, registerAsMain } from "./harness.ts";

const roots: string[] = [];
afterEach(async () => { clearRegistry(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const model = { id: "audit-fixture", provider: "openai", api: "openai-completions", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Parameters<NonNullable<Parameters<typeof runVerificationAudit>[3]>>[0];
function answer(text = "Done.", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const note: AuditNote = { note: 'The answer says "all tests pass" but `bun test` exited 1.', severity: "blocker", advisor: AUDITOR_NAME };
async function settled() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function fixture(runner: AuditRunner, main = true) {
  const fake = makeSession();
  const manager = SessionManager.inMemory(process.cwd());
  Object.assign(fake.session, { sessionManager: manager });
  Object.assign(fake.ctx, { sessionManager: manager });
  if (main) registerAsMain(fake.session);
  let enabled = true;
  type Payload = Parameters<ExtensionAPI["sendMessage"]>[0];
  type Delivery = Parameters<ExtensionAPI["sendMessage"]>[1];
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {};
  const delivered: { message: NormalizedCustomMessagePayload; options: Delivery }[] = [];
  const { pi: host } = makeApi();
  const pi = { logger: host.logger, on(event: string, handler: typeof handlers[string]) { handlers[event] = handler; }, sendMessage(payload: Payload, options: Delivery) { const message = normalizeCustomMessagePayload(payload); delivered.push({ message, options }); manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); } } as unknown as ExtensionAPI;
  registerVerificationAuditor(pi, () => enabled, runner);
  const emit = (event: string, payload: unknown = {}) => handlers[event]?.(payload, fake.ctx);
  return { ...fake, manager, delivered, emit, disable() { enabled = false; }, begin() { emit("before_agent_start", { prompt: "Fix the importer." }); emit("agent_start"); }, end(message = answer(), willContinue = false) { emit("agent_end", { messages: [{ role: "user", content: "Fix the importer.", timestamp: 0 }, message], willContinue }); } };
}

test("one background audit per terminal run, not mid-run turns or continuation boundaries", async () => {
  const seen: AuditInput[] = [];
  const app = fixture(async input => { seen.push(input); return []; });
  app.begin();
  app.emit("turn_end", { message: answer() });
  app.end(answer(), true);
  expect(seen).toEqual([]);
  app.end(); app.end();
  await settled();
  expect(seen.map(input => [input.request, input.finalAnswer])).toEqual([["Fix the importer.", "Done."]]);
  expect(app.delivered).toEqual([]);
});

test("subagents, disabled runs, aborted/error output and no final answer never audit", async () => {
  let calls = 0;
  const run: AuditRunner = async () => { calls++; return []; };
  const child = fixture(run, false); child.begin(); child.end();
  const app = fixture(run); app.begin(); app.end(answer("", "stop")); app.end(answer("Failed", "error")); app.end(answer("Aborted", "aborted"));
  app.disable(); app.end();
  await settled(); expect(calls).toBe(0);
});

for (const severity of ["concern", "blocker"] as const) test(`${severity} persists and starts one follow-up; that follow-up is audited but cannot start another`, async () => {
  let calls = 0;
  const app = fixture(async () => { calls++; return [{ ...note, severity }]; });
  app.begin(); app.end(); await settled();
  expect(app.delivered[0]?.options?.triggerTurn).toBe(true);
  expect(app.delivered[0]?.message.customType).toBe(AUDIT_MESSAGE_TYPE);
  const first = collectFindings(app.manager.getBranch());
  expect(first[0]).toMatchObject({ id: `${app.manager.getBranch()[0]!.id}:0`, severity, status: "open" });
  app.emit("agent_start"); app.end(answer(), true); app.emit("agent_start"); app.end(); await settled();
  expect(calls).toBe(2);
  expect(app.delivered.map(entry => entry.options?.triggerTurn)).toEqual([true, false]);
  expect(collectFindings(app.manager.getBranch())[0]?.id).toBe(first[0]?.id);
  app.begin(); app.end(); await settled();
  expect(app.delivered.map(entry => entry.options?.triggerTurn)).toEqual([true, false, true]);
});

test("new primary run aborts and discards stale findings", async () => {
  const pending = Promise.withResolvers<AuditNote[]>();
  let signal!: AbortSignal;
  const app = fixture(async (_input, _ctx, value) => { signal = value; return pending.promise; });
  app.begin(); app.end(); app.begin();
  expect(signal.aborted).toBe(true);
  pending.resolve([note]); await settled();
  expect(app.delivered).toEqual([]);
});

test("audit failure shows one warning without notes or a follow-up", async () => {
  const app = fixture(async () => { throw new Error("provider unavailable"); });
  app.begin(); app.end(); await settled();
  expect(app.delivered).toHaveLength(1);
  expect(app.delivered[0]?.message.content).toBe("Verification audit failed: provider unavailable");
  expect(app.delivered[0]?.options?.triggerTurn).toBe(false);
  expect(collectFindings(app.manager.getBranch())).toEqual([]);
});

async function providerFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "orche-audit-model-")); roots.push(root);
  await writeFile(path.join(root, "result.txt"), "1 fail\n");
  const fake = makeSession(); registerAsMain(fake.session);
  fake.session.settings.setModelRole(AUDITOR_ROLE, `${model.provider}/${model.id}`);
  Object.assign(fake.session.settings, { reloadFromDisk: async () => {} });
  Object.assign(fake.ctx.modelRegistry, { getAvailable: () => [model], getApiKey: async () => "fixture-key" });
  const input = { request: "Test the importer", transcript: "toolResult: 1 fail", finalAnswer: "all tests pass", cwd: root };
  return { ...fake, root, input, signal: new AbortController().signal };
}

test("tool-using model loop checks output and enforces severity before persistence", async () => {
  const app = await providerFixture();
  let calls = 0;
  const notes = await runVerificationAudit(app.input, app.ctx, app.signal, async (_model, context) => {
    calls++;
    if (calls === 1) return { ...answer(), stopReason: "toolUse", content: [{ type: "toolCall", id: "read-output", name: "read", arguments: { path: "result.txt" } }] };
    expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: false, content: [{ type: "text", text: "result.txt:1: 1 fail\nresult.txt:2: " }] });
    return answer(JSON.stringify({ notes: [note, { note: "result.txt:1 contradicts the count.", severity: "blocker" }, { note: "Missing proof", severity: "concern" }] }));
  });
  expect(calls).toBe(2);
  expect(notes.map(value => value.severity)).toEqual(["blocker", "concern"]);
});

test("provider errors retry at most once and invalid output fails rather than claiming clean", async () => {
  const app = await providerFixture();
  let calls = 0;
  await expect(runVerificationAudit(app.input, app.ctx, app.signal, async () => { calls++; return { ...answer("", "error"), errorMessage: "provider unavailable" }; })).rejects.toThrow("provider unavailable");
  expect(calls).toBe(2);
  calls = 0;
  await expect(runVerificationAudit(app.input, app.ctx, app.signal, async () => { calls++; return answer("looks fine"); })).rejects.toThrow("expected JSON");
  expect(calls).toBe(1);
});

test("read/grep/glob are confined including symlink targets and report file:line evidence", async () => {
  const app = await providerFixture();
  const outside = await mkdtemp(path.join(tmpdir(), "orche-audit-outside-")); roots.push(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(path.join(outside, "secret.txt"), path.join(app.root, "escape.txt"));
  await expect(executeAuditTool(app.root, "read", { path: "escape.txt" }, app.signal)).rejects.toThrow("outside");
  await expect(executeAuditTool(app.root, "grep", { path: outside, pattern: "secret" }, app.signal)).rejects.toThrow("outside");
  await expect(executeAuditTool(app.root, "glob", { pattern: "../**" }, app.signal)).rejects.toThrow("inside");
  expect(await executeAuditTool(app.root, "grep", { pattern: "fail" }, app.signal)).toBe("result.txt:1: 1 fail");
  expect(await executeAuditTool(app.root, "glob", { pattern: "*.txt" }, app.signal)).toBe("result.txt");
});
