/**
 * Mechanical enforcement of the Verification Auditor's note contract.
 *
 * The auditor's instructions alone did not hold: a small watchdog model kept emitting `nit`
 * progress commentary and "stop and answer now" blockers. OMP gives plugins no hook on the
 * advisor's `advise` call, so enforcement happens where this plugin does own the data — the
 * primary's provider context and the findings ledger. The rules only use what the contract
 * already demands and a string can show:
 *
 * - no `nit`: the auditor may only raise `concern` or `blocker`;
 * - every note cites what it checked: a quotation, a backticked output/identifier, or `file:line`;
 * - a `blocker` quotes the completion claim it contradicts; without a quotation it is a `concern`.
 *
 * Other advisors' notes are never touched, and the persisted transcript is never rewritten: the
 * TUI still shows every card as OMP delivered it.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AdvisorNote, formatAdvisorBatchContent } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { slugifyAdvisorName } from "@oh-my-pi/pi-coding-agent/advisor/config";
import { AUDITOR_SLUG } from "./advisor-review.ts";
import { AUDITOR_NAME } from "./verification-auditor.ts";

/** A quoted claim: straight or curly double quotes, curly single quotes, or CJK corner brackets. */
const QUOTATION = /["“”][^"“”\n]{6,}["“”]|‘[^’\n]{6,}’|「[^」\n]{3,}」|『[^』\n]{3,}』/;
/** Checked output or location: a backticked span or a `path.ext:line` reference. */
const CITATION = /`[^`\n]+`|\b[\w./-]+\.[A-Za-z]\w*:\d+/;

export type AuditorSeverity = "concern" | "blocker";

/**
 * The severity an owned-auditor note keeps under the contract, or `undefined` when it is
 * withheld. Callers apply it only to notes from the bundled auditor's roster name.
 */
export function admittedSeverity(note: string, severity: unknown): AuditorSeverity | undefined {
	if (severity !== "concern" && severity !== "blocker") return undefined;
	const quoted = QUOTATION.test(note);
	if (!quoted && !CITATION.test(note)) return undefined;
	return severity === "blocker" && !quoted ? "concern" : severity;
}

export function isOwnedAuditor(advisor: unknown): boolean {
	return typeof advisor === "string" && slugifyAdvisorName(advisor) === AUDITOR_SLUG;
}

/** Shown only when withholding would otherwise end the provider context on an assistant message. */
export const WITHHELD_TAIL =
	`<system-notice>om-orche withheld ${AUDITOR_NAME} notes that broke its note contract (nit, uncited, or a blocker without a quoted claim). No action is needed for them.</system-notice>`;

function isNote(value: unknown): value is AdvisorNote {
	return value !== null && typeof value === "object" && "note" in value && typeof value.note === "string";
}

function advisorNotes(message: AgentMessage): AdvisorNote[] | undefined {
	if (message.role !== "custom" || message.customType !== "advisor") return undefined;
	const details: unknown = message.details;
	if (details === null || typeof details !== "object" || !("notes" in details)) return undefined;
	const notes = details.notes;
	return Array.isArray(notes) && notes.every(isNote) ? notes : undefined;
}

/**
 * Apply the contract to every advisor card in the primary's provider context. Returns a new
 * array when anything changed, otherwise `undefined`. Cards are copied, never mutated.
 */
export function enforceAuditorContract(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
	let changed = false;
	const next: AgentMessage[] = [];
	for (const message of messages) {
		const notes = advisorNotes(message);
		if (!notes || message.role !== "custom" || !notes.some(note => isOwnedAuditor(note.advisor))) {
			next.push(message);
			continue;
		}
		const kept: AdvisorNote[] = [];
		for (const note of notes) {
			if (!isOwnedAuditor(note.advisor)) {
				kept.push(note);
				continue;
			}
			const severity = admittedSeverity(note.note, note.severity);
			if (severity) kept.push(severity === note.severity ? note : { ...note, severity });
		}
		if (kept.length === notes.length && kept.every((note, index) => note === notes[index])) {
			next.push(message);
			continue;
		}
		changed = true;
		if (kept.length > 0) {
			next.push({ ...message, content: formatAdvisorBatchContent(kept), details: { notes: kept } });
		} else if (message === messages.at(-1) && next.at(-1)?.role === "assistant") {
			// A card that woke an idle primary is the whole new turn: keep the request well formed.
			next.push({ ...message, content: WITHHELD_TAIL, details: { notes: [] } });
		}
	}
	return changed ? next : undefined;
}
