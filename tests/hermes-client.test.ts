import assert from "node:assert/strict";
import test from "node:test";

import {
  HermesKanbanClient,
  type CommandExecutor,
} from "../src/hermes/client.js";
import type { CommandResult } from "../src/process/runner.js";

function result(stdout: string, exitCode = 0): CommandResult {
  return {
    stdout,
    stderr: "",
    exitCode,
    signal: null,
    timedOut: false,
    outputTruncated: false,
  };
}

test("lists only ready tasks for the configured external lane", async () => {
  const calls: string[][] = [];
  const execute: CommandExecutor = async ({ argv }) => {
    calls.push(argv);
    return result(
      JSON.stringify([
        {
          id: "t_1",
          title: "Add orders",
          body: "Requirement",
          assignee: "ai-dev",
          status: "ready",
          workspace_kind: "worktree",
          workspace_path: null,
          branch_name: "codex/orders",
        },
      ]),
    );
  };
  const client = new HermesKanbanClient({ board: "crm", execute });

  const tasks = await client.listReady("ai-dev");

  assert.equal(tasks[0]?.id, "t_1");
  assert.deepEqual(calls[0], [
    "hermes",
    "kanban",
    "--board",
    "crm",
    "list",
    "--status",
    "ready",
    "--assignee",
    "ai-dev",
    "--json",
  ]);
});

test("claims a task and resolves the active run without parsing prose as state", async () => {
  let call = 0;
  const execute: CommandExecutor = async () => {
    call += 1;
    if (call === 1) {
      return result("Claimed t_1\nWorkspace: /tmp/worktree\n");
    }
    return result(
      JSON.stringify({
        task: {
          id: "t_1",
          title: "Add orders",
          body: "Requirement",
          assignee: "ai-dev",
          status: "running",
          workspace_kind: "worktree",
          workspace_path: "/tmp/worktree",
          branch_name: "codex/orders",
        },
        comments: [],
        events: [],
        runs: [
          {
            id: 42,
            status: "running",
            outcome: null,
            ended_at: null,
          },
        ],
      }),
    );
  };
  const client = new HermesKanbanClient({ board: "crm", execute });

  const claim = await client.claim("t_1");

  assert.equal(claim.workspacePath, "/tmp/worktree");
  assert.equal(claim.runId, 42);
});

test("completes a claimed task with run-scoped environment guards", async () => {
  const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv | undefined }> = [];
  const execute: CommandExecutor = async (options) => {
    calls.push({ argv: options.argv, env: options.env });
    return result("Completed t_1\n");
  };
  const client = new HermesKanbanClient({ board: "crm", execute });

  await client.complete({
    taskId: "t_1",
    runId: 42,
    summary: "Done",
    metadata: { changed_files: ["src/orders.ts"] },
  });

  assert.equal(calls[0]?.env?.HERMES_KANBAN_TASK, "t_1");
  assert.equal(calls[0]?.env?.HERMES_KANBAN_RUN_ID, "42");
  assert.match(calls[0]?.argv.join(" ") ?? "", /--metadata/);
});

test("submits one idempotent worktree task without touching the main workspace", async () => {
  const calls: string[][] = [];
  const execute: CommandExecutor = async ({ argv }) => {
    calls.push(argv);
    return result(JSON.stringify({ id: "t_9", status: "ready" }));
  };
  const client = new HermesKanbanClient({ board: "crm", execute });

  const taskId = await client.submit({
    title: "Add order filters",
    requirement: "Support status filtering.",
    assignee: "ai-dev",
    repoPath: "/tmp/crm",
    branch: "codex/crm-order-filters",
    idempotencyKey: "crm:order-filters",
  });

  assert.equal(taskId, "t_9");
  assert.ok(calls[0]?.includes("worktree:/tmp/crm"));
  assert.ok(calls[0]?.includes("codex/crm-order-filters"));
});
