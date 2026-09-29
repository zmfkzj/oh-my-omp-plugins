import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/advisor-cli.ts";

const PLAN = path.join(import.meta.dir, "../examples/initial-plan.json");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-orche-cli-"));
  roots.push(root);
  return root;
}

/** Run the CLI with its standard streams captured. */
async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    return { code: await runCli(args), stderr };
  } finally {
    process.stderr.write = write;
  }
}

test("a directory given as input is reported as a directory, not a missing file", async () => {
  const { code, stderr } = await run(tempRoot(), "--check");
  expect(code).toBe(2);
  expect(stderr).toMatch(/is a directory/);
  expect(stderr).not.toMatch(/not found/);
});

test("an agent directory that does not exist is an error and is not created or populated", async () => {
  const missing = path.join(tempRoot(), "typo");
  const { code, stderr } = await run(PLAN, "--check", "--agent-dir", missing);
  expect(code).toBe(2);
  expect(stderr).toContain("Agent directory not found");
  expect(fs.existsSync(missing)).toBe(false);
});

test("a credential the model registry cannot resolve exits 2, as the help documents", async () => {
  const agentDir = tempRoot();
  fs.writeFileSync(path.join(agentDir, "config.yml"), "modelRoles:\n  orche-advisor: fakeprov/m1\n");
  fs.writeFileSync(
    path.join(agentDir, "models.yml"),
    [
      "providers:",
      "  fakeprov:",
      "    baseUrl: http://127.0.0.1:9/v1",
      '    apiKey: "!exit 1"',
      "    api: openai-completions",
      "    models:",
      "      - id: m1",
      "        name: M1",
      "",
    ].join("\n"),
  );
  const { code, stderr } = await run(PLAN, "--agent-dir", agentDir);
  expect(stderr).toMatch(/credential/i);
  expect(code).toBe(2);
});
