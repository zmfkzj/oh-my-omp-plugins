import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import example from "../examples/initial-plan.json";
import { runReview, ROLE, TOOL, type ReviewSelection } from "../src/advisor-review.ts";
import { registerOmOrche } from "../src/index.ts";
import { AUDITOR_NAME, VERIFICATION_AUDITOR } from "../src/verification-auditor.ts";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ORCHESTRATE_GUIDANCE, registerOrcheAdvisor } from "../src/orche-advisor.ts";
import {
  NATIVE_ORCHESTRATE_NOTICE_TYPE,
  NATIVE_WORKFLOW_NOTICE_TYPE,
  policyModeOf,
} from "../src/orchestration-policy.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";
import type { HostSetupStore } from "../src/omp-setup.ts";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";

const tempRoots: string[] = [];
afterEach(() => {
  clearRegistry();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/**
 * The whole plugin on a main session with real settings, its session_start handlers in registration order.
 *
 * The fake session models what a real host was observed to do: writing `advisor.enabled` does not toggle an
 * already-built session, only `setAdvisorEnabled` does. `timeline` records the live advisor calls in order.
 */
function plugin(store: HostSetupStore, settings = Settings.isolated()) {
  const handlers: Handler[] = [];
  const commands: string[] = [];
  const timeline: string[] = [];
  let roster: AdvisorConfig[] = [];
  let advisorLive = false;
  let adviceTool: Tool | undefined;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-orche-plugin-"));
  tempRoots.push(root);
  const { session, ctx } = makeSession();
  Object.assign(session.sessionManager, { getBranch: () => [], getCwd: () => root });
  Object.assign(settings, { getAgentDir: () => root });
  Object.assign(session, {
    settings,
    isAdvisorEnabled: () => {
      timeline.push(`isAdvisorEnabled=${advisorLive}`);
      return advisorLive;
    },
    setAdvisorEnabled: (enabled: boolean) => {
      timeline.push(`setAdvisorEnabled(${enabled})`);
      advisorLive = enabled;
      return false;
    },
    applyAdvisorConfigs: (configs: AdvisorConfig[]) => {
      timeline.push("roster");
      roster = configs;
    },
  });
  registerAsMain(session);
  const pi = {
    zod: z,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    setLabel() {},
    events: { on: () => () => {} },
    registerCommand(name: string) { commands.push(name); },
    registerTool(tool: Tool) { if (tool.name === TOOL) adviceTool = tool; },
    on(event: string, handler: Handler) {
      if (event === "session_start") handlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  const runtime = registerOmOrche(pi, store);
  runtime.reloadConfig = async () => runtime.config;
  runtime.telemetry.load = async () => {};
  return {
    session, ctx, settings, runtime, commands, timeline,
    get roster() { return roster.map(config => config.name); },
    get adviceTool() { return adviceTool; },
    async start() { for (const handler of handlers) await handler({}, ctx); },
  };
}

function markerStore(initial?: number) {
  const written: number[] = [];
  let version = initial;
  const store: HostSetupStore = {
    async version() { return version; },
    async markApplied(next) { version = next; written.push(next); },
  };
  return { store, written };
}

test("the first main session start configures OMP and turns the live advisor on before the auditor installs", async () => {
  const { store, written } = markerStore();
  const settings = Settings.isolated();
  settings.setModelRole("advisor", "existing-advisor-model");
  const app = plugin(store, settings);

  await app.start();

  expect(settings.getModelRole("verification-auditor")).toBe("@smol");
  expect(settings.getModelRole("orche-advisor")).toBe("@slow");
  expect(settings.getModelRole("advisor")).toBe("existing-advisor-model");
  expect(written).toEqual([2]);
  // The live flag is switched on first, so the installer in the same start sees advisors enabled and installs.
  expect(app.timeline).toEqual(["isAdvisorEnabled=false", "setAdvisorEnabled(true)", "isAdvisorEnabled=true", "roster"]);
  expect(app.roster).toEqual([AUDITOR_NAME]);
});

describe("the live advisor is only switched on for a value this run wrote", () => {
  test("a user-configured advisor.enabled is left alone", async () => {
    const settings = Settings.isolated();
    cfgAdvisorEnabled.set(settings, false);
    const app = plugin(markerStore().store, settings);

    await app.start();

    expect(cfgAdvisorEnabled.get(settings)).toBe(false);
    expect(app.timeline).toEqual(["isAdvisorEnabled=false"]);
    expect(app.roster).toEqual([]);
  });

  test("a session-scoped advisor.enabled stays pending and the live flag is untouched", async () => {
    const { store, written } = markerStore();
    const app = plugin(store, Settings.isolated({ "advisor.enabled": false }));

    await app.start();

    expect(app.timeline).toEqual(["isAdvisorEnabled=false"]);
    expect(written).toEqual([]);
  });
});

test("a disabled plugin leaves OMP's advisor roster and auditor notes untouched", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-orche-disabled-"));
  tempRoots.push(root);
  const { session, ctx } = makeSession();
  let roster: AdvisorConfig[] | undefined;
  Object.assign(session.sessionManager, { getCwd: () => root });
  Object.assign(session.settings, { getAgentDir: () => root });
  Object.assign(session, {
    isAdvisorEnabled: () => true,
    applyAdvisorConfigs: (configs: AdvisorConfig[]) => { roster = configs; },
  });
  registerAsMain(session);
  const handlers: Record<string, Handler[]> = {};
  let enabled = false;
  registerOrcheAdvisor({
    zod: z,
    registerTool() {},
    getActiveTools: () => [TOOL],
    on(event: string, handler: Handler) { (handlers[event] ??= []).push(handler); },
  } as unknown as ExtensionAPI, undefined, () => enabled);
  const note = {
    role: "custom", customType: "advisor", display: true, attribution: "agent", timestamp: 1,
    content: "raw",
    details: { notes: [{ note: "consider renaming foo", severity: "nit", advisor: AUDITOR_NAME }] },
  } as AgentMessage;
  const messages = [user(PROMPT), note];
  const run = async (event: string, payload: unknown) => {
    const results: unknown[] = [];
    for (const handler of handlers[event] ?? []) results.push(await handler(payload, ctx));
    return results;
  };

  await run("session_start", {});
  expect(roster).toBeUndefined();
  expect((await run("context", { type: "context", messages })).every(result => result === undefined)).toBe(true);

  // Enabled, the same start installs the auditor and the same context is rewritten.
  enabled = true;
  await run("session_start", {});
  expect(roster?.map(config => config.name)).toEqual([AUDITOR_NAME]);
  expect((await run("context", { type: "context", messages })).some(result => result !== undefined)).toBe(true);
});

test("an auditor dropped by /advisor configure is restored before the next prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-orche-roster-"));
  tempRoots.push(root);
  const { session, ctx } = makeSession();
  let roster: AdvisorConfig[] = [];
  let applies = 0;
  Object.assign(session.sessionManager, { getCwd: () => root });
  Object.assign(session.settings, { getAgentDir: () => root });
  Object.assign(session, {
    isAdvisorEnabled: () => true,
    getAdvisorStats: () => ({ advisors: roster.map(config => ({ name: config.name })) }),
    applyAdvisorConfigs: (configs: AdvisorConfig[]) => { roster = configs; applies++; },
  });
  registerAsMain(session);
  const handlers: Record<string, Handler[]> = {};
  let enabled = true;
  registerOrcheAdvisor({
    zod: z,
    registerTool() {},
    getActiveTools: () => [],
    on(event: string, handler: Handler) { (handlers[event] ??= []).push(handler); },
  } as unknown as ExtensionAPI, undefined, () => enabled);
  const prompt = async () => { for (const handler of handlers.before_agent_start ?? []) await handler({ systemPrompt: [] }, ctx); };

  for (const handler of handlers.session_start ?? []) await handler({}, ctx);
  expect(roster.map(config => config.name)).toEqual([AUDITOR_NAME]);
  await prompt();
  expect(applies).toBe(1);

  // `/advisor configure` saves a freshly discovered roster, which has no auditor.
  fs.writeFileSync(path.join(root, "WATCHDOG.yml"), 'advisors:\n  - name: Custom Advisor\n    model: "@advisor"\n');
  roster = [{ name: "Custom Advisor", model: "@advisor" }];
  enabled = false;
  await prompt();
  expect(roster.map(config => config.name)).toEqual(["Custom Advisor"]);
  enabled = true;
  await prompt();
  expect(roster.map(config => config.name)).toEqual(["Custom Advisor", AUDITOR_NAME]);
  await prompt();
  expect(applies).toBe(2);

  // A user-declared auditor, even a disabled one, is theirs to keep.
  roster = [{ name: AUDITOR_NAME, enabled: false }];
  await prompt();
  expect(applies).toBe(2);
});

