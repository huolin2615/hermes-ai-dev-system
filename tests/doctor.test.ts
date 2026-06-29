import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandResult } from "../src/process/runner.js";
import { runDoctor } from "../src/runtime/doctor.js";
import { WorkerHealthStore } from "../src/runtime/health.js";

function result(stdout: string): CommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
  };
}

test("checks the tested local compatibility matrix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-doctor-"));
  const configs = path.join(root, "projects");
  const runtime = path.join(root, "runtime");
  await mkdir(configs, { recursive: true });
  await writeFile(
    path.join(configs, "crm.yaml"),
    `
schema_version: 1
id: crm
repo: { path: /tmp/crm, base_branch: main, require_clean: true }
hermes: { board: crm, assignee: ai-dev }
codex: { network: false, reasoning_effort: high }
review: { model: sonnet, max_fix_cycles: 2, max_turns: 8 }
verification: { commands: [] }
knowledge: { vault_path: /tmp/vault, project_path: AI/crm, task_logs: auto, reusable_knowledge: ask }
ci: { mode: local }
`,
  );
  await new WorkerHealthStore(runtime).write("idle");

  const report = await runDoctor(
    { configDirectory: configs, runtimeRoot: runtime },
    async ({ argv }) => {
      if (argv[0] === "hermes") return result("hermes 0.17.0");
      if (argv[0] === "codex") return result("codex-cli 0.142.3");
      return result("2.1.195 (Claude Code)");
    },
  );

  assert.equal(report.ok, true);
  assert.equal(
    report.checks.find((check) => check.name === "Codex SDK compatibility")?.ok,
    true,
  );
});
