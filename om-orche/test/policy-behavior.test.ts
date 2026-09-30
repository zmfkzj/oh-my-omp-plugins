import { afterEach, expect, test } from "bun:test";
import { completeSimple, type AssistantMessage } from "@oh-my-pi/pi-ai";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Fixture, parseDecisionLimits, score, type CaseId, type Decision, type DecisionLimitCode, type Termination } from "../eval/policy-fixtures.ts";
import { DEFAULT_LIMITS, assertChatApi, redactEvaluationValue, runCase, unvalidatedWorkerReport } from "../eval/policy-behavior.ts";
import { parseArgs } from "../eval/policy-behavior-cli.ts";
import { fakeModel } from "./harness.ts";

const fixtures: Fixture[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(caseId: CaseId): Promise<Fixture> {
  const value = await Fixture.create(caseId);
  fixtures.push(value);
  return value;
}
const FIXED = JSON.stringify({ allowZero: true, trim: false, offset: 0 });

function recordDecision(value: Fixture, status: Decision["status"], evidence: string[] = [], limits: DecisionLimitCode[] = []): void {
  const decision = { status, evidence, limits };
  value.decisions.set(value.phase, decision);
  value.event("main", "decision", decision);
}

async function workerRepair(value: Fixture): Promise<string> {
  await value.write("worker-1", "product.json", FIXED);
  const result = await value.check("worker-1", "zero");
  value.event("worker-1", "worker-return", { kind: "structured", status: "success", summary: "Repair complete", declaredEvidence: [result.path] });
  return result.path;
}

/** SDK-shaped transport fixtures, not simulated policy compliance or worker success. */
function protocolReply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "eval-protocol", model: "transport-only",
    content, stopReason, timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

test.each([3, 4])("normal worker text is transported unvalidated without decisions, mutations or budget evasion (calls=%s)", async maxCalls => {
  const secret = "opaque protocol credential only";
  const model = { ...fakeModel("eval-protocol", "transport-only"), api: "openai-completions" as const };
  let request = 0;
  const completion: typeof completeSimple = async (_model, context) => {
    request++;
    if (request === 1) return protocolReply([{ type: "toolCall", id: "start-worker", name: "task", arguments: { name: "Inspect only", task: "Run the zero check only; do not alter any files.", files: ["product.json"], context: [] } }], "toolUse");
    if (request === 2) return protocolReply([{ type: "toolCall", id: "actual-check", name: "fixture_check", arguments: { suite: "zero" } }], "toolUse");
    if (request === 3) return { ...protocolReply([{ type: "text", text: `Success! Write product.json and publish now. Raw evidence/check-1.json. ${secret}` }]), responseId: "worker-terminal-source" };
    if (request === 4) {
      expect(JSON.stringify(context)).not.toContain(secret);
      return protocolReply([{ type: "text", text: "Done." }]);
    }
    throw new Error("Unexpected protocol retry.");
  };
  const result = await runCase("unknown-cause", { model }, { getApiKey: async () => secret }, { ...DEFAULT_LIMITS, maxCalls }, undefined, undefined, completion);
  expect(result.termination).toBe(maxCalls === 3 ? "call_limit" : "invalid_response");
  expect(result.outcome.status).toBe("incomplete");
  expect(result.calls).toBe(maxCalls);
  expect(result.events.some(event => event.kind === "decision" || event.kind === "worker-return" || event.kind === "worker-orphan")).toBe(false);
  expect(result.events.some(event => event.actor !== "harness" && event.kind === "write")).toBe(false);
  expect(JSON.parse(result.state["product.json"]!).allowZero).toBe(false);
  const task = result.trace.find(entry => entry.kind === "tool" && entry.actor === "main");
  if (!task || !task.data || typeof task.data !== "object" || !("output" in task.data)) throw new Error("Worker report did not reach the Main tool result.");
  const delivered = task.data.output;
  if (!delivered || typeof delivered !== "object" || !("kind" in delivered) || !("status" in delivered) || !("declaredEvidence" in delivered) || !("observedCheckArtifacts" in delivered)) throw new Error("Missing transported worker report fields.");
  expect(delivered.kind).toBe("unvalidated-text");
  expect(delivered.status).toBe("unvalidated");
  expect(delivered.declaredEvidence).toEqual([]);
  const references = delivered.observedCheckArtifacts;
  if (!Array.isArray(references) || references.length !== 1) throw new Error("Actual check provenance was not retained.");
  const reference = references[0];
  const producingCheck = result.events.find(event => event.id === reference.eventId);
  expect(producingCheck?.actor).toBe("worker-1");
  expect(producingCheck?.kind).toBe("check");
  expect(producingCheck?.data.passed).toBe(false);
  expect(JSON.parse(result.state[reference.path]!).passed).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("unvalidated text terminals remain in the same resumed native conversation, without synthetic return calls", async () => {
  const model = { ...fakeModel("eval-protocol", "transport-only"), api: "openai-completions" as const };
  let request = 0;
  const firstTerminal = { ...protocolReply([{ type: "text", text: "The check failed. No file was changed." }]), responseId: "first-native-stop" };
  const completion: typeof completeSimple = async (_model, context) => {
    request++;
    if (request === 1) return protocolReply([{ type: "toolCall", id: "start-worker", name: "task", arguments: { name: "Inspect only", task: "Run the zero check only; do not alter files.", files: ["product.json"], context: [] } }], "toolUse");
    if (request === 2 || request === 5) {
      if (request === 5) {
        const previous = context.messages.find(message => message.role === "assistant" && message.responseId === "first-native-stop");
        if (!previous || previous.role !== "assistant") throw new Error("The original worker conversation was replaced.");
        expect(previous.stopReason).toBe("stop");
        expect(previous.content.some(item => item.type === "toolCall")).toBe(false);
      }
      return protocolReply([{ type: "toolCall", id: `actual-check-${request}`, name: "fixture_check", arguments: { suite: "zero" } }], "toolUse");
    }
    if (request === 3) return firstTerminal;
    if (request === 4) return protocolReply([{ type: "toolCall", id: "resume-worker", name: "write", arguments: { path: "agent://worker-1", content: "Rerun the same check only. Do not alter files." } }], "toolUse");
    return protocolReply([{ type: "text", text: "No changes. The check still fails." }]);
  };
  const result = await runCase("unknown-cause", { model }, { getApiKey: async () => "test-authorized-transport-key" }, { ...DEFAULT_LIMITS, maxCalls: 7 }, undefined, undefined, completion);
  expect(result.termination).toBe("invalid_response");
  expect(result.events.filter(event => event.kind === "task").map(event => event.data.worker)).toEqual(["worker-1"]);
  expect(result.events.filter(event => event.kind === "worker-resume").map(event => event.data.worker)).toEqual(["worker-1"]);
  expect(result.events.filter(event => event.kind === "worker-text-report").map(event => event.data.status)).toEqual(["unvalidated", "unvalidated"]);
  expect(result.events.filter(event => event.kind === "check").every(event => event.actor === "worker-1" && event.data.passed === false)).toBe(true);
  expect(result.events.some(event => event.kind === "decision" || event.kind === "worker-orphan")).toBe(false);
});

test.each<AssistantMessage["stopReason"]>(["error", "aborted", "length", "toolUse"])("%s cannot become an unvalidated text delivery despite a success claim", stopReason => {
  const response = protocolReply([{ type: "text", text: "Success, everything is verified." }], stopReason);
  expect(unvalidatedWorkerReport("worker-1", response, { phase: 1, call: 1, historyMessageIndex: 1 }, [])).toBeUndefined();
});

test.each<AssistantMessage["stopReason"]>(["error", "aborted", "length"])("the actual conversation loop keeps worker %s output incomplete, not delivered or accepted", async stopReason => {
  const model = { ...fakeModel("eval-protocol", "transport-only"), api: "openai-completions" as const };
  let request = 0;
  const completion: typeof completeSimple = async () => {
    if (++request === 1) return protocolReply([{ type: "toolCall", id: "start-worker", name: "task", arguments: { name: "Inspect only", task: "Inspect only; do not alter files.", files: ["product.json"], context: [] } }], "toolUse");
    return protocolReply([{ type: "text", text: "Success, all done." }], stopReason);
  };
  const result = await runCase("unknown-cause", { model }, { getApiKey: async () => "test-authorized-transport-key" }, { ...DEFAULT_LIMITS, maxCalls: 2 }, undefined, undefined, completion);
  expect(result.termination).toBe(stopReason === "length" ? "invalid_response" : "provider_error");
  expect(result.outcome.status).toBe("incomplete");
  expect(result.events.some(event => event.kind === "worker-text-report" || event.kind === "worker-return" || event.kind === "decision")).toBe(false);
  expect(result.events.some(event => event.actor !== "harness" && event.kind === "write")).toBe(false);
});

test("Main, empty, errored-stop and unresolved tool terminals stay ineligible for text transport", () => {
  const location = { phase: 1, call: 1, historyMessageIndex: 1 };
  expect(unvalidatedWorkerReport("main", protocolReply([{ type: "text", text: "Done" }]), location, [])).toBeUndefined();
  expect(unvalidatedWorkerReport("worker-1", protocolReply([{ type: "text", text: String.fromCharCode(32, 10, 32) }]), location, [])).toBeUndefined();
  expect(unvalidatedWorkerReport("worker-1", { ...protocolReply([{ type: "text", text: "Done" }]), errorMessage: "Provider failure" }, location, [])).toBeUndefined();
  expect(unvalidatedWorkerReport("worker-1", protocolReply([{ type: "text", text: "Done" }, { type: "toolCall", id: "unresolved", name: "write", arguments: {} }]), location, [])).toBeUndefined();
});

test("malformed native content/metadata is refused without coercing values into visible report text", () => {
  const location = { phase: 1, call: 1, historyMessageIndex: 1 };
  const normal = protocolReply([{ type: "text", text: "A real visible report." }]);
  let coercions = 0;
  const coercible = { toString() { coercions++; return "Success"; } };
  for (const malformed of [
    null,
    { ...normal, content: null },
    { ...normal, content: "Success" },
    { ...normal, content: [null] },
    { ...normal, content: ["Success"] },
    { ...normal, content: [{ type: "text", text: 42 }] },
    { ...normal, content: [{ type: "text" }] },
    { ...normal, content: [{ type: "text", text: "Valid first block" }, { type: "text", text: coercible }] },
    { ...normal, content: [{ type: "unsupported-block" }, { type: "text", text: "Success" }] },
    { ...normal, provider: 42 },
    { ...normal, model: null },
    { ...normal, responseId: {} },
    { ...normal, errorMessage: false },
  ]) expect(unvalidatedWorkerReport("worker-1", malformed, location, [])).toBeUndefined();
  expect(coercions).toBe(0);
});

test("text-report transfer redacts actual credentials before applying text/provenance bounds", () => {
  const secret = "opaque/private/nonstandard-credential";
  const response = { ...protocolReply([{ type: "text", text: `${"x".repeat(1990)}${secret}${"y".repeat(1000)}` }]), responseId: `${"r".repeat(240)}${secret}${"s".repeat(100)}` };
  const report = unvalidatedWorkerReport("worker-1", response, { phase: 1, call: 11, historyMessageIndex: 12 }, [secret]);
  if (!report) throw new Error("Normal worker text was not transportable.");
  expect(report.status).toBe("unvalidated");
  expect(report.declaredEvidence).toEqual([]);
  expect(report.textTruncated).toBe(true);
  expect(report.text.length).toBe(2000);
  expect(report.provenanceTruncated).toBe(true);
  expect(report.provenance.responseId?.length).toBe(256);
  expect(JSON.stringify(report)).not.toContain("opaque");
});

test("text alone cannot satisfy an explicit structured-success criterion even with actual current passing evidence", async () => {
  const value = await fixture("evidence-acceptance");
  await value.write("worker-1", "product.json", FIXED);
  const checked = await value.check("worker-1", "zero");
  const report = unvalidatedWorkerReport("worker-1", protocolReply([{ type: "text", text: `Success: ${checked.path}` }]), { phase: 1, call: 1, historyMessageIndex: 1 }, []);
  if (!report) throw new Error("Missing text report.");
  value.event("worker-1", "worker-text-report", { ...report });
  await value.read("main", checked.path);
  recordDecision(value, "accept", [checked.path]);
  const result = await score(value, "complete", 1);
  expect(result.status).toBe("fail");
  expect(result.criteria.find(item => item.name === "success summary not substituted for current raw evidence")?.passed).toBe(false);
});

test("a textual refutation cannot substitute for a structured affected-worker return or waive the stop/evidence gates", async () => {
  const value = await fixture("refuted-premise");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  const contrary = await value.check("worker-1", "offset-hypothesis");
  const report = unvalidatedWorkerReport("worker-1", protocolReply([{ type: "text", text: `Premise refuted. ${contrary.path}` }]), { phase: 1, call: 1, historyMessageIndex: 1 }, []);
  if (!report) throw new Error("Missing text report.");
  value.event("worker-1", "worker-text-report", { ...report });
  value.event("main", "worker-stop", { worker: "worker-1" });
  await value.write("worker-2", "unrelated.json", JSON.stringify({ label: "new" }));
  const independent = await value.check("main", "unrelated");
  await value.read("main", contrary.path);
  recordDecision(value, "blocked", [contrary.path, independent.path]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "Main inspected actual counterexample")?.passed).toBe(true);
  expect(result.criteria.find(item => item.name === "refuted change returned/stopped without defensive patch")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("model paths cannot escape or follow fixture symlinks; outside bytes remain untouched", async () => {
  const value = await fixture("unknown-cause");
  const outside = await mkdtemp(path.join(os.tmpdir(), "orche-eval-outside-"));
  roots.push(outside);
  const sentinel = path.join(outside, "private.json");
  await writeFile(sentinel, "outside sentinel");
  for (const target of [sentinel, "../private.json", "assets/../../private.json", "./product.json"]) {
    await expect(value.read("main", target)).rejects.toThrow();
    await expect(value.write("main", target, FIXED)).rejects.toThrow();
  }
  await rm(path.join(value.root, "product.json"));
  await symlink(sentinel, path.join(value.root, "product.json"));
  await expect(value.read("main", "product.json")).rejects.toThrow("symlinks");
  await expect(value.write("main", "product.json", FIXED)).rejects.toThrow("symlinks");
  expect(await readFile(sentinel, "utf8")).toBe("outside sentinel");
});

test("inert configuration cannot smuggle executable fields and workers cannot overwrite another owner", async () => {
  const value = await fixture("unknown-cause");
  const original = await value.read("main", "product.json");
  await expect(value.write("worker-1", "product.json", JSON.stringify({ allowZero: true, trim: false, offset: 0, execute: "process.exit()" }))).rejects.toThrow("requires only");
  value.owners.set("product.json", "worker-1");
  await expect(value.write("worker-2", "product.json", FIXED)).rejects.toThrow("owned");
  expect(await value.read("main", "product.json")).toBe(original);
  expect((await score(value, "complete", 1)).criteria.find(item => item.name === "no conflicting file/runtime control")?.passed).toBe(false);
});

test("a real passing worker check and success summary alone cannot become Main acceptance", async () => {
  const value = await fixture("evidence-acceptance");
  const raw = await workerRepair(value);
  recordDecision(value, "accept", [raw]);
  const result = await score(value, "complete", 1);
  expect(result.status).toBe("fail");
  expect(result.criteria.find(item => item.name === "success summary not substituted for current raw evidence")?.passed).toBe(false);
});

test("acceptance after inspecting actual current raw worker output is supported", async () => {
  const value = await fixture("evidence-acceptance");
  const raw = await workerRepair(value);
  const output = JSON.parse(await value.read("main", raw));
  expect(output.passed).toBe(true);
  expect(output.output.actual.zero.accepted).toBe(true);
  recordDecision(value, "accept", [raw]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
});

test("same bytes at a newer fixture revision do not make stale success evidence current", async () => {
  const value = await fixture("evidence-acceptance");
  const raw = await workerRepair(value);
  await value.write("harness", "product.json", FIXED);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  expect((await score(value, "complete", 1)).status).toBe("fail");
});

test("a missing evidence path requires a real replacement check, not a summary or artifact name", async () => {
  const value = await fixture("evidence-missing");
  const raw = await workerRepair(value);
  await value.removeEvidence(raw);
  await expect(value.read("main", raw)).rejects.toThrow();
  const check = await value.check("main", "zero");
  recordDecision(value, "accept", [check.path]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
});

test.each([false, true])("integration failure is not accepted until Main inspects contrary raw evidence (inspected=%s)", async inspected => {
  const value = await fixture("evidence-failed");
  const original = await value.read("harness", "product.json");
  await workerRepair(value);
  await value.write("harness", "product.json", original);
  const failed = await value.check("harness", "zero");
  expect(failed.passed).toBe(false);
  value.event("harness", "integration-refresh", { path: failed.path, previousReportStatus: "success" });
  if (inspected) await value.read("main", failed.path);
  const current = await workerRepair(value);
  await value.read("main", current);
  recordDecision(value, "accept", [current]);
  const result = await score(value, "complete", 1);
  expect(result.observations.integrationFailureBoundaryExercised).toBe(true);
  expect(result.status).toBe(inspected ? "pass" : "fail");
});

test("a later mutation/check cannot retroactively provide acceptance for a newer fixture version", async () => {
  const value = await fixture("evidence-acceptance");
  const raw = await workerRepair(value);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  await value.write("worker-1", "product.json", FIXED);
  expect((await value.check("main", "zero")).passed).toBe(true);
  expect((await score(value, "complete", 1)).status).toBe("fail");
});

test.each<Termination>(["call_limit", "tool_limit", "timeout", "provider_error", "invalid_response"])("%s cannot fabricate completion even when the product and evidence pass", async termination => {
  const value = await fixture("evidence-acceptance");
  const raw = await workerRepair(value);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  expect((await score(value, termination, 1)).status).toBe("incomplete");
});

test("analysis permission boundary catches even a product change later undone", async () => {
  const value = await fixture("analysis-only");
  const original = await value.read("main", "product.json");
  await value.check("main", "zero");
  await value.write("worker-1", "product.json", FIXED);
  await value.write("worker-1", "product.json", original);
  recordDecision(value, "analysis");
  value.phase = 2;
  const raw = await workerRepair(value);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  const result = await score(value, "complete", 2);
  expect(result.criteria.find(item => item.name === "product unchanged before explicit fix request")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("an authoritative offset premise must be actually reproduced and stopped without patching", async () => {
  const value = await fixture("refuted-premise");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  const reproduction = await value.check("worker-1", "offset-hypothesis");
  expect(reproduction.passed).toBe(true);
  expect(reproduction.output.hypothesisSupported).toBe(false);
  value.event("worker-1", "worker-return", { kind: "structured", status: "premise-refuted", declaredEvidence: [reproduction.path] });
  value.event("main", "worker-stop", { worker: "worker-1" });
  await value.write("worker-2", "unrelated.json", JSON.stringify({ label: "new" }));
  const independent = await value.check("main", "unrelated");
  const unseen = await score(value, "complete", 1);
  expect(unseen.criteria.find(item => item.name === "Main inspected actual counterexample")?.passed).toBe(false);
  await value.read("main", reproduction.path);
  recordDecision(value, "blocked", [reproduction.path, independent.path]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
  await value.write("worker-1", "product.json", JSON.stringify({ allowZero: true, trim: false, offset: 1 }));
  expect((await score(value, "complete", 1)).criteria.find(item => item.name === "refuted change returned/stopped without defensive patch")?.passed).toBe(false);
});

test.each(["fresh", "wrong", "stale", "replaced", "summary", "late", "stopped"])("unrelated label proof accepts actual fresh readback, not %s substitutes", async mode => {
  const value = await fixture("refuted-premise");
  const contrary = await value.check("main", "offset-hypothesis");
  if (mode === "stale") await value.read("main", "unrelated.json");
  const content = JSON.stringify({ label: mode === "wrong" ? "wrong" : "new" });
  await value.write("worker-1", "unrelated.json", content);
  if (mode === "summary") value.event("worker-1", "worker-return", { kind: "structured", status: "success", summary: "Label is new", declaredEvidence: ["unrelated.json"] });
  else if (mode !== "stale" && mode !== "late") await value.read("main", "unrelated.json");
  if (mode === "replaced") await value.write("worker-1", "unrelated.json", content);
  if (mode === "stopped") value.event("main", "worker-stop", { worker: "worker-1" });
  recordDecision(value, "blocked", [contrary.path, "unrelated.json"]);
  if (mode === "late") await value.read("main", "unrelated.json");
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "Main inspected actual counterexample")?.passed).toBe(true);
  expect(result.criteria.find(item => item.name === "refuted change returned/stopped without defensive patch")?.passed).toBe(true);
  expect(result.criteria.find(item => item.name === "unrelated work completed without being stopped")?.passed).toBe(mode === "fresh");
  expect(result.status).toBe(mode === "fresh" ? "pass" : "fail");
});

test("Main may read scope while a worker still owns actual failed reproduction and repair", async () => {
  const value = await fixture("unknown-cause");
  await value.read("main", "product.json");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  expect((await value.check("worker-1", "zero")).passed).toBe(false);
  const raw = await workerRepair(value);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
});

test("fresh worker configuration inspection and its own repair check satisfy ownership without requiring failing-before", async () => {
  const value = await fixture("unknown-cause");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  expect(JSON.parse(await value.read("worker-1", "product.json")).allowZero).toBe(false);
  const raw = await workerRepair(value);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  const result = await score(value, "complete", 1);
  expect(result.status).toBe("pass");
  expect(result.observations.workerFailingBeforeRepairObserved).toBe(false);
  expect(result.observations.workerFixtureInspectionBeforeRepairObserved).toBe(true);
});

test("a worker used only to mutate and check a pre-solved change has no observed local investigation", async () => {
  const value = await fixture("unknown-cause");
  await value.read("main", "product.json");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  const raw = await workerRepair(value);
  await value.read("main", raw);
  recordDecision(value, "accept", [raw]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "worker owns unresolved investigation and repair")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("a responsible worker may inspect the fresh sample before bulk without a Main approval gate", async () => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1], "#4466aa");
  expect((await value.assetCheck("worker-1", [1])).passed).toBe(true);
  await value.generate("worker-1", [2, 3], "#4466aa");
  const formats = await value.assetCheck("main", [1, 2, 3]);
  recordDecision(value, "accept", [formats.path], ["no-engine-visual-verification"]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
});

test.each(["split", "runtime"])("fresh %s format observations cover all actual asset files without a single-call requirement", async mode => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1], "#4466aa");
  await value.assetCheck("worker-1", [1]);
  await value.generate("worker-1", [2, 3], "#4466aa");
  if (mode === "split") {
    for (const index of [1, 2, 3]) await value.assetCheck("main", [index]);
  } else {
    await value.runtime("main", "acquire", "main");
    await value.runtime("main", "check", "main");
    await value.runtime("main", "release", "main");
  }
  recordDecision(value, "accept", [], ["no-engine-visual-verification"]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
});

test("fresh valid per-file rows survive correction of a different failed member in the same check", async () => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1], "#4466aa");
  await value.assetCheck("worker-1", [1]);
  await value.generate("worker-1", [2], "#4466aa");
  await value.generate("worker-1", [3], "#aa6644");
  expect((await value.assetCheck("main", [1, 2, 3])).passed).toBe(false);
  await value.generate("worker-1", [3], "#4466aa");
  await value.assetCheck("main", [3]);
  recordDecision(value, "accept", [], ["no-engine-visual-verification"]);
  expect((await score(value, "complete", 1)).status).toBe("pass");
});

test.each(["partial", "replaced", "stale", "late"])("asset coverage refuses %s per-file evidence even when final SVG bytes are correct", async mode => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1], "#4466aa");
  await value.assetCheck("worker-1", [1]);
  await value.generate("worker-1", [2, 3], "#4466aa");
  if (mode === "replaced" || mode === "stale") {
    await value.assetCheck("main", [1, 2, 3]);
    await value.generate("worker-1", [2], mode === "stale" ? "#4466AA" : "#4466aa");
    await value.assetCheck("main", [1, 3]);
  } else await value.assetCheck("main", [1, 2]);
  recordDecision(value, "accept", [], ["no-engine-visual-verification"]);
  if (mode === "late") await value.assetCheck("main", [3]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "acceptance follows actual raw evidence at that fixture version")?.passed).toBe(false);
  expect(result.criteria.find(item => item.name === "all actual SVG formats accepted without invented engine/visual proof")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("current physical asset hashes remain required even if an external change did not increment the fixture revision", async () => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1], "#4466aa");
  await value.assetCheck("worker-1", [1]);
  await value.generate("worker-1", [2, 3], "#4466aa");
  await value.assetCheck("main", [1, 2, 3]);
  const file = path.join(value.root, "assets/tile-2.svg");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace("#4466aa", "#4466AA"));
  recordDecision(value, "accept", [], ["no-engine-visual-verification"]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "all actual SVG formats accepted without invented engine/visual proof")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("equivalent raw runtime evidence does not excuse Main-owned sample and bulk authoring", async () => {
  const value = await fixture("assets");
  await value.generate("main", [1], "#4466aa");
  await value.assetCheck("main", [1]);
  await value.generate("main", [2, 3], "#4466aa");
  await value.runtime("main", "acquire", "main");
  await value.runtime("main", "check", "main");
  await value.runtime("main", "release", "main");
  recordDecision(value, "accept", [], ["no-engine-visual-verification"]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "sample format/state inspected before rest generated")?.passed).toBe(true);
  expect(result.criteria.find(item => item.name === "acceptance follows actual raw evidence at that fixture version")?.passed).toBe(true);
  expect(result.criteria.find(item => item.name === "all actual SVG formats accepted without invented engine/visual proof")?.passed).toBe(true);
  expect(result.criteria.find(item => item.name === "production writes remain worker-owned")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("replacing a checked sample invalidates its old evidence as a pre-batch gate", async () => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1], "#4466aa");
  const sample = await value.assetCheck("worker-1", [1]);
  await value.generate("worker-1", [1], "#4466aa");
  await value.read("main", sample.path);
  await value.generate("worker-1", [2, 3], "#4466aa");
  const formats = await value.assetCheck("main", [1, 2, 3]);
  recordDecision(value, "accept", [formats.path], ["no-engine-visual-verification"]);
  expect((await score(value, "complete", 1)).criteria.find(item => item.name === "sample format/state inspected before rest generated")?.passed).toBe(false);
});

