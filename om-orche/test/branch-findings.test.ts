import { describe, expect, test } from "bun:test";
import type { AdvisorNote } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ROLE, TOOL } from "../src/advisor-review.ts";
import { collectFindings, FINDING_ENTRY_TYPE } from "../src/findings.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";

/** A real in-memory session, so ids, parent links and branch paths are the host's own. */
function transcript() {
  const manager = SessionManager.inMemory("/tmp/jev-router-findings");
  return {
    manager,
    branch: (): SessionEntry[] => manager.getBranch(),
    user: (text: string, attribution: "user" | "agent" = "user") =>
      manager.appendMessage({ role: "user", content: text, attribution, timestamp: Date.now() }),
    audit: (...notes: AdvisorNote[]) =>
      manager.appendCustomMessageEntry("advisor", "Advisor notes", true, { notes }),
    tool: (text: string, options: { isError?: boolean; toolName?: string } = {}) =>
      manager.appendMessage({
        role: "toolResult",
        toolCallId: crypto.randomUUID(),
        toolName: options.toolName ?? "bash",
        content: [{ type: "text", text }],
        details: options.toolName === TOOL ? { role: ROLE } : undefined,
        isError: options.isError ?? false,
        timestamp: Date.now(),
      }),
    /** A persisted transition exactly as `review_findings` writes one. */
    transition: (
      findingId: string,
      action: "resolve" | "waive" | "reopen",
      evidence: string[],
      author: "orchestrator" | "user" = action === "waive" ? "user" : "orchestrator",
      version: 1 | 2 = 2,
    ) =>
      manager.appendCustomEntry(FINDING_ENTRY_TYPE, {
        v: version,
        findingId,
        action,
        author,
        reason: `${action} for test`,
        evidence,
        toolCallId: "call",
      }),
  };
}

// Contract-compliant notes: the quoted claim keeps a blocker a blocker and cites evidence for a concern.
const CLAIM = ' Re: "the work is complete".';
const blocker = (note: string): AdvisorNote => ({ note: note + CLAIM, severity: "blocker", advisor: AUDITOR_NAME });
const concern = (note: string): AdvisorNote => ({ note: note + CLAIM, severity: "concern", advisor: AUDITOR_NAME });

