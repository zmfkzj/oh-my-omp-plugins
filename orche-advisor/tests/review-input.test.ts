import { describe, expect, test } from "bun:test";
import example from "../examples/initial-plan.json";
import { prepareReviewInput, SNAPSHOT_KEYS } from "../src/review.ts";

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
