import { describe, expect, test } from "bun:test";
import example from "../examples/initial-plan.json";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";
import {
  prepareFindings,
  prepareReviewInput,
  SNAPSHOT_KEYS,
  type VerificationFinding,
} from "../src/advisor-review.ts";

const minute = (value: number) => `2026-09-26T10:${String(value).padStart(2, "0")}:00.000Z`;

/** A finding shaped as the branch ledger emits it: id, provenance and lifecycle status. */
function ledgerFinding(
  index: number,
  severity: "concern" | "blocker",
  overrides: Partial<VerificationFinding> = {},
): VerificationFinding {
  return {
    id: `e${index}:0`,
    note: `${severity} ${index}`,
    severity,
    advisor: AUDITOR_NAME,
    occurredAt: minute(index),
    status: "open",
    ...overrides,
  };
}

describe("orchestration snapshot boundary", () => {
  test("rejects conversation and repository fields rather than sending hidden context", () => {
    expect(() =>
      prepareReviewInput({ ...example, conversation: "private unrelated conversation" }),
    ).toThrow();
    expect(() =>
      prepareReviewInput({
        ...example,
        snapshot: { ...example.snapshot, repository: "unrelated source tree" },
      }),
    ).toThrow();
  });

  test("keeps one review identity across key order and overlapping checkpoint labels", () => {
    const first = prepareReviewInput(example);
    const reordered = Object.fromEntries(
      Object.entries(example.snapshot)
        .reverse()
        .map(([key, value]) => [key, `  ${value}  `]),
    );
    const second = prepareReviewInput({ checkpoint: "phase-boundary", snapshot: reordered });
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.snapshotHash).toBe(first.snapshotHash);
  });

  test("rejects excessive aggregate context even when individual fields fit", () => {
    const snapshot = Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, "x".repeat(1500)]));
    expect(() => prepareReviewInput({ checkpoint: "escalation", snapshot })).toThrow();
  });

  test("rejects whitespace-only task descriptions before a review can be requested", () => {
    expect(() =>
      prepareReviewInput({ ...example, snapshot: { ...example.snapshot, goal: " \n\t " } }),
    ).toThrow();
  });
});

