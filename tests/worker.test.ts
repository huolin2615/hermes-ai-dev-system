import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { TaskErrorStore } from "../src/artifacts/errors.js";
import type { ProjectConfig } from "../src/config/project.js";
import { WorkerHealthStore } from "../src/runtime/health.js";
import {
  AiDevWorker,
  recordWorkerFailure,
  type ProjectTaskRunner,
} from "../src/runtime/worker.js";
import { createWorkflowState } from "../src/workflow/state.js";

const config = `
schema_version: 1
id: crm
repo: { path: /tmp/crm, base_branch: main, require_clean: true }
hermes: { board: crm, assignee: ai-dev }
codex: { network: false, reasoning_effort: high }
review: { model: sonnet, max_fix_cycles: 2, max_turns: 8 }
verification: { commands: [] }
knowledge:
  vault_path: /tmp/vault
  project_path: AI/crm
  task_logs: auto
  reusable_knowledge: ask
ci: { mode: local }
`;

test("runs at most one task and records worker health", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-worker-"));
  const configDirectory = path.join(root, "projects");
  const runtimeRoot = path.join(root, "runtime");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(configDirectory, { recursive: true }),
  );
  await writeFile(path.join(configDirectory, "crm.yaml"), config);
  const seen: ProjectConfig[] = [];
  const runner: ProjectTaskRunner = {
    async run(project) {
      seen.push(project);
      return { status: "completed", projectId: project.id, taskId: "t_1" };
    },
  };

  const result = await new AiDevWorker(
    configDirectory,
    runtimeRoot,
    runner,
  ).runOnce();

  assert.equal(result.status, "completed");
  assert.equal(seen.length, 1);
  const health = await new WorkerHealthStore(runtimeRoot).read();
  assert.equal(health.status, "completed");
  assert.equal(health.taskId, "t_1");
});

test("reports configuration failures as health errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-worker-"));
  const result = await new AiDevWorker(
    path.join(root, "missing"),
    path.join(root, "runtime"),
  ).runOnce();

  assert.equal(result.status, "error");
  assert.match(result.reason ?? "", /ENOENT/);
});

test("one invalid project does not starve ready tasks in another project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-worker-"));
  const configDirectory = path.join(root, "projects");
  const runtimeRoot = path.join(root, "runtime");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(configDirectory, { recursive: true }),
  );
  await writeFile(path.join(configDirectory, "a-broken.yaml"), config);
  await writeFile(
    path.join(configDirectory, "b-working.yaml"),
    config.replaceAll("crm", "orders"),
  );
  const runner: ProjectTaskRunner = {
    async run(project) {
      if (project.id === "crm") throw new Error("repo not ready");
      return { status: "completed", projectId: project.id, taskId: "t_2" };
    },
  };

  const result = await new AiDevWorker(
    configDirectory,
    runtimeRoot,
    runner,
  ).runOnce();

  assert.equal(result.status, "completed");
  assert.equal(result.projectId, "orders");
});

test("records stage-scoped worker errors without overwriting legacy error.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-worker-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  await store.writeJson("state.json", {
    ...createWorkflowState("t_1", "crm", 2),
    stage: "reviewing",
  });
  await store.writeJson("error.json", { message: "legacy error" });

  await recordWorkerFailure(
    store,
    new Error("invalid Claude review output: Expected object."),
  );

  const active = await new TaskErrorStore(store).active();
  assert.equal(active[0]?.stage, "reviewing");
  assert.equal(active[0]?.code, "CLAUDE_INVALID_OUTPUT");
  assert.deepEqual(await store.readJson("error.json"), {
    message: "legacy error",
  });
});