test("once the setup has run, a start registers no roles and enables nothing", async () => {
  const { store, written } = markerStore(2);
  const settings = Settings.isolated();
  const app = plugin(store, settings);

  await app.start();
  await app.start();

  expect(app.timeline).toEqual(["isAdvisorEnabled=false", "isAdvisorEnabled=false"]);
  expect(settings.getModelRole("verification-auditor")).toBeUndefined();
  expect(settings.getModelRole("orche-advisor")).toBeUndefined();
  expect(written).toEqual([]);
});

test("a disabled plugin leaves OMP unconfigured, the live advisor off and the marker unset", async () => {
  const { store, written } = markerStore();
  const settings = Settings.isolated();
  const app = plugin(store, settings);
  app.runtime.reloadConfig = async () => {
    app.runtime.config.enabled = false;
    return app.runtime.config;
  };

  await app.start();

  expect(settings.getModelRole("verification-auditor")).toBeUndefined();
  expect(cfgAdvisorEnabled.get(settings)).toBe(false);
  expect(app.timeline).toEqual([]);
  expect(app.roster).toEqual([]);
  expect(written).toEqual([]);
});

test("one extension registers the advice tool and an independent auditor role, without review commands", async () => {
  // Setup already applied, so `orche-advisor` stays unset and the advice tool reports it.
  const { store } = markerStore(1);
  const settings = Settings.isolated();
  settings.setModelRole("advisor", "existing-advisor-model");
  const app = plugin(store, settings);
  const { session, ctx } = app;

  await app.start();
  const adviceTool = app.adviceTool;
  expect(adviceTool?.name).toBe(TOOL);
  expect(VERIFICATION_AUDITOR.model).toBe("@verification-auditor");
  expect(settings.getModelRole("advisor")).toBe("existing-advisor-model");
  expect(settings.getModelRole("verification-auditor")).toBeUndefined();
  expect(app.commands.filter(name => /review|waive|approv/i.test(name))).toEqual([]);

  // The schema accepts only the checkpoint and seven-field snapshot: no dispatch staging.
  const schema = adviceTool!.parameters as unknown as z.ZodType;
  expect(schema.safeParse(example).success).toBe(true);
  expect(schema.safeParse({ ...example, dispatch: null }).success).toBe(false);

  // No configured advisor model is an actual failure, surfaced as such after a settings reload.
  let reloaded = false;
  Object.assign(session.settings, { reloadFromDisk: async () => { reloaded = true; } });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [] });
  await expect(adviceTool!.execute("advice", example, new AbortController().signal, () => {}, ctx))
    .rejects.toThrow("Configure modelRoles.orche-advisor");
  expect(reloaded).toBe(true);
});

