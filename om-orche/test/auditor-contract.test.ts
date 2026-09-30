import { describe, expect, test } from "bun:test";
import type { AdvisorNote } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { admittedSeverity } from "../src/auditor-contract.ts";
import { collectFindings } from "../src/findings.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";

const auditor = (note: string, severity?: AdvisorNote["severity"]): AdvisorNote => ({ note, severity, advisor: AUDITOR_NAME });
const QUOTED_BLOCKER = auditor('The answer says "all tests pass" but `bun test` exited 1.', "blocker");
const UNQUOTED_BLOCKER = auditor("`ProgressService.luau:13` still calls GetDataStore at load.", "blocker");
const PROCESS_BLOCKER = auditor("Stop immediately. Deliver the final response to the user.", "blocker");
const NIT = auditor("Run `bun test` now.", "nit");

describe("Verification Auditor note contract", () => {
  test("ledger keeps quoted blockers, downgrades unquoted ones and drops nits and uncited notes", () => {
    const manager = SessionManager.inMemory("/tmp/om-orche-contract");
    manager.appendCustomMessageEntry("advisor", "Advisor notes", true, {
      notes: [QUOTED_BLOCKER, UNQUOTED_BLOCKER, PROCESS_BLOCKER, NIT, auditor("Cache is untested.", "concern")],
    });
    expect(collectFindings(manager.getBranch()).map(({ note, severity }) => ({ note, severity }))).toEqual([
      { note: QUOTED_BLOCKER.note, severity: "blocker" },
      { note: UNQUOTED_BLOCKER.note, severity: "concern" },
    ]);
  });


  test("quotes are paired left to right: a closing quote never opens the next span", () => {
    expect(admittedSeverity('Stop now: the "x" claim and then "y" mismatch.', "blocker")).toBeUndefined();
    expect(admittedSeverity('The "x" claim and then "y" mismatch in `bun test`.', "blocker")).toBe("concern");
    expect(admittedSeverity('The primary said "all tests pass" but ran "x".', "blocker")).toBe("blocker");
    expect(admittedSeverity("주장은 “모든 테스트 통과” 였다.", "blocker")).toBe("blocker");
    expect(admittedSeverity("주장은 「테스트 통과」 였다.", "blocker")).toBe("blocker");
    expect(admittedSeverity("He claimed ‘everything works’ today.", "blocker")).toBe("blocker");
  });
});