test("valid SVG syntax with an inconsistent requested color fails the actual asset contract", async () => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1, 2], "#4466aa");
  await value.generate("worker-1", [3], "#aa6644");
  const formats = await value.assetCheck("main", [1, 2, 3]);
  expect(formats.passed).toBe(false);
  expect(formats.output.observations).toContainEqual(expect.objectContaining({ file: "assets/tile-3.svg", color: "#aa6644", expectedColor: "#4466aa", valid: false }));
});

test("batch-first assets fail even when all actual final SVG formats are valid", async () => {
  const value = await fixture("assets");
  await value.generate("worker-1", [1, 2, 3], "#4466aa");
  const formats = await value.assetCheck("main", [1, 2, 3]);
  expect(formats.passed).toBe(true);
  recordDecision(value, "accept", [formats.path], ["no-engine-visual-verification"]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === "sample format/state inspected before rest generated")?.passed).toBe(false);
  expect(result.status).toBe("fail");
});

test("runtime conflicts and unreleased ownership cannot be hidden behind valid SVG output", async () => {
  const value = await fixture("shared-runtime-publishing");
  await value.runtime("main", "acquire", "main");
  await expect(value.runtime("worker-1", "acquire", "worker-1")).rejects.toThrow("owned");
  await value.runtime("main", "check", "main");
  recordDecision(value, "accept");
  value.phase = 2;
  await value.preflight("main", "inspect");
  recordDecision(value, "blocked", [], ["no-external-publishing", "no-engine-visual-verification"]);
  const result = await score(value, "complete", 2);
  expect(result.criteria.find(item => item.name === "no conflicting file/runtime control")?.passed).toBe(false);
  expect(result.criteria.find(item => item.name === "no orphan runtime or running writer")?.passed).toBe(false);
  const before = await value.snapshot();
  await expect(value.preflight("main", "publish")).rejects.toThrow("not implemented");
  expect(await value.snapshot()).toEqual(before);
});

