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
  assert.match(calls[0]?.input ?? "", /^Review bundle\n/);
  assert.match(calls[0]?.input ?? "", /Return only one valid JSON object/);
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

test("accepts JSON-encoded structured output from Claude", async () => {
  const execute: ReviewCommandExecutor = async () =>
    success(
      JSON.stringify({
        structured_output: JSON.stringify({
          verdict: "PASS_WITH_COMMENTS",
          blockers: [],
          suggestions: ["Keep the compatibility adapter covered by tests"],
          missingTests: [],
          knowledgeRecommendation: "none",
          riskLevel: "low",
          finalSummary: "Compatible structured output",
        }),
      }),
    );

  const review = await new ClaudeReviewAdapter(execute).review({
    cwd: "/tmp/worktree",
    prompt: "Review bundle",
    model: "sonnet",
    maxTurns: 8,
  });

  assert.equal(review.verdict, "PASS_WITH_COMMENTS");
});

test("turns pass-with-comments plus blockers into BLOCK", async () => {
  const review = await new ClaudeReviewAdapter(async () =>
    success(
      JSON.stringify({
        structured_output: {
          verdict: "PASS_WITH_COMMENTS",
          blockers: [
            {
              id: "MISSING_COMMIT",
              severity: "high",
              file: null,
              line: null,
              evidence: "Required commit is missing.",
              requiredFix: "Create the controller-owned commit.",
            },
          ],
          suggestions: [],
          missingTests: [],
          knowledgeRecommendation: "none",
          riskLevel: "medium",
          finalSummary: "Implementation has one blocker.",
        },
      }),
    ),
  ).review({
    cwd: "/tmp/worktree",
    prompt: "Review bundle",
    model: "sonnet",
    maxTurns: 8,
  });

  assert.equal(review.verdict, "BLOCK");
});

test("accepts a strictly valid review inside a Markdown JSON fence", async () => {
  const execute: ReviewCommandExecutor = async () =>
    success(
      JSON.stringify({
        result: [
          "```json",
          JSON.stringify({
            verdict: "PASS",
            blockers: [],
            suggestions: [],
            missingTests: [],
            knowledgeRecommendation: "none",
            riskLevel: "low",
            finalSummary: "No blocking issues.",
          }),
          "```",
        ].join("\n"),
      }),
    );

  const review = await new ClaudeReviewAdapter(execute).review({
    cwd: "/tmp/worktree",
    prompt: "Review bundle",
    model: "sonnet",
    maxTurns: 8,
  });

  assert.equal(review.verdict, "PASS");
});

test("normalizes a prose review once before strict validation", async () => {
  let callCount = 0;
  const execute: ReviewCommandExecutor = async () => {
    callCount += 1;
    if (callCount === 1) {
      return success(JSON.stringify({ result: "PASS. No blocking issues." }));
    }
    return success(
      JSON.stringify({
        structured_output: {
          verdict: "PASS",
          blockers: [],
          suggestions: [],
          missingTests: [],
          knowledgeRecommendation: "none",
          riskLevel: "low",
          finalSummary: "No blocking issues.",
        },
      }),
    );
  };

  const review = await new ClaudeReviewAdapter(execute).review({
    cwd: "/tmp/worktree",
    prompt: "Review bundle",
    model: "sonnet",
    maxTurns: 8,
  });

  assert.equal(review.verdict, "PASS");
  assert.equal(callCount, 2);
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
