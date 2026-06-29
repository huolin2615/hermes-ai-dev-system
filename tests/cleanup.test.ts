import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CleanupApprovalStore,
  type CleanupExecutor,
} from "../src/cleanup/approval.js";

test("requires one-time approval before invoking a single-target cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-cleanup-"));
  const calls: string[] = [];
  const execute: CleanupExecutor = async (request) => {
    calls.push(request.targetPath);
  };
  const store = new CleanupApprovalStore(root, execute);
  const request = await store.request({
    taskId: "t_1",
    targetType: "worktree",
    targetPath: "/tmp/worktrees/t_1",
    reason: "Task archived",
  });

  assert.deepEqual(calls, []);
  await assert.rejects(store.execute(request.id), /not approved/);

  await store.approve(request.id);
  await store.execute(request.id);
  assert.deepEqual(calls, ["/tmp/worktrees/t_1"]);
  await assert.rejects(store.execute(request.id), /already executed/);
});

test("rejects directory and batch cleanup targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-cleanup-"));
  const store = new CleanupApprovalStore(root, async () => {});

  await assert.rejects(
    store.request({
      taskId: "t_1",
      targetType: "directory" as "worktree",
      targetPath: "/tmp/a",
      reason: "No",
    }),
    /target type/,
  );
  await assert.rejects(
    store.request({
      taskId: "t_1",
      targetType: "file",
      targetPath: "/tmp/*.log",
      reason: "No",
    }),
    /wildcard/,
  );
  const directory = path.join(root, "not-a-file");
  await mkdir(directory);
  await assert.rejects(
    store.request({
      taskId: "t_1",
      targetType: "file",
      targetPath: directory,
      reason: "No",
    }),
    /must not be a directory/,
  );
});
