import { readFile } from "node:fs/promises";

import { ArtifactStore } from "../artifacts/store.js";
import {
  TaskErrorStore,
  type TaskErrorRecord,
} from "../artifacts/errors.js";
import {
  TaskMetrics,
  type BudgetStatus,
} from "../artifacts/metrics.js";
import { findProjectConfig } from "../config/registry.js";
import {
  scanRetention,
  type RetentionStatus,
} from "../cleanup/retention.js";
import { GitAdapter } from "../git/adapter.js";
import { HermesKanbanClient } from "../hermes/client.js";
import { OperatorControls, type ApprovalGate } from "../operator/controls.js";
import {
  RepoWriteLease,
  type RepoLeaseOwner,
} from "./repo-lease.js";
import { auditTask, type TaskAuditReport } from "./audit.js";

export interface TaskStatus {
  projectId: string;
  taskId: string;
  hermesStatus: string;
  workflowStage: string | null;
  worktreePath: string | null;
  branch: string | null;
  codexThreadId: string | null;
  codexDesktopUrl: string | null;
  artifactPath: string;
  activeErrors: TaskErrorRecord[];
  budgetStatus: BudgetStatus;
  activeDurationMs: number;
  operatorWaitDurationMs: number;
}

export interface QueuedOperatorAction {
  commandId: string;
  status: "queued";
}

export interface ReclaimedLease {
  projectId: string;
  taskId: string;
  pid: number;
  status: "reclaimed";
}

