/**
 * Durable Verification Auditor finding ledger for the active branch.
 *
 * Nothing is cached. Every read walks the branch it is given, so the ledger follows tree
 * navigation and survives plugin reloads without plugin state: findings come from persisted
 * `advisor` custom messages, lifecycle transitions from `custom` entries that `review_findings`
 * appends. A finding never expires and no review outcome changes it; only a recorded transition
 * does, and a transition is replayed only while its cited evidence still validates on the branch.
 * The ledger starts after the latest `/clear` (`reset_boundary`), as the model's context does.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { slugifyAdvisorName } from "@oh-my-pi/pi-coding-agent/advisor/config";
import type { CustomEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
  FINDING_LIMITS,
  TOOL as REVIEW_TOOL,
  collapse,
  formatFinding,
  isUnresolved,
  type FindingEvidence,
  type FindingStatus,
  type VerificationFinding,
} from "./advisor-review.ts";
import { type AuditorSeverity, admittedSeverity, isOwnedAuditor } from "./auditor-contract.ts";
import { mainSessionOf } from "./host.ts";
import { AUDITOR_NAME } from "./verification-auditor.ts";

/** Text parts of a message's content, trimmed; anything non-textual is dropped. */
function visibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string",
    )
    .map(part => part.text)
    .join("\n")
    .trim();
}

export const FINDINGS_TOOL = "review_findings";
/** `customType` of the lifecycle transitions `review_findings` persists. */
export const FINDING_ENTRY_TYPE = "orche-advisor-finding";

type TransitionAction = "resolve" | "waive" | "reopen";

const TRANSITIONS: Record<
  TransitionAction,
  { from: readonly FindingStatus[]; to: Exclude<FindingStatus, "open"> }
> = {
  resolve: { from: ["open", "reopened"], to: "resolved" },
  waive: { from: ["open", "reopened"], to: "waived" },
  reopen: { from: ["resolved", "waived"], to: "reopened" },
};

/** What one `list` shows in full; the rest is named by ID. */
const LISTED_UNRESOLVED = 10;
const LISTED_TRANSITIONED = 5;
const LISTED_CANDIDATES = 10;
const LISTED_IDS = 20;

/**
 * Persisted transition. Evidence stays entry ids, never copied excerpts: the transcript is the
 * one source, and a record whose evidence is no longer on the active branch, or was never
 * citable, is not replayed. Evidence the host pruned afterwards still counts, listed as pruned.
 */
interface TransitionRecord {
  /** v1 required post-receipt evidence; v2 permits evidence predating delayed delivery. */
  v: 1 | 2;
  /** Canonical ledger id of the finding. */
  findingId: string;
  action: TransitionAction;
  /** `user` only for a waiver the user confirmed in a dialog; anything else is the orchestrator's report. */
  author: "orchestrator" | "user";
  reason: string;
  evidence: string[];
  /** The `review_findings` call that wrote the record. */
  toolCallId: string;
}

interface Tracked {
  id: string;
  finding: VerificationFinding;
  /** Advisor, scope and folded note: repeats of one key merge instead of adding findings. */
  key: string;
  /** Original receipt index, retained to replay v1 transitions under their original rules. */
  receivedIndex: number;
  /** Only an explicit reopening establishes a freshness boundary. Receipt is not observation. */
  evidenceAfter: number;
}

interface Ledger {
  tracked: Tracked[];
  /** Finding ids, and the ids of repeats merged into them, to their finding. */
  byId: Map<string, Tracked>;
  /** Branch index of every entry walked so far. */
  indexOf: Map<string, number>;
}

/**
 * Text of a message the user actually typed: not synthetic or agent-attributed, not a hidden
 * system notice. Nothing else in the transcript speaks for the user. A leading "/" is no
 * exclusion: commands never become messages, and what OMP passes on as text is a real request.
 */
function actualUserText(entry: SessionEntry): string | undefined {
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role !== "user" || message.synthetic || message.attribution === "agent") {
    return undefined;
  }
  const text = visibleText(message.content);
  return text && !text.startsWith("<system-") ? text : undefined;
}

