import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GitAdapter } from "../src/git/adapter.js";
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

test("collects changed files and diff without modifying the index", async () => {
  const calls: string[][] = [];
  const adapter = new GitAdapter(async (options) => {
    calls.push(options.argv);
    if (options.argv.includes("status")) {
      return result(" M src/orders.ts\u0000?? tests/orders.test.ts\u0000");
    }
    return result("diff --git a/src/orders.ts b/src/orders.ts\n");
  });

  const facts = await adapter.collect("/tmp/worktree");

  assert.deepEqual(facts.changedFiles, ["src/orders.ts", "tests/orders.test.ts"]);
  assert.match(facts.diff, /src\/orders\.ts/);
  assert.equal(calls.some((argv) => argv.includes("add")), false);
});

test("creates only a local commit and never pushes", async () => {
  const calls: string[][] = [];
  const adapter = new GitAdapter(async (options) => {
    calls.push(options.argv);
    if (options.argv.includes("status")) {
      return result(" M src/orders.ts\u0000");
    }
    return options.argv.includes("rev-parse") ? result("abc123\n") : result("");
  });
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ai-dev-git-"));

  const commit = await adapter.commit(cwd, "feat: implement task");

  assert.equal(commit, "abc123");
  assert.equal(calls.some((argv) => argv.includes("push")), false);
  assert.ok(calls.some((argv) => argv.includes("add")));
  assert.ok(calls.some((argv) => argv.includes("commit")));
});

test("detects deletions for an explicit approval gate", async () => {
  const adapter = new GitAdapter(async (options) =>
    options.argv.includes("status")
      ? result(" D src/legacy.ts\u0000R  src/new.ts\u0000src/old.ts\u0000")
      : result(""),
  );

  const facts = await adapter.collect("/tmp/worktree");

  assert.deepEqual(facts.deletedFiles, ["src/legacy.ts", "src/old.ts"]);
});

test("restores each undeclared deletion by exact path without a shell", async () => {
  const calls: string[][] = [];
  const adapter = new GitAdapter(async (options) => {
    calls.push(options.argv);
    return result("");
  });

  await adapter.restoreDeleted("/tmp/worktree", [
    "src/legacy.ts",
    "docs/old note.md",
  ]);

  assert.deepEqual(calls, [
    [
      "git",
      "restore",
      "--source=HEAD",
      "--worktree",
      "--",
      "src/legacy.ts",
    ],
    [
      "git",
      "restore",
      "--source=HEAD",
      "--worktree",
      "--",
      "docs/old note.md",
    ],
  ]);
});

test("rejects unsafe restore targets", async () => {
  const adapter = new GitAdapter(async () => result(""));
  await assert.rejects(
    adapter.restoreDeleted("/tmp/worktree", ["../outside.txt"]),
    /unsafe deleted path/,
  );
});

test("requires the configured clean base branch before creating worktrees", async () => {
  const adapter = new GitAdapter(async ({ argv }) => {
    if (argv.includes("--show-current")) return result("main\n");
    return result("");
  });

  await adapter.assertRepoReady("/tmp/repo", "main", true);
});

test("rejects a worktree anchor on the wrong branch", async () => {
  const adapter = new GitAdapter(async ({ argv }) =>
    argv.includes("--show-current") ? result("feature/wip\n") : result(""),
  );

  await assert.rejects(
    adapter.assertRepoReady("/tmp/repo", "main", false),
    /must be on base branch main/,
  );
});

test("validates a task branch through git without shell interpolation", async () => {
  const calls: string[][] = [];
  const adapter = new GitAdapter(async ({ argv }) => {
    calls.push(argv);
    return result("");
  });

  await adapter.assertBranchName("/tmp/repo", "codex/crm-order-filter");

  assert.deepEqual(calls[0], [
    "git",
    "check-ref-format",
    "--branch",
    "codex/crm-order-filter",
  ]);
});
