import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import type { ClaudeReview } from "../src/claude/adapter.js";
import type {
  CodexImplementationResult,
  CodexPlan,
} from "../src/codex/adapter.js";
import { parseProjectConfig } from "../src/config/project.js";
import { OperatorControls } from "../src/operator/controls.js";
import {
  TaskController,
  type TaskControllerDependencies,
} from "../src/workflow/controller.js";
import {
  createWorkflowState,
  type WorkflowStage,
} from "../src/workflow/state.js";

class CrashOnce {
  private crashed = false;

  constructor(private readonly stage: WorkflowStage) {}

  maybeCrash(current: WorkflowStage): void {
    if (!this.crashed && current === this.stage) {
      this.crashed = true;
      throw new Error(`injected crash at ${current}`);
    }
  }
}

const config = parseProjectConfig({
  schema_version: 1,
  id: "crm",
  repo: { path: "/tmp/crm", base_branch: "main", require_clean: true },
  hermes: { board: "crm", assignee: "ai-dev" },
  codex: { network: false, reasoning_effort: "high" },
  review: { model: "sonnet", max_fix_cycles: 2, max_turns: 8 },
  verification: { commands: [] },
  knowledge: {
    vault_path: "/tmp/vault",
    project_path: "AI/crm",
    task_logs: "auto",
    reusable_knowledge: "ask",
  },
  ci: { mode: "local" },
});

const plan: CodexPlan = {
  version: 2,
  summary: "Implement change",
  assumptions: [],
  files: ["src/app.ts"],
  tests: [],
  capabilities: {
    network: false,
    dependencyInstall: false,
    externalWrite: false,
  },
  fileDeletions: [],
  questions: [],
  knowledgeNeeds: [],
};

const implementation: CodexImplementationResult = {
  summary: "Implemented change",
  changedFiles: ["src/app.ts"],
  testsSuggested: [],
  residualRisks: [],
  knowledgeCandidates: [],
};

const review: ClaudeReview = {
  verdict: "PASS",
  blockers: [],
  suggestions: [],
  missingTests: [],
  knowledgeRecommendation: "none",
  riskLevel: "low",
  finalSummary: "Looks good.",
};

function harness(crash: CrashOnce) {
  const counts = {
    planning: 0,
    implementing: 0,
    verifying: 0,
    reviewing: 0,
    knowledge: 0,
    finalizing: 0,
  };
  const dependencies: TaskControllerDependencies = {
    codex: {
      async plan() {
        counts.planning += 1;
        crash.maybeCrash("planning");
        return { threadId: "thread-1", plan, usage: null };
      },
      async implement() {
        counts.implementing += 1;
        crash.maybeCrash("implementing");
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
    claude: {
      async review() {
        counts.reviewing += 1;
        crash.maybeCrash("reviewing");
        return review;
      },
    },
    verification: {
      async run() {
        counts.verifying += 1;
        crash.maybeCrash("verifying");
        return { allRequiredPassed: true, commands: [] };
      },
    },
    git: {
      async collect() {
        return {
          changedFiles: ["src/app.ts"],
          deletedFiles: [],
          renamedFiles: [],
          diff: "diff",
        };
      },
      async restoreDeleted() {},
      async commit() {
        counts.finalizing += 1;
        crash.maybeCrash("finalizing");
        return "abc123";
      },
    },
    hermes: {
      async heartbeat() {},
      async comment() {},
      async block() {},
      async complete() {},
    },
    knowledge: {
      async writeTaskLog() {
        counts.knowledge += 1;
        crash.maybeCrash("knowledge");
        return "/tmp/vault/run.md";
      },
      async writeProposal() {
        throw new Error("not expected");
      },
      async promoteProposal() {
        throw new Error("not expected");
      },
    },
  };
  return { dependencies, counts };
}

for (const stage of [
  "planning",
  "implementing",
  "verifying",
  "reviewing",
  "knowledge",
  "finalizing",
] as const) {
  test(`restarts safely after a crash in ${stage}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-recovery-"));
    const crash = new CrashOnce(stage);
    const { dependencies, counts } = harness(crash);
    const firstStore = new ArtifactStore(root, "crm", `t_${stage}`);
    const input = {
      config,
      task: {
        id: `t_${stage}`,
        title: "Recovery",
        requirement: "Complete after restart.",
      },
      claim: { runId: 1, workspacePath: "/tmp/worktree" },
      store: firstStore,
    };

    await assert.rejects(
      new TaskController(dependencies).run(input),
      new RegExp(`injected crash at ${stage}`),
    );
    const secondStore = new ArtifactStore(root, "crm", `t_${stage}`);
    const outcome = await new TaskController(dependencies).run({
      ...input,
      store: secondStore,
    });

    assert.equal(outcome.status, "completed");
    assert.equal(
      (await secondStore.readJson<{ stage: string }>("state.json")).stage,
      "completed",
    );
    for (const [name, count] of Object.entries(counts)) {
      assert.ok(
        count <= (name === stage ? 2 : 1),
        `${name} ran ${count} times after a ${stage} crash`,
      );
    }
  });
}

class CrashBeforeCommandResultStore extends ArtifactStore {
  private crashed = false;

  override async writeJson(
    relativePath: string,
    value: unknown,
  ): Promise<void> {
    if (
      !this.crashed &&
      relativePath.startsWith("operator/results/")
    ) {
      this.crashed = true;
      throw new Error("injected crash before command result");
    }
    await super.writeJson(relativePath, value);
  }
}

test("command replay preserves applied result and advances revision once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-recovery-"));
  const crashStore = new CrashBeforeCommandResultStore(root, "crm", "t_cmd");
  await crashStore.writeJson("state.json", {
    ...createWorkflowState("t_cmd", "crm", 2),
    stage: "blocked",
    blockedFrom: "context_preparing",
    blockedReason: "human takeover requested",
  });
  const command = await new OperatorControls(crashStore).resume("huolin");
  const { dependencies } = harness(new CrashOnce("completed"));
  const input = {
    config,
    task: {
      id: "t_cmd",
      title: "Command recovery",
      requirement: "Resume once.",
    },
    claim: { runId: 2, workspacePath: "/tmp/worktree" },
    store: crashStore,
  };

  await assert.rejects(
    new TaskController(dependencies).run(input),
    /injected crash before command result/,
  );
  const resumedRevision = (
    await crashStore.readJson<{ revision: number }>("state.json")
  ).revision;
  const resumedStore = new ArtifactStore(root, "crm", "t_cmd");
  assert.equal(
    (
      await new TaskController(dependencies).run({
        ...input,
        store: resumedStore,
      })
    ).status,
    "completed",
  );

  const result = await resumedStore.readJson<{
    status: string;
    stateRevision: number;
  }>(`operator/results/${command.commandId}.json`);
  assert.equal(result.status, "applied");
  assert.equal(result.stateRevision, resumedRevision);
  assert.equal(
    (await resumedStore.readWorkflowEvents()).filter(
      (event) => event.stateRevision === resumedRevision,
    ).length,
    1,
  );
});
