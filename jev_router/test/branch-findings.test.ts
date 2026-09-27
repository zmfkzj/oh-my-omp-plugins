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
    ) =>
      manager.appendCustomEntry(FINDING_ENTRY_TYPE, {
        v: 1,
        findingId,
        action,
        author,
        reason: `${action} for test`,
        evidence,
        toolCallId: "call",
      }),
  };
}

const blocker = (note: string): AdvisorNote => ({ note, severity: "blocker", advisor: AUDITOR_NAME });
const concern = (note: string): AdvisorNote => ({ note, severity: "concern", advisor: AUDITOR_NAME });

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
      note: "User said the API may change; the diff renames parse().",
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

  test("replays a transition only when its cited evidence validates after the finding", () => {
    const session = transcript();
    const stale = session.tool("12 pass, 0 fail");
    const source = session.audit(blocker("Claimed tests pass; no runner output."));
    const id = `${source}:0`;
    const failed = session.tool("1 fail", { isError: true });
    const review = session.tool("VERDICT: KEEP", { toolName: TOOL });
    const passing = session.tool("13 pass, 0 fail");

    session.transition(id, "resolve", [stale]);
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

  test("scopes transitions to their branch and survives serialization", () => {
    const session = transcript();
    session.user("Ship it.");
    const source = session.audit(blocker("No smoke run recorded."));
    const smoke = session.tool("smoke ok");
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
});
