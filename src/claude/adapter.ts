import { z } from "zod";

import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/runner.js";
import { normalizeReviewVerdict } from "../workflow/review-policy.js";

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

export interface ClaudeReviewExecution {
  calls: number;
  normalizations: number;
}

export type ClaudeReview = z.infer<typeof claudeReviewSchema> & {
  execution?: ClaudeReviewExecution;
};
export type ReviewCommandExecutor = (
  options: RunCommandOptions,
) => Promise<CommandResult>;

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value
      .trim()
      .match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (fenced) {
      try {
        return JSON.parse(fenced);
      } catch {
        // Continue to the conservative object-boundary fallback.
      }
    }
    const firstBrace = value.indexOf("{");
    const lastBrace = value.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(value.slice(firstBrace, lastBrace + 1));
      } catch {
        return value;
      }
    }
    return value;
  }
}

function reviewCandidate(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("invalid Claude review output: response is not JSON");
  }
  if (parsed && typeof parsed === "object" && "structured_output" in parsed) {
    const structuredOutput = (parsed as { structured_output: unknown })
      .structured_output;
    if (typeof structuredOutput === "string") {
      return parseJsonText(structuredOutput);
    }
    return structuredOutput;
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { result?: unknown }).result === "string") {
    return parseJsonText((parsed as { result: string }).result);
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
    const outputSchema = JSON.stringify(z.toJSONSchema(claudeReviewSchema));
    const argv: [string, ...string[]] = [
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
        outputSchema,
        "--no-chrome",
        "--disable-slash-commands",
      ];
    const command = {
      argv,
      cwd: input.cwd,
      timeoutMs: 15 * 60_000,
      maxOutputBytes: 2_000_000,
      signal: input.signal,
    };
    const result = await this.execute({
      ...command,
      input: [
        input.prompt,
        "",
        "# Required output",
        "Return only one valid JSON object matching this schema. Do not wrap it in Markdown.",
        outputSchema,
      ].join("\n"),
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Claude review failed (${result.exitCode ?? result.signal ?? "unknown"}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      );
    }

    let candidate = reviewCandidate(result.stdout);
    let parsed = claudeReviewSchema.safeParse(candidate);
    let calls = 1;
    let normalizations = 0;
    if (!parsed.success && typeof candidate === "string") {
      calls += 1;
      normalizations += 1;
      const normalized = await this.execute({
        ...command,
        input: [
          "Convert the review below into exactly one JSON object matching the schema.",
          "Preserve its verdict and findings. Do not add commentary or Markdown.",
          "",
          "# Schema",
          outputSchema,
          "",
          "# Review to normalize",
          candidate,
        ].join("\n"),
      });
      if (normalized.exitCode !== 0) {
        throw new Error(
          `Claude review normalization failed (${
            normalized.exitCode ?? normalized.signal ?? "unknown"
          }): ${normalized.stderr.trim() || normalized.stdout.trim()}`,
        );
      }
      candidate = reviewCandidate(normalized.stdout);
      parsed = claudeReviewSchema.safeParse(candidate);
    }
    if (!parsed.success) {
      throw new Error(
        `invalid Claude review output: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return {
      ...normalizeReviewVerdict(parsed.data),
      execution: { calls, normalizations },
    };
  }
}
