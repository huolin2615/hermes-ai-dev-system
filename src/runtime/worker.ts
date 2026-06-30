import { ArtifactStore } from "../artifacts/store.js";
import { TaskErrorStore } from "../artifacts/errors.js";
import { ClaudeReviewAdapter } from "../claude/adapter.js";
import { CodexAdapter } from "../codex/adapter.js";
import type { ProjectConfig } from "../config/project.js";
import { loadProjectConfigs } from "../config/registry.js";
import { GitAdapter } from "../git/adapter.js";
import {
  HermesKanbanClient,
  type ClaimResult,
} from "../hermes/client.js";
import { KnowledgeWriter } from "../knowledge/writer.js";
import { VerificationRunner } from "../verification/runner.js";
import { TaskController, type TaskControllerOutcome } from "../workflow/controller.js";
import {
  parseWorkflowState,
  type WorkflowStage,
} from "../workflow/state.js";
import { WorkerHealthStore } from "./health.js";
import {
  RepoLeaseHeldError,
  RepoWriteLease,
} from "./repo-lease.js";

export interface WorkerRunResult {
  status: "idle" | "completed" | "blocked" | "error";
  projectId?: string;
  taskId?: string;
  reason?: string;
  durationMs: number;
}

export interface ProjectTaskRunner {
  run(
    config: ProjectConfig,
    runtimeRoot: string,
  ): Promise<Omit<WorkerRunResult, "durationMs">>;
}

function workerErrorCode(message: string): string {
  if (/invalid Claude review output/i.test(message)) {
    return "CLAUDE_INVALID_OUTPUT";
  }
  if (/timed? out|timeout/i.test(message)) {
    return "STAGE_TIMEOUT";
  }
  return "WORKER_STAGE_ERROR";
}

export async function recordWorkerFailure(
  store: ArtifactStore,
  error: unknown,
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  let stage: WorkflowStage = "context_preparing";
  if (await store.exists("state.json")) {
    stage = parseWorkflowState(
      await store.readJson<unknown>("state.json"),
    ).stage;
  }
  await new TaskErrorStore(store).record({
    stage,
    code: workerErrorCode(reason),
    message: reason,
  });
}

class DefaultProjectTaskRunner implements ProjectTaskRunner {
  async run(
    config: ProjectConfig,
    runtimeRoot: string,
  ): Promise<Omit<WorkerRunResult, "durationMs">> {
    const hermes = new HermesKanbanClient({ board: config.hermes.board });
    const ready = await hermes.listReady(config.hermes.assignee);
    const task = ready[0];
    if (!task) return { status: "idle", projectId: config.id };
    if (task.workspace_kind !== "worktree") {
      throw new Error(`task ${task.id} must use a worktree workspace`);
    }

    const lease = new RepoWriteLease(runtimeRoot, config.id);
    let owner;
    try {
      owner = await lease.acquire(task.id, process.pid);
    } catch (error) {
      if (error instanceof RepoLeaseHeldError) {
        return { status: "idle", projectId: config.id };
      }
      throw error;
    }
    try {
      await new GitAdapter().assertRepoReady(
        config.repo.path,
        config.repo.baseBranch,
        config.repo.requireClean,
      );
      const claim = await hermes.claim(task.id);
      return await this.runClaimed(
        config,
        runtimeRoot,
        hermes,
        claim,
      );
    } finally {
      await lease.release(owner);
    }
  }

  private async runClaimed(
    config: ProjectConfig,
    runtimeRoot: string,
    hermes: HermesKanbanClient,
    claim: ClaimResult,
  ): Promise<Omit<WorkerRunResult, "durationMs">> {
    const store = new ArtifactStore(
      runtimeRoot,
      config.hermes.board,
      claim.task.id,
    );
    const controller = new TaskController({
      codex: new CodexAdapter(),
      claude: new ClaudeReviewAdapter(),
      verification: new VerificationRunner(),
      git: new GitAdapter(),
      hermes,
      knowledge: new KnowledgeWriter({
        vaultPath: config.knowledge.vaultPath,
        projectPath: config.knowledge.projectPath,
      }),
    });
    const heartbeat = setInterval(() => {
      void hermes
        .heartbeat(
          claim.task.id,
          claim.runId,
          "ai-dev worker is still processing the active stage",
        )
        .catch(() => undefined);
    }, 60_000);
    heartbeat.unref();
    try {
      const task = {
        id: claim.task.id,
        title: claim.task.title,
        requirement: claim.task.body?.trim() || claim.task.title,
        ...(claim.task.branch_name
          ? { branch: claim.task.branch_name }
          : {}),
      };
      const outcome: TaskControllerOutcome = await controller.run({
        config,
        task,
        claim: {
          runId: claim.runId,
          workspacePath: claim.workspacePath,
        },
        store,
      });
      return {
        status: outcome.status,
        projectId: config.id,
        taskId: claim.task.id,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await recordWorkerFailure(store, error);
      await hermes.block({
        taskId: claim.task.id,
        runId: claim.runId,
        reason: `worker error: ${reason}`,
        kind: "transient",
      });
      return {
        status: "error",
        projectId: config.id,
        taskId: claim.task.id,
        reason,
      };
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export class AiDevWorker {
  private readonly health: WorkerHealthStore;

  constructor(
    private readonly configDirectory: string,
    private readonly runtimeRoot: string,
    private readonly taskRunner: ProjectTaskRunner = new DefaultProjectTaskRunner(),
  ) {
    this.health = new WorkerHealthStore(runtimeRoot);
  }

  async runOnce(): Promise<WorkerRunResult> {
    const started = Date.now();
    await this.health.write("starting", { startedAt: new Date().toISOString() });
    const heartbeat = setInterval(() => {
      void this.health.write("running").catch(() => undefined);
    }, 30_000);
    heartbeat.unref();
    try {
      const configs = await loadProjectConfigs(this.configDirectory);
      const projectErrors: string[] = [];
      for (const config of configs) {
        let result: Omit<WorkerRunResult, "durationMs">;
        try {
          result = await this.taskRunner.run(config, this.runtimeRoot);
        } catch (error) {
          projectErrors.push(
            `${config.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (result.status !== "idle") {
          const durationMs = Date.now() - started;
          await this.health.write(
            result.status === "error" ? "error" : result.status,
            {
              ...(result.projectId ? { projectId: result.projectId } : {}),
              ...(result.taskId ? { taskId: result.taskId } : {}),
              lastDurationMs: durationMs,
              ...(result.reason ? { lastError: result.reason } : {}),
            },
          );
          return { ...result, durationMs };
        }
      }
      const durationMs = Date.now() - started;
      if (projectErrors.length > 0) {
        const reason = projectErrors.join("; ");
        await this.health.write("error", {
          lastDurationMs: durationMs,
          lastError: reason,
        });
        return { status: "error", reason, durationMs };
      }
      await this.health.write("idle", { lastDurationMs: durationMs });
      return { status: "idle", durationMs };
    } catch (error) {
      const durationMs = Date.now() - started;
      const reason = error instanceof Error ? error.message : String(error);
      await this.health.write("error", {
        lastDurationMs: durationMs,
        lastError: reason,
      });
      return { status: "error", reason, durationMs };
    } finally {
      clearInterval(heartbeat);
    }
  }

  async runLoop(pollIntervalMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1_000) {
      throw new Error("poll interval must be at least 1000ms");
    }
    while (!signal?.aborted) {
      await this.runOnce();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    await this.health.write("stopped");
  }
}
