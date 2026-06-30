import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandResult } from "../src/process/runner.js";
import { runDoctor } from "../src/runtime/doctor.js";
import { WorkerHealthStore } from "../src/runtime/health.js";
import { RepoWriteLease } from "../src/runtime/repo-lease.js";

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
    async () => false,
  );

  assert.equal(report.ok, true);
  assert.equal(
    report.checks.find((check) => check.name === "Codex SDK compatibility")?.ok,
    true,
  );
});

test("reports an absent idle worker without failing compatibility", async () => {
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

  const report = await runDoctor(
    { configDirectory: configs, runtimeRoot: runtime },
    async ({ argv }) => {
      if (argv[0] === "hermes") return result("hermes 0.17.0");
      if (argv[0] === "codex") return result("codex-cli 0.142.3");
      return result("2.1.195 (Claude Code)");
    },
    async () => false,
  );

  const heartbeat = report.checks.find(
    (check) => check.name === "Worker heartbeat",
  );
  assert.equal(heartbeat?.ok, false);
  assert.equal(heartbeat?.detail, "worker has not written health status yet");
  assert.equal(report.ok, true);
});

test("reports a stale repository lease without reclaiming it", async () => {
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
  const expiredTask = path.join(runtime, "crm", "t_old");
  await mkdir(expiredTask, { recursive: true });
  await writeFile(
    path.join(expiredTask, "manifest.json"),
    JSON.stringify({ completedAt: "2000-01-01T00:00:00.000Z" }),
  );
  const owner = await new RepoWriteLease(
    runtime,
    "crm",
    async () => false,
  ).acquire("t_stale", 999_999);

  const report = await runDoctor(
    { configDirectory: configs, runtimeRoot: runtime },
    async ({ argv }) => {
      if (argv[0] === "hermes") return result("hermes 0.17.0");
      if (argv[0] === "codex") return result("codex-cli 0.142.3");
      return result("2.1.195 (Claude Code)");
    },
    async () => false,
  );

  assert.equal(report.ok, false);
  assert.equal(report.leases[0]?.ownerTaskId, "t_stale");
  assert.equal(report.leases[0]?.stale, true);
  assert.equal(report.leases[0]?.taskRunActive, false);
  assert.equal(report.retention[0]?.status, "expired");
  assert.equal(report.retention[0]?.artifactPath, expiredTask);
  assert.equal((await stat(owner.ownerPath)).isFile(), true);
  assert.equal((await stat(expiredTask)).isDirectory(), true);
});