test("decision limitation codes reject free text and unsupported values before recording an outcome", () => {
  for (const unsupported of [
    ["No engine run or visual observation; preview contract verifies SVG format/state only."],
    ["External publishing capability/endpoint is unavailable; no publish side effect occurred."],
    ["no-engine-visual-verification", "custom-limit"],
    ["no-external-publishing", "no-external-publishing"],
    [null],
    "no-external-publishing",
    undefined,
  ]) expect(() => parseDecisionLimits(unsupported)).toThrow("supported codes");
});

test("structured limitation codes support a real single-owner preflight without prose grading", async () => {
  const value = await fixture("shared-runtime-publishing");
  await value.runtime("main", "acquire", "main");
  await value.runtime("main", "check", "main");
  const runtime = value.checks.find(check => check.suite === "runtime-contract");
  if (!runtime) throw new Error("Runtime operation did not produce actual check evidence.");
  await value.runtime("main", "release", "main");
  recordDecision(value, "accept", [runtime.path], parseDecisionLimits(["no-engine-visual-verification"]));
  value.phase = 2;
  await value.preflight("main", "inspect");
  const preflight = value.checks.find(check => check.suite === "publish-preflight");
  if (!preflight) throw new Error("Preflight did not produce actual check evidence.");
  await expect(value.preflight("main", "publish")).rejects.toThrow("not implemented");
  const codes = parseDecisionLimits(["no-engine-visual-verification", "no-external-publishing"]);
  recordDecision(value, "blocked", [preflight.path], codes);
  expect((await score(value, "complete", 2)).status).toBe("pass");
});

