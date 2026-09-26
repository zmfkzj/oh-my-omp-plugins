import { describe, expect, test } from "bun:test";
import { clip, gate, orchestrationState } from "../src/jev.ts";

describe("confidence gate", () => {
	test("accepts a decision only when confidence and margin both clear", () => {
		const clear = gate({ DEFAULT: 0.75, ORCHESTRATE: 0.25 }, "DEFAULT", 0.6, 0.2);
		expect(clear).toMatchObject({ top: "DEFAULT", confident: true });
		expect(clear.confidence).toBeCloseTo(0.75, 5);
		expect(clear.margin).toBeCloseTo(0.5, 5);

		const split = gate({ DEFAULT: 0.525, ORCHESTRATE: 0.475 }, "DEFAULT", 0.6, 0.2);
		expect(split).toMatchObject({ top: "DEFAULT", confident: false });
		expect(split.margin).toBeCloseTo(0.05, 5);
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
		expect(gate({}, "TASK_CHALLENGE", 0.75, 0.2)).toMatchObject({ top: "TASK_CHALLENGE", confident: false, confidence: 0 });
		expect(gate({ A: Number.NaN }, "TASK_CHALLENGE", 0.75, 0.2).confident).toBe(false);
	});
});

describe("input bounding", () => {
	test("oversized input is cut and marked as partial", () => {
		const clipped = clip("x".repeat(500), 100);
		expect(clipped).toContain("[truncated]");
		expect(clipped.length).toBeLessThanOrEqual(100);
	});

	test("input within budget is passed through trimmed and unmarked", () => {
		expect(clip("  keep me  ", 100)).toBe("keep me");
	});

	test("expanded conversation and plan share one text budget", () => {
		const state = orchestrationState("r".repeat(10000), {
			recentMessages: [
				{ role: "user", text: "u".repeat(10000) },
				{ role: "assistant", text: "a".repeat(10000) },
			],
			plan: "p".repeat(10000),
		}, 300);
		const used = state.request.length + (state.plan?.length ?? 0)
			+ state.recent_messages.reduce((sum, item) => sum + item.text.length, 0);
		expect(used).toBeLessThanOrEqual(300);
		expect(state.request).toContain("r");
		expect(state.plan).toContain("p");
		expect(state.recent_messages.map(item => item.role)).toEqual(["user", "assistant"]);
		expect(clip("oversized", 0)).toBe("");
	});
});
