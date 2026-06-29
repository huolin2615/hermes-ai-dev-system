import assert from "node:assert/strict";
import test from "node:test";

import {
  ClaudeReviewAdapter,
  type ReviewCommandExecutor,
} from "../src/claude/adapter.js";
import type { CommandResult } from "../src/process/runner.js";

function success(stdout: string): CommandResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputTruncated: false,
  };
}

test("runs Claude in safe read-only structured review mode", async () => {
  const calls: Parameters<ReviewCommandExecutor>[0][] = [];
  const execute: ReviewCommandExecutor = async (options) => {
    calls.push(options);
    return success(
      JSON.stringify({
        structured_output: {
          verdict: "PASS",
          blockers: [],
          suggestions: [],
          missingTests: [],
          knowledgeRecommendation: "log",
          riskLevel: "low",
          finalSummary: "Looks good",
        },
      }),
    );
  };
  const adapter = new ClaudeReviewAdapter(execute);

  const review = await adapter.review({
    cwd: "/tmp/worktree",
    prompt: "Review bundle",
    model: "sonnet",
    maxTurns: 8,
  });

  assert.equal(review.verdict, "PASS");
  assert.equal(calls[0]?.input, "Review bundle");
  assert.ok(calls[0]?.argv.includes("--safe-mode"));
  assert.ok(calls[0]?.argv.includes("dontAsk"));
  assert.deepEqual(
    calls[0]?.argv.slice(
      (calls[0]?.argv.indexOf("--tools") ?? -1) + 1,
      (calls[0]?.argv.indexOf("--model") ?? -1),
    ),
    ["Read", "Glob", "Grep"],
  );
});

test("rejects non-zero Claude exits and malformed review output", async () => {
  const failed: ReviewCommandExecutor = async () => ({
    ...success(""),
    exitCode: 1,
    stderr: "authentication failed",
  });
  await assert.rejects(
    new ClaudeReviewAdapter(failed).review({
      cwd: "/tmp/worktree",
      prompt: "Review",
      model: "sonnet",
      maxTurns: 8,
    }),
    /authentication failed/,
  );

  const malformed: ReviewCommandExecutor = async () =>
    success(JSON.stringify({ structured_output: { verdict: "MAYBE" } }));
  await assert.rejects(
    new ClaudeReviewAdapter(malformed).review({
      cwd: "/tmp/worktree",
      prompt: "Review",
      model: "sonnet",
      maxTurns: 8,
    }),
    /invalid Claude review output/,
  );
});