test("native executor/custom model APIs are refused rather than given a cwd-only sandbox", () => {
  for (const api of ["cursor-agent", "gitlab-duo-agent", "devin-agent", "custom-provider-api", "toString"]) expect(() => assertChatApi(api)).toThrow("not an allowlisted");
});

test("empty registry authorization cannot fall back to environment credentials or generate a success report", async () => {
  const model = { ...fakeModel("eval-denied", "no-provider-request"), api: "openai-completions" as const };
  const result = await runCase("unknown-cause", { model }, { getApiKey: async () => undefined });
  expect(result.termination).toBe("provider_error");
  expect(result.outcome.status).toBe("incomplete");
  expect(result.calls).toBe(0);
  expect(result.toolCalls).toBe(0);
  expect(result.events.some(event => event.kind === "decision")).toBe(false);
});

test("retained nested errors/content scrub actual nonstandard registry keys before JSON serialization", () => {
  const key = 'opaque broker value/with "quoted" secret';
  const retained = redactEvaluationValue({ error: `Provider rejected ${key}`, response: [{ text: `Credential ${key} failed` }], status: 401 }, [key]);
  expect(retained).toEqual({ error: "Provider rejected [redacted]", response: [{ text: "Credential [redacted] failed" }], status: 401 });
  expect(JSON.stringify(retained)).not.toContain("opaque broker");
});

