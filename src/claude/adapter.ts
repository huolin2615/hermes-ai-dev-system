import { z } from "zod";

import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/runner.js";

const blockerSchema = z.strictObject({
  id: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  evidence: z.string(),
  requiredFix: z.string(),
});

export const claudeReviewSchema = z.strictObject({
  verdict: z.enum(["PASS", "PASS_WITH_COMMENTS", "BLOCK"]),
  blockers: z.array(blockerSchema),
  suggestions: z.array(z.string()),
  missingTests: z.array(z.string()),
  knowledgeRecommendation: z.enum(["none", "log", "decision", "pattern", "rule"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  finalSummary: z.string(),
});

export type ClaudeReview = z.infer<typeof claudeReviewSchema>;
export type ReviewCommandExecutor = (
  options: RunCommandOptions,
) => Promise<CommandResult>;

function reviewCandidate(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("invalid Claude review output: response is not JSON");
  }
  if (parsed && typeof parsed === "object" && "structured_output" in parsed) {
    return (parsed as { structured_output: unknown }).structured_output;
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { result?: unknown }).result === "string") {
    try {
      return JSON.parse((parsed as { result: string }).result);
    } catch {
      return (parsed as { result: string }).result;
    }
  }
  return parsed;
}

export class ClaudeReviewAdapter {
  constructor(private readonly execute: ReviewCommandExecutor = runCommand) {}

  async review(input: {
    cwd: string;
    prompt: string;
    model: string;
    maxTurns: number;
    signal?: AbortSignal;
  }): Promise<ClaudeReview> {
    const result = await this.execute({
      argv: [
        "claude",
        "-p",
        "--safe-mode",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Read",
        "Glob",
        "Grep",
        "--model",
        input.model,
        "--max-turns",
        String(input.maxTurns),
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(z.toJSONSchema(claudeReviewSchema)),
        "--no-chrome",
        "--disable-slash-commands",
      ],
      cwd: input.cwd,
      input: input.prompt,
      timeoutMs: 15 * 60_000,
      maxOutputBytes: 2_000_000,
      signal: input.signal,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Claude review failed (${result.exitCode ?? result.signal ?? "unknown"}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      );
    }

    const parsed = claudeReviewSchema.safeParse(reviewCandidate(result.stdout));
    if (!parsed.success) {
      throw new Error(
        `invalid Claude review output: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }
}