/**
 * The entries OMP still builds the model's context from: those after the latest `/clear`
 * boundary (`reset_boundary`), which also elides everything before an earlier compaction
 * (session-context.ts). What the model can no longer see is neither a finding to answer for
 * nor evidence to cite, and the persisted history stays untouched.
 */
function activeBranch(branch: readonly SessionEntry[]): readonly SessionEntry[] {
  const boundary = branch.findLastIndex((entry) => entry.type === "reset_boundary");
  return boundary < 0 ? branch : branch.slice(boundary + 1);
}

/** Shown for output the host pruned from a result a recorded resolution cited. */
const PRUNED_EXCERPT = "(output later pruned from context)";

/**
 * The entry as citable evidence, or why it cannot be cited. A tool result the host pruned or its
 * tool flagged uneventful holds nothing to check a claim against, so it is refused; `replay`
 * keeps a record written earlier valid and shows pruned output as `PRUNED_EXCERPT`, not as the
 * host's placeholder.
 */
function classifyEvidence(entry: SessionEntry, replay = false): FindingEvidence | string {
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role === "toolResult") {
    if (message.isError) return "is a failed tool result";
    // A review verdict or a ledger listing reports on findings, not on the work itself.
    if (message.toolName === REVIEW_TOOL || message.toolName === FINDINGS_TOOL) {
      return `is ${message.toolName} output, not evidence about the work`;
    }
    const pruned = message.prunedAt !== undefined;
    if (!replay) {
      if (pruned) return "is a tool result whose output was pruned from context";
      if (message.useless) return "is a tool result its tool flagged as uneventful";
    }
    return {
      entryId: entry.id,
      kind: "tool_result",
      toolName: collapse(message.toolName, FINDING_LIMITS.token),
      at: entry.timestamp,
      excerpt: pruned
        ? PRUNED_EXCERPT
        : collapse(visibleText(message.content), FINDING_LIMITS.excerpt) || "(no text output)",
    };
  }
  const text = actualUserText(entry);
  if (text === undefined) return "is neither a successful tool result nor a message the user typed";
  return {
    entryId: entry.id,
    kind: "user_message",
    at: entry.timestamp,
    excerpt: collapse(text, FINDING_LIMITS.excerpt),
  };
}

/** A persisted note the ledger tracks: the owned auditor's concern or blocker, under its contract. */
function trackedNote(
  raw: unknown,
): { note: string; severity: AuditorSeverity; advisor: string } | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const { note, severity, advisor } = raw as Record<string, unknown>;
  if (typeof note !== "string" || typeof advisor !== "string") return undefined;
  if (!isOwnedAuditor(advisor) || !collapse(note, FINDING_LIMITS.note)) return undefined;
  const admitted = admittedSeverity(note, severity);
  return admitted && { note, severity: admitted, advisor };
}

/**
 * Advisor, scope and note folded as OMP's advisor emission guard folds notes (case, punctuation
 * and whitespace), so a watchdog re-raising the same note in the same scope lands on one key.
 */
function semanticKey(advisor: string, scopeEntryId: string | undefined, note: string): string {
  const folded = note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return JSON.stringify([slugifyAdvisorName(advisor), scopeEntryId ?? null, folded]);
}

function parseRecord(data: unknown): TransitionRecord | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const record = data as Partial<Record<keyof TransitionRecord, unknown>>;
  const valid =
    (record.v === 1 || record.v === 2) &&
    typeof record.findingId === "string" &&
    typeof record.action === "string" &&
    Object.hasOwn(TRANSITIONS, record.action) &&
    (record.author === "orchestrator" || record.author === "user") &&
    typeof record.reason === "string" &&
    Array.isArray(record.evidence) &&
    record.evidence.length <= FINDING_LIMITS.evidence &&
    record.evidence.every((id) => typeof id === "string") &&
    typeof record.toolCallId === "string";
  return valid ? (record as TransitionRecord) : undefined;
}

/**
 * Validate cited entry ids against the branch walked so far. Each must follow the finding's
 * latest opening and be a successful tool result or a message the user typed; a waiver may cite
 * only the latter, and a resolution must cite at least one. Returns the rejection otherwise.
 * `replay` re-validates a record written earlier: output the host has pruned since still counts.
 */