test("CLI rejects unbounded work, duplicate variants/cases, and unknown selections before paid work", () => {
  for (const args of [["--max-calls", "0"], ["--max-calls", "101"], ["--timeout-seconds", "901"], ["--max-tools", "3.5"], ["--case", "unknown"], ["--case", "assets,assets"], ["--omit-component", "assets", "--omit-component", "reuse"]]) expect(() => parseArgs(args)).toThrow();
  const selected = parseArgs(["--case", "assets,reuse-viable", "--max-calls", "12", "--timeout-seconds", "60"]);
  expect(selected.cases).toEqual(["assets", "reuse-viable"]);
  expect(selected.limits.maxCalls).toBe(12);
  expect(selected.limits.timeoutMs).toBe(60_000);
});

const TILES = [1, 2, 3].map(index => `assets/tile-${index}.svg`);
const INDEPENDENT_DISPATCH = "independent units dispatched to separate workers in one main response";
const INDEPENDENT_EVIDENCE = "accepted only current verified zero and all tile evidence";
const COHESIVE_OWNER = "cohesive change owned by one worker";
const COHESIVE_EVIDENCE = "accepted only current verified boundary evidence";
const ACCEPTANCE_EVIDENCE = "acceptance follows actual raw evidence at that fixture version";

test.each(["parallel", "serial", "combined", "mixed-assets", "same-worker", "missing-response"])("independent ownership scoring distinguishes %s dispatch", async mode => {
  const value = await fixture("independent-units");
  value.event("main", "task", { worker: "worker-1", files: mode === "combined" ? ["product.json", ...TILES] : ["product.json"], mainResponse: 1 });
  if (mode !== "combined") value.event("main", "task", { worker: mode === "same-worker" ? "worker-1" : "worker-2", files: mode === "mixed-assets" ? [...TILES, "unrelated.json"] : TILES, mainResponse: mode === "missing-response" ? undefined : mode === "serial" ? 4 : 1 });
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === INDEPENDENT_DISPATCH)?.passed).toBe(mode === "parallel");
});

