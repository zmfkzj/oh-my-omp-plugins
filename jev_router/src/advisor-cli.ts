import type { AuthStorage } from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import {
  ModelRegistry,
  Settings,
  discoverAuthStorage,
  getAgentDir,
} from "@oh-my-pi/pi-coding-agent";
import {
  resolveCliModel,
  resolveRoleSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import packageJson from "../package.json" with { type: "json" };
import {
  ROLE,
  prepareReviewInput,
  runReview,
  type PreparedReview,
  type ReviewSelection,
} from "./advisor-review.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const VERSION = packageJson.version;

const HELP = `orche-advisor ${VERSION}

Usage:
  orche-advisor [snapshot.json|-] [--model <selector>] [--agent-dir <dir>] [--json] [--check]
  orche-advisor --help
  orche-advisor --version

Request one bounded Orche-Advisor review from a JSON object containing
{ "checkpoint": "...", "snapshot": { ... } }. Pass - to read stdin. With no
input path, stdin is used only when it is piped.

Options:
  --model <selector>  Override modelRoles.${ROLE} for this invocation only.
  --agent-dir <dir>   Read OMP settings and credentials from this agent directory.
                      Defaults to OMP's native agent dir (PI_CODING_AGENT_DIR).
  --json              Emit the ReviewResult as JSON.
  --check             Validate input and resolve the model without a review call.
  -h, --help          Show this help.
  -v, --version       Show the package version.

Exit status:
  0  Review succeeded, input/model check succeeded, or help/version was shown.
  1  The reviewer returned an error.
  2  Usage, input, settings, credential, or model configuration error.
  130/143  Cancelled by SIGINT/SIGTERM.

Standalone install and use:
  cd /path/to/jev_router
  bun install
  bun run bin/orche-advisor.ts examples/initial-plan.json --check
  bun run bin/orche-advisor.ts examples/initial-plan.json
  cat examples/initial-plan.json | bun run bin/orche-advisor.ts --json

Install a release archive as a command:
  bun install --global /path/to/omp-jev-router-${VERSION}.tgz
  orche-advisor /path/to/snapshot.json --model provider/model:high --check
Requires Bun >=1.3.14 and credentials for the selected provider, not a running OMP session.
Use provider API-key environment variables or credentials in the selected OMP agent directory.
The CLI is stateless: every non-check invocation requests a review. Same-branch reuse is
available only inside the OMP extension. Review usage is in the result, not /advisor status.

Install the OMP extension from this same package:
  omp plugin install /path/to/jev_router
Configure modelRoles.${ROLE}; examples/config.yml also shows the independent
Verification Auditor role (default @smol, not ADVISOR).
Reload OMP with /reload-plugins or start a new session after installing or updating.
The standalone prose keyword orchestrate enables required initial-plan and phase/replan
reviews through OMP's native orchestration notice. Ordinary requests keep reviews optional.
The orchestrator calls the tool with a compact snapshot; hooks never invoke a model directly.
`;

interface CliOptions {
  input?: string;
  model?: string;
  agentDir?: string;
  json: boolean;
  check: boolean;
  help: boolean;
  version: boolean;
}

class CliError extends Error {}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new CliError(`${option} requires a value.`);
  }
  return value;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { json: false, check: false, help: false, version: false };
  let positionalOnly = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && (argument === "--help" || argument === "-h")) {
      options.help = true;
      continue;
    }
    if (!positionalOnly && (argument === "--version" || argument === "-v")) {
      options.version = true;
      continue;
    }
    if (!positionalOnly && argument === "--json") {
      options.json = true;
      continue;
    }
    if (!positionalOnly && argument === "--check") {
      options.check = true;
      continue;
    }
    if (!positionalOnly && argument === "--model") {
      if (options.model !== undefined) throw new CliError("--model may be specified only once.");
      options.model = optionValue(args, index, "--model");
      index++;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--model=")) {
      if (options.model !== undefined) throw new CliError("--model may be specified only once.");
      options.model = argument.slice("--model=".length);
      if (options.model.length === 0) throw new CliError("--model requires a value.");
      continue;
    }
    if (!positionalOnly && argument === "--agent-dir") {
      if (options.agentDir !== undefined)
        throw new CliError("--agent-dir may be specified only once.");
      options.agentDir = optionValue(args, index, "--agent-dir");
      index++;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--agent-dir=")) {
      if (options.agentDir !== undefined)
        throw new CliError("--agent-dir may be specified only once.");
      options.agentDir = argument.slice("--agent-dir=".length);
      if (options.agentDir.length === 0) throw new CliError("--agent-dir requires a value.");
      continue;
    }
    if (!positionalOnly && argument.startsWith("-") && argument !== "-") {
      throw new CliError(`Unknown option: ${argument}`);
    }
    if (options.input !== undefined) {
      throw new CliError(`Unexpected positional argument: ${argument}`);
    }
    options.input = argument;
  }

  return options;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  description: string,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_INPUT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new CliError(`${description} exceeds the ${MAX_INPUT_BYTES}-byte input limit.`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError(`${description} is not valid UTF-8.`);
  }
}

