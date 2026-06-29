import assert from "node:assert/strict";
import test from "node:test";

import type { VerificationCommand } from "../src/config/project.js";
import type { CommandResult } from "../src/process/runner.js";
import {
  VerificationRunner,
  type VerificationCommandExecutor,
} from "../src/verification/runner.js";

function command(id: string, required = true): VerificationCommand {
  return {
    id,
    argv: ["pnpm", id],
    required,
    timeoutSeconds: 10,
  };
}

function output(exitCode: number): CommandResult {
  return {
    stdout: exitCode === 0 ? "ok" : "",
    stderr: exitCode === 0 ? "" : "failed",
    exitCode,
    signal: null,
    timedOut: false,
    outputTruncated: false,
  };
}

test("runs configured commands without a shell and reports required failures", async () => {
  const calls: string[][] = [];
  const execute: VerificationCommandExecutor = async (options) => {
    calls.push(options.argv);
    return output(options.argv[1] === "test" ? 1 : 0);
  };
  const runner = new VerificationRunner(execute);

  const result = await runner.run(
    [command("lint"), command("test"), command("optional", false)],
    "/tmp/worktree",
  );

  assert.equal(result.allRequiredPassed, false);
  assert.deepEqual(calls, [
    ["pnpm", "lint"],
    ["pnpm", "test"],
    ["pnpm", "optional"],
  ]);
  assert.equal(result.commands[1]?.stderr, "failed");
});

test("optional failures do not fail the required verification gate", async () => {
  const execute: VerificationCommandExecutor = async () => output(1);
  const runner = new VerificationRunner(execute);

  const result = await runner.run([command("optional", false)], "/tmp/worktree");

  assert.equal(result.allRequiredPassed, true);
});