describe("verification finding boundary", () => {
  test("admits the owned auditor's evidence and drops every other note", () => {
    const { findings } = prepareReviewInput(example, [
      { note: "Naming could be tighter.", severity: "nit", advisor: AUDITOR_NAME },
      { note: "A simpler queue already exists.", severity: "concern", advisor: "Challenger" },
      { note: "Unsourced completion doubt.", severity: "blocker" },
      {
        note: "  tests pass\u0000 claimed;\n no run in tool results  ",
        severity: "blocker",
        advisor: AUDITOR_NAME,
      },
    ]);

    expect(findings).toEqual([
      {
        note: "tests pass claimed; no run in tool results",
        severity: "blocker",
        advisor: AUDITOR_NAME,
      },
    ]);
  });

  test("puts a contradicted completion claim first and summarizes the rest of a note flood", () => {
    const { findings, omitted } = prepareFindings([
      ...Array.from({ length: 6 }, (_, index) => ({
        note: `concern ${index}`,
        severity: "concern" as const,
        advisor: AUDITOR_NAME,
      })),
      {
        note: "phase 1 completion claim contradicted",
        severity: "blocker" as const,
        advisor: AUDITOR_NAME,
      },
    ]);

    expect(findings).toHaveLength(5);
    expect(findings[0]).toEqual({
      note: "phase 1 completion claim contradicted",
      severity: "blocker",
      advisor: AUDITOR_NAME,
    });
    expect(omitted).toEqual([
      { severity: "concern", status: "open" },
      { severity: "concern", status: "open" },
    ]);
  });

  test("never lets standing old blockers starve a newer finding or silently disappear", () => {
    const { findings, omitted } = prepareFindings([
      ...Array.from({ length: 8 }, (_, index) => ledgerFinding(index, "blocker")),
      ledgerFinding(8, "concern"),
    ]);

    expect(findings.map((finding) => finding.id)).toEqual(["e4:0", "e5:0", "e6:0", "e7:0", "e8:0"]);
    expect(omitted).toEqual(
      [0, 1, 2, 3].map((index) => ({ id: `e${index}:0`, severity: "blocker", status: "open" })),
    );
  });

  test("counts a reopening as the finding's latest development", () => {
    const reopened = ledgerFinding(0, "concern", {
      status: "reopened",
      transition: {
        status: "reopened",
        recordId: "r0",
        at: minute(50),
        author: "orchestrator",
        reason: "The fix regressed.",
        evidence: [],
      },
    });
    const { findings, omitted } = prepareFindings([
      reopened,
      ...Array.from({ length: 6 }, (_, index) => ledgerFinding(index + 1, "blocker")),
    ]);

    expect(findings.map((finding) => finding.id)).toContain("e0:0");
    expect(omitted.map((finding) => finding.id)).toEqual(["e1:0", "e2:0"]);
  });

  test("forwards the newest reported resolutions with their evidence and summarizes older ones", () => {
    const resolved = (index: number) =>
      ledgerFinding(index, "blocker", {
        status: "resolved",
        transition: {
          status: "resolved",
          recordId: `r${index}`,
          at: minute(30 + index),
          author: "orchestrator",
          reason: `fixed ${index}`,
          evidence: [{ entryId: `t${index}`, kind: "tool_result", toolName: "bash", excerpt: "pass" }],
        },
      });
    const { findings, omitted } = prepareFindings([
      ...[0, 1, 2, 3, 4].map(resolved),
      ledgerFinding(5, "concern"),
    ]);

    expect(findings.map((finding) => finding.id)).toEqual(["e5:0", "e2:0", "e3:0", "e4:0"]);
    expect(findings[3]?.transition).toMatchObject({
      author: "orchestrator",
      evidence: [{ entryId: "t4", excerpt: "pass" }],
    });
    expect(omitted).toEqual([
      { id: "e1:0", severity: "blocker", status: "resolved" },
      { id: "e0:0", severity: "blocker", status: "resolved" },
    ]);
  });

  test("bounds every forwarded field whatever the input's size", () => {
    const long = "x".repeat(5000);
    const { findings } = prepareFindings([
      {
        ...ledgerFinding(0, "blocker", { id: long, note: long, sourceEntryId: long }),
        occurredAt: long,
        scopeUserEntryId: long,
        scopeUserText: long,
        repeatCount: 40,
        repeatIds: Array.from({ length: 40 }, (_, index) => `${index}${long}`),
        lastRaisedAt: long,
        status: "resolved",
        transition: {
          status: "resolved",
          recordId: long,
          at: long,
          author: "orchestrator",
          reason: long,
          evidence: Array.from({ length: 9 }, () => ({
            entryId: long,
            kind: "tool_result" as const,
            toolName: long,
            at: long,
            excerpt: long,
          })),
        },
      },
    ]);
    const strings = (value: unknown): string[] =>
      typeof value === "string"
        ? [value]
        : value !== null && typeof value === "object"
          ? Object.values(value).flatMap(strings)
          : [];

    expect(findings).toHaveLength(1);
    expect(Math.max(...strings(findings[0]).map((text) => text.length))).toBeLessThanOrEqual(400);
    expect(findings[0]?.repeatIds).toHaveLength(10);
    expect(findings[0]?.transition?.evidence).toHaveLength(5);
  });

  test("keeps review identity to the snapshot alone so an unchanged situation stays reusable", () => {
    const bare = prepareReviewInput(example);
    const evidenced = prepareReviewInput(example, [
      { note: "no runner output", severity: "blocker", advisor: AUDITOR_NAME },
    ]);

    expect(evidenced.snapshotHash).toBe(bare.snapshotHash);
    expect(bare.findings).toEqual([]);
    expect(evidenced.findings).toHaveLength(1);
  });
});
