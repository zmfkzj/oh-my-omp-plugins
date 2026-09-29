import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AdvisorNote } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { WITHHELD_TAIL, enforceAuditorContract } from "../src/auditor-contract.ts";
import { collectFindings } from "../src/findings.ts";
import { AUDITOR_NAME } from "../src/verification-auditor.ts";

const auditor = (note: string, severity?: AdvisorNote["severity"]): AdvisorNote => ({ note, severity, advisor: AUDITOR_NAME });
const QUOTED_BLOCKER = auditor('The answer says "all tests pass" but `bun test` exited 1.', "blocker");
const UNQUOTED_BLOCKER = auditor("`ProgressService.luau:13` still calls GetDataStore at load.", "blocker");
const PROCESS_BLOCKER = auditor("Stop immediately. Deliver the final response to the user.", "blocker");
const NIT = auditor("Run `bun test` now.", "nit");
const OTHER = { note: "Consider a smaller queue.", severity: "concern", advisor: "Challenger" } satisfies AdvisorNote;

function card(...notes: AdvisorNote[]): AgentMessage {
  return { role: "custom", customType: "advisor", content: "raw", display: true, details: { notes }, timestamp: 1 };
}
// A minimal assistant turn; only its role matters to the contract.
const answer = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 } as unknown as AgentMessage;
const user: AgentMessage = { role: "user", content: "Ship it.", timestamp: 1 };

function notesOf(message: AgentMessage | undefined): unknown {
  return message?.role === "custom" ? (message.details as { notes: unknown }).notes : undefined;
}

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

  test("provider context drops withheld notes, rewrites severity and leaves other advisors alone", () => {
    const mixed = card(OTHER, NIT, UNQUOTED_BLOCKER);
    const withheldOnly = card(NIT, PROCESS_BLOCKER);
    const untouched = card(QUOTED_BLOCKER);
    const next = enforceAuditorContract([user, mixed, withheldOnly, untouched, answer]);

    expect(next).toHaveLength(4);
    expect(notesOf(next![1])).toEqual([OTHER, { ...UNQUOTED_BLOCKER, severity: "concern" }]);
    expect(next![1]?.role === "custom" && next![1].content).toContain('severity="concern"');
    expect(next![2]).toBe(untouched);
    expect(notesOf(mixed)).toEqual([OTHER, NIT, UNQUOTED_BLOCKER]);
    expect(enforceAuditorContract([user, untouched, card(OTHER)])).toBeUndefined();
  });

  test("a fully withheld card that woke an idle primary becomes a closing notice", () => {
    const next = enforceAuditorContract([user, answer, card(PROCESS_BLOCKER)]);
    expect(next?.map((message) => message.role)).toEqual(["user", "assistant", "custom"]);
    expect(next![2]?.role === "custom" && next![2].content).toBe(WITHHELD_TAIL);
    // Mid-turn the same card simply disappears; the tool results carry the turn.
    expect(enforceAuditorContract([user, card(PROCESS_BLOCKER), answer])).toEqual([user, answer]);
  });
});