const MODEL = { id: "review-fixture", provider: "openai", api: "openai-completions",
  name: "Review fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as ReviewSelection["model"];

type Completion = NonNullable<Parameters<typeof runReview>[4]>;

function verdictText(verdict: string): string {
  return `VERDICT: ${verdict}\n\nISSUES:\n- None\n\nORCHESTRATION CHANGES:\n- None\n\nAVOID:\n- None`;
}

function completionOf(verdict: string): Completion {
  return async () => ({
    role: "assistant", api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 0,
    stopReason: "stop", content: [{ type: "text", text: verdictText(verdict) }],
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as AssistantMessage);
}

/**
 * The advice tool on a primary session with a configured model and a scripted provider. Any
 * custom entry the tool writes lands in `customEntries`, so hidden approval state is observable.
 */
function adviceFixture(branch: SessionEntry[] = []) {
  const { session, ctx } = makeSession({ branch });
  const state = { completion: completionOf("KEEP"), modelCalls: 0, usage: [] as unknown[], customEntries: [] as string[] };
  Object.assign(session.sessionManager, {
    getLeafId: () => branch.at(-1)?.id ?? null,
    appendCustomEntry(customType: string) { state.customEntries.push(customType); return undefined; },
    appendModelUsage(entry: unknown) { state.usage.push(entry); return undefined; },
  });
  registerAsMain(session);
  session.settings.setModelRole(ROLE, `${MODEL.provider}/${MODEL.id}`);
  Object.assign(session.settings, { reloadFromDisk: async () => {} });
  Object.assign(ctx.modelRegistry, { getAvailable: () => [MODEL], getApiKey: async () => "fixture-key" });
  let tool!: Tool;
  registerOrcheAdvisor({ zod: z, on() {}, registerTool(registered: Tool) { tool = registered; } } as unknown as ExtensionAPI,
    (prepared, selection, registry, signal) => runReview(prepared, selection, registry, signal, (...args) => {
      state.modelCalls++;
      return state.completion(...args);
    }));
  let calls = 0;
  /** Execute once and persist the result as the host would, so later calls see it on the branch. */
  const advise = async () => {
    const id = `advice-${++calls}`;
    const result = await tool.execute(id, example, new AbortController().signal, () => {}, ctx);
    branch.push({ type: "message", id, parentId: branch.at(-1)?.id ?? null, timestamp: "2026-09-28T00:00:00Z",
      message: { role: "toolResult", toolCallId: id, toolName: TOOL, content: result.content,
        details: result.details, isError: result.isError === true, timestamp: calls } } as SessionEntry);
    return result;
  };
  return { session, ctx, branch, tool, state, advise };
}

test("every explicit call requests fresh advice on the submitted plan, even when unchanged", async () => {
  const { state, advise } = adviceFixture();
  const first = await advise();
  const second = await advise();
  expect(first.isError).not.toBe(true);
  expect(second.isError).not.toBe(true);
  expect(second.content[0]).toMatchObject({ type: "text" });
  expect((second.content[0] as { text: string }).text.startsWith(verdictText("KEEP"))).toBe(true);
  expect(state.modelCalls).toBe(2);
  expect(state.usage).toHaveLength(2);
  expect(state.customEntries).toEqual([]);
});

for (const verdict of ["REPLAN", "ESCALATE"]) {
  test(`${verdict} is advice returned as a successful result, with no recorded state`, async () => {
    const { state, advise } = adviceFixture();
    state.completion = completionOf(verdict);
    const result = await advise();
    expect(result.isError).not.toBe(true);
    expect((result.content[0] as { text: string }).text.startsWith(verdictText(verdict))).toBe(true);
    expect(result.details).not.toHaveProperty("failureKind");
    expect(state.customEntries).toEqual([]);
  });
}

test("a provider failure is an actual error with its usage accounted, and advice recovers without state", async () => {
  const { state, advise } = adviceFixture();
  state.completion = async () => { throw new Error("upstream unavailable"); };
  const failed = await advise();
  expect(failed.isError).toBe(true);
  expect(failed.details).toMatchObject({ failureKind: "provider_error" });
  expect(state.modelCalls).toBe(2);
  expect(state.usage).toHaveLength(2);
  state.completion = completionOf("KEEP");
  expect((await advise()).isError).not.toBe(true);
  expect(state.modelCalls).toBe(3);
  expect(state.customEntries).toEqual([]);
});

test("a cancelled review still records the usage of the attempts that were billed", async () => {
  const { ctx, tool, state } = adviceFixture();
  const controller = new AbortController();
  let attempt = 0;
  const keep = completionOf("KEEP");
  state.completion = async (...args) => {
    const settled = await keep(...args);
    if (++attempt === 1) return { ...settled, stopReason: "error" };
    controller.abort();
    return { ...settled, stopReason: "aborted" };
  };
  await expect(tool.execute("advice", example, controller.signal, () => {}, ctx)).rejects.toThrow();
  expect(state.usage).toMatchObject([{ stopReason: "error" }, { stopReason: "aborted" }]);
});

test("advice is primary-only and one request runs at a time", async () => {
  const { ctx, tool, state } = adviceFixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const keep = completionOf("KEEP");
  state.completion = async (...args) => { await held; return keep(...args); };
  const execute = () => tool.execute("advice", example, new AbortController().signal, () => {}, ctx);
  const running = execute();
  await expect(execute()).rejects.toThrow("already running");
  release();
  expect((await running).isError).not.toBe(true);
  expect((await execute()).isError).not.toBe(true);
  clearRegistry();
  await expect(execute()).rejects.toThrow("primary orchestrator");
});

const PROMPT = "Refactor the ingestion pipeline.";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}
function keywordNotice(customType: string, timestamp: number, content = customType): AgentMessage {
  return { role: "custom", customType, content, display: false, attribution: "user", timestamp } as AgentMessage;
}
function guidanceCount(message: AgentMessage | undefined): number {
  return message?.role === "custom" && typeof message.content === "string"
    ? message.content.split(ORCHESTRATE_GUIDANCE).length - 1
    : 0;
}
function totalGuidance(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + guidanceCount(message), 0);
}
function ofType(messages: AgentMessage[], customType: string): AgentMessage[] {
  return messages.filter(message => message.role === "custom" && message.customType === customType);
}

