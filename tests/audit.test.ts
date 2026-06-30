import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { TaskErrorStore } from "../src/artifacts/errors.js";
import { OperatorCommandQueue } from "../src/operator/commands.js";
import { runCommand } from "../src/process/runner.js";
import { auditTask } from "../src/runtime/audit.js";
import { createWorkflowState } from "../src/workflow/state.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({
    argv: ["git", ...args],
    cwd,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function completedTask() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-audit-"));
  const worktree = path.join(root, "repo");
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await git(worktree, "init", "-b", "main");
  await git(worktree, "config", "user.name", "Audit Test");
  await git(worktree, "config", "user.email", "audit@example.com");
  await writeFile(path.join(worktree, "src", "app.txt"), "base\n", "utf8");
  await git(worktree, "add", "src/app.txt");
  await git(worktree, "commit", "-m", "base");
  await git(worktree, "branch", "base");
  await writeFile(path.join(worktree, "src", "app.txt"), "changed\n", "utf8");
  await git(worktree, "add", "src/app.txt");
  await git(worktree, "commit", "-m", "change");
  const commit = await git(worktree, "rev-parse", "HEAD");

  const store = new ArtifactStore(root, "crm", "t_1");
  await store.writeJson("state.json", {
    ...createWorkflowState("t_1", "crm", 2),
    stage: "completed",
    revision: 7,
  });
  await store.writeJson("manifest.json", {
    schemaVersion: 1,
    taskId: "t_1",
    projectId: "crm",
    commit,
    changedFiles: ["src/app.txt"],
    completedAt: "2026-06-30T00:00:00.000Z",
  });
  await store.writeText("summary.md", "# Complete\n");
  await store.writeJson("metrics.json", {
    status: "completed",
    budgetStatus: "ok",
    activeDurationMs: 1_000,
    operatorWaitDurationMs: 0,
  });
  await store.appendWorkflowEvent("worker", 7, "state_changed", {
    stage: "completed",
  });
  return { root, store, worktree };
}

test("passes a completed task with matching durable evidence", async () => {
  const { store, worktree } = await completedTask();

  const report = await auditTask(store, {
    worktreePath: worktree,
    baseBranch: "base",
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("fails a completed task with active errors or pending commands", async () => {
  const { store, worktree } = await completedTask();
  await new TaskErrorStore(store).record({
    stage: "reviewing",
    code: "CLAUDE_INVALID_OUTPUT",
    message: "Expected object.",
  });
  await new OperatorCommandQueue(store).enqueue({
    type: "reprepare",
    requestedBy: "huolin",
    payload: {},
  });

  const report = await auditTask(store, {
    worktreePath: worktree,
    baseBranch: "base",
  });

  assert.deepEqual(
    report.violations.map((item) => item.code),
    [
      "COMPLETED_WITH_ACTIVE_ERROR",
      "COMPLETED_WITH_PENDING_COMMAND",
    ],
  );
  assert.equal(report.ok, false);
});

test("reports event, deletion, Git, and budget invariant violations", async () => {
  const { store, worktree } = await completedTask();
  const eventSource = await readFile(store.resolve("events.jsonl"), "utf8");
  await appendFile(store.resolve("events.jsonl"), eventSource, "utf8");
  await store.appendWorkflowEvent("worker", 8, "state_changed", {
    stage: "completed",
  });
  await store.writeJson("deletion-request.json", {
    status: "restored_and_blocked",
    files: ["src/legacy.ts"],
  });
  await store.writeJson("manifest.json", {
    commit: "deadbeef",
    changedFiles: [],
  });
  await store.writeJson("metrics.json", {
    budgetStatus: "unknown",
  });

  const report = await auditTask(store, {
    worktreePath: worktree,
    baseBranch: "base",
  });

  assert.deepEqual(
    report.violations.map((item) => item.code),
    [
      "DUPLICATE_EVENT_ID",
      "EVENT_REVISION_AHEAD",
      "UNRESOLVED_DELETION_REQUEST",
      "MANIFEST_COMMIT_UNRESOLVED",
      "CHANGED_FILES_MISMATCH",
      "BUDGET_SUMMARY_INVALID",
    ],
  );
});