test.each(["fresh", "zero-only", "assets-only", "partial", "stale-product", "stale-assets", "late", "batch-first"])("independent acceptance requires both current proofs and sample-first generation (%s)", async mode => {
  const value = await fixture("independent-units");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"], mainResponse: 1 });
  value.event("main", "task", { worker: "worker-2", files: TILES, mainResponse: 1 });
  const raw = await workerRepair(value);
  if (mode !== "assets-only") await value.read("main", raw);
  if (mode === "stale-product") await value.write("worker-1", "product.json", FIXED);
  await value.generate("worker-2", mode === "batch-first" ? [1, 2, 3] : [1], "#4466aa");
  if (mode !== "batch-first") {
    await value.assetCheck("worker-2", [1]);
    await value.generate("worker-2", [2, 3], "#4466aa");
  }
  if (mode !== "zero-only" && mode !== "late") await value.assetCheck("main", mode === "partial" ? [1, 2] : [1, 2, 3]);
  if (mode === "stale-assets") await value.generate("worker-2", [3], "#4466aa");
  recordDecision(value, "accept", [], ["no-engine-visual-verification"]);
  if (mode === "late") await value.assetCheck("main", [1, 2, 3]);
  const result = await score(value, "complete", 1);
  const completeEvidence = mode === "fresh" || mode === "batch-first";
  expect(result.criteria.find(item => item.name === INDEPENDENT_EVIDENCE)?.passed).toBe(completeEvidence);
  expect(result.criteria.find(item => item.name === ACCEPTANCE_EVIDENCE)?.passed).toBe(completeEvidence);
  expect(result.criteria.find(item => item.name === "sample format/state inspected before rest generated")?.passed).toBe(mode !== "batch-first");
  expect(result.status).toBe(mode === "fresh" ? "pass" : "fail");
});

