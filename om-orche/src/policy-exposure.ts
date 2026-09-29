import { createHash, type Hash } from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isPolicySection, policyModeOf } from "./orchestration-policy.ts";

/** Durable state, never a context/custom_message entry. */
export const POLICY_EXPOSURE_ENTRY_TYPE = "om-orche-policy-exposure";
export const POLICY_REVISION = "judgment-production-2026-09-30-r2";
export type PolicyGovernance = "governed" | "plan-mode" | "task-tool-unavailable";

export interface PolicyExposure {
	schema: 1;
	policy: typeof POLICY_REVISION;
	/** Observed here, not proof of provider delivery or of later extension output. */
	phase: "orchestration-context-view";
	governance: PolicyGovernance;
	/** SHA-256 over ordered, UTF-8 byte-length-prefixed sections; null means absent. */
	sections: { system: string | null; orchestrate: string | null; workflow: string | null };
}

function sectionDigest(sections: Iterable<string>): string | null {
	let hash: Hash | undefined;
	for (const section of sections) {
		hash ??= createHash("sha256");
		hash.update(`${Buffer.byteLength(section, "utf8")}:`).update(section);
	}
	return hash?.digest("hex") ?? null;
}

function* keywordSections(messages: readonly AgentMessage[], mode: "orchestrate" | "workflow"): Iterable<string> {
	for (const message of messages) {
		if (policyModeOf(message) !== mode || message.role !== "custom") continue;
		if (typeof message.content === "string") yield message.content;
		else for (const block of message.content) if (block.type === "text") yield block.text;
	}
}

/** Called only for enabled main sessions. Read-only observation apart from a non-message entry.
 * Branch history is authoritative: resuming/forking retains a matching baseline; branching before
 * it, clearing context, or changing observed sections/gates needs a new baseline. No prompt,
 * transcript, tool names, paths, model stage or credentials are stored. Host owns entry ID/time.
 * Failure is deliberately isolated from the user turn; no error text (possibly private) is logged.
 */
export function observePolicyExposure(
	ctx: ExtensionContext,
	session: AgentSession,
	governance: PolicyGovernance,
	messages: readonly AgentMessage[],
): void {
	try {
		const observation: PolicyExposure = {
			schema: 1,
			policy: POLICY_REVISION,
			phase: "orchestration-context-view",
			governance,
			sections: {
				system: sectionDigest(ctx.getSystemPrompt().filter(isPolicySection)),
				orchestrate: sectionDigest(keywordSections(messages, "orchestrate")),
				workflow: sectionDigest(keywordSections(messages, "workflow")),
			},
		};
		const branch = session.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type === "reset_boundary") break;
			if (entry.type !== "custom" || entry.customType !== POLICY_EXPOSURE_ENTRY_TYPE) continue;
			if (JSON.stringify(entry.data) === JSON.stringify(observation)) return;
			break;
		}
		session.sessionManager.appendCustomEntry(POLICY_EXPOSURE_ENTRY_TYPE, observation);
	} catch {
		// Metadata is best-effort; failures must not change context or prevent a request.
	}
}
