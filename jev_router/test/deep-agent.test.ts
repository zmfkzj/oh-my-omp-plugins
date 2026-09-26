import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledAgent, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { normalizeConfig } from "../src/config.ts";
import {
	agentsDir,
	CHALLENGE_AGENT_NAME,
	EASY_AGENT_NAME,
	HARD_AGENT_NAME,
	materializeTierAgents,
	readInheritedAgentBehavior,
	renderTierAgent,
	requiredTierAgents,
} from "../src/deep-agent.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "jev-router-"));
	roots.push(root);
	return root;
}
afterAll(async () => {
	await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

describe("tier alias derivation", () => {
	test("each alias preserves bundled worker behavior but selects its own role", () => {
		const base = getBundledAgent("task");
		expect(base).toBeDefined();
		const config = normalizeConfig(undefined);
		const specs = requiredTierAgents(config.easyTaskRole, config.hardTaskRole, config.challengeTaskRole);
		expect(specs.map(spec => spec.name)).toEqual([EASY_AGENT_NAME, HARD_AGENT_NAME, CHALLENGE_AGENT_NAME]);
		for (const spec of specs) {
			const parsed = parseAgent(`${spec.name}.md`, renderTierAgent(base!, spec), "user");
			expect(parsed.name).toBe(spec.name);
			expect(parsed.model).toEqual([`@${spec.role}`]);
			expect(parsed.systemPrompt.trim()).toBe(base!.systemPrompt.trim());
			expect(parsed.spawns).toEqual(base!.spawns);
			expect(parsed.thinkingLevel).toBe(base!.thinkingLevel);
			expect(parsed.tools).toEqual(base!.tools);
		}
	});

	test("configured roles do not collapse aliases even when equal", () => {
		const specs = requiredTierAgents("task", "task", "task");
		expect(specs.map(spec => spec.name)).toEqual([EASY_AGENT_NAME, HARD_AGENT_NAME, CHALLENGE_AGENT_NAME]);
		const rendered = renderTierAgent(getBundledAgent("task")!, { ...specs[0]!, role: "review" });
		expect(parseAgent("task-easy.md", rendered, "user").model).toEqual(["@review"]);
	});


	test("per-agent prewalk and advisor configured for `task` carry to the alias", () => {
		const settings = Settings.isolated({
			"task.agentAdvisor": { task: "deepseek/deepseek-v4-flash" },
			"task.agentPrewalk": { task: "on" },
		});
		const inherited = readInheritedAgentBehavior(settings);
		expect(inherited).toEqual({ prewalk: true, advisor: "deepseek/deepseek-v4-flash" });

		for (const spec of requiredTierAgents("fast", "slow", "deep", inherited)) {
			const rendered = renderTierAgent(getBundledAgent("task")!, spec);
			const parsed = parseAgent(`${spec.name}.md`, rendered, "user");
			expect(parsed.prewalk).toBe(true);
			expect(parsed.advisor).toBe("deepseek/deepseek-v4-flash");
		}
	});

	test("the plugin never introduces an advisor or prewalk of its own", () => {
		const none = readInheritedAgentBehavior(Settings.isolated());
		expect(none).toEqual({});
		const off = readInheritedAgentBehavior(Settings.isolated({ "task.agentAdvisor": { task: "off" } }));
		expect(off).toEqual({});

		const rendered = renderTierAgent(getBundledAgent("task")!, { name: CHALLENGE_AGENT_NAME, role: "slow", description: "d" });
		expect(rendered).not.toContain("advisor:");
		expect(rendered).not.toContain("prewalk:");
	});

	test("the global `task.prewalk` switch also carries", () => {
		const inherited = readInheritedAgentBehavior(Settings.isolated({ "task.prewalk": true }));
		expect(inherited).toEqual({ prewalk: true });
	});
});

describe("materialization", () => {
	test("writes all three aliases into the package agents dir and is idempotent", async () => {
		const root = await tempRoot();
		const specs = requiredTierAgents("task_easy", "task_hard", "task_challenge");
		const names = [EASY_AGENT_NAME, HARD_AGENT_NAME, CHALLENGE_AGENT_NAME];
		const first = await materializeTierAgents(root, specs);
		expect(first.written).toEqual(names);
		expect(first.available).toEqual(names);
		for (const name of names) {
			expect(await Bun.file(path.join(agentsDir(root), `${name}.md`)).exists()).toBe(true);
		}
		const second = await materializeTierAgents(root, specs);
		expect(second.written).toEqual([]);
		expect(second.available).toEqual(names);
	});

	test("a role change rewrites the alias", async () => {
		const root = await tempRoot();
		await materializeTierAgents(root, requiredTierAgents("task_easy", "task_hard", "slow"));
		const rewritten = await materializeTierAgents(root, requiredTierAgents("task_easy", "task_hard", "task_challenge"));
		expect(rewritten.written).toEqual([CHALLENGE_AGENT_NAME]);
		const content = await Bun.file(path.join(agentsDir(root), `${CHALLENGE_AGENT_NAME}.md`)).text();
		expect(parseAgent("task-challenge.md", content, "user").model).toEqual(["@task_challenge"]);
	});

	test("every artifact lives inside the package, so uninstall removes it", async () => {
		const root = await tempRoot();
		await materializeTierAgents(root, requiredTierAgents("easy", "hard", "challenge"));
		expect(agentsDir(root).startsWith(root)).toBe(true);
		const entries = [...new Bun.Glob("**/*").scanSync(root)];
		expect(entries.sort()).toEqual([
			path.join("agents", `${CHALLENGE_AGENT_NAME}.md`),
			path.join("agents", `${EASY_AGENT_NAME}.md`),
			path.join("agents", `${HARD_AGENT_NAME}.md`),
		]);
	});
});