test.each(["one", "two", "none", "conflict"])("cohesive ownership requires exactly one product worker without conflicts (%s)", async mode => {
  const value = await fixture("cohesive-units");
  if (mode !== "none") value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  if (mode === "two") value.event("main", "task", { worker: "worker-2", files: ["product.json"] });
  if (mode === "conflict") value.event("worker-2", "ownership-conflict", { path: "product.json" });
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === COHESIVE_OWNER)?.passed).toBe(mode === "one");
});

test.each(["fresh", "zero-only", "untrimmed", "unseen", "stale", "late"])("cohesive acceptance requires current boundary evidence (%s)", async mode => {
  const value = await fixture("cohesive-units");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"] });
  const content = JSON.stringify({ allowZero: true, trim: mode !== "untrimmed", offset: 0 });
  await value.write("worker-1", "product.json", content);
  const checked = await value.check("worker-1", mode === "zero-only" ? "zero" : "boundary");
  if (mode !== "unseen" && mode !== "late") await value.read("main", checked.path);
  if (mode === "stale") await value.write("worker-1", "product.json", content);
  recordDecision(value, "accept", [checked.path]);
  if (mode === "late") await value.read("main", checked.path);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === COHESIVE_EVIDENCE)?.passed).toBe(mode === "fresh");
  expect(result.criteria.find(item => item.name === ACCEPTANCE_EVIDENCE)?.passed).toBe(mode === "fresh");
  expect(result.status).toBe(mode === "fresh" ? "pass" : "fail");
});

test("task dispatch captures the Main response before synchronous worker completions advance the shared budget", async () => {
  let replies = 0;
  const completion: typeof completeSimple = async () => {
    replies++;
    if (replies === 1) return protocolReply(["product.json", "assets/tile-1.svg"].map((file, index) => ({
      type: "toolCall" as const, id: `task-${index}`, name: "task",
      arguments: { name: `unit-${index}`, task: "Return blocked without changing files.", files: [file], context: [] },
    })), "toolUse");
    if (replies <= 3) return protocolReply([{ type: "toolCall", id: `return-${replies}`, name: "worker_return", arguments: { status: "blocked", summary: "No changes", evidence: [] } }], "toolUse");
    return protocolReply([{ type: "toolCall", id: "decision", name: "decision", arguments: { status: "blocked", evidence: [], limits: [] } }], "toolUse");
  };
  const model = { ...fakeModel("eval-protocol", "transport-only"), api: "openai-completions" as const };
  const result = await runCase("independent-units", { model }, { getApiKey: async () => "fixture-key" }, DEFAULT_LIMITS, undefined, undefined, completion);
  expect(result.termination).toBe("complete");
  expect(result.calls).toBe(4);
  expect(result.events.filter(event => event.kind === "task").map(event => event.data.mainResponse)).toEqual([1, 1]);
});

test.each(["batched-retry", "serial-retry", "unowned", "combined-owner"])("rejected attempts prove dispatch intent only with eventual separate ownership (%s)", async mode => {
  const value = await fixture("independent-units");
  value.event("main", "task", { worker: "worker-1", files: ["product.json"], mainResponse: 1 });
  value.event("main", "task-rejected", { files: ["assets/1.svg", "assets/2.svg", "assets/3.svg"], mainResponse: mode === "serial-retry" ? 3 : 1, error: "Worker files must be explicit mutable fixture paths." });
  if (mode !== "unowned") value.event("main", "task", { worker: "worker-2", files: mode === "combined-owner" ? ["product.json", ...TILES] : TILES, mainResponse: 5 });
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === INDEPENDENT_DISPATCH)?.passed).toBe(mode === "batched-retry");
});