async function readInput(
  input: string,
  signal: AbortSignal,
): Promise<{ raw: string; description: string }> {
  if (input === "-") {
    return {
      raw: await readBoundedStream(Bun.stdin.stream(), "Standard input", signal),
      description: "standard input",
    };
  }

  const resolved = path.resolve(input);
  const file = Bun.file(resolved);
  if (!(await file.exists())) throw new CliError(`Input file not found: ${resolved}`);
  if (file.size > MAX_INPUT_BYTES) {
    throw new CliError(`Input file exceeds the ${MAX_INPUT_BYTES}-byte input limit: ${resolved}`);
  }
  try {
    return {
      raw: await readBoundedStream(file.stream(), `Input file ${resolved}`, signal),
      description: resolved,
    };
  } catch (error) {
    if (error instanceof CliError || signal.aborted) throw error;
    throw new CliError(`Could not read input file: ${resolved}`);
  }
}

function parseInput(raw: string, description: string): PreparedReview {
  if (raw.trim().length === 0) throw new CliError(`Input from ${description} is empty.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CliError(`Input from ${description} is not valid JSON.`);
  }
  try {
    return prepareReviewInput(value);
  } catch (error) {
    throw new CliError(`Invalid review input: ${safeErrorMessage(error)}`);
  }
}

async function modelsConfigPath(agentDir: string): Promise<string> {
  for (const name of ["models.yml", "models.yaml", "models.json"]) {
    const candidate = path.join(agentDir, name);
    if (await Bun.file(candidate).exists()) return candidate;
  }
  // A .json path disables ConfigFile's legacy JSON-to-YAML migration. With no
  // file present, the registry still supplies the bundled catalog without
  // creating configuration as a side effect of this standalone command.
  return path.join(agentDir, "models.json");
}

function resolveSelection(
  options: CliOptions,
  settings: Settings,
  registry: ModelRegistry,
): ReviewSelection {
  if (options.model !== undefined) {
    const resolved = resolveCliModel({
      cliModel: options.model,
      modelRegistry: registry,
      availableModels: registry.getAvailable(),
      settings,
    });
    if (!resolved.model) {
      throw new CliError(
        resolved.error ?? `Model selector "${options.model}" did not match a model.`,
      );
    }
    if (!registry.hasConfiguredAuth(resolved.model)) {
      throw new CliError(
        `No credentials are configured for ${resolved.model.provider}/${resolved.model.id} in the selected agent directory.`,
      );
    }
    return { model: resolved.model, thinkingLevel: resolved.thinkingLevel };
  }

  if (!settings.getModelRole(ROLE)) {
    throw new CliError(
      `Configure modelRoles.${ROLE} or pass --model; no DEFAULT/slow fallback is used.`,
    );
  }
  const selection = resolveRoleSelection([ROLE], settings, registry.getAvailable());
  if (!selection) {
    throw new CliError(
      `modelRoles.${ROLE} does not resolve to an available model with configured credentials; no DEFAULT/slow fallback is used.`,
    );
  }
  return { model: selection.model, thinkingLevel: selection.thinkingLevel };
}

function safeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const redacted = raw
    .replace(
      /((?:api[-_ ]?key|authorization|bearer|access[-_ ]?token|refresh[-_ ]?token|secret|password)\s*(?::|=)\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.slice(0, 2000) || "Unknown error";
}

function writeCheck(prepared: PreparedReview, selection: ReviewSelection, json: boolean): void {
  const result = {
    ok: true,
    check: true,
    checkpoint: prepared.checkpoint,
    snapshotHash: prepared.snapshotHash,
    model: `${selection.model.provider}/${selection.model.id}`,
    thinkingLevel: selection.thinkingLevel ?? null,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "Review input is valid; no review was requested.",
      `Checkpoint: ${result.checkpoint}`,
      `Snapshot hash: ${result.snapshotHash}`,
      `Model: ${result.model}`,
      `Thinking level: ${result.thinkingLevel ?? "model default"}`,
    ].join("\n") + "\n",
  );
}

/** Execute the standalone command and return its documented process exit code. */
export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    process.stderr.write(
      `Error: ${safeErrorMessage(error)}\nRun 'orche-advisor --help' for usage.\n`,
    );
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (options.input === undefined) {
    if (process.stdin.isTTY === true) {
      process.stderr.write(
        "Error: no input provided. Pass snapshot.json, pass -, or pipe JSON on standard input.\n" +
          "Run 'orche-advisor --help' for usage.\n",
      );
      return 2;
    }
    options.input = "-";
  }

  const controller = new AbortController();
  let interruptedExitCode: 130 | 143 | undefined;
  const interrupt = (exitCode: 130 | 143, signalName: "SIGINT" | "SIGTERM") => {
    interruptedExitCode ??= exitCode;
    if (!controller.signal.aborted) controller.abort(signalName);
  };
  const onSigint = () => interrupt(130, "SIGINT");
  const onSigterm = () => interrupt(143, "SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let authStorage: AuthStorage | undefined;
  let exitCode = 2;
  let reviewStarted = false;
  try {
    const input = await readInput(options.input, controller.signal);
    const prepared = parseInput(input.raw, input.description);
    controller.signal.throwIfAborted();

    const agentDir =
      options.agentDir === undefined ? getAgentDir() : path.resolve(options.agentDir);
    const settings = await Settings.loadReadOnly({ cwd: process.cwd(), agentDir });
    controller.signal.throwIfAborted();
    authStorage = await discoverAuthStorage(agentDir);
    controller.signal.throwIfAborted();
    const registry = new ModelRegistry(authStorage, await modelsConfigPath(agentDir), { settings });
    await registry.hydrateCredentialScopedModelCaches();
    await registry.refresh();
    controller.signal.throwIfAborted();
    const selection = resolveSelection(options, settings, registry);

    if (options.check) {
      writeCheck(prepared, selection, options.json);
      exitCode = 0;
    } else {
      reviewStarted = true;
      const result = await runReview(prepared, selection, registry, controller.signal);
      if (controller.signal.aborted) {
        exitCode = interruptedExitCode ?? 1;
      } else {
        process.stdout.write(
          options.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.text}\n`,
        );
        exitCode = result.isError ? 1 : 0;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write(`Cancelled by ${String(controller.signal.reason ?? "abort signal")}.\n`);
      exitCode = interruptedExitCode ?? 1;
    } else {
      process.stderr.write(`Error: ${safeErrorMessage(error)}\n`);
      exitCode = reviewStarted ? 1 : 2;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (authStorage) {
      try {
        authStorage.close();
      } catch (error) {
        process.stderr.write(`Error releasing credential storage: ${safeErrorMessage(error)}\n`);
        if (exitCode === 0) exitCode = 2;
      }
    }
  }
  return exitCode;
}
