#!/usr/bin/env bun
/**
 * Ship a pre-generated `agents/task-deep.md` so a read-only install still has a
 * usable alias before the extension's first `session_start`.
 *
 * At runtime the plugin regenerates this file from the *host* OMP's bundled
 * `task` agent, so a newer OMP self-heals the drift; this build step only
 * guarantees the file exists in the published package.
 */
import { DEFAULT_CONFIG } from "../src/config.ts";
import { materializeTierAgents, requiredTierAgents } from "../src/deep-agent.ts";

const packageRoot = new URL("..", import.meta.url).pathname;
const specs = requiredTierAgents(DEFAULT_CONFIG.normalTaskRole, DEFAULT_CONFIG.deepTaskRole);
const result = await materializeTierAgents(packageRoot, specs);

if (result.failed.length > 0) {
	console.error(`failed to generate: ${result.failed.join(", ")}`);
	process.exit(1);
}
console.log(
	result.written.length > 0 ? `generated: ${result.written.join(", ")}` : `up to date: ${result.available.join(", ")}`,
);