function citeEvidence(
  ledger: Ledger,
  branch: readonly SessionEntry[],
  ids: readonly string[],
  evidenceAfter: number,
  action: TransitionAction,
  replay = false,
): FindingEvidence[] | string {
  if (action === "resolve" && ids.length === 0) {
    return "A resolution must cite at least one evidence entry id; `list` shows citable entries.";
  }
  const evidence: FindingEvidence[] = [];
  for (const id of new Set(ids)) {
    const index = ledger.indexOf.get(id);
    const entry = index === undefined ? undefined : branch[index];
    if (index === undefined || !entry) return `Evidence ${id} is not an entry on the active branch.`;
    if (index <= evidenceAfter) {
      return `Evidence ${id} predates the latest explicit reopening; cite an entry recorded after it.`;
    }
    const cited = classifyEvidence(entry, replay);
    if (typeof cited === "string") return `Evidence ${id} ${cited}.`;
    if (action === "waive" && cited.kind !== "user_message") {
      return `Evidence ${id} is not a message the user typed; a waiver may cite only those.`;
    }
    evidence.push(cited);
  }
  return evidence;
}

function applyRecord(
  ledger: Ledger,
  branch: readonly SessionEntry[],
  entry: CustomEntry,
  index: number,
): void {
  const record = parseRecord(entry.data);
  const tracked = record && ledger.byId.get(record.findingId);
  if (!record || !tracked) return;
  const { from, to } = TRANSITIONS[record.action];
  // Only the confirmation dialog writes `user`, and only a waiver may carry it.
  const authorized = (record.action === "waive") === (record.author === "user");
  if (!authorized || !from.includes(tracked.finding.status ?? "open")) return;
  const boundary = record.v === 1
    ? Math.max(tracked.receivedIndex, tracked.evidenceAfter)
    : tracked.evidenceAfter;
  const evidence = citeEvidence(ledger, branch, record.evidence, boundary, record.action, true);
  if (typeof evidence === "string") return;
  tracked.finding.status = to;
  tracked.finding.transition = {
    status: to,
    recordId: entry.id,
    at: entry.timestamp,
    author: record.author,
    reason: collapse(record.reason, FINDING_LIMITS.reason),
    evidence,
  };
  if (to === "reopened") tracked.evidenceAfter = index;
}

function buildLedger(branch: readonly SessionEntry[]): Ledger {
  const ledger: Ledger = { tracked: [], byId: new Map(), indexOf: new Map() };
  let scope: { id: string; text: string } | undefined;
  branch.forEach((entry, index) => {
    ledger.indexOf.set(entry.id, index);
    const userText = actualUserText(entry);
    if (userText !== undefined) {
      scope = { id: entry.id, text: userText };
    } else if (entry.type === "custom" && entry.customType === FINDING_ENTRY_TYPE) {
      applyRecord(ledger, branch, entry, index);
    } else if (entry.type === "custom_message" && entry.customType === "advisor") {
      // Persisted session entries are not provider-facing CustomMessages.
      const notes = (entry.details as { notes?: unknown } | undefined)?.notes;
      if (!Array.isArray(notes)) return;
      notes.forEach((raw, noteIndex) => {
        const note = trackedNote(raw);
        if (!note) return;
        // The index counts every note in the message, so the id is stable whatever is admitted.
        const id = `${entry.id}:${noteIndex}`;
        const key = semanticKey(note.advisor, scope?.id, note.note);
        const same = ledger.tracked.filter((tracked) => tracked.key === key);
        // A repeat is the same assertion again while the finding is unresolved, or while the user
        // has waived it at no lower severity. After a reported resolution it is a fresh dispute.
        const standing =
          same.findLast((tracked) => isUnresolved(tracked.finding.status)) ??
          same.findLast(
            (tracked) =>
              tracked.finding.status === "waived" &&
              (note.severity === "concern" || tracked.finding.severity === "blocker"),
          );
        if (standing) {
          const { finding } = standing;
          finding.repeatCount = (finding.repeatCount ?? 0) + 1;
          finding.repeatIds = [...(finding.repeatIds ?? []), id].slice(-FINDING_LIMITS.repeatIds);
          finding.lastRaisedAt = entry.timestamp;
          if (note.severity === "blocker") finding.severity = "blocker";
          ledger.byId.set(id, standing);
          return;
        }
        const tracked: Tracked = {
          id,
          key,
          receivedIndex: index,
          evidenceAfter: -1,
          finding: {
            id,
            note: collapse(note.note, FINDING_LIMITS.note),
            severity: note.severity,
            advisor: collapse(note.advisor, FINDING_LIMITS.token),
            sourceEntryId: entry.id,
            occurredAt: entry.timestamp,
            ...(scope
              ? {
                  scopeUserEntryId: scope.id,
                  scopeUserText: collapse(scope.text, FINDING_LIMITS.scopeText),
                }
              : {}),
            status: "open",
          },
        };
        ledger.tracked.push(tracked);
        ledger.byId.set(id, tracked);
      });
    }
  });
  return ledger;
}