/** The whole plugin as OMP loads it, with no network, credentials or disk writes. */
function registeredPlugin(enabled = true, branch: SessionEntry[] = []) {
  const { session, ctx } = makeSession({ branch });
  Object.assign(session.sessionManager, {
    appendCustomEntry(customType: string, data: unknown) {
      const id = `state-${branch.length}`;
      branch.push({ type: "custom", id, parentId: null, timestamp: "2026-09-28T00:00:00Z", customType, data });
      return id;
    },
  });
  // The router reads the model's context off the session, as the host's `AgentSession.messages` getter does.
  const messages: AgentMessage[] = [];
  Object.assign(session, { isAdvisorEnabled: () => false, messages });
  registerAsMain(session);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    zod: z,
    logger: { debug() {}, warn() {}, info() {}, error() {} },
    setLabel() {},
    events: { on: () => () => {} },
    registerCommand() {},
    registerTool() {},
    getActiveTools: () => [TOOL],
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const runtime = registerOmOrche(pi);
  runtime.config.enabled = enabled;
  // `syncConfig` would replace the config with the real stored one on every turn.
  runtime.syncConfig = async () => {};
  runtime.telemetry.setEnabled(false);
  return {
    branch, session, ctx, runtime, messages,
    async endTurn() {
      for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end", willContinue: false }, ctx);
    },
    /** The first blocking `tool_call` result, if any hook would deny this call. */
    async attempt(toolName: string, input: Record<string, unknown> = {}) {
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ type: "tool_call", toolName, toolCallId: `pending-${toolName}`, input }, ctx);
        if (result) return result;
      }
      return undefined;
    },
    /**
     * Deliver a prompt as the host does: the user message joins the session's context, then the hidden
     * message a `before_agent_start` handler returned is appended after it. Returns that appended message.
     */
    async beginTurn(prompt: string): Promise<AgentMessage[]> {
      messages.push(user(prompt));
      const appended: AgentMessage[] = [];
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await handler({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx) as
          { message?: Record<string, unknown> } | undefined;
        if (result?.message) {
          appended.push({ role: "custom", ...result.message, attribution: "user", timestamp: 0 } as AgentMessage);
        }
      }
      messages.push(...appended);
      return appended;
    },
    /** Mirrors `ExtensionRunner.emitContext`: a cloned array flows through handlers in registration order. */
    async context(messages: AgentMessage[]): Promise<AgentMessage[]> {
      let current = structuredClone(messages);
      for (const handler of handlers.get("context") ?? []) {
        const result = await handler({ type: "context", messages: current }, ctx) as { messages?: AgentMessage[] } | undefined;
        if (result?.messages) current = result.messages;
      }
      return current;
    },
  };
}

