import { describe, expect, test } from "bun:test";
import { clip, gate } from "../src/jev.ts";

describe("confidence gate", () => {
	test("accepts a decision only when confidence and margin both clear", () => {
		// Spec example: DIRECT 0.91 / ORCHESTRATE 0.09.
		const clear = gate({ DIRECT: 0.91, ORCHESTRATE: 0.09 }, "DIRECT", 0.8, 0.25);
		expect(clear).toMatchObject({ top: "DIRECT", confident: true });
		expect(clear.confidence).toBeCloseTo(0.91, 5);
		expect(clear.margin).toBeCloseTo(0.82, 5);

		// Spec example: 0.54 / 0.46 is UNCERTAIN.
		const split = gate({ DIRECT: 0.54, ORCHESTRATE: 0.46 }, "DIRECT", 0.8, 0.25);
		expect(split).toMatchObject({ top: "DIRECT", confident: false });
		expect(split.margin).toBeCloseTo(0.08, 5);
	});

	test("a high top probability still fails when the runner-up is close", () => {
		// Three labels: confidence clears, margin does not.
		expect(gate({ A: 0.82, B: 0.76, C: 0.02 }, "A", 0.8, 0.25).confident).toBe(false);
	});

	test("margin is measured against the runner-up, not the remainder", () => {
		const outcome = gate({ A: 0.5, B: 0.3, C: 0.2 }, "A", 0.4, 0.15);
		expect(outcome.margin).toBeCloseTo(0.2, 5);
		expect(outcome.confident).toBe(true);
	});

	test("an empty or non-numeric distribution falls back without claiming confidence", () => {
		expect(gate({}, "TASK_DEEP", 0.75, 0.2)).toMatchObject({ top: "TASK_DEEP", confident: false, confidence: 0 });
		expect(gate({ A: Number.NaN }, "TASK_DEEP", 0.75, 0.2).confident).toBe(false);
	});
});

describe("input bounding", () => {
	test("oversized input is cut and marked as partial", () => {
		const clipped = clip("x".repeat(500), 100);
		expect(clipped.startsWith("x".repeat(100))).toBe(true);
		expect(clipped).toContain("[truncated]");
		expect(clipped.length).toBeLessThan(140);
	});

	test("input within budget is passed through trimmed and unmarked", () => {
		expect(clip("  keep me  ", 100)).toBe("keep me");
	});
});