/**
 * Every finding the ledger tracks on the branch — the owned auditor's concern and blocker notes
 * — oldest first, in whatever lifecycle state, with provenance. Repeats merge into one finding.
 */
export function collectFindings(branch: readonly SessionEntry[]): VerificationFinding[] {
  return buildLedger(activeBranch(branch)).tracked.map(({ finding }) => finding);
}

function findTracked(ledger: Ledger, findingId: string): Tracked {
  const tracked = ledger.byId.get(findingId);
  if (tracked) return tracked;
  // Name the real ids so a guessed id (a label, "all") is corrected in one step, unresolved first.
  const ordered = [
    ...ledger.tracked.filter((candidate) => isUnresolved(candidate.finding.status)),
    ...ledger.tracked.filter((candidate) => !isUnresolved(candidate.finding.status)),
  ];
  const named = ordered
    .slice(0, LISTED_IDS)
    .map((candidate) => `${candidate.id} ${candidate.finding.severity} ${candidate.finding.status}`);
  const more = ordered.length > named.length ? `, and ${ordered.length - named.length} more` : "";
  const known =
    named.length === 0
      ? "The ledger has no findings on this branch."
      : `Current finding ids: ${named.join(", ")}${more}. Omit findingId to list the whole ledger.`;
  throw new Error(`No ${AUDITOR_NAME} finding ${findingId} on the active branch. ${known}`);
}

/** A finding as `list` shows it: the reviewer's rendering plus the ids of merged repeats. */
function describe(finding: VerificationFinding): string {
  const repeats = finding.repeatIds ?? [];
  if (repeats.length === 0) return formatFinding(finding);
  const shown = (finding.repeatCount ?? 0) > repeats.length ? `, latest ${repeats.length} shown` : "";
  return `${formatFinding(finding)}\n  Repeats merged into it: ${repeats.join(", ")}${shown}`;
}

