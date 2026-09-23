import { describe, expect, test } from "bun:test";
import type { Effort, AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import example from "../examples/initial-plan.json";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";
import {
  prepareReviewInput,
  runReview,
  type ReviewAttemptDetails,
  type ReviewFailureKind,
  type ReviewResult,
  type ReviewSelection,
} from "../src/advisor-review.ts";

const structuredReview = `VERDICT: KEEP
The independent slices are appropriately bounded.

ISSUES:
- None

ORCHESTRATION CHANGES:
- None

AVOID:
- Unnecessary delegation.`;
const rawOutput = "UNTRUSTED_MODEL_OUTPUT_MUST_NOT_BE_DISPLAYED";
const prepared = prepareReviewInput(example);
const selection: ReviewSelection = {
  model: {
    id: "review-test-model",
    provider: "review-test-provider",
    api: "openai-responses",
  } as ReviewSelection["model"],
  thinkingLevel: "high" as Effort,
};

type Completion = NonNullable<Parameters<typeof runReview>[4]>;

function usage(): Usage {
  return {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 4,
    totalTokens: 154,
    cost: {
      input: 0.125,
      output: 0.25,
      cacheRead: 0.0625,
      cacheWrite: 0.0625,
      total: 0.5,
    },
  };
}

function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: selection.model.provider,
    model: selection.model.id,
    content: [{ type: "text", text: structuredReview }],
    usage: usage(),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function completionSequence(...responses: AssistantMessage[]) {
  const calls: Parameters<Completion>[] = [];
  const completion: Completion = async (...args) => {
    calls.push(args);
    const result = responses[calls.length - 1];
    if (!result) throw new Error("Unexpected extra completion attempt");
    return result;
  };
  return { calls, completion };
}

function review(completion: Completion) {
  return runReview(
    prepared,
    selection,
    { getApiKey: async () => "test-api-key" },
    undefined,
    completion,
  );
}

function expectFailure(result: ReviewResult, failureKind: ReviewFailureKind) {
  expect(result.isError).toBe(true);
  expect(result.details.failureKind).toBe(failureKind);
  expect(result.text).toMatch(/no review is available/i);
  expect(result.text).not.toContain(rawOutput);
}

describe("review completion boundary", () => {
  test("accepts a structured first completion without retrying", async () => {
    const message = response();
    const { completion, calls } = completionSequence(message);
    const result = await review(completion);

    expect(result.isError).toBe(false);
    expect(result.text.startsWith(structuredReview)).toBe(true);
    expect(result.details.failureKind).toBeUndefined();
    expect(result.details.model).toBe("review-test-provider/review-test-model");
    expect(result.details.checkpoint).toBe(prepared.checkpoint);
    expect(result.details.snapshotHash).toBe(prepared.snapshotHash);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toMatchObject({ reasoning: "high", maxTokens: 4096 });
    const attempts: ReviewAttemptDetails[] = result.details.attempts;
    expect(attempts).toEqual([
      {
        attempt: 1,
        mode: "configured",
        api: "openai-responses",
        provider: "review-test-provider",
        model: "review-test-model",
        stopReason: "stop",
        usage: message.usage,
      },
    ]);
  });

  test("retries a length completion once without reasoning in a distinct session", async () => {
    const { completion, calls } = completionSequence(
      response({ stopReason: "length", content: [{ type: "text", text: rawOutput }] }),
      response(),
    );
    const result = await review(completion);

    expect(result.isError).toBe(false);
    expect(result.text.startsWith(structuredReview)).toBe(true);
    expect(result.text).not.toContain(rawOutput);
    expect(result.details.failureKind).toBeUndefined();
    expect(result.details.stopReason).toBe("stop");
    expect(result.details.attempts).toMatchObject([
      { attempt: 1, mode: "configured", stopReason: "length" },
      { attempt: 2, mode: "no-reasoning", stopReason: "stop" },
    ]);
    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    const second = calls[1]!;
    expect(first[2]).toMatchObject({ reasoning: "high", maxTokens: 4096 });
    expect(second[2]).toMatchObject({ disableReasoning: true, maxTokens: 4096 });
    expect(second[2]?.reasoning).toBeUndefined();
    expect(first[2]?.sessionId).toBe(result.details.requestId);
    expect(second[2]?.sessionId).toContain(result.details.requestId);
    expect(second[2]?.sessionId).not.toBe(first[2]?.sessionId);
    expect(second[0]).toEqual(first[0]);
    expect(second[1]).toEqual(first[1]);
    expect(second[2]?.apiKey).toBe(first[2]?.apiKey);
  });

  test("reports truncation after exactly two length completions", async () => {
    const truncated = response({
      stopReason: "length",
      content: [{ type: "text", text: rawOutput }],
    });
    const { completion, calls } = completionSequence(truncated, truncated);
    const result = await review(completion);

    expectFailure(result, "output_truncated");
    expect(result.text).toMatch(/truncat/i);
    expect(result.details.stopReason).toBe("length");
    expect(result.details.attempts).toMatchObject([
      { attempt: 1, mode: "configured", stopReason: "length" },
      { attempt: 2, mode: "no-reasoning", stopReason: "length" },
    ]);
    expect(calls).toHaveLength(2);
  });

  test("rejects malformed headings on a completed response without retrying", async () => {
    const { completion, calls } = completionSequence(
      response({
        content: [
          { type: "text", text: `${structuredReview.replace("ISSUES:", "Issues:")}\n${rawOutput}` },
        ],
      }),
    );
    const result = await review(completion);

    expectFailure(result, "invalid_structure");
    expect(result.details.attempts).toMatchObject([{ stopReason: "stop" }]);
    expect(calls).toHaveLength(1);
  });

  test("rejects a tool call even alongside a structured stopped response without retrying", async () => {
    const { completion, calls } = completionSequence(
      response({
        content: [
          { type: "text", text: structuredReview },
          { type: "toolCall", id: "tool-1", name: rawOutput, arguments: {} },
        ],
      }),
    );
    const result = await review(completion);

    expectFailure(result, "unexpected_tool_call");
    expect(result.text).toMatch(/tool call/i);
    expect(result.details.attempts).toMatchObject([{ stopReason: "stop" }]);
    expect(calls).toHaveLength(1);
  });

  test("reports a provider error without retrying or displaying partial model output", async () => {
    const { completion, calls } = completionSequence(
      response({
        stopReason: "error",
        errorMessage: "Provider unavailable",
        content: [{ type: "text", text: rawOutput }],
      }),
    );
    const result = await review(completion);

    expectFailure(result, "provider_error");
    expect(result.details.attempts).toMatchObject([
      { stopReason: "error", errorMessage: "Provider unavailable" },
    ]);
    expect(calls).toHaveLength(1);
  });

  test("reports a rejected completion without retrying or exposing raw runtime errors", async () => {
    const errorMarker = "PRIVATE_COMPLETION_REJECTION";
    let calls = 0;
    const completion: Completion = async () => {
      calls += 1;
      throw new Error(`\u001b[31m${errorMarker}\u001b[0m\n\u0000 test-api-key`);
    };
    const result = await review(completion);

    expectFailure(result, "provider_error");
    expect(calls).toBe(1);
    expect(result.details.attempts).toHaveLength(1);
    expect(result.details.attempts[0]?.stopReason).toBe("error");
    const errorMessage = result.details.attempts[0]?.errorMessage;
    expect(errorMessage).toContain(errorMarker);
    expect(errorMessage).not.toContain("test-api-key");
    expect(errorMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(result.text).not.toContain(errorMarker);
  });

  test("aggregates billable usage and optional nested counters across retry attempts", async () => {
    const firstUsage: Usage = {
      ...usage(),
      totalTokens: 159,
      reasoningTokens: 12,
      premiumRequests: 1,
      orchestration: { input: 2, output: 3 },
      cttl: { ephemeral5m: 4 },
      server: { webSearch: 1 },
      credits: { cost: 0.5 },
    };
    const secondUsage: Usage = {
      input: 50,
      output: 10,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 78,
      reasoningTokens: 4,
      orchestration: { input: 5, cacheRead: 6 },
      cttl: { ephemeral1h: 2 },
      server: { webSearch: 2, webFetch: 1 },
      credits: { cost: 0.25, committedCost: 0.125, acuCost: 0.0625 },
      cost: { input: 0.25, output: 0.5, cacheRead: 0.125, cacheWrite: 0.125, total: 1 },
    };
    const { completion } = completionSequence(
      response({ stopReason: "length", usage: firstUsage }),
      response({ usage: secondUsage }),
    );
    const result = await review(completion);

    expect(result.isError).toBe(false);
    expect(result.details.usage).toEqual({
      input: 150,
      output: 30,
      cacheRead: 35,
      cacheWrite: 6,
      totalTokens: 237,
      reasoningTokens: 16,
      premiumRequests: 1,
      orchestration: { input: 7, output: 3, cacheRead: 6 },
      cttl: { ephemeral5m: 4, ephemeral1h: 2 },
      server: { webSearch: 3, webFetch: 1 },
      credits: { cost: 0.75, committedCost: 0.125, acuCost: 0.0625 },
      cost: { input: 0.375, output: 0.75, cacheRead: 0.1875, cacheWrite: 0.1875, total: 1.5 },
    });
    expect(result.details.attempts.map((attempt) => attempt.usage)).toEqual([
      firstUsage,
      secondUsage,
    ]);
  });

  test("attaches verification findings beside the snapshot instead of merging them into it", async () => {
    const evidenced = prepareReviewInput(example, [
      {
        note: "Phase 1 'tests pass' contradicted: no runner output in tool results.",
        severity: "blocker",
        advisor: AUDITOR_NAME,
      },
    ]);
    const { completion, calls } = completionSequence(response());
    const result = await runReview(
      evidenced,
      selection,
      { getApiKey: async () => "test-api-key" },
      undefined,
      completion,
    );
    const content = calls[0]?.[1].messages[0]?.content as string;

    expect(result.details.findingsForwarded).toBe(1);
    // Verbatim seven-field JSON: evidence must stay distinguishable from DEFAULT's own report.
    expect(content).toContain(JSON.stringify(evidenced.snapshot, null, 2));
    expect(content).toContain(
      `- [blocker ${AUDITOR_NAME}] Phase 1 'tests pass' contradicted: no runner output in tool results.`,
    );
  });

  test("sends no findings block when no verification evidence landed", async () => {
    const { completion, calls } = completionSequence(response());
    await review(completion);

    expect(calls[0]?.[1].messages[0]?.content).not.toContain("verification findings");
  });
});
