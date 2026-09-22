import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBundledAgent, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { normalizeConfig } from "../src/config.ts";
import {
	agentsDir,
	DEEP_AGENT_NAME,
	materializeTierAgents,
	NORMAL_AGENT_NAME,
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
	test("the alias is the bundled task agent with only the model role changed", () => {
		const base = getBundledAgent("task");
		expect(base).toBeDefined();
		const config = normalizeConfig(undefined);
		const rendered = renderTierAgent(base!, requiredTierAgents(config.normalTaskRole, config.deepTaskRole)[0]!);

		// Round-trip through OMP's own frontmatter parser, not a local regex.
		const parsed = parseAgent(`${DEEP_AGENT_NAME}.md`, rendered, "user");
		expect(parsed.name).toBe(DEEP_AGENT_NAME);
		expect(parsed.model).toEqual(["@task_hard"]);
		expect(parsed.systemPrompt.trim()).toBe(base!.systemPrompt.trim());
		expect(parsed.spawns).toEqual(base!.spawns);
		expect(parsed.thinkingLevel).toBe(base!.thinkingLevel);
		expect(parsed.tools).toEqual(base!.tools);
	});

	test("the derived model role follows configuration", () => {
		const base = getBundledAgent("task")!;
		const rendered = renderTierAgent(base, { name: "task-deep", role: "review", description: "d" });
		expect(parseAgent("task-deep.md", rendered, "user").model).toEqual(["@review"]);
	});

	test("only the deep alias is required while the normal tier keeps OMP's own agent", () => {
		expect(requiredTierAgents("task", "slow").map(spec => spec.name)).toEqual([DEEP_AGENT_NAME]);
		expect(requiredTierAgents("fast_worker", "slow").map(spec => spec.name)).toEqual([
			DEEP_AGENT_NAME,
			NORMAL_AGENT_NAME,
		]);
	});


	test("per-agent prewalk and advisor configured for `task` carry to the alias", () => {
		const settings = {
			get: (key: string) =>
				key === "task.agentAdvisor"
					? { task: "deepseek/deepseek-v4-flash" }
					: key === "task.agentPrewalk"
						? { task: "on" }
						: undefined,
		};
		const inherited = readInheritedAgentBehavior(settings);
		expect(inherited).toEqual({ prewalk: true, advisor: "deepseek/deepseek-v4-flash" });

		const rendered = renderTierAgent(getBundledAgent("task")!, {
			name: DEEP_AGENT_NAME,
			role: "slow",
			description: "d",
			...inherited,
		});
		const parsed = parseAgent("task-deep.md", rendered, "user");
		expect(parsed.prewalk).toBe(true);
		expect(parsed.advisor).toBe("deepseek/deepseek-v4-flash");
	});

	test("the plugin never introduces an advisor or prewalk of its own", () => {
		const none = readInheritedAgentBehavior({ get: () => undefined });
		expect(none).toEqual({});
		const off = readInheritedAgentBehavior({
			get: (key: string) => (key === "task.agentAdvisor" ? { task: "off" } : undefined),
		});
		expect(off).toEqual({});

		const rendered = renderTierAgent(getBundledAgent("task")!, { name: DEEP_AGENT_NAME, role: "slow", description: "d" });
		expect(rendered).not.toContain("advisor:");
		expect(rendered).not.toContain("prewalk:");
	});

	test("the global `task.prewalk` switch also carries", () => {
		const inherited = readInheritedAgentBehavior({ get: (key: string) => key === "task.prewalk" || undefined });
		expect(inherited).toEqual({ prewalk: true });
	});
});

describe("materialization", () => {
	test("writes the alias into the package agents dir and is idempotent", async () => {
		const root = await tempRoot();
		const specs = requiredTierAgents("task", "slow");

		const first = await materializeTierAgents(root, specs);
		expect(first.written).toEqual([DEEP_AGENT_NAME]);
		expect(first.available).toEqual([DEEP_AGENT_NAME]);
		expect(await Bun.file(path.join(agentsDir(root), `${DEEP_AGENT_NAME}.md`)).exists()).toBe(true);

		const second = await materializeTierAgents(root, specs);
		expect(second.written).toEqual([]);
		expect(second.available).toEqual([DEEP_AGENT_NAME]);
	});

	test("a role change rewrites the alias", async () => {
		const root = await tempRoot();
		await materializeTierAgents(root, requiredTierAgents("task", "slow"));
		const rewritten = await materializeTierAgents(root, requiredTierAgents("task", "task_hard"));

		expect(rewritten.written).toEqual([DEEP_AGENT_NAME]);
		const content = await Bun.file(path.join(agentsDir(root), `${DEEP_AGENT_NAME}.md`)).text();
		expect(parseAgent("task-deep.md", content, "user").model).toEqual(["@task_hard"]);
	});

	test("every artifact lives inside the package, so uninstall removes it", async () => {
		const root = await tempRoot();
		await materializeTierAgents(root, requiredTierAgents("normal_worker", "slow"));
		expect(agentsDir(root).startsWith(root)).toBe(true);
		const entries = [...new Bun.Glob("**/*").scanSync(root)];
		expect(entries.sort()).toEqual([
			path.join("agents", `${DEEP_AGENT_NAME}.md`),
			path.join("agents", `${NORMAL_AGENT_NAME}.md`),
		]);
	});
});