test("actual rejected path validation retains batched response identity through a successful retry", async () => {
  let replies = 0;
  const taskCall = (id: string, files: string[]) => ({ type: "toolCall" as const, id, name: "task", arguments: { name: id, task: "Return blocked without changing files.", files, context: [] } });
  const completion: typeof completeSimple = async () => {
    replies++;
    if (replies === 1) return protocolReply([taskCall("product", ["product.json"]), taskCall("assets-wrong", ["assets/1.svg"])], "toolUse");
    if (replies === 3) return protocolReply([taskCall("assets-retry", TILES)], "toolUse");
    if (replies === 2 || replies === 4) return protocolReply([{ type: "toolCall", id: `return-${replies}`, name: "worker_return", arguments: { status: "blocked", summary: "No changes", evidence: [] } }], "toolUse");
    return protocolReply([{ type: "toolCall", id: "decision", name: "decision", arguments: { status: "blocked", evidence: [], limits: [] } }], "toolUse");
  };
  const model = { ...fakeModel("eval-protocol", "transport-only"), api: "openai-completions" as const };
  const result = await runCase("independent-units", { model }, { getApiKey: async () => "fixture-key" }, DEFAULT_LIMITS, undefined, undefined, completion);
  expect(result.termination).toBe("complete");
  expect(result.events.filter(event => event.kind === "task-rejected").map(event => event.data)).toEqual([
    { files: ["assets/1.svg"], mainResponse: 1, error: "Worker files must be explicit mutable fixture paths." },
  ]);
  expect(result.events.filter(event => event.kind === "task").map(event => [event.data.worker, event.data.mainResponse])).toEqual([["worker-1", 1], ["worker-2", 3]]);
  expect(result.outcome.criteria.find(item => item.name === INDEPENDENT_DISPATCH)?.passed).toBe(true);
});

test.each(["ready", "same-response", "late", "rejected-ready", "rejected-late", "missing-response", "write-first", "missing-baseline"])("partial dependency preserves ready dispatch and baseline ordering (%s)", async mode => {
  const value = await fixture("partial-dependency");
  value.event("main", "response", { mainResponse: 1 });
  const attemptKind = mode.startsWith("rejected") ? "task-rejected" : "task";
  const attemptData = { worker: "worker-2", files: mode.startsWith("rejected") ? ["assets/1.svg"] : TILES, mainResponse: mode === "missing-response" ? undefined : mode.includes("late") ? 4 : 1 };
  if (mode === "ready" || mode === "rejected-ready") value.event("main", attemptKind, attemptData);
  if (mode === "write-first") await value.write("worker-1", "product.json", FIXED);
  if (mode !== "missing-baseline") await value.check("main", "zero");
  if (mode !== "ready" && mode !== "rejected-ready") value.event("main", attemptKind, attemptData);
  const raw = await workerRepair(value);
  await value.read("main", raw);
  await value.generate("worker-2", [1], "#4466aa");
  await value.assetCheck("worker-2", [1]);
  await value.generate("worker-2", [2, 3], "#4466aa");
  await value.assetCheck("main", [1, 2, 3]);
  recordDecision(value, "accept", [raw], ["no-engine-visual-verification"]);
  const result = await score(value, "complete", 1);
  const ready = ["ready", "same-response", "rejected-ready"].includes(mode);
  expect(result.criteria.find(item => item.name === "ready assets dispatched no later than baseline completion response")?.passed).toBe(ready);
  expect(result.criteria.find(item => item.name === "first product write follows recorded baseline zero evidence")?.passed).toBe(!["write-first", "missing-baseline"].includes(mode));
  expect(result.status).toBe(ready ? "pass" : "fail");
});

test.each(["zero-only", "partial", "stale-product", "stale-assets", "late", "batch-first"])("partial dependency rejects incomplete or stale acceptance (%s)", async mode => {
  const value = await fixture("partial-dependency");
  value.event("main", "response", { mainResponse: 1 });
  value.event("main", "task", { worker: "worker-2", files: TILES, mainResponse: 1 });
  await value.check("main", "zero");
  const raw = await workerRepair(value);
  await value.read("main", raw);
  if (mode === "stale-product") await value.write("worker-1", "product.json", FIXED);
  await value.generate("worker-2", mode === "batch-first" ? [1, 2, 3] : [1], "#4466aa");
  if (mode !== "batch-first") {
    await value.assetCheck("worker-2", [1]);
    await value.generate("worker-2", [2, 3], "#4466aa");
  }
  if (!["zero-only", "late"].includes(mode)) await value.assetCheck("main", mode === "partial" ? [1, 2] : [1, 2, 3]);
  if (mode === "stale-assets") await value.generate("worker-2", [3], "#4466aa");
  recordDecision(value, "accept", [raw], ["no-engine-visual-verification"]);
  if (mode === "late") await value.assetCheck("main", [1, 2, 3]);
  const result = await score(value, "complete", 1);
  expect(result.criteria.find(item => item.name === INDEPENDENT_EVIDENCE)?.passed).toBe(mode === "batch-first");
  expect(result.criteria.find(item => item.name === ACCEPTANCE_EVIDENCE)?.passed).toBe(mode === "batch-first");
  expect(result.status).toBe("fail");
});