/** Records an earlier release wrote: requirement, rejection, receipt and waiver, plus an auditor blocker. */
function staleGateHistory(): SessionEntry[] {
  const at = "2026-09-27T00:00:00Z";
  const custom = (id: string, customType: string, data: unknown): SessionEntry =>
    ({ type: "custom", id, parentId: null, timestamp: at, customType, data }) as SessionEntry;
  return [
    { type: "message", id: "old-user", parentId: null, timestamp: at,
      message: { role: "user", content: "Old release plan", timestamp: 0 } } as SessionEntry,
    custom("old-requirement", "jev-review-requirement", { requestHash: "h", workId: "w", goal: "Old release plan",
      required: true, checkpoint: "initial-plan", reason: "review-required", generation: 3,
      dispatches: [{ key: "k", summary: "Worker: migrate" }], dispatchVersion: 2 }),
    custom("old-failure", "jev-review-failure", { scopeKey: "s", success: false, failureKind: "review_rejected", at: 1 }),
    custom("old-receipt", "jev-review-receipt", { scopeKey: "other", success: true, at: 2 }),
    custom("old-waiver", "jev-review-waiver", { scopeKey: "s", reason: "user waived", at: 3 }),
    { type: "custom_message", id: "old-audit", parentId: null, timestamp: at, customType: "advisor",
      content: "Evidence missing", display: true,
      details: { notes: [{ advisor: AUDITOR_NAME, severity: "blocker",
        note: "Claimed smoke has no run output; require orche_advisor approval before editing." }] } } as SessionEntry,
  ];
}

