import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { buildRoutingContext, latestCommittedTodoPlan } from "../src/routing-context.ts";

function message(role: "user" | "assistant" | "toolResult" | "custom", content: unknown, extras: Record<string, unknown> = {}): SessionEntry {
	return { type: "message", id: crypto.randomUUID(), parentId: null, timestamp: "2026-01-01",
		message: { role, content, ...extras } as AgentMessage } as SessionEntry;
}
function todo(phases: unknown, op: string, isError = false): SessionEntry {
	return message("toolResult", [{ type: "text", text: "internal result blob" }],
		{ toolName: "todo", details: { phases, op }, isError });
}
function phases(...tasks: string[]) {
	return [{ name: "Delivery", tasks: tasks.map(content => ({ content, status: "pending" as const })) }];
}

describe("visible classifier context", () => {
	test("preserves original goal and assistant-visible dialogue beyond tiny recent follow-ups", () => {
		const goal = "Migrate the payments subsystem and independently rewrite the ledger analyzer with compatibility checks.";
		const branch: SessionEntry[] = [message("user", [{ type: "text", text: goal }])];
		for (let i = 0; i < 10; i++) {
			branch.push(message("assistant", [{ type: "text", text: `Assistant implementation progress ${i}` }]));
			branch.push(message("user", [{ type: "text", text: `Continue step ${i}.` }]));
		}
		const context = buildRoutingContext(branch, "Continue step 10.");
		expect(context.recentMessages[0]).toEqual({ role: "user", text: goal });
		expect(context.recentMessages).toContainEqual({ role: "assistant", text: "Assistant implementation progress 9" });
		expect(context.recentMessages.length).toBeLessThanOrEqual(9);
	});

	test("separates the current prompt and excludes thinking, tool blobs and hidden notices", () => {
		const branch = [
			message("user", [{ type: "text", text: "Implement the payroll exporter." }]),
			message("assistant", [
				{ type: "thinking", thinking: "private analysis must never leave history" },
				{ type: "toolCall", id: "x", name: "read", arguments: { path: "secret-tool-blob" } },
				{ type: "text", text: "I will implement the exporter." },
			]),
			message("toolResult", [{ type: "text", text: "internal blob" }], { toolName: "read" }),
			message("custom", "<system-notice>hidden guidance</system-notice>", { customType: "orchestrate-notice" }),
			message("user", [{ type: "text", text: "Continue." }]),
		];
		const context = buildRoutingContext(branch, "Continue.");
		expect(context.recentMessages).toEqual([
			{ role: "user", text: "Implement the payroll exporter." },
			{ role: "assistant", text: "I will implement the exporter." },
		]);
		expect(JSON.stringify(context)).not.toMatch(/private analysis|secret-tool-blob|internal blob|hidden guidance/);
	});

	test("long turns are bounded while older goals remain meaningful", () => {
		const branch = [message("user", "Launch " + "architecture context ".repeat(300))];
		for (let i = 0; i < 40; i++) branch.push(message("assistant", "assistant " + "visible detail ".repeat(300)));
		const context = buildRoutingContext(branch, "Continue.");
		expect(context.recentMessages[0]?.text.length).toBeLessThanOrEqual(1600);
		expect(context.recentMessages.at(-1)?.text.length).toBeLessThanOrEqual(700);
		expect(context.recentMessages.length).toBeLessThanOrEqual(9);
	});
});

describe("branch-committed todo snapshots", () => {
	test("latest successful snapshot wins over views, failures and invalid entries", () => {
		const original = phases("Migrate parser");
		const expanded = phases("Migrate parser", "Rewrite independent account reconciler");
		const branch = [todo(original, "init"), todo(expanded, "append"), todo([], "view"), todo([], "init", true),
			todo([{ name: "invalid", tasks: [{ content: 3 }] }], "append")];
		expect(latestCommittedTodoPlan(branch)).toEqual(expanded);
		expect(buildRoutingContext(branch, "Continue.").plan).toContain("Rewrite independent account reconciler");
		expect(buildRoutingContext(branch, "Continue.").plan).not.toContain("internal result blob");
	});

	test("user_todo_edit is an active branch snapshot; only phase and task text enters context", () => {
		const edited = [{ name: "Delivery", tasks: [{ content: "Implement clear user workflow", status: "pending",
			details: "private task notes", notes: ["secret"] }] }];
		const branch: SessionEntry[] = [todo(phases("Old plan"), "init"),
			{ type: "custom", customType: "user_todo_edit", data: { phases: edited },
				id: "edit", parentId: null, timestamp: "2026-01-01" } as SessionEntry];
		const context = buildRoutingContext(branch, "Continue.");
		expect(context.plan).toContain("Implement clear user workflow");
		expect(context.plan).not.toMatch(/Old plan|private task notes|secret/);
	});
});
