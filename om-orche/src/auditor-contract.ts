/** Evidence admission contract shared by the plugin runner and persisted finding ledger. */
import { slugifyAdvisorName } from "@oh-my-pi/pi-coding-agent/advisor/config";
import { AUDITOR_SLUG } from "./advisor-review.ts";

/** Double quotes, straight or curly: paired left to right, so a claim's closing quote never opens the next. */
const DOUBLE_QUOTED = /["“”]([^"“”\n]*)["“”]/g;
/** A quoted claim in other quote styles: curly single quotes or CJK corner brackets. */
const OTHER_QUOTED = /‘[^’\n]{6,}’|「[^」\n]{3,}」|『[^』\n]{3,}』/;

function hasQuotation(note: string): boolean {
	for (const [, inner] of note.matchAll(DOUBLE_QUOTED)) {
		if (inner!.length >= 6) return true;
	}
	return OTHER_QUOTED.test(note);
}

/** Checked output or location: a backticked span or a `path.ext:line` reference. */
const CITATION = /`[^`\n]+`|\b[\w./-]+\.[A-Za-z]\w*:\d+/;

export type AuditorSeverity = "concern" | "blocker";

/**
 * The severity an owned-auditor note keeps under the contract, or `undefined` when it is
 * withheld. Callers apply it only to notes from the bundled auditor's roster name.
 */
export function admittedSeverity(note: string, severity: unknown): AuditorSeverity | undefined {
	if (severity !== "concern" && severity !== "blocker") return undefined;
	const quoted = hasQuotation(note);
	if (!quoted && !CITATION.test(note)) return undefined;
	return severity === "blocker" && !quoted ? "concern" : severity;
}

export function isOwnedAuditor(advisor: unknown): boolean {
	return typeof advisor === "string" && slugifyAdvisorName(advisor) === AUDITOR_SLUG;
}

