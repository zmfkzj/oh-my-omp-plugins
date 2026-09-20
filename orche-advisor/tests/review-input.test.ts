import { describe, expect, test } from "bun:test";
import example from "../examples/initial-plan.json";
import { AUDITOR_NAME } from "../src/auditor.ts";
import { prepareFindings, prepareReviewInput, SNAPSHOT_KEYS } from "../src/review.ts";

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

  test("keeps a contradicted completion claim when the cap truncates a note flood", () => {
    const findings = prepareFindings([
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

    expect(findings).toHaveLength(3);
    expect(findings[0]).toEqual({
      note: "phase 1 completion claim contradicted",
      severity: "blocker",
      advisor: AUDITOR_NAME,
    });
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
