import path from "node:path";
import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(path.isAbsolute, "must be an absolute path");

const verificationCommandSchema = z.strictObject({
  id: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
  required: z.boolean().default(true),
  timeout_seconds: z.number().int().positive().default(600),
});

const projectConfigFileSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  repo: z.strictObject({
    path: absolutePath,
    base_branch: z.string().min(1).default("main"),
    require_clean: z.boolean().default(true),
  }),
  hermes: z.strictObject({
    board: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    assignee: z.string().min(1).default("ai-dev"),
  }),
  codex: z.strictObject({
    network: z.boolean().default(false),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("high"),
    turn_timeout_seconds: z.number().int().positive().max(7200).default(1800),
  }),
  review: z.strictObject({
    model: z.string().min(1).default("sonnet"),
    max_fix_cycles: z.number().int().min(0).max(10).default(2),
    max_turns: z.number().int().positive().max(50).default(8),
  }),
  verification: z.strictObject({
    commands: z.array(verificationCommandSchema).default([]),
  }),
  knowledge: z.strictObject({
    vault_path: absolutePath,
    project_path: z.string().min(1).refine((value) => !path.isAbsolute(value), "must be relative"),
    task_logs: z.enum(["none", "auto"]).default("auto"),
    reusable_knowledge: z.enum(["none", "ask"]).default("ask"),
  }),
  ci: z.strictObject({
    mode: z.enum(["none", "local"]).default("local"),
  }),
});

export interface VerificationCommand {
  id: string;
  argv: string[];
  required: boolean;
  timeoutSeconds: number;
}

export interface ProjectConfig {
  schemaVersion: 1;
  id: string;
  repo: {
    path: string;
    baseBranch: string;
    requireClean: boolean;
  };
  hermes: {
    board: string;
    assignee: string;
  };
  codex: {
    network: boolean;
    reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh";
    turnTimeoutSeconds: number;
  };
  review: {
    model: string;
    maxFixCycles: number;
    maxTurns: number;
  };
  verification: {
    commands: VerificationCommand[];
  };
  knowledge: {
    vaultPath: string;
    projectPath: string;
    taskLogs: "none" | "auto";
    reusableKnowledge: "none" | "ask";
  };
  ci: {
    mode: "none" | "local";
  };
}

function issuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length > 0 ? issue.path.join(".") : "configuration";
}

export function parseProjectConfig(input: unknown): ProjectConfig {
  const result = projectConfigFileSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issuePath(issue)}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid project configuration: ${details}`);
  }

  const config = result.data;
  return {
    schemaVersion: config.schema_version,
    id: config.id,
    repo: {
      path: config.repo.path,
      baseBranch: config.repo.base_branch,
      requireClean: config.repo.require_clean,
    },
    hermes: config.hermes,
    codex: {
      network: config.codex.network,
      reasoningEffort: config.codex.reasoning_effort,
      turnTimeoutSeconds: config.codex.turn_timeout_seconds,
    },
    review: {
      model: config.review.model,
      maxFixCycles: config.review.max_fix_cycles,
      maxTurns: config.review.max_turns,
    },
    verification: {
      commands: config.verification.commands.map((command) => ({
        id: command.id,
        argv: [...command.argv],
        required: command.required,
        timeoutSeconds: command.timeout_seconds,
      })),
    },
    knowledge: {
      vaultPath: config.knowledge.vault_path,
      projectPath: config.knowledge.project_path,
      taskLogs: config.knowledge.task_logs,
      reusableKnowledge: config.knowledge.reusable_knowledge,
    },
    ci: config.ci,
  };
}

export async function loadProjectConfig(configPath: string): Promise<ProjectConfig> {
  const source = await readFile(configPath, "utf8");
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new Error(
      `invalid YAML in ${configPath}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return parseProjectConfig(document.toJS({ maxAliasCount: 0 }));
}
