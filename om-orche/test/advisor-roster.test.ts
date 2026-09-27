import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { registerOrcheAdvisor } from "../src/orche-advisor.ts";
import { clearRegistry, makeSession, registerAsMain } from "./harness.ts";

afterEach(clearRegistry);

test("installing the auditor removes the default advisor and keeps explicit watchdog entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jev-roster-"));
  try {
    const { session, ctx } = makeSession();
    let roster: AdvisorConfig[] = [];
    Object.assign(session.sessionManager, { getCwd: () => root });
    Object.assign(session.settings, { getAgentDir: () => root });
    Object.assign(session, {
      isAdvisorEnabled: () => true,
      applyAdvisorConfigs: (configs: AdvisorConfig[]) => { roster = configs; },
    });
    registerAsMain(session);
    let start: (event: unknown, ctx: ExtensionContext) => unknown = () => {};
    registerOrcheAdvisor({
      zod: z,
      registerTool() {},
      on(event: string, handler: typeof start) { if (event === "session_start") start = handler; },
    } as unknown as ExtensionAPI);
    await start({}, ctx);
    expect(roster.map(config => config.name)).toEqual(["Verification Auditor"]);
    expect(roster[0]?.model).toBe("@verification-auditor");

    await Bun.write(path.join(root, "WATCHDOG.yml"), 'advisors:\n  - name: Custom Advisor\n    model: "@advisor"\n');
    await start({}, ctx);
    expect(roster.map(config => config.name)).toEqual(["Custom Advisor", "Verification Auditor"]);
    expect(roster[0]?.model).toBe("@advisor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