async function optionalJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class AiDevService {
  constructor(
    private readonly configDirectory: string,
    private readonly runtimeRoot: string,
  ) {}

  private async resources(projectId: string, taskId?: string) {
    const config = await findProjectConfig(this.configDirectory, projectId);
    const hermes = new HermesKanbanClient({ board: config.hermes.board });
    const store = taskId
      ? new ArtifactStore(this.runtimeRoot, config.hermes.board, taskId)
      : null;
    return { config, hermes, store };
  }

  async submit(input: {
    projectId: string;
    title: string;
    requirement: string;
    idempotencyKey: string;
    branch?: string;
  }): Promise<{ taskId: string; branch: string }> {
    const { config, hermes } = await this.resources(input.projectId);
    const git = new GitAdapter();
    await git.assertRepoReady(
      config.repo.path,
      config.repo.baseBranch,
      config.repo.requireClean,
    );
    const branch =
      input.branch ??
      `codex/${config.id}-${input.idempotencyKey
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)}`;
    await git.assertBranchName(config.repo.path, branch);
    const taskId = await hermes.submit({
      title: input.title,
      requirement: input.requirement,
      assignee: config.hermes.assignee,
      repoPath: config.repo.path,
      branch,
      idempotencyKey: input.idempotencyKey,
    });
    return { taskId, branch };
  }

  async status(projectId: string, taskId: string): Promise<TaskStatus> {
    const { config, hermes, store } = await this.resources(projectId, taskId);
    if (!store) throw new Error("artifact store unavailable");
    const details = await hermes.show(taskId);
    const state = await optionalJson<{
      stage: string;
      codexThreadId?: string;
    }>(store.resolve("state.json"));
    const threadId = state?.codexThreadId ?? null;
    const activeErrors = await new TaskErrorStore(store).active();
    const metrics = await new TaskMetrics(
      store,
      config.budgets,
    ).summary();
    return {
      projectId,
      taskId,
      hermesStatus: details.task.status,
      workflowStage: state?.stage ?? null,
      worktreePath: details.task.workspace_path ?? null,
      branch: details.task.branch_name ?? null,
      codexThreadId: threadId,
      codexDesktopUrl: threadId
        ? `codex://threads/${encodeURIComponent(threadId)}`
        : null,
      artifactPath: store.taskRoot,
      activeErrors,
      budgetStatus: metrics.budgetStatus,
      activeDurationMs: metrics.activeDurationMs,
      operatorWaitDurationMs: metrics.operatorWaitDurationMs,
    };
  }

  async approve(
    projectId: string,
    taskId: string,
    gate: ApprovalGate,
    approvedBy: string,
    note = "",
    answers: Record<string, string> = {},
  ): Promise<QueuedOperatorAction> {
    const { hermes, store } = await this.resources(projectId, taskId);
    if (!store) throw new Error("artifact store unavailable");
    const command = await new OperatorControls(store).approve(
      gate,
      approvedBy,
      note,
      answers,
    );
    await hermes.unblock(taskId);
    return { commandId: command.commandId, status: "queued" };
  }

  async operate(
    projectId: string,
    taskId: string,
    operation: "pause" | "resume" | "retry" | "reprepare" | "rereview",
    requestedBy: string,
    note = "",
  ): Promise<QueuedOperatorAction> {
    const { hermes, store } = await this.resources(projectId, taskId);
    if (!store) throw new Error("artifact store unavailable");
    const controls = new OperatorControls(store);
    let command;
    switch (operation) {
      case "pause":
        command = await controls.requestPause(requestedBy, note);
        await hermes.comment(taskId, `Pause requested by ${requestedBy}: ${note}`);
        return { commandId: command.commandId, status: "queued" };
      case "resume":
        command = await controls.resume(requestedBy, note);
        break;
      case "retry":
        command = await controls.retry(requestedBy, note);
        break;
      case "reprepare":
        command = await controls.reprepare(requestedBy, note);
        break;
      case "rereview":
        command = await controls.rereview(requestedBy, note);
        break;
    }
    await hermes.unblock(taskId);
    return { commandId: command.commandId, status: "queued" };
  }

  async reclaimLease(
    projectId: string,
    ownerTaskId: string,
    approvedBy: string,
  ): Promise<ReclaimedLease> {
    const { config, hermes } = await this.resources(projectId);
    const lease = new RepoWriteLease(this.runtimeRoot, config.id);
    const initialDiagnosis = await lease.diagnose();
    if (
      initialDiagnosis.available ||
      initialDiagnosis.ownerTaskId !== ownerTaskId ||
      initialDiagnosis.pid === null ||
      initialDiagnosis.acquiredAt === null ||
      initialDiagnosis.ownerPath === null
    ) {
      throw new Error(
        `lease owner does not match requested task: ${ownerTaskId}`,
      );
    }
    const details = await hermes.show(ownerTaskId);
    const taskRunActive = details.runs.some(
      (run) => run.status === "running" && run.ended_at == null,
    );
    const diagnosis = await lease.diagnose(taskRunActive);
    if (!diagnosis.stale) {
      throw new Error(
        taskRunActive
          ? `Hermes task run is still active: ${ownerTaskId}`
          : `lease owner process is still alive: ${ownerTaskId}`,
      );
    }
    const owner: RepoLeaseOwner = {
      projectId: config.id,
      taskId: ownerTaskId,
      pid: initialDiagnosis.pid,
      acquiredAt: initialDiagnosis.acquiredAt,
      ownerPath: initialDiagnosis.ownerPath,
    };
    await lease.reclaimStale(owner, approvedBy, taskRunActive);
    return {
      projectId: config.id,
      taskId: ownerTaskId,
      pid: owner.pid,
      status: "reclaimed",
    };
  }

  async retention(projectId: string): Promise<RetentionStatus[]> {
    const { config } = await this.resources(projectId);
    return scanRetention(this.runtimeRoot, [config]);
  }

  async audit(
    projectId: string,
    taskId: string,
  ): Promise<TaskAuditReport> {
    const { config, hermes, store } = await this.resources(
      projectId,
      taskId,
    );
    if (!store) throw new Error("artifact store unavailable");
    const details = await hermes.show(taskId);
    if (!details.task.workspace_path) {
      throw new Error(`task ${taskId} has no worktree path`);
    }
    return auditTask(store, {
      worktreePath: details.task.workspace_path,
      baseBranch: config.repo.baseBranch,
    });
  }
}
