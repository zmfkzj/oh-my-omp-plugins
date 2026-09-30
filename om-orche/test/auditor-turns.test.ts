import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AdvisorRuntime } from "@oh-my-pi/pi-coding-agent/advisor/runtime";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { registerOrcheAdvisor } from "../src/orche-advisor.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";

const roots: string[] = [];
afterEach(async () => { clearRegistry(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
async function fixture(initialEnabled = true) {
  const root = await mkdtemp(path.join(tmpdir(), "orche-audit-turns-"));
  roots.push(root);
  await Bun.write(path.join(root, "WATCHDOG.yml"), 'advisors:\n  - name: Other Watchdog\n    model: "@advisor"\n  - name: Verification Auditor\n    enabled: false\n    model: "@verification-auditor"\n');
  const { session, ctx } = makeSession();
  let enabled = initialEnabled;
  let master = false;
  let roster: AdvisorConfig[] = [];
  let runtime: AdvisorRuntime | undefined;
  const transcript: AgentMessage[] = [];
  const audits: string[] = [];
  const warnings: string[] = [];
  const rebuild = () => {
    runtime?.dispose();
    runtime = undefined;
    if (master && roster.some(config => config.name === "Verification Auditor" && config.enabled !== false)) {
      runtime = new AdvisorRuntime({
        state: { messages: [] },
        async prompt(input) { audits.push(JSON.stringify(input)); },
        abort() {}, reset() {},
      }, { snapshotMessages: () => transcript });
    }
  };
  Object.assign(session.sessionManager, { getCwd: () => root });
  Object.assign(session.settings, { getAgentDir: () => root });
  Object.assign(session, {
    isAdvisorEnabled: () => master,
    setAdvisorEnabled(value: boolean) { master = value; rebuild(); },
    applyAdvisorConfigs(configs: AdvisorConfig[]) { roster = configs; rebuild(); },
    getAdvisorStats: () => ({ advisors: roster.map(config => ({ name: config.name, status: config.enabled === false ? "paused" : "running" })) }),
  });
  registerAsMain(session);
  const handlers = new Map<string, Handler[]>();
  const pi = {
    zod: z, registerTool() {}, getActiveTools: () => [],
    logger: { warn(message: string) { warnings.push(message); } },
    on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  // Duplicate plugin loading must not create a second runtime or second audit request.
  registerOrcheAdvisor(pi, undefined, () => enabled);
  registerOrcheAdvisor(pi, undefined, () => enabled);
  const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({ systemPrompt: [] }, ctx); };
  await emit("session_start");
  return {
    audits, warnings, session,
    get roster() { return roster; },
    disable() { enabled = false; },
    async begin() { await emit("before_agent_start"); },
    async end(text?: string) {
      if (text) {
        transcript.push({ role: "user", content: text, timestamp: transcript.length });
        transcript.push({ role: "assistant", content: [{ type: "text", text: `Answer to ${text}` }], timestamp: transcript.length } as unknown as AgentMessage);
      }
      // Exercise OMP's real delta/cursor/drain implementation, as its native turn-end callback does.
      runtime?.onTurnEnd(transcript, { willContinue: false });
      await runtime?.waitForCatchup(1000, 0);
      await emit("turn_end");
    },
    close() { runtime?.dispose(); },
  };
}

test("every consecutive no-tool main turn is audited once, without enabling other watchdogs", async () => {
  const app = await fixture();
  try {
    expect(app.roster.find(config => config.name === "Other Watchdog")?.enabled).toBe(false);
    expect(app.roster.find(config => config.name === "Verification Auditor")?.enabled).toBe(true);
    await app.begin();
    const first = app.end("First text-only turn");
    const duplicate = app.end(); // Same transcript while the first audit is in flight.
    await Promise.all([first, duplicate]);
    await app.end(); // Also no duplicate after the drain completes.
    await app.begin();
    await app.end("Second text-only turn");
    expect(app.audits).toHaveLength(2);
    expect(app.audits[0]).toContain("First text-only turn");
    expect(app.audits[1]).toContain("Second text-only turn");
    expect(app.audits[1]).not.toContain("First text-only turn");
    app.disable();
    await app.begin();
    await app.end("Disabled turn");
    expect(app.audits).toHaveLength(2);
  } finally { app.close(); }
});

test("a disabled plugin never installs a runtime", async () => {
  const app = await fixture(false);
  try { await app.begin(); await app.end("No audit"); expect(app.audits).toEqual([]); }
  finally { app.close(); }
});

