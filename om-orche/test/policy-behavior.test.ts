import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Fixture, parseDecisionLimits, score, type CaseId, type Decision, type DecisionLimitCode, type Termination } from "../eval/policy-fixtures.ts";
import { assertChatApi, redactEvaluationValue, runCase } from "../eval/policy-behavior.ts";
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
  value.event("worker-1", "worker-return", { status: "success", summary: "Repair complete", evidence: [result.path] });
  return result.path;
}

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
  value.event("worker-1", "worker-return", { status: "premise-refuted", evidence: [reproduction.path] });
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