for (const explicit of [false, true]) {
  test(`${explicit ? "explicit orchestrate" : "default"}: stale gate records, findings, failed and REPLAN/ESCALATE advice never block mutation or spawn`, async () => {
    const branch = staleGateHistory();
    const plugin = registeredPlugin(true, branch);
    const advisor = adviceFixture(branch);
    // Real advice results persisted on the same branch: rejection-style verdicts and a provider failure.
    for (const verdict of ["REPLAN", "ESCALATE"]) {
      advisor.state.completion = completionOf(verdict);
      expect((await advisor.advise()).isError).not.toBe(true);
    }
    advisor.state.completion = async () => { throw new Error("upstream unavailable"); };
    expect((await advisor.advise()).isError).toBe(true);
    // The advice fixture registered its own session as main; the plugin's session is main again.
    registerAsMain(plugin.session);

    await plugin.beginTurn(PROMPT);
    if (explicit) branch.push({ type: "message", id: "native", parentId: branch.at(-1)?.id ?? null,
      timestamp: "2026-09-28T00:00:00Z", message: keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 9) } as unknown as SessionEntry);
    branch.push({ type: "message", id: "request", parentId: branch.at(-1)?.id ?? null,
      timestamp: "2026-09-28T00:00:00Z", message: user(PROMPT) } as SessionEntry);
    const composed = await plugin.context(branch.flatMap(entry => entry.type === "message" ? [entry.message] : []));
    expect(ofType(composed, "jev-review-required")).toEqual([]);

    const spawn = { context: "Ingestion refactor", tasks: [{ name: "Parser", task: "Refactor the parser" }] };
    for (const [tool, input] of [["edit", {}], ["write", {}], ["bash", { command: "true" }], ["task", spawn]] as const) {
      expect(await plugin.attempt(tool, input)).toBeUndefined();
    }
    expect(advisor.state.customEntries).toEqual([]);
  });
}