function listLedger(branch: readonly SessionEntry[], findingId: string | undefined) {
  const ledger = buildLedger(branch);
  const sections: string[] = [];
  let details: Record<string, unknown>;
  // Initial notices have no observation boundary; reopened findings require newer evidence.
  let citableAfter: number | undefined;
  if (findingId !== undefined) {
    const tracked = findTracked(ledger, findingId);
    sections.push(describe(tracked.finding));
    citableAfter = tracked.evidenceAfter;
    details = { action: "list", findingId: tracked.id, status: tracked.finding.status };
  } else {
    const unresolved = ledger.tracked.filter((tracked) => isUnresolved(tracked.finding.status));
    const transitioned = ledger.tracked
      .filter((tracked) => !isUnresolved(tracked.finding.status))
      .toSorted(
        (left, right) =>
          (ledger.indexOf.get(right.finding.transition?.recordId ?? "") ?? 0) -
          (ledger.indexOf.get(left.finding.transition?.recordId ?? "") ?? 0),
      );
    const counts = { unresolved: unresolved.length, resolved: 0, waived: 0 };
    for (const { finding } of transitioned) counts[finding.status === "waived" ? "waived" : "resolved"]++;
    const blockers = unresolved.filter((tracked) => tracked.finding.severity === "blocker").length;
    sections.push(
      `${AUDITOR_NAME} ledger on the active branch: ${counts.unresolved} unresolved (${blockers} blocker, ${counts.unresolved - blockers} concern), ${counts.resolved} resolved, ${counts.waived} waived.`,
    );
    const groups = [
      { title: "Unresolved, oldest first", members: unresolved, limit: LISTED_UNRESOLVED },
      {
        title: "Resolved or waived, newest transition first",
        members: transitioned,
        limit: LISTED_TRANSITIONED,
      },
    ];
    for (const { title, members, limit } of groups) {
      if (members.length === 0) continue;
      sections.push(
        `${title}:\n${members
          .slice(0, limit)
          .map(({ finding }) => describe(finding))
          .join("\n")}`,
      );
      const rest = members.slice(limit);
      if (rest.length === 0) continue;
      const named = rest
        .slice(0, LISTED_IDS)
        .map((tracked) => `${tracked.id} ${tracked.finding.severity} ${tracked.finding.status}`);
      const unnamed = rest.length > named.length ? `, and ${rest.length - named.length} more` : "";
      sections.push(`${rest.length} more: ${named.join(", ")}${unnamed}; add findingId to see one.`);
    }
    if (unresolved.length > 0) {
      citableAfter = Math.min(...unresolved.map((tracked) => tracked.evidenceAfter));
    }
    details = { action: "list", ...counts };
  }
  if (citableAfter !== undefined) {
    const lines: string[] = [];
    for (
      let index = branch.length - 1;
      index > citableAfter && lines.length < LISTED_CANDIDATES;
      index--
    ) {
      const entry = branch[index];
      const cited = entry && classifyEvidence(entry);
      if (!cited || typeof cited === "string") continue;
      const source = cited.kind === "tool_result" ? `tool result (${cited.toolName})` : "user message";
      lines.push(`- ${cited.entryId} ${source} at ${cited.at}: "${cited.excerpt}"`);
    }
    const scope = citableAfter < 0 ? "on this branch" : "after the relevant explicit reopening";
    sections.push(
      lines.length > 0
        ? `Citable evidence ${scope}, newest first (pass entry ids as \`evidence\`):\n${lines.join("\n")}`
        : `No citable evidence ${scope}.`,
      "Notice receipt is not the auditor's observation time. Earlier results may answer a delayed note; explain their relevance instead of rerunning solely for chronology. For reopened findings, focus by findingId to see their individual evidence boundary.",
    );
  }
  return { content: [{ type: "text" as const, text: sections.join("\n\n") }], details };
}

/** Validate a transition against the branch as it is now, or throw the reason it cannot apply. */
function planTransition(
  branch: readonly SessionEntry[],
  action: TransitionAction,
  findingId: string,
  evidenceIds: readonly string[],
): { tracked: Tracked; evidence: FindingEvidence[] } {
  const ledger = buildLedger(branch);
  const tracked = findTracked(ledger, findingId);
  const status = tracked.finding.status ?? "open";
  const { from } = TRANSITIONS[action];
  if (!from.includes(status)) {
    throw new Error(
      `Finding ${tracked.id} is ${status}; ${action} applies only to ${from.join(" or ")} findings.`,
    );
  }
  const evidence = citeEvidence(ledger, branch, evidenceIds, tracked.evidenceAfter, action);
  if (typeof evidence === "string") throw new Error(evidence);
  return { tracked, evidence };
}