describe("verification finding ledger", () => {
  test("gives each tracked note a stable id and the user's own words as scope", () => {
    const session = transcript();
    const scope = session.user("Ship the parser; keep the public API unchanged.");
    session.user("Auto-continue: keep going.", "agent");
    const source = session.audit(
      { note: "Naming could be tighter.", severity: "nit", advisor: AUDITOR_NAME },
      { note: "A simpler queue exists.", severity: "concern", advisor: "Challenger" },
      blocker("User said the API may change; the diff renames parse()."),
    );

    const findings = collectFindings(session.branch());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: `${source}:2`,
      sourceEntryId: source,
      occurredAt: session.manager.getEntry(source)?.timestamp,
      note: `User said the API may change; the diff renames parse().${CLAIM}`,
      severity: "blocker",
      advisor: AUDITOR_NAME,
      scopeUserEntryId: scope,
      scopeUserText: "Ship the parser; keep the public API unchanged.",
      status: "open",
    });
  });

  test("keeps findings open across successful reviews until a transition is recorded", () => {
    const session = transcript();
    session.audit(blocker("Claimed tests pass; no runner output."));
    session.tool("VERDICT: KEEP", { toolName: TOOL });

    expect(collectFindings(session.branch()).map((finding) => finding.status)).toEqual(["open"]);
  });

  test("merges watchdog repeats and preserves distinct findings and severity escalation", () => {
    const session = transcript();
    session.user("Fix the cache.");
    const first = session.audit(concern("Cache eviction is untested."));

    const repeat = session.audit(concern("cache eviction is UNTESTED"));
    session.tool("unrelated output");
    session.audit(
      { note: "Different advisor, same words.", severity: "blocker", advisor: "Challenger" },
      { note: "Nit about naming.", severity: "nit", advisor: AUDITOR_NAME },
    );
    expect(collectFindings(session.branch())).toMatchObject([
      { id: `${first}:0`, repeatCount: 1, repeatIds: [`${repeat}:0`] },
    ]);

    session.audit(blocker("Cache eviction is untested."));
    expect(collectFindings(session.branch())).toMatchObject([{ id: `${first}:0`, severity: "blocker" }]);

    session.audit(concern("Cache TTL is hard-coded."));

    // The same words under a newer user message are a new assertion in a new scope.
    session.user("Also handle the TTL.");
    session.audit(blocker("Cache eviction is untested."));
    expect(collectFindings(session.branch())).toHaveLength(3);
  });

  test("replays delayed-notice resolutions only with valid branch evidence", () => {
    const session = transcript();
    const passing = session.tool("13 pass, 0 fail");
    const source = session.audit(blocker("Claimed tests pass; no runner output."));
    const id = `${source}:0`;
    const failed = session.tool("1 fail", { isError: true });
    const review = session.tool("VERDICT: KEEP", { toolName: TOOL });

    session.transition(id, "resolve", [failed]);
    session.transition(id, "resolve", [review]);
    session.transition(id, "resolve", ["missing-entry"]);
    session.transition(id, "resolve", []);
    session.transition(id, "waive", [], "orchestrator");
    expect(collectFindings(session.branch())[0]?.status).toBe("open");

    const record = session.transition(id, "resolve", [passing]);
    expect(collectFindings(session.branch())[0]).toMatchObject({
      status: "resolved",
      transition: {
        status: "resolved",
        recordId: record,
        author: "orchestrator",
        evidence: [{ entryId: passing, kind: "tool_result", toolName: "bash", excerpt: "13 pass, 0 fail" }],
      },
    });
  });

  test("preserves historical v1 evidence eligibility instead of reinterpreting old reports", () => {
    const session = transcript();
    const earlier = session.tool("upload done");
    const source = session.audit(blocker("No upload result."));
    const id = `${source}:0`;
    session.transition(id, "resolve", [earlier], "orchestrator", 1);
    expect(collectFindings(session.branch())[0]?.status).toBe("open");

    const later = session.tool("matching upload confirmed");
    session.transition(id, "resolve", [later], "orchestrator", 1);
    expect(collectFindings(session.branch())[0]?.status).toBe("resolved");
    session.transition(id, "reopen", [], "orchestrator", 1);
    session.transition(id, "resolve", [later], "orchestrator", 2);
    expect(collectFindings(session.branch())[0]?.status).toBe("reopened");

    const fresh = session.tool("new revision confirmed");
    session.transition(id, "resolve", [fresh], "orchestrator", 2);
    expect(collectFindings(session.branch())[0]?.status).toBe("resolved");
  });

  test("requires a new v2 report to use evidence rejected by a historical v1 report", () => {
    const session = transcript();
    const earlier = session.tool("upload done");
    const source = session.audit(blocker("No upload result."));
    const id = `${source}:0`;
    session.transition(id, "resolve", [earlier], "orchestrator", 1);
    expect(collectFindings(session.branch())[0]?.status).toBe("open");
    const record = session.transition(id, "resolve", [earlier]);
    const branch = JSON.parse(JSON.stringify(session.branch())) as SessionEntry[];
    expect(collectFindings(branch)[0]).toMatchObject({
      status: "resolved", transition: { recordId: record, evidence: [{ entryId: earlier }] },
    });
  });

  test("does not replay a resolution that cites a result recorded after that resolution", () => {
    const session = transcript();
    const source = session.audit(blocker("No upload result."));
    const record = session.transition(`${source}:0`, "resolve", []);
    const future = session.tool("upload done");
    const branch = JSON.parse(JSON.stringify(session.branch())) as SessionEntry[];
    const transition = branch.find(entry => entry.id === record)!;
    if (transition.type !== "custom") throw new Error("Expected the persisted transition.");
    const data = transition.data;
    if (!data || typeof data !== "object" || !("evidence" in data)) throw new Error("Expected evidence.");
    data.evidence = [future];
    expect(collectFindings(branch)[0]?.status).toBe("open");
  });

  test("scopes transitions to their branch and survives serialization", () => {
    const session = transcript();
    session.user("Ship it.");
    const smoke = session.tool("smoke ok");
    const source = session.audit(blocker("No smoke run recorded."));
    session.transition(`${source}:0`, "resolve", [smoke]);
    const resolved = session.branch();

    const reloaded = JSON.parse(JSON.stringify(resolved)) as SessionEntry[];
    expect(collectFindings(reloaded)).toEqual(collectFindings(resolved));

    session.manager.branch(source);
    session.user("Try a different approach.");
    expect(collectFindings(session.branch()).map((finding) => finding.status)).toEqual(["open"]);
  });

  test("treats a re-raise after a reported resolution as new, but not a repeat of a waiver", () => {
    const session = transcript();
    session.user("Finish the migration.");
    const resolvedSource = session.audit(blocker("Migration was never run."));
    const run = session.tool("migrated 3 tables");
    session.transition(`${resolvedSource}:0`, "resolve", [run]);
    const waivedSource = session.audit(concern("Rollback path is untested."));
    // Confirmed in the dialog alone: no new user message, so a repeat stays in the same scope.
    session.transition(`${waivedSource}:0`, "waive", []);

    session.audit(concern("Rollback path is untested."));
    expect(collectFindings(session.branch())).toHaveLength(2);

    session.audit(blocker("Migration was never run."));
    expect(collectFindings(session.branch()).map((finding) => finding.status)).toEqual([
      "resolved",
      "waived",
      "open",
    ]);
  });

  test("a user-invoked skill or collab prompt starts a new scope; an agent-attributed one does not", () => {
    const session = transcript();
    const typed = session.user("Build the importer.");
    const early = session.audit(blocker("Importer was never run."));
    // Host shape: a `/skill:` prompt persists as a `custom_message` entry, not a `message` entry.
    const skill = session.manager.appendCustomMessageEntry(
      "skill-prompt",
      '[IMPORTANT: User invoked the "fix" skill; follow its instructions.]\nUser: fix the parser',
      true,
      undefined,
      "user",
    );
    const late = session.audit(blocker("Importer was never run."));
    session.manager.appendCustomMessageEntry("skill-prompt", "Loaded a helper skill.", true, undefined, "agent");
    const injected = session.audit(blocker("Parser fixture was never added."));
    const peer = session.manager.appendCustomMessageEntry("collab-prompt", "Peer asks: also cover tabs.", true, undefined, "user");
    const collab = session.audit(blocker("Parser fixture was never added."));

    const findings = collectFindings(session.branch());
    // Same note, different scope: two findings rather than a merged repeat.
    expect(findings.map((finding) => [finding.id, finding.scopeUserEntryId])).toEqual([
      [`${early}:0`, typed],
      [`${late}:0`, skill],
      [`${injected}:0`, skill],
      [`${collab}:0`, peer],
    ]);
    expect(findings[1]!.scopeUserText).toContain("fix the parser");
  });

  test("replays a recorded resolution that cites a result with no text", () => {
    const session = transcript();
    session.user("Capture the dashboard.");
    const source = session.audit(blocker("No screenshot was taken."));
    const capture = session.manager.appendMessage({
      role: "toolResult",
      toolCallId: "shot",
      toolName: "screen_capture",
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      isError: false,
      timestamp: Date.now(),
    });
    session.transition(`${source}:0`, "resolve", [capture]);
    expect(collectFindings(session.branch())[0]).toMatchObject({
      status: "resolved",
      transition: { evidence: [{ entryId: capture, kind: "tool_result", excerpt: "(no text output)" }] },
    });
  });

  test("links a re-raised finding to the resolved one and flags evidence its resolution reuses", () => {
    const session = transcript();
    session.user("Finish the migration.");
    const original = session.audit(blocker("Migration was never run."));
    const run = session.tool("migrated 3 tables");
    session.transition(`${original}:0`, "resolve", [run]);
    const again = session.audit(blocker("Migration was never run."));
    session.transition(`${again}:0`, "resolve", [run]);
    const third = session.audit(blocker("Migration was never run."));
    const fresh = session.tool("migrated 3 tables after the schema change");
    session.transition(`${third}:0`, "resolve", [run, fresh]);
    const fourth = session.audit(blocker("Migration was never run."));
    session.transition(`${fourth}:0`, "resolve", [fresh]);

    const [first, second, thirdFinding, fourthFinding] = collectFindings(session.branch());
    expect(first).not.toHaveProperty("reraisesId");
    expect(first).not.toHaveProperty("reusedEvidenceIds");
    expect(second).toMatchObject({ status: "resolved", reraisesId: `${original}:0`, reusedEvidenceIds: [run] });
    expect(thirdFinding).toMatchObject({ reraisesId: `${again}:0`, reusedEvidenceIds: [run] });
    // Only entries the re-raised finding's own resolution cited are flagged: `fresh` was new for the third.
    expect(thirdFinding!.reusedEvidenceIds).not.toContain(fresh);
    expect(fourthFinding).toMatchObject({ reraisesId: `${third}:0`, reusedEvidenceIds: [fresh] });
  });

  test("a re-raised finding not yet resolved carries the link but no reuse flag; a waiver does not create one", () => {
    const session = transcript();
    session.user("Finish the migration.");
    const original = session.audit(blocker("Migration was never run."));
    session.transition(`${original}:0`, "resolve", [session.tool("migrated 3 tables")]);
    session.audit(blocker("Migration was never run."));
    expect(collectFindings(session.branch())[1]).toMatchObject({ status: "open", reraisesId: `${original}:0` });
    expect(collectFindings(session.branch())[1]).not.toHaveProperty("reusedEvidenceIds");

    const waivedSource = session.audit(concern("Rollback path is untested."));
    session.transition(`${waivedSource}:0`, "waive", []);
    session.audit(blocker("Rollback path is untested."));
    const [, , , escalated] = collectFindings(session.branch());
    expect(escalated).not.toHaveProperty("reraisesId");
  });
});