test("explicit orchestration composes stand-in policy notices with Advisor guidance once", async () => {
  const plugin = registeredPlugin();
  const historical = keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1, "earlier native");
  const persisted = [historical, user("Earlier request"), assistant("done"),
    keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 2), user(PROMPT)];
  const snapshot = structuredClone(persisted);

  const first = await plugin.context(persisted);
  expect(persisted).toEqual(snapshot);
  // Every native notice, historical or current, becomes a stand-in in place; the default copy trails.
  expect(ofType(first, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
  const policy = first.filter(message => policyModeOf(message) !== undefined);
  expect(policy.map(policyModeOf)).toEqual(["orchestrate", "orchestrate", "default"]);
  expect(first[0]).toBe(policy[0]!);
  expect(first[3]).toBe(policy[1]!);
  expect(first.at(-1)).toBe(policy[2]!);
  expect(guidanceCount(policy[0])).toBe(1);
  expect(totalGuidance(first)).toBe(1);

  // A later provider request re-runs every hook on persisted history, or on an already composed copy.
  expect(await plugin.context(persisted)).toEqual(first);
  expect(await plugin.context(first)).toEqual(first);
  // Mutation attempts leave the composed context unchanged: no pending-review notice appears.
  expect(await plugin.attempt("edit")).toBeUndefined();
  expect(await plugin.context(persisted)).toEqual(first);
});

test("a workflow turn keeps the native workflow notice and gets one guided supplement", async () => {
  for (const explicit of [false, true]) {
    const plugin = registeredPlugin();
    const workflow = keywordNotice(NATIVE_WORKFLOW_NOTICE_TYPE, 3);
    const persisted = [assistant("previous"),
      ...(explicit ? [keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 3)] : []), workflow, user(PROMPT)];
    for (const composed of [await plugin.context(persisted), await plugin.context(persisted)]) {
      expect(ofType(composed, NATIVE_WORKFLOW_NOTICE_TYPE)).toEqual([workflow]);
      expect(ofType(composed, NATIVE_ORCHESTRATE_NOTICE_TYPE)).toEqual([]);
      const policy = composed.filter(message => policyModeOf(message) !== undefined);
      expect(policy.map(policyModeOf)).toEqual(["workflow", "default"]);
      expect(guidanceCount(policy[0])).toBe(1);
      expect(totalGuidance(composed)).toBe(1);
    }
  }
});

test("a default turn carries the Judgment/Production policy without orchestration guidance", async () => {
  const plugin = registeredPlugin();
  const appended = await plugin.beginTurn(PROMPT);
  expect(appended.map(policyModeOf)).toEqual(["default"]);
  const composed = await plugin.context([user(PROMPT), ...appended]);
  expect(composed.map(message => policyModeOf(message) ?? null).filter(Boolean)).toEqual(["default"]);
  expect(totalGuidance(composed)).toBe(0);
  // The persisted notice is still in the model's context, so the next prompt persists no second one.
  expect(await plugin.beginTurn("Next request")).toEqual([]);
});

test("master disable leaves native guidance unchanged and does not gate execution", async () => {
  const plugin = registeredPlugin(false);
  expect(await plugin.beginTurn(PROMPT)).toEqual([]);
  const messages = [keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1), user(PROMPT)];
  expect(await plugin.context(messages)).toEqual(messages);
  expect(await plugin.attempt("edit")).toBeUndefined();
});

