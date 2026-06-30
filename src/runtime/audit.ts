import path from "node:path";

import type { ArtifactStore } from "../artifacts/store.js";
import { TaskErrorStore } from "../artifacts/errors.js";
import { GitAdapter } from "../git/adapter.js";
import { OperatorCommandQueue } from "../operator/commands.js";
import { runCommand } from "../process/runner.js";
import {
  parseWorkflowState,
  type WorkflowState,
} from "../workflow/state.js";

export interface TaskAuditViolation {
  code: string;
  message: string;
  artifactPath?: string;
}

export interface TaskAuditReport {
  ok: boolean;
  taskId: string;
  stateRevision: number;
  violations: TaskAuditViolation[];
}

interface TaskManifest {
  commit?: string;
  changedFiles?: string[];
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

export async function auditTask(
  store: ArtifactStore,
  input: {
    worktreePath: string;
    baseBranch: string;
  },
): Promise<TaskAuditReport> {
  const violations: TaskAuditViolation[] = [];
  let state: WorkflowState;
  try {
    state = parseWorkflowState(
      await store.readJson<unknown>("state.json"),
    );
  } catch (error) {
    violations.push({
      code: "STATE_INVALID",
      message: error instanceof Error ? error.message : String(error),
      artifactPath: store.resolve("state.json"),
    });
    return {
      ok: false,
      taskId: path.basename(store.taskRoot),
      stateRevision: 0,
      violations,
    };
  }

  const events = await store.readWorkflowEvents();
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    violations.push({
      code: "DUPLICATE_EVENT_ID",
      message: "workflow event IDs are not unique",
      artifactPath: store.resolve("events.jsonl"),
    });
  }
  if (events.some((event) => event.stateRevision > state.revision)) {
    violations.push({
      code: "EVENT_REVISION_AHEAD",
      message: "an event revision exceeds the persisted state revision",
      artifactPath: store.resolve("events.jsonl"),
    });
  }

  let manifest: TaskManifest | undefined;
  if (state.stage === "completed") {
    if (!(await store.exists("manifest.json"))) {
      violations.push({
        code: "COMPLETED_WITHOUT_MANIFEST",
        message: "completed task has no manifest",
        artifactPath: store.resolve("manifest.json"),
      });
    } else {
      manifest = await store.readJson<TaskManifest>("manifest.json");
    }
    if (!(await store.exists("summary.md"))) {
      violations.push({
        code: "COMPLETED_WITHOUT_SUMMARY",
        message: "completed task has no summary",
        artifactPath: store.resolve("summary.md"),
      });
    }
    if ((await new TaskErrorStore(store).active()).length > 0) {
      violations.push({
        code: "COMPLETED_WITH_ACTIVE_ERROR",
        message: "completed task still has active errors",
        artifactPath: store.resolve("errors"),
      });
    }
    if ((await new OperatorCommandQueue(store).pending()).length > 0) {
      violations.push({
        code: "COMPLETED_WITH_PENDING_COMMAND",
        message: "completed task still has pending operator commands",
        artifactPath: store.resolve("operator/commands"),
      });
    }
  }

  if (
    (await store.exists("deletion-request.json")) &&
    !(await store.exists("deletion-resolution.json"))
  ) {
    violations.push({
      code: "UNRESOLVED_DELETION_REQUEST",
      message: "task has a deletion request without a resolution",
      artifactPath: store.resolve("deletion-request.json"),
    });
  }

  if (state.stage === "completed" && manifest) {
    if (typeof manifest.commit !== "string" || !manifest.commit) {
      violations.push({
        code: "MANIFEST_COMMIT_MISSING",
        message: "manifest does not contain a commit",
        artifactPath: store.resolve("manifest.json"),
      });
    } else {
      const commit = await runCommand({
        argv: [
          "git",
          "-C",
          input.worktreePath,
          "cat-file",
          "-e",
          `${manifest.commit}^{commit}`,
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 100_000,
      });
      if (commit.exitCode !== 0) {
        violations.push({
          code: "MANIFEST_COMMIT_UNRESOLVED",
          message: "manifest commit does not resolve in the worktree",
          artifactPath: store.resolve("manifest.json"),
        });
      }
    }

    try {
      const facts = await new GitAdapter().collect(
        input.worktreePath,
        input.baseBranch,
      );
      const changedFiles = Array.isArray(manifest.changedFiles)
        ? manifest.changedFiles
        : [];
      if (!sameStrings(changedFiles, facts.changedFiles)) {
        violations.push({
          code: "CHANGED_FILES_MISMATCH",
          message:
            "manifest changed files do not match Git evidence against the base branch",
          artifactPath: store.resolve("manifest.json"),
        });
      }
    } catch (error) {
      violations.push({
        code: "GIT_EVIDENCE_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!(await store.exists("metrics.json"))) {
    violations.push({
      code: "BUDGET_SUMMARY_MISSING",
      message: "task has no persisted budget summary",
      artifactPath: store.resolve("metrics.json"),
    });
  } else {
    const metrics = await store.readJson<{ budgetStatus?: unknown }>(
      "metrics.json",
    );
    if (
      metrics.budgetStatus !== "ok" &&
      metrics.budgetStatus !== "warning" &&
      metrics.budgetStatus !== "exceeded"
    ) {
      violations.push({
        code: "BUDGET_SUMMARY_INVALID",
        message: "task budget summary is invalid",
        artifactPath: store.resolve("metrics.json"),
      });
    }
  }

  return {
    ok: violations.length === 0,
    taskId: state.taskId,
    stateRevision: state.revision,
    violations,
  };
}
