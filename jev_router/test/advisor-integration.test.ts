import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import example from "../examples/initial-plan.json";
import { prepareReviewInput, ROLE, TOOL } from "../src/advisor-review.ts";
import { registerJevRouter } from "../src/index.ts";
import { AUDITOR_NAME, VERIFICATION_AUDITOR } from "../src/verification-auditor.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";

afterEach(clearRegistry);

test("one extension registers the checkpoint tool and an independent auditor role", async () => {
  const handlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
  let checkpointTool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  const { session, ctx } = makeSession();
  const roles = new Map<string, string>([["advisor", "existing-advisor-model"]]);
  let flushes = 0;
  Object.assign(session.settings, {
    getModelRole: (role: string) => roles.get(role),
    setModelRole: (role: string, model: string) => roles.set(role, model),
    flush: async () => { flushes++; },
  });
  registerAsMain(session);
  Object.assign(session, { isAdvisorEnabled: () => false });
  const pi = {
    zod: z,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    setLabel() {},
    events: { on: () => () => {} },
    registerCommand() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { checkpointTool = tool; },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      if (event === "session_start") handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  const runtime = registerJevRouter(pi, import.meta.dir);
  runtime.reloadConfig = async () => runtime.config;
  runtime.telemetry.load = async () => {};
  runtime.surveyAgents = async () => runtime.survey;
  runtime.checkTierRoles = () => {};

  for (const handler of handlers) await handler({}, ctx);
  expect(checkpointTool?.name).toBe(TOOL);
  expect(roles.get("verification-auditor")).toBe("@smol");
  expect(VERIFICATION_AUDITOR.model).toBe("@verification-auditor");
  expect(roles.get("advisor")).toBe("existing-advisor-model");
  expect(flushes).toBe(1);

  roles.set("verification-auditor", "custom-auditor-model");
  for (const handler of handlers) await handler({}, ctx);
  expect(roles.get("verification-auditor")).toBe("custom-auditor-model");
  expect(flushes).toBe(1);

  const snapshotHash = prepareReviewInput(example).snapshotHash;
  Object.assign(session.sessionManager, { getBranch: (): SessionEntry[] => [{
    type: "message",
    message: {
      role: "toolResult",
      toolName: TOOL,
      isError: false,
      details: { role: ROLE, snapshotHash, model: "review-model" },
      content: [{ type: "text", text: "VERDICT: KEEP" }],
    },
  } as SessionEntry] });
  const result = await checkpointTool!.execute("review-call", example, new AbortController().signal, () => {}, ctx);
  expect(result.content).toContainEqual({ type: "text", text: "VERDICT: KEEP" });
  expect(result.details).toMatchObject({ role: ROLE, reused: true, findingsForwarded: 0 });

  // A persisted auditor finding must invalidate the otherwise identical cached review.
  const prior = session.sessionManager.getBranch();
  const finding: SessionEntry = {
    type: "custom_message", id: "fresh-audit", parentId: null, timestamp: "2026-09-26T00:00:00Z",
    customType: "advisor", content: "Evidence missing", display: true,
    details: { notes: [{ advisor: AUDITOR_NAME, severity: "blocker", note: "Claimed smoke has no run output" }] },
  };
  Object.assign(session.sessionManager, { getBranch: () => [...prior, finding] });
  Object.assign(session.settings, { reloadFromDisk: async () => {} });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [] });
  // No reviewer configured: attempting a new review must fail, never reuse stale KEEP.
  await expect(checkpointTool!.execute("review-call-2", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Configure modelRoles.orche-advisor");
});
