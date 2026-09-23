import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { findingsSinceLastReview } from "../src/orche-advisor.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";
import { ROLE, TOOL, type VerificationFinding } from "../src/advisor-review.ts";

function advisorNotes(...notes: VerificationFinding[]): SessionEntry {
  return {
    type: "message",
    message: { role: "custom", customType: "advisor", details: { notes } },
  } as unknown as SessionEntry;
}

function review(isError = false): SessionEntry {
  return {
    type: "message",
    message: { role: "toolResult", toolName: TOOL, isError, details: { role: ROLE } },
  } as unknown as SessionEntry;
}

const audit: VerificationFinding = {
  note: "no runner output",
  severity: "blocker",
  advisor: AUDITOR_NAME,
};

describe("verification finding window", () => {
  test("forwards only evidence newer than the last completed review, in emission order", () => {
    const branch = [
      advisorNotes({ ...audit, note: "already reviewed" }),
      review(),
      advisorNotes({ ...audit, note: "first" }, { ...audit, note: "second" }),
      advisorNotes({ ...audit, note: "third" }),
    ];

    expect(findingsSinceLastReview(branch).map((finding) => finding.note)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("keeps evidence open across a failed review that produced no verdict", () => {
    const branch = [advisorNotes(audit), review(true)];

    expect(findingsSinceLastReview(branch)).toEqual([audit]);
  });

  test("reports no evidence when the newest entry is the review itself", () => {
    const branch = [advisorNotes(audit), review()];

    expect(findingsSinceLastReview(branch)).toEqual([]);
  });
});
