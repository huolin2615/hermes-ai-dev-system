import { z } from "zod";

import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/runner.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  status: z.string(),
  workspace_kind: z.string(),
  workspace_path: z.string().nullable().optional(),
  branch_name: z.string().nullable().optional(),
});

const runSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  outcome: z.string().nullable().optional(),
  ended_at: z.number().nullable().optional(),
});

const showSchema = z.object({
  task: taskSchema,
  comments: z.array(z.unknown()).default([]),
  events: z.array(z.unknown()).default([]),
  runs: z.array(runSchema).default([]),
});

export type HermesTask = z.infer<typeof taskSchema>;

export type CommandExecutor = (options: RunCommandOptions) => Promise<CommandResult>;

export interface HermesKanbanClientOptions {
  board: string;
  execute?: CommandExecutor;
}

export interface ClaimResult {
  task: HermesTask;
  workspacePath: string;
  runId: number;
}

export class HermesKanbanClient {
  private readonly board: string;
  private readonly execute: CommandExecutor;

  constructor(options: HermesKanbanClientOptions) {
    this.board = options.board;
    this.execute = options.execute ?? runCommand;
  }

  private args(...args: string[]): [string, ...string[]] {
    return ["hermes", "kanban", "--board", this.board, ...args];
  }

  private async invoke(
    argv: [string, ...string[]],
    env?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    const result = await this.execute({
      argv,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Hermes command failed (${result.exitCode ?? result.signal ?? "unknown"}): ${
          result.stderr.trim() || result.stdout.trim()
        }`,
      );
    }
    return result;
  }

  async listReady(assignee: string): Promise<HermesTask[]> {
    const result = await this.invoke(
      this.args("list", "--status", "ready", "--assignee", assignee, "--json"),
    );
    return z.array(taskSchema).parse(JSON.parse(result.stdout));
  }

  async show(taskId: string): Promise<z.infer<typeof showSchema>> {
    const result = await this.invoke(this.args("show", taskId, "--json"));
    return showSchema.parse(JSON.parse(result.stdout));
  }

  async claim(taskId: string, ttlSeconds = 900): Promise<ClaimResult> {
    await this.invoke(this.args("claim", taskId, "--ttl", String(ttlSeconds)));
    const details = await this.show(taskId);
    const run = [...details.runs]
      .reverse()
      .find((candidate) => candidate.status === "running" && candidate.ended_at == null);
    const workspacePath = details.task.workspace_path;
    if (!run || !workspacePath) {
      throw new Error(`claimed task ${taskId} is missing its active run or workspace`);
    }
    return { task: details.task, workspacePath, runId: run.id };
  }

  async submit(input: {
    title: string;
    requirement: string;
    assignee: string;
    repoPath: string;
    branch: string;
    idempotencyKey: string;
  }): Promise<string> {
    const result = await this.invoke(
      this.args(
        "create",
        input.title,
        "--body",
        input.requirement,
        "--assignee",
        input.assignee,
        "--workspace",
        `worktree:${input.repoPath}`,
        "--branch",
        input.branch,
        "--idempotency-key",
        input.idempotencyKey,
        "--json",
      ),
    );
    const parsed = z.object({ id: z.string() }).parse(JSON.parse(result.stdout));
    return parsed.id;
  }

  private runEnvironment(taskId: string, runId: number): NodeJS.ProcessEnv {
    return {
      HERMES_KANBAN_BOARD: this.board,
      HERMES_KANBAN_TASK: taskId,
      HERMES_KANBAN_RUN_ID: String(runId),
    };
  }

  async heartbeat(taskId: string, runId: number, note: string): Promise<void> {
    await this.invoke(
      this.args("heartbeat", taskId, "--note", note),
      this.runEnvironment(taskId, runId),
    );
  }

  async comment(taskId: string, text: string): Promise<void> {
    await this.invoke(this.args("comment", taskId, text));
  }

  async block(input: {
    taskId: string;
    runId: number;
    reason: string;
    kind?: "capability" | "dependency" | "needs_input" | "transient";
  }): Promise<void> {
    const args = this.args("block", input.taskId, input.reason);
    if (input.kind) {
      args.push("--kind", input.kind);
    }
    await this.invoke(args, this.runEnvironment(input.taskId, input.runId));
  }

  async unblock(taskId: string): Promise<void> {
    await this.invoke(this.args("unblock", taskId));
  }

  async complete(input: {
    taskId: string;
    runId: number;
    summary: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.invoke(
      this.args(
        "complete",
        input.taskId,
        "--summary",
        input.summary,
        "--metadata",
        JSON.stringify(input.metadata),
      ),
      this.runEnvironment(input.taskId, input.runId),
    );
  }
}
