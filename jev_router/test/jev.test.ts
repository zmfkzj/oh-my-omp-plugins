import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { clip, gate, JevEngine, orchestrationState } from "../src/jev.ts";
import type { RoutingContext } from "../src/jev.ts";

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
			previousReview: "review".repeat(10000),
			workScopes: Array.from({ length: 10 }, (_, index) => ({ id: `scope-${index}`, goal: "goal".repeat(10000) })),
		}, 300);
		const used = state.request.length + (state.plan?.length ?? 0) + (state.previous_review?.length ?? 0)
			+ state.recent_messages.reduce((sum, item) => sum + item.text.length, 0)
			+ (state.work_scopes ?? []).reduce((sum, item) => sum + item.goal.length, 0);
		expect(used).toBeLessThanOrEqual(300);
		expect(state.request).toContain("r");
		expect(state.plan).toContain("p");
		expect(state.recent_messages.map(item => item.role)).toEqual(["user", "assistant"]);
		expect(clip("oversized", 0)).toBe("");
	});
});

describe("front-door classifier request", () => {
	const savedBaseUrl = process.env.TYPESAFE_BASE_URL;
	let server: Server<undefined> | undefined;
	afterEach(() => {
		server?.stop(true);
		server = undefined;
		if (savedBaseUrl === undefined) delete process.env.TYPESAFE_BASE_URL;
		else process.env.TYPESAFE_BASE_URL = savedBaseUrl;
	});

	/** The path and JSON body the SDK sent: named questions over one state. */
	interface RecordedRequest {
		path: string;
		body: { state: unknown; questions: Record<string, { type: string; criteria: Record<string, unknown> }> };
	}

	/** A local TypeSafe endpoint that records each request and answers with `answers`. */
	function serve(answers: Record<string, unknown>): RecordedRequest[] {
		const requests: RecordedRequest[] = [];
		server?.stop(true);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as RecordedRequest["body"];
				requests.push({ path: new URL(request.url).pathname, body });
				return Response.json({ model: "jev-test", answers, usage: { input_tokens: 1, output_tokens: 1 } });
			},
		});
		process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.port}`;
		return requests;
	}

	const context: RoutingContext = {
		recentMessages: [{ role: "user", text: "Ship the invoice backfill once billing reads the new column." }],
		plan: "Billing\n- Backfill invoice totals [pending]\n- Switch reads to the new column [pending]",
	};
	const options = { apiKey: "ts_test_key_0123456789", model: "", timeoutMs: 5000 };
	const gates = { minConfidence: 0.6, minMargin: 0.2 };
	const route = { type: "choice", choice: "DEFAULT", confidence: 0.9, probabilities: { DEFAULT: 0.9, ORCHESTRATE: 0.1 } };

	test("one request asks separate route and review questions over the same bounded state", async () => {
		const requests = serve({
			route,
			review: { type: "choice", choice: "REQUIRED", confidence: 0.85, probabilities: { REQUIRED: 0.85, OPTIONAL: 0.15 } },
		});
		const decision = await new JevEngine().decideOrchestration("Go ahead.", context, options, gates, 600);
		expect(requests).toHaveLength(1);
		const { path, body } = requests[0]!;
		expect(path).toBe("/v1/systemone");
		const questions = Object.fromEntries(Object.entries(body.questions).map(([name, question]) =>
			[name, { type: question.type, labels: Object.keys(question.criteria).sort() }]));
		expect(questions).toEqual({
			route: { type: "choice", labels: ["DEFAULT", "ORCHESTRATE"] },
			review: { type: "choice", labels: ["OPTIONAL", "REQUIRED"] },
		});
		expect(body.state).toEqual(orchestrationState("Go ahead.", context, 600));
		expect(decision).toMatchObject({ top: "DEFAULT", confident: true, review: { top: "REQUIRED", confident: true } });
	});

	test("a missing, malformed or split review answer never counts as a confident answer and keeps the route", async () => {
		for (const [review, top, missing] of [
			[undefined, "REQUIRED", true],
			[{ type: "score", score: 1, confidence: 0.9, probabilities: { 0: 0.1, 1: 0.9 } }, "REQUIRED", true],
			[{ type: "choice", choice: "OPTIONAL", confidence: 0.9 }, "REQUIRED", true],
			[{ type: "choice", choice: "OPTIONAL", confidence: 0.55, probabilities: { OPTIONAL: 0.55, REQUIRED: 0.45 } }, "OPTIONAL", false],
		] as const) {
			serve(review ? { route, review } : { route });
			const decision = await new JevEngine().decideOrchestration("Go ahead.", context, options, gates, 600);
			expect(decision).toMatchObject({ top: "DEFAULT", confident: true, review: { top, confident: false } });
			// The router reports an empty distribution as a missing answer.
			expect(Object.keys(decision.review.probabilities).length === 0).toBe(missing);
		}
	});
	test("only confident in-list scope linkage can reuse an existing work identity", async () => {
		const scoped = { ...context, workScopes: [{ id: "work-a", goal: "Existing release" }] };
		for (const [answer, expected] of [
			[{ type: "choice", probabilities: { W0: 0.95, NEW: 0.05 } }, "work-a"],
			[{ type: "choice", probabilities: { W0: 0.51, NEW: 0.49 } }, "NEW"],
			[{ type: "choice", probabilities: { W99: 1 } }, "NEW"],
			[undefined, "NEW"],
		] as const) {
			serve({ route, work_scope: answer, review: { type: "choice", probabilities: { REQUIRED: 0.9, OPTIONAL: 0.1 } } });
			const decision = await new JevEngine().decideOrchestration("Continue", scoped, options, gates, 12000);
			expect(decision.workScope).toBe(expected);
			expect(decision.workScopeUncertain).toBe(expected === "NEW");
		}
	});
});
