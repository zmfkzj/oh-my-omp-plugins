import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { discoverAuthStorage, getAgentDir, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { resolveCliModel, resolveRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { redactSecrets, type ReviewSelection } from "../src/advisor-review.ts";
import { CASE_IDS, DECISION_LIMIT_CODES, SCORING_VERSION, type CaseId } from "./policy-fixtures.ts";
import { ADAPTER_REVISION, COMPONENTS, DECISION_OUTCOME_MEANINGS, DEFAULT_LIMITS, REPORT_SCHEMA_VERSION, assertChatApi, policyFor, runCase, type Component, type Limits } from "./policy-behavior.ts";

const HELP = `Opt-in Judgment/Production behavioral evaluation

Usage: bun run eval:policy -- [options]

  --help, -h                 Show help (no config/model access)
  --list                     List sanitized cases (no config/model access)
  --case <id[,id...]>         Select cases; repeatable; default all twelve cases
  --model <selector>         Provider/model[:effort]; otherwise configured modelRoles.default
  --agent-dir <existing-dir> Read OMP settings/credentials, as orche-advisor does
  --check                    Resolve authorized model/fixtures/policy without model calls
  --omit-component <name>    Paired current + one omission: selection, production, reuse,
                             evidence, assets, decomposition. No combined CUT.
  --max-calls <1..100>        Shared Main+worker SDK completion budget per case (default 48)
  --max-tools <1..400>        Shared tool-call budget per case (default 160)
  --timeout-seconds <1..900>  Per-case wall timeout (default 300)
  --max-tokens <512..4096>    Output tokens per SDK completion (default 1536)
  --output <new-dir>         New evidence directory; default retained fresh OS-temp directory

This is a safe evaluation ADAPTER, not native OMP task/Studio/engine validation.
Real authenticated model+worker conversations operate on inert temporary JSON/SVG
fixtures through allowlisted reads/writes and trusted checks. No model shell, eval,
network, arbitrary host filesystem or execution of model-authored code. Native
agent/provider APIs with their own executors are refused. SVG/runtime checks prove
format/state contracts, not visual or engine behavior. External publishing is
unavailable and permanently blocked; that case evaluates preflight/limit reporting.

Records report.json and per-case result.json, trace.jsonl, state.json, policy.txt.
Temporary mutable sandboxes are removed even on failure; evidence is retained.
Scores use operations/current-version raw evidence and state, never a prose judge.
SDK/provider internal transport retries may occur within the wall timeout; max-calls
counts completion invocations, including workers, not unobserved HTTP attempts.
No provider calls run at import or in normal bun test. Explicit live runs may cost money.
Exit: 0 all selected cases pass (or help/list/check); 1 fail/incomplete; 2 usage/config error.
`;
export interface Options {
  help: boolean;
  list: boolean;
  check: boolean;
  cases: CaseId[];
  model?: string;
  agentDir?: string;
  output?: string;
  component?: Component;
  limits: Limits;
}

export function parseArgs(args: readonly string[]): Options {
  const options: Options = { help: false, list: false, check: false, cases: [], limits: { ...DEFAULT_LIMITS } };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (argument === "--list") { options.list = true; continue; }
    if (argument === "--check") { options.check = true; continue; }
    const [flag, inline] = argument.split(/=(.*)/s);
    if (!["--case", "--model", "--agent-dir", "--output", "--omit-component", "--max-calls", "--max-tools", "--timeout-seconds", "--max-tokens"].includes(flag!)) throw new Error(`Unknown option: ${argument}`);
    if (flag !== "--case" && seen.has(flag!)) throw new Error(`${flag} may be specified only once.`);
    seen.add(flag!);
    const value = inline ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    switch (flag) {
      case "--case":
        for (const id of value.split(",")) {
          if (!CASE_IDS.includes(id as CaseId)) throw new Error(`Unknown case: ${id}. Use --list.`);
          if (options.cases.includes(id as CaseId)) throw new Error(`Case selected twice: ${id}`);
          options.cases.push(id as CaseId);
        }
        break;
      case "--model": options.model = value; break;
      case "--agent-dir": options.agentDir = value; break;
      case "--output": options.output = value; break;
      case "--omit-component":
        if (!COMPONENTS.includes(value as Component)) throw new Error(`Unknown component: ${value}.`);
        options.component = value as Component;
        break;
      default: {
        const bound: Record<string, [keyof Limits, number, number, number]> = {
          "--max-calls": ["maxCalls", 1, 100, 1], "--max-tools": ["maxTools", 1, 400, 1],
          "--timeout-seconds": ["timeoutMs", 1, 900, 1000], "--max-tokens": ["maxTokens", 512, 4096, 1],
        };
        const [key, min, max, multiplier] = bound[flag!]!;
        if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${flag} must be an integer ${min}..${max}.`);
        options.limits[key] = Number(value) * multiplier;
      }
    }
  }
  if (options.cases.length === 0) options.cases = [...CASE_IDS];
  return options;
}


async function resolveModel(options: Options, signal: AbortSignal): Promise<{ selection: ReviewSelection; registry: ModelRegistry; storage: AuthStorage }> {
  const agentDir = options.agentDir === undefined ? getAgentDir() : path.resolve(options.agentDir);
  const info = await stat(agentDir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Agent directory not found or not a directory: ${agentDir}`);
  const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir });
  signal.throwIfAborted();
  const storage = await discoverAuthStorage(agentDir);
  try {
    let modelsPath = path.join(agentDir, "models.json");
    for (const filename of ["models.yml", "models.yaml", "models.json"]) {
      const candidate = path.join(agentDir, filename);
      if (await Bun.file(candidate).exists()) { modelsPath = candidate; break; }
    }
    const registry = new ModelRegistry(storage, modelsPath, { settings });
    await registry.hydrateCredentialScopedModelCaches();
    await registry.refresh();
    signal.throwIfAborted();
    let selection: ReviewSelection;
    if (options.model !== undefined) {
      const resolved = resolveCliModel({ cliModel: options.model, modelRegistry: registry, availableModels: registry.getAvailable(), settings });
      if (!resolved.model) throw new Error(resolved.error ?? "Model selector did not resolve.");
      if (!registry.hasConfiguredAuth(resolved.model)) throw new Error("No credentials configured for the selected model.");
      selection = { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
    } else {
      if (!settings.getModelRole("default")) throw new Error("Pass --model or configure modelRoles.default; no fallback model is selected.");
      const resolved = resolveRoleSelection(["default"], settings, registry.getAvailable());
      if (!resolved) throw new Error("Configured modelRoles.default does not resolve to an authorized available model.");
      selection = { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
    }
    assertChatApi(selection.model.api);
    return { selection, registry, storage };
  } catch (error) { storage.close(); throw error; }
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: Options;
  try { options = parseArgs(args); }
  catch (error) { process.stderr.write(`Error: ${redactSecrets(String(error))}\nUse --help.\n`); return 2; }
  if (options.help) { process.stdout.write(HELP); return 0; }
  if (options.list) { process.stdout.write(`${CASE_IDS.join("\n")}\n`); return 0; }
  const controller = new AbortController();
  const onInterrupt = () => controller.abort("Interrupted");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  let storage: AuthStorage | undefined;
  let started = false;
  try {
    // Validate policy variants before credentials or paid work; never remove several lines.
    const policies = [policyFor(), ...(options.component ? [policyFor(options.component)] : [])];
    if (options.output !== undefined && !options.check && await Bun.file(path.resolve(options.output)).exists()) throw new Error("Output directory must not already exist.");
    const resolved = await resolveModel(options, controller.signal);
    storage = resolved.storage;
    if (options.check) {
      process.stdout.write(`${JSON.stringify({ check: true, model: `${resolved.selection.model.provider}/${resolved.selection.model.id}`, api: resolved.selection.model.api, thinkingLevel: resolved.selection.thinkingLevel ?? null, cases: options.cases, policies: policies.map(policy => ({ hash: policy.hash, omitted: policy.omitted?.component ?? null })), limits: options.limits, modelCalls: 0 }, null, 2)}\n`);
      return 0;
    }
    const output = options.output === undefined ? await mkdtemp(path.join(os.tmpdir(), "orche-policy-eval-")) : path.resolve(options.output);
    if (options.output !== undefined) await mkdir(output, { mode: 0o700 });
    process.stdout.write(`Evidence directory: ${output}\n`);
    const reports: unknown[] = [];
    const exercisedCases = new Set<CaseId>();
    let failed = false;
    started = true;
    const reportBase = {
      schemaVersion: REPORT_SCHEMA_VERSION, adapterRevision: ADAPTER_REVISION, scoringVersion: SCORING_VERSION, startedAt: new Date().toISOString(), adapter: "safe-fixture-tool-chat (not native OMP)",
      limits: options.limits, selectedCases: options.cases,
      decisionLimitCodes: DECISION_LIMIT_CODES,
      decisionOutcomeMeanings: DECISION_OUTCOME_MEANINGS,
      scoringNotes: ["Version 2: unresolved-cause ownership accepts a worker's fresh pre-mutation fixture inspection or failing reproduction plus its actual post-repair check; failing-before is reported separately, not equated with ownership.", "Version 2: a fresh pre-batch sample check may be performed by the responsible worker or Main; no mandatory Main/user approval gate is introduced.", "Version 3: actual asset/spec observations may be combined per file across equivalent asset/runtime/preflight checks; every file's hash/version must be fresh before acceptance and final evidence must match current bytes.", "Version 3: actual Main readback of current valid unrelated.json label=new may prove that requested change; summaries, citations, stale or post-claim reads do not."],
      decompositionMeasurement: "Version 4: independent product/assets dispatch attempts (including rejected task validation) must share one Main response, with eventual ownership by separate successful workers; cohesive product changes must have one worker. Acceptance requires current raw evidence for every requested unit. Task/task-rejected mainResponse is the Main SDK call number, not native concurrent execution proof.",
      verificationLimits: ["No real project/workspace mutation", "No native OMP lifecycle proof", "Private reasoning/cause attribution cannot be inferred from tool events", "SVG/runtime format-state contracts, not engine/visual verification", "Publication preflight only; external operation unavailable", "SDK call counts include workers but not hidden provider transport retries", "Results describe these model runs, not universal policy compliance"],
      comparisons: options.component ? { component: options.component, changes: "one rendered policy component only", assumesDegradation: false } : null,
    };
    for (const caseId of options.cases) {
      for (const policy of policies) {
        if (controller.signal.aborted) break;
        const component = policy.omitted?.component;
        const name = `${caseId}-${component ?? "current"}`;
        const directory = path.join(output, name);
        await mkdir(directory, { mode: 0o700 });
        const result = await runCase(caseId, resolved.selection, resolved.registry, options.limits, component, controller.signal);
        const { trace, state, ...summary } = result;
        const paths = { trace: path.join(directory, "trace.jsonl"), state: path.join(directory, "state.json"), policy: path.join(directory, "policy.txt"), result: path.join(directory, "result.json") };
        await writeFile(paths.trace, `${trace.map(entry => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
        await writeFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await writeFile(paths.policy, `${policy.text}\n`, { mode: 0o600 });
        const record = { ...summary, omitted: policy.omitted ?? null, paths };
        await writeFile(paths.result, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        reports.push(record);
        exercisedCases.add(caseId);
        failed ||= result.outcome.status !== "pass";
        process.stdout.write(`${name}: ${result.outcome.status} (${result.termination}; ${result.calls} calls, ${result.toolCalls} tools)\n`);
        for (const criterion of result.outcome.criteria) if (!criterion.passed) process.stdout.write(`  FAIL: ${criterion.name}\n`);
        await writeFile(path.join(output, "report.json"), `${JSON.stringify({ ...reportBase, completedAt: new Date().toISOString(), interrupted: controller.signal.aborted, unexercisedCases: CASE_IDS.filter(id => !exercisedCases.has(id)), cases: reports }, null, 2)}\n`, { mode: 0o600 });
      }
    }
    process.stdout.write(`Report: ${path.join(output, "report.json")}\n`);
    return failed || controller.signal.aborted ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Error: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2000)}\n`);
    return started ? 1 : 2;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    storage?.close();
  }
}

if (import.meta.main) process.exitCode = await runCli();