test("without a router policy, only the current turn's native notice is guided, by copy", async () => {
  const branch: SessionEntry[] = [];
  const { session, ctx } = makeSession({ branch });
  registerAsMain(session);
  let context: Handler | undefined;
  registerOrcheAdvisor({
    zod: z,
    registerTool() {},
    getActiveTools: () => [TOOL],
    on(event: string, handler: Handler) { if (event === "context") context = handler; },
  } as unknown as ExtensionAPI);
  const historical = keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1);
  const current = keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 2);
  const messages = [historical, user("Earlier request"), assistant("done"), current, user(PROMPT)]
    .map(message => Object.freeze(message));
  const snapshot = structuredClone(messages);
  const result = await context!({ type: "context", messages }, ctx) as { messages: AgentMessage[] };
  expect(messages).toEqual(snapshot);
  expect(result.messages[0]).toBe(historical);
  expect(guidanceCount(result.messages[3])).toBe(1);
  expect(totalGuidance(result.messages)).toBe(1);
  expect(await context!({ type: "context", messages: result.messages }, ctx)).toBeUndefined();
  // A workflow notice alone carries no orchestration contract to annotate.
  expect(await context!({ type: "context", messages: [keywordNotice(NATIVE_WORKFLOW_NOTICE_TYPE, 4), user(PROMPT)] }, ctx))
    .toBeUndefined();
});

test("a governed turn is composed by the whole plugin with no network call and no credential access", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("network is forbidden"); }) as unknown as typeof fetch;
  try {
    const plugin = registeredPlugin();
    let credentialAccesses = 0;
    Object.defineProperty(plugin.ctx.modelRegistry, "authStorage", {
      get() { credentialAccesses++; throw new Error("credentials are forbidden"); },
    });
    const modelBefore = plugin.ctx.model;

    const appended = await plugin.beginTurn(PROMPT);
    expect(appended.map(policyModeOf)).toEqual(["default"]);
    const first = await plugin.context([user(PROMPT), ...appended]);
    expect(first.map(message => policyModeOf(message) ?? null).filter(Boolean)).toEqual(["default"]);
    // The persisted notice follows its user message, exactly as the host places it.
    expect(first.findIndex(message => policyModeOf(message) === "default")).toBe(1);
    expect(await plugin.context([user(PROMPT), ...appended])).toEqual(first);

    // Agent-attributed steering continues the turn and keeps the single notice where it is.
    const steering = { ...user("Worker A is available."), steering: true, attribution: "agent" } as AgentMessage;
    const steered = await plugin.context([user(PROMPT), ...appended, steering]);
    expect(steered.map(policyModeOf).filter(Boolean)).toEqual(["default"]);
    expect(steered[1]).toEqual(first[1]!);

    // agent_end settles the turn; a worker delivery then wakes the session without before_agent_start.
    await plugin.endTurn();
    for (const [customType, text] of [
      ["async-result", "<system-notice>\nBackground job bg_1 has completed"],
      ["irc:incoming", "<irc from=\"Worker\">done</irc>"],
    ]) {
      const delivery = { role: "custom", customType, content: text, display: false, attribution: "agent", timestamp: 7 } as AgentMessage;
      const woken = await plugin.context([user(PROMPT), ...appended, assistant("workers started"), delivery]);
      expect(woken.map(policyModeOf).filter(Boolean)).toEqual(["default"]);
      expect(woken[1]).toEqual(first[1]!);
      expect(woken[0]).toEqual(user(PROMPT));
    }
    // A synthetic prompt or a blank one persists nothing: the notice is already in the context.
    expect(await plugin.beginTurn("<system-notice>background job finished</system-notice>")).toEqual([]);
    expect(await plugin.beginTurn("   ")).toEqual([]);
    // A request whose context lost the persisted notice still carries a default copy, at the end.
    const bare = await plugin.context([user(PROMPT)]);
    expect(bare.map(policyModeOf).filter(Boolean)).toEqual(["default"]);
    expect(policyModeOf(bare.at(-1))).toBe("default");
    const explicit = await plugin.context([keywordNotice(NATIVE_ORCHESTRATE_NOTICE_TYPE, 1), user(PROMPT), ...appended]);
    expect(explicit.map(policyModeOf).filter(Boolean)).toEqual(["orchestrate", "default"]);

    expect(fetches).toBe(0);
    expect(credentialAccesses).toBe(0);
    expect(plugin.ctx.model).toBe(modelBefore);
  } finally {
    globalThis.fetch = realFetch;
  }
});
