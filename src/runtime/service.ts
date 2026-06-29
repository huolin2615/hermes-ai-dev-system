import { readFile } from "node:fs/promises";

import { ArtifactStore } from "../artifacts/store.js";
import { findProjectConfig } from "../config/registry.js";
import { GitAdapter } from "../git/adapter.js";
import { HermesKanbanClient } from "../hermes/client.js";
import { OperatorControls, type ApprovalGate } from "../operator/controls.js";

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
    const { hermes, store } = await this.resources(projectId, taskId);
    if (!store) throw new Error("artifact store unavailable");
    const details = await hermes.show(taskId);
    const state = await optionalJson<{
      stage: string;
      codexThreadId?: string;
    }>(store.resolve("state.json"));
    const threadId = state?.codexThreadId ?? null;
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
    };
  }

  async approve(
    projectId: string,
    taskId: string,
    gate: ApprovalGate,
    approvedBy: string,
    note = "",
  ): Promise<void> {
    const { hermes, store } = await this.resources(projectId, taskId);
    if (!store) throw new Error("artifact store unavailable");
    await new OperatorControls(store).approve(gate, approvedBy, note);
    await hermes.unblock(taskId);
  }

  async operate(
    projectId: string,
    taskId: string,
    operation: "pause" | "resume" | "retry" | "reprepare" | "rereview",
    requestedBy: string,
    note = "",
  ): Promise<void> {
    const { hermes, store } = await this.resources(projectId, taskId);
    if (!store) throw new Error("artifact store unavailable");
    const controls = new OperatorControls(store);
    switch (operation) {
      case "pause":
        await controls.requestPause(requestedBy, note);
        await hermes.comment(taskId, `Pause requested by ${requestedBy}: ${note}`);
        return;
      case "resume":
        await controls.resume(requestedBy);
        break;
      case "retry":
        await controls.retry(requestedBy);
        break;
      case "reprepare":
        await controls.reprepare(requestedBy);
        break;
      case "rereview":
        await controls.rereview(requestedBy);
        break;
    }
    await hermes.unblock(taskId);
  }
}