/** Register the primary-only `review_findings` tool over the branch ledger. */
export function registerFindingTools(pi: ExtensionAPI): void {
  const z = pi.zod;
  const entryId = z.string().min(1).max(FINDING_LIMITS.token);

  // Awaited so a later session_start handler filtering the tool list sees this removal.
  pi.on("session_start", async (_event, ctx) => {
    if (!mainSessionOf(ctx)) {
      await pi.setActiveTools(pi.getActiveTools().filter((name) => name !== FINDINGS_TOOL));
    }
  });

  pi.registerTool({
    name: FINDINGS_TOOL,
    label: "Review findings",
    description: `Manage ${AUDITOR_NAME} findings, which stay attached to ${REVIEW_TOOL} reviews until their status changes. DEFAULT only. "list" shows the ledger on this branch (IDs, status, provenance) and citable evidence entry ids; add findingId to focus one finding. "resolve" records your report that a finding is addressed: findingId, reason explaining relevance, and evidence = entry ids of successful tool results or actual user messages on this branch. Evidence may precede a delayed notice; its receipt time is not its observation time. Do not rerun solely to obtain a later timestamp. The auditor's note stays; reviewers weigh your report and its evidence, not as proof. "reopen" makes a resolved or waived finding unresolved again and requires evidence after that explicit reopening for another resolution. "waive" asks the user to accept a finding unresolved; only their explicit confirmation waives it. A review never resolves a finding.`,
    loadMode: "essential",
    approval: (args) =>
      (args as { action?: unknown } | undefined)?.action === "list" ? "read" : "write",
    parameters: z
      .object({
        action: z.enum(["list", "resolve", "waive", "reopen"]),
        findingId: entryId.optional(),
        reason: z.string().min(1).max(FINDING_LIMITS.reason).optional(),
        evidence: z.array(entryId).max(FINDING_LIMITS.evidence).optional(),
      })
      .strict(),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const primary = mainSessionOf(ctx);
      if (!primary) {
        throw new Error(`${FINDINGS_TOOL} is available only to the primary orchestrator, not workers.`);
      }
      const { sessionManager } = primary;
      const { action, findingId } = params;
      if (action === "list") return listLedger(activeBranch(sessionManager.getBranch()), findingId);

      const reason = collapse(params.reason ?? "", FINDING_LIMITS.reason);
      if (!findingId || !reason) throw new Error(`${action} requires findingId and a reason.`);
      const evidenceIds = params.evidence ?? [];
      let planned = planTransition(activeBranch(sessionManager.getBranch()), action, findingId, evidenceIds);
      let author: TransitionRecord["author"] = "orchestrator";
      if (action === "waive") {
        if (!ctx.hasUI) {
          throw new Error(
            "Waiving needs the user's explicit confirmation in an interactive UI, and none is available. Resolve the finding with evidence or leave it open.",
          );
        }
        const { finding } = planned.tracked;
        const confirmed = await ctx.ui.confirm(
          `Waive ${AUDITOR_NAME} finding?`,
          [
            "The orchestrator asks you to accept this finding without it being resolved.",
            "",
            `${planned.tracked.id} [${finding.severity}, ${finding.status}]`,
            `Auditor note: ${finding.note}`,
            ...(finding.scopeUserText ? [`Your message at the time: "${finding.scopeUserText}"`] : []),
            `Orchestrator's reason: ${reason}`,
            ...planned.evidence.map((cited) => `Cited message ${cited.entryId}: "${cited.excerpt}"`),
            "",
            "Confirm only if you accept it. It stays in the ledger as waived, and checkpoint reviews see your waiver.",
          ].join("\n"),
          signal ? { signal } : undefined,
        );
        if (!confirmed) {
          throw new Error(
            `The user did not confirm the waiver; ${planned.tracked.id} stays ${finding.status}.`,
          );
        }
        author = "user";
        // The ledger may have moved while the dialog was open; record only what still holds.
        planned = planTransition(activeBranch(sessionManager.getBranch()), action, findingId, evidenceIds);
      }

      const { tracked, evidence } = planned;
      const record: TransitionRecord = {
        v: 2,
        findingId: tracked.id,
        action,
        author,
        reason,
        evidence: evidence.map((cited) => cited.entryId),
        toolCallId,
      };
      const recordId = sessionManager.appendCustomEntry(FINDING_ENTRY_TYPE, record);
      const status = TRANSITIONS[action].to;
      const text =
        action === "resolve"
          ? `Recorded your resolution report for ${tracked.id} (record ${recordId}) citing ${record.evidence.join(", ")}. The auditor's note stays in the ledger; reviews weigh this report and its evidence, not as proof.`
          : action === "reopen"
            ? `Reopened ${tracked.id} (record ${recordId}); it is unresolved again, and a resolution must cite evidence recorded after this.`
            : `The user confirmed waiving ${tracked.id} (record ${recordId}); it stays in the ledger as waived.`;
      return {
        content: [{ type: "text", text }],
        details: { action, findingId: tracked.id, status, recordId, evidence: record.evidence },
      };
    },
  });
}
