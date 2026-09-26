import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AdvisorNote } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectFindings, registerFindingTools } from "../src/findings.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";
import { clearRegistry, registerAsMain } from "./harness.ts";

afterEach(clearRegistry);

type FindingTool = Parameters<ExtensionAPI["registerTool"]>[0];
type Confirm = (title: string, message: string) => Promise<boolean>;

/** `review_findings` over a real in-memory session registered as the process main agent. */
function primarySession(ui: { hasUI: boolean; confirm?: Confirm } = { hasUI: false }) {
  const manager = SessionManager.inMemory("/tmp/jev-router-findings-tool");
  let tool: FindingTool | undefined;
  registerFindingTools({
    zod: z,
    on() {},
    registerTool(definition: FindingTool) {
      tool = definition;
    },
  } as unknown as ExtensionAPI);
  registerAsMain({ sessionManager: manager } as unknown as AgentSession);
  const ctx = {
    sessionManager: manager,
    hasUI: ui.hasUI,
    ui: { confirm: ui.confirm ?? (async () => false) },
  } as unknown as ExtensionContext;
  const call = (params: Record<string, unknown>, context = ctx) =>
    tool!.execute("call-1", params as Parameters<FindingTool["execute"]>[1], undefined, undefined, context);
  return {
    manager,
    ctx,
    call,
    text: async (params: Record<string, unknown>) =>
      (await call(params)).content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    status: () => collectFindings(manager.getBranch()).map((finding) => finding.status),
    records: () => manager.getEntries().filter((entry) => entry.type === "custom").length,
    user: (text: string) =>
      manager.appendMessage({ role: "user", content: text, attribution: "user", timestamp: Date.now() }),
    audit: (note: AdvisorNote) =>
      manager.appendCustomMessageEntry("advisor", "Advisor notes", true, { notes: [note] }),
    result: (text: string, isError = false) =>
      manager.appendMessage({
        role: "toolResult",
        toolCallId: crypto.randomUUID(),
        toolName: "bash",
        content: [{ type: "text", text }],
        isError,
        timestamp: Date.now(),
      }),
  };
}

const blocker = (note: string): AdvisorNote => ({ note, severity: "blocker", advisor: AUDITOR_NAME });

describe("review_findings", () => {
  test("records a resolution only with successful evidence recorded after the finding", async () => {
    const session = primarySession();
    const stale = session.result("12 pass, 0 fail");
    const id = `${session.audit(blocker("Claimed tests pass; no runner output."))}:0`;
    const failed = session.result("1 fail", true);
    const passing = session.result("13 pass, 0 fail");

    const listing = await session.text({ action: "list" });
    expect(listing).toContain(id);
    expect(listing).toContain(`- ${passing} tool result (bash)`);
    expect(listing).not.toContain(stale);
    expect(listing).not.toContain(failed);

    const resolve = (evidence?: string[]) =>
      session.call({ action: "resolve", findingId: id, reason: "Reran the suite.", evidence });
    await expect(resolve([failed])).rejects.toThrow("failed tool result");
    await expect(resolve([stale])).rejects.toThrow("before the finding");
    await expect(resolve(["not-an-entry"])).rejects.toThrow("not an entry on the active branch");
    await expect(resolve()).rejects.toThrow("at least one evidence");
    expect(session.records()).toBe(0);

    const result = await resolve([passing]);
    expect(result.details).toMatchObject({ findingId: id, status: "resolved", evidence: [passing] });
    expect(collectFindings(session.manager.getBranch())[0]).toMatchObject({
      status: "resolved",
      transition: { author: "orchestrator", reason: "Reran the suite.", evidence: [{ entryId: passing }] },
    });
    await expect(resolve([passing])).rejects.toThrow("is resolved");
  });

  test("waives only after the user explicitly confirms", async () => {
    const prompts: string[] = [];
    let answer = false;
    const session = primarySession({
      hasUI: true,
      confirm: async (_title, message) => {
        prompts.push(message);
        return answer;
      },
    });
    session.user("Build the importer.");
    const id = `${session.audit({ note: "Rollback path is untested.", severity: "concern", advisor: AUDITOR_NAME })}:0`;
    const output = session.result("rollback skipped");
    const waive = (evidence?: string[]) =>
      session.call({ action: "waive", findingId: id, reason: "Rollback is out of scope.", evidence });

    await expect(waive([output])).rejects.toThrow("not a message the user typed");
    expect(prompts).toEqual([]);
    await expect(waive()).rejects.toThrow("did not confirm");
    expect(prompts[0]).toContain("Rollback path is untested.");
    expect(prompts[0]).toContain("Rollback is out of scope.");
    expect(session.status()).toEqual(["open"]);
    expect(session.records()).toBe(0);

    answer = true;
    await waive();
    expect(collectFindings(session.manager.getBranch())[0]).toMatchObject({
      status: "waived",
      transition: { author: "user", reason: "Rollback is out of scope." },
    });
  });

  test("refuses to waive without an interactive user to confirm", async () => {
    const session = primarySession({ hasUI: false });
    const id = `${session.audit(blocker("No smoke run."))}:0`;

    await expect(
      session.call({ action: "waive", findingId: id, reason: "Not needed." }),
    ).rejects.toThrow("explicit confirmation");
    expect(session.status()).toEqual(["open"]);
  });

  test("reopening requires fresh evidence for the next resolution", async () => {
    const session = primarySession();
    const id = `${session.audit(blocker("No smoke run."))}:0`;
    const smoke = session.result("smoke ok");
    await session.call({ action: "resolve", findingId: id, reason: "Smoke ran.", evidence: [smoke] });
    await session.call({ action: "reopen", findingId: id, reason: "The smoke used a stale build." });
    expect(session.status()).toEqual(["reopened"]);

    await expect(
      session.call({ action: "resolve", findingId: id, reason: "Smoke ran.", evidence: [smoke] }),
    ).rejects.toThrow("before the finding");
    const fresh = session.result("smoke ok after rebuild");
    await session.call({ action: "resolve", findingId: id, reason: "Rebuilt and reran.", evidence: [fresh] });
    expect(session.status()).toEqual(["resolved"]);
  });

  test("cites only the active branch and serves only the primary session", async () => {
    const session = primarySession();
    const source = session.audit(blocker("No smoke run."));
    const elsewhere = session.result("smoke ok");
    session.manager.branch(source);
    session.user("Try another approach.");

    await expect(
      session.call({ action: "resolve", findingId: `${source}:0`, reason: "Smoke ran.", evidence: [elsewhere] }),
    ).rejects.toThrow("not an entry on the active branch");
    const worker = { ...session.ctx, sessionManager: SessionManager.inMemory("/tmp/worker") };
    await expect(
      session.call({ action: "list" }, worker as unknown as ExtensionContext),
    ).rejects.toThrow("only to the primary orchestrator");
  });
});
