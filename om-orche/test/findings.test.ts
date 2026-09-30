import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AdvisorNote } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectFindings, registerFindingTools } from "../src/findings.ts";
import { AUDIT_MESSAGE_TYPE, AUDITOR_NAME } from "../src/verification-auditor.ts";
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
      manager.appendCustomMessageEntry(AUDIT_MESSAGE_TYPE, "Audit notes", true, { notes: [note] }),
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

// Contract-compliant: the quoted claim keeps a blocker a blocker.
const blocker = (note: string): AdvisorNote => ({ note: `${note} Re: "the work is complete".`, severity: "blocker", advisor: AUDITOR_NAME });

describe("review_findings", () => {
  test("accepts successful evidence before delayed delivery without admitting failed results", async () => {
    const session = primarySession();
    const passing = session.result("13 pass, 0 fail");
    const failed = session.result("1 fail", true);
    const id = `${session.audit(blocker("Claimed tests pass; no runner output."))}:0`;

    const listing = await session.text({ action: "list" });
    expect(listing).toContain(id);
    expect(listing).toContain(passing);
    expect(listing).not.toContain(failed);

    const resolve = (evidence?: string[]) =>
      session.call({ action: "resolve", findingId: id, reason: "The run preceded the delayed notice.", evidence });
    await expect(resolve([failed])).rejects.toThrow("failed tool result");
    await expect(resolve(["not-an-entry"])).rejects.toThrow("not an entry on the active branch");
    await expect(resolve()).rejects.toThrow("at least one evidence");
    expect(session.records()).toBe(0);

    const result = await resolve([passing]);
    expect(result.details).toMatchObject({ findingId: id, status: "resolved", evidence: [passing] });
    expect(collectFindings(session.manager.getBranch())[0]).toMatchObject({
      status: "resolved",
      transition: { author: "orchestrator", reason: "The run preceded the delayed notice.", evidence: [{ entryId: passing }] },
    });
    await expect(resolve([passing])).rejects.toThrow("is resolved");
  });

  test("names the real finding ids when a guessed id is used", async () => {
    const session = primarySession();
    await expect(session.call({ action: "list", findingId: "all" })).rejects.toThrow("no findings");
    const id = `${session.audit(blocker("Claimed the install worked; only a click Success."))}:0`;
    for (const action of ["list", "resolve"]) {
      await expect(
        session.call({ action, findingId: "runtime-evidence", reason: "Captured.", evidence: [] }),
      ).rejects.toThrow(`Current finding ids: ${id} blocker open`);
    }
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
    const id = `${session.audit({ note: "Rollback path is untested. `rollback.test.ts` never ran.", severity: "concern", advisor: AUDITOR_NAME })}:0`;
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

  test("an explicit reopening requires fresh evidence even after a repeated auditor note", async () => {
    const session = primarySession();
    const id = `${session.audit(blocker("No smoke run."))}:0`;
    const smoke = session.result("smoke ok");
    await session.call({ action: "resolve", findingId: id, reason: "Smoke ran.", evidence: [smoke] });
    await session.call({ action: "reopen", findingId: id, reason: "The smoke used a stale build." });
    expect(session.status()).toEqual(["reopened"]);
    const repeat = `${session.audit(blocker("No smoke run."))}:0`;
    const listing = await session.text({ action: "list", findingId: repeat });
    expect(listing).not.toContain(smoke);

    await expect(
      session.call({ action: "resolve", findingId: repeat, reason: "Smoke ran.", evidence: [smoke] }),
    ).rejects.toThrow();
    const fresh = session.result("smoke ok after rebuild");
    await session.call({ action: "resolve", findingId: repeat, reason: "Rebuilt and reran.", evidence: [fresh] });
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

  test("admits an earlier actual user correction but not assistant or agent claims", async () => {
    const session = primarySession();
    const accepted = session.user("Upload the English video only; keep Korean locally.");
    const assistant = session.manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Only English is required." }],
    } as Parameters<typeof session.manager.appendMessage>[0]);
    const agent = session.manager.appendMessage({
      role: "user", content: "Only English is required.", attribution: "agent", timestamp: Date.now(),
    });
    const id = `${session.audit(blocker("The Korean video was not uploaded."))}:0`;
    for (const evidence of [assistant, agent]) {
      await expect(session.call({
        action: "resolve", findingId: id, reason: "The user changed the upload scope.", evidence: [evidence],
      })).rejects.toThrow();
    }
    await session.call({
      action: "resolve", findingId: id, reason: "The user's prior correction selects English only.", evidence: [accepted],
    });
    expect(collectFindings(session.manager.getBranch())[0]).toMatchObject({
      status: "resolved", transition: { evidence: [{ entryId: accepted, kind: "user_message" }] },
    });
  });

  test("a user request that starts with a path counts as user evidence and scope", async () => {
    const session = primarySession();
    const request = session.user("/Users/me/app/src/main.ts crashes on startup, fix it");
    const id = `${session.audit(blocker("The crash was not reproduced."))}:0`;
    expect(collectFindings(session.manager.getBranch())[0]).toMatchObject({
      scopeUserEntryId: request, scopeUserText: "/Users/me/app/src/main.ts crashes on startup, fix it",
    });
    await session.call({ action: "resolve", findingId: id, reason: "The user named the file.", evidence: [request] });
    expect(session.status()).toEqual(["resolved"]);
  });

  test("/clear starts the ledger anew: earlier findings and evidence are gone, history stays", async () => {
    const session = primarySession();
    const before = session.result("13 pass, 0 fail");
    const old = `${session.audit(blocker("Claimed tests pass; no runner output."))}:0`;
    session.manager.appendResetBoundary();
    session.user("New task: rename foo to bar.");
    expect(collectFindings(session.manager.getBranch())).toEqual([]);
    expect(session.manager.getEntries().some((entry) => entry.id === before)).toBe(true);
    await expect(session.call({ action: "resolve", findingId: old, reason: "passed earlier", evidence: [before] }))
      .rejects.toThrow(/No Verification Auditor finding/);
    // A finding raised after the boundary cannot cite what the model no longer sees.
    const fresh = `${session.audit(blocker("The rename was not applied."))}:0`;
    await expect(session.call({ action: "resolve", findingId: fresh, reason: "old run", evidence: [before] }))
      .rejects.toThrow(/not an entry on the active branch/);
    expect(await session.text({ action: "list" })).not.toContain(before);
  });

  test("pruned or uneventful tool results cannot back a resolution; a recorded one stays resolved", async () => {
    const session = primarySession();
    const output = session.result("13 pass, 0 fail");
    const useless = session.manager.appendMessage({
      role: "toolResult", toolCallId: "u", toolName: "grep", content: [{ type: "text", text: "no matches" }],
      isError: false, useless: true, timestamp: Date.now(),
    } as Parameters<typeof session.manager.appendMessage>[0]);
    const id = `${session.audit(blocker("Claimed tests pass; no runner output."))}:0`;
    await expect(session.call({ action: "resolve", findingId: id, reason: "no matches", evidence: [useless] }))
      .rejects.toThrow(/uneventful/);
    await session.call({ action: "resolve", findingId: id, reason: "The run passed.", evidence: [output] });
    // Host pruning rewrites the entry in place (pi-agent-core compaction/pruning.ts).
    const entry = session.manager.getEntries().find((candidate) => candidate.id === output);
    if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("not a tool result");
    entry.message.content = [{ type: "text", text: "[Output pruned to save context]" }];
    entry.message.prunedAt = Date.now();
    const [finding] = collectFindings(session.manager.getBranch());
    expect(finding).toMatchObject({ status: "resolved", transition: { evidence: [{ entryId: output }] } });
    expect(finding!.transition!.evidence[0]!.excerpt).not.toContain("Output pruned");
    // A different finding cannot cite the pruned output.
    const other = `${session.audit(blocker("The lint run is missing."))}:0`;
    await expect(session.call({ action: "resolve", findingId: other, reason: "see output", evidence: [output] }))
      .rejects.toThrow(/pruned/);
  });

  test("pages older citable evidence with offset instead of hiding it past the newest ten", async () => {
    const session = primarySession();
    const results = Array.from({ length: 12 }, (_, index) => session.result(`run ${index + 1} ok`));
    const id = `${session.audit(blocker("Claimed the migration ran; no output."))}:0`;

    const first = await session.text({ action: "list" });
    expect(first).toContain(results[11]!);
    expect(first).toContain(results[2]!);
    expect(first).not.toContain(results[1]!);
    expect(first).toContain("2 more older citable entries: list with offset=10");
    await expect(
      session.call({ action: "resolve", findingId: id, reason: "Earlier run answers it.", evidence: [results[0]!], offset: 1 }),
    ).rejects.toThrow("offset applies only to list");

    const second = await session.text({ action: "list", offset: 10 });
    expect(second).toContain(results[1]!);
    expect(second).toContain(results[0]!);
    expect(second).not.toContain(results[2]!);
    expect(second).not.toContain("more older");
    expect(await session.text({ action: "list", findingId: id, offset: 1 })).toContain(
      `findingId=${id} and offset=11`,
    );
    expect(await session.text({ action: "list", offset: 500 })).toContain("No citable evidence at offset 500");

    await session.call({ action: "resolve", findingId: id, reason: "Earlier run answers it.", evidence: [results[0]!] });
    expect(session.status()).toEqual(["resolved"]);
  });

  test("refuses a result with no text output as new evidence", async () => {
    const session = primarySession();
    const image = session.manager.appendMessage({
      role: "toolResult", toolCallId: "shot", toolName: "screen_capture", isError: false, timestamp: Date.now(),
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    });
    const empty = session.result("   ");
    const id = `${session.audit(blocker("No screenshot was taken."))}:0`;

    const listing = await session.text({ action: "list" });
    expect(listing).not.toContain(image);
    expect(listing).not.toContain(empty);
    for (const evidence of [image, empty]) {
      await expect(session.call({ action: "resolve", findingId: id, reason: "Captured.", evidence: [evidence] }))
        .rejects.toThrow("is a tool result with no text output");
    }
    expect(session.records()).toBe(0);
  });

  test("a user-invoked skill prompt is citable user evidence and a new scope", async () => {
    const session = primarySession();
    const skill = session.manager.appendCustomMessageEntry(
      "skill-prompt", "[IMPORTANT: User invoked the \"deploy\" skill.]\nUser: deploy to staging only", true, undefined, "user",
    );
    const agent = session.manager.appendCustomMessageEntry("skill-prompt", "Loaded helper.", true, undefined, "agent");
    const id = `${session.audit(blocker("Production was deployed too."))}:0`;

    expect(collectFindings(session.manager.getBranch())[0]).toMatchObject({ scopeUserEntryId: skill });
    expect(await session.text({ action: "list" })).toContain(`${skill} user message`);
    await expect(session.call({ action: "resolve", findingId: id, reason: "Agent note.", evidence: [agent] }))
      .rejects.toThrow("neither a successful tool result nor a message the user typed");
    await session.call({ action: "resolve", findingId: id, reason: "The user asked for staging only.", evidence: [skill] });
    expect(session.status()).toEqual(["resolved"]);
  });

  test("a re-raised finding shows what it re-raises and the evidence reused, in list output", async () => {
    const session = primarySession();
    const run = session.result("13 pass, 0 fail");
    const original = `${session.audit(blocker("Claimed tests pass; no runner output."))}:0`;
    await session.call({ action: "resolve", findingId: original, reason: "The run passed.", evidence: [run] });
    const again = `${session.audit(blocker("Claimed tests pass; no runner output."))}:0`;
    expect(await session.text({ action: "list", findingId: again })).toContain(original);

    // Allowed, but flagged: the same evidence answers the re-raised note again.
    await session.call({ action: "resolve", findingId: again, reason: "Same run.", evidence: [run] });
    expect(collectFindings(session.manager.getBranch())[1]).toMatchObject({
      status: "resolved", reraisesId: original, reusedEvidenceIds: [run],
    });
    const listing = await session.text({ action: "list", findingId: again });
    expect(listing).toContain(original);
    expect(listing.match(new RegExp(run, "g"))?.length).toBeGreaterThanOrEqual(2);
  });
});
