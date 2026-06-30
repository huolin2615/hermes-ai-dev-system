import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { TaskErrorStore } from "../src/artifacts/errors.js";
import type { ClaudeReview } from "../src/claude/adapter.js";
import type {
  CodexImplementationResult,
  CodexPlan,
} from "../src/codex/adapter.js";
import { parseProjectConfig } from "../src/config/project.js";
import { KnowledgeWriter } from "../src/knowledge/writer.js";
import { OperatorControls } from "../src/operator/controls.js";
import {
  TaskController,
  type TaskControllerDependencies,
} from "../src/workflow/controller.js";
import { createWorkflowState } from "../src/workflow/state.js";

const configInput = {
  schema_version: 1,
  id: "crm",
  repo: { path: "/tmp/crm", base_branch: "main", require_clean: true },
  hermes: { board: "crm", assignee: "ai-dev" },
  codex: { network: false, reasoning_effort: "high" },
  review: { model: "sonnet", max_fix_cycles: 2, max_turns: 8 },
  verification: { commands: [] },
  knowledge: {
    vault_path: "/tmp/vault",
    project_path: "AI Dev/Projects/crm",
    task_logs: "auto",
    reusable_knowledge: "ask",
  },
  ci: { mode: "local" },
} as const;

const plan: CodexPlan = {
  version: 2,
  summary: "Implement order filters",
  assumptions: [],
  files: ["src/orders.ts"],
  tests: ["tests/orders.test.ts"],
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
  summary: "Implemented order filters",
  changedFiles: ["src/orders.ts"],
  testsSuggested: ["tests/orders.test.ts"],
  residualRisks: [],
  knowledgeCandidates: [],
};

const review: ClaudeReview = {
  verdict: "PASS",
  blockers: [],
  suggestions: [],
  missingTests: [],
  knowledgeRecommendation: "log",
  riskLevel: "low",
  finalSummary: "Implementation matches the requirement.",
};

function dependencies(overrides: Partial<TaskControllerDependencies> = {}) {
  const calls = {
    implement: 0,
    complete: 0,
    block: 0,
    restore: 0,
    network: [] as boolean[],
    implementationPrompts: [] as string[],
    comments: [] as string[],
  };
  const value: TaskControllerDependencies = {
    codex: {
      async plan() {
        return { threadId: "thread-1", plan, usage: null };
      },
      async implement(input) {
        calls.implement += 1;
        calls.network.push(input.network);
        calls.implementationPrompts.push(input.prompt);
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
    claude: {
      async review() {
        return review;
      },
    },
    verification: {
      async run() {
        return { allRequiredPassed: true, commands: [] };
      },
    },
    git: {
      async collect() {
        return {
          changedFiles: ["src/orders.ts"],
          deletedFiles: [],
          renamedFiles: [],
          diff: "diff",
        };
      },
      async restoreDeleted() {
        calls.restore += 1;
      },
      async commit() {
        return "abc123";
      },
    },
    hermes: {
      async heartbeat() {},
      async comment(_taskId, text) {
        calls.comments.push(text);
      },
      async block() {
        calls.block += 1;
      },
      async complete() {
        calls.complete += 1;
      },
    },
    knowledge: {
      async writeTaskLog() {
        return "/tmp/vault/run.md";
      },
      async writeProposal() {
        return "/tmp/vault/proposal.md";
      },
      async promoteProposal() {
        return "/tmp/vault/knowledge.md";
      },
    },
    ...overrides,
  };
  return { value, calls };
}

test("runs the low-risk local workflow to a reviewed local commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  await new TaskErrorStore(store).record({
    stage: "planning",
    code: "CODEX_TIMEOUT",
    message: "Prior planning attempt timed out.",
  });
  const { value, calls } = dependencies();
  const controller = new TaskController(value);

  const runInput = {
    config: parseProjectConfig({
      ...configInput,
      codex: { ...configInput.codex, network: true },
    }),
    task: { id: "t_1", title: "Order Filters", requirement: "Add filters." },
    claim: { runId: 10, workspacePath: "/tmp/worktree" },
    store,
  };
  const outcome = await controller.run(runInput);

  assert.equal(outcome.status, "completed");
  assert.equal(calls.implement, 1);
  assert.equal(calls.complete, 1);
  assert.equal(calls.block, 0);
  assert.deepEqual(calls.network, [false]);
  assert.match(
    calls.implementationPrompts[0] ?? "",
    /The TypeScript controller owns git staging and commits/,
  );
  assert.ok(calls.comments.some((comment) => comment.includes("codex://threads/thread-1")));
  const completedState = await store.readJson<{
    stage: string;
    revision: number;
  }>("state.json");
  assert.equal(completedState.stage, "completed");
  const stateEvents = (await store.readWorkflowEvents()).filter(
    (event) => event.type === "state_changed",
  );
  assert.equal(
    stateEvents.at(-1)?.stateRevision,
    completedState.revision,
  );
  assert.equal(
    (await store.readJson<{ status: string }>("metrics.json")).status,
    "completed",
  );
  assert.deepEqual(await new TaskErrorStore(store).active(), []);
  const invalidCommand = await new OperatorControls(store).reprepare("huolin");
  assert.equal((await controller.run(runInput)).status, "completed");
  assert.equal(calls.implement, 1);
  assert.equal(
    (
      await store.readJson<{ status: string }>(
        `operator/results/${invalidCommand.commandId}.json`,
      )
    ).status,
    "rejected",
  );
});

test("blocks a high-risk plan before Codex can modify the worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_2");
  const riskyPlan: CodexPlan = {
    ...plan,
    files: ["migrations/001.sql"],
  };
  const { value, calls } = dependencies({
    codex: {
      async plan() {
        return { threadId: "thread-2", plan: riskyPlan, usage: null };
      },
      async implement() {
        throw new Error("must not implement");
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
  });
  const controller = new TaskController(value);

  const outcome = await controller.run({
    config: parseProjectConfig(configInput),
    task: { id: "t_2", title: "Migration", requirement: "Add migration." },
    claim: { runId: 11, workspacePath: "/tmp/worktree" },
    store,
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(calls.implement, 0);
  assert.equal(calls.block, 1);
  assert.equal(
    (await store.readJson<{ stage: string }>("state.json")).stage,
    "awaiting_plan_approval",
  );
});

test("blocks before implementation when a completed stage exceeds budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_budget");
  const { value, calls } = dependencies({
    codex: {
      async plan() {
        return {
          threadId: "thread-budget",
          plan,
          usage: {
            input_tokens: 101,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        };
      },
      async implement() {
        calls.implement += 1;
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
  });
  const config = parseProjectConfig(configInput);
  config.budgets = {
    maxActiveMinutes: 60,
    maxCodexInputTokens: 100,
    maxCodexOutputTokens: 100,
    warningRatio: 0.8,
  };
  const input = {
    config,
    task: {
      id: "t_budget",
      title: "Budget guard",
      requirement: "Stop before implementation.",
    },
    claim: { runId: 20, workspacePath: "/tmp/worktree" },
    store,
  };

  const outcome = await new TaskController(value).run(input);

  assert.match(outcome.reason ?? "", /budget exceeded before next stage/);
  assert.equal(calls.implement, 0);
  assert.equal(
    calls.comments.filter((comment) => comment.includes("Budget exceeded"))
      .length,
    1,
  );
  assert.equal(
    (
      await store.readJson<{ budgetStatus: string }>("metrics.json")
    ).budgetStatus,
    "exceeded",
  );
  assert.equal((await new TaskController(value).run(input)).status, "blocked");
  assert.equal(
    calls.comments.filter((comment) => comment.includes("Budget exceeded"))
      .length,
    1,
  );
});

test("binds required question answers to the approved implementation prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_answers");
  const questionPlan: CodexPlan = {
    ...plan,
    questions: [
      {
        id: "target_runtime",
        prompt: "Which runtime should be targeted?",
        required: true,
      },
    ],
  };
  const { value, calls } = dependencies({
    codex: {
      async plan() {
        return { threadId: "thread-answers", plan: questionPlan, usage: null };
      },
      async implement(input) {
        calls.implement += 1;
        calls.implementationPrompts.push(input.prompt);
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
  });
  const controller = new TaskController(value);
  const input = {
    config: parseProjectConfig(configInput),
    task: {
      id: "t_answers",
      title: "Runtime target",
      requirement: "Use the selected runtime.",
    },
    claim: { runId: 17, workspacePath: "/tmp/worktree" },
    store,
  };

  assert.equal((await controller.run(input)).status, "blocked");
  const approvalCommand = await new OperatorControls(store).approve(
    "plan",
    "huolin",
    "",
    {
      target_runtime: "Node.js 22",
    },
  );
  assert.equal((await controller.run(input)).status, "completed");
  assert.match(
    calls.implementationPrompts[0] ?? "",
    /"target_runtime": "Node\.js 22"/,
  );
  assert.equal(
    (
      await store.readJson<{ status: string }>(
        `operator/results/${approvalCommand.commandId}.json`,
      )
    ).status,
    "applied",
  );
  assert.equal((await controller.run(input)).status, "completed");
  assert.equal(calls.implement, 1);
});

test("rejects external writes even after explicit plan approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_external");
  const externalPlan: CodexPlan = {
    ...plan,
    capabilities: {
      ...plan.capabilities,
      externalWrite: true,
    },
  };
  const { value, calls } = dependencies({
    codex: {
      async plan() {
        return { threadId: "thread-external", plan: externalPlan, usage: null };
      },
      async implement() {
        calls.implement += 1;
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
  });
  const controller = new TaskController(value);
  const input = {
    config: parseProjectConfig(configInput),
    task: {
      id: "t_external",
      title: "Publish branch",
      requirement: "Push the branch.",
    },
    claim: { runId: 18, workspacePath: "/tmp/worktree" },
    store,
  };

  assert.match(
    (await controller.run(input)).reason ?? "",
    /external writes are not supported/,
  );
  const approvalCommand = await new OperatorControls(store).approve(
    "plan",
    "huolin",
  );
  assert.match(
    (await controller.run(input)).reason ?? "",
    /external writes are not supported/,
  );
  assert.equal(calls.implement, 0);
  assert.equal(
    (
      await store.readJson<{ status: string }>(
        `operator/results/${approvalCommand.commandId}.json`,
      )
    ).status,
    "rejected",
  );
});

test("returns a persisted v1 deletion plan to planning for a typed v2 plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_replan");
  await store.writeJson("state.json", {
    ...createWorkflowState("t_replan", "crm", 2),
    stage: "awaiting_plan_approval",
    codexThreadId: "legacy-thread",
  });
  await store.writeJson("codex/plan.json", {
    summary: "Delete legacy module",
    assumptions: [],
    files: ["src/legacy.ts"],
    tests: [],
    requiresNetwork: false,
    operations: ["delete_file"],
    questions: [],
    knowledgeNeeds: [],
  });
  await store.writeJson("context/manifest.json", []);
  await store.writeText("context/retrieved-context.md", "No prior context.");
  const replanned: CodexPlan = {
    ...plan,
    summary: "Delete one exact legacy module",
    files: ["src/legacy.ts"],
    fileDeletions: ["src/legacy.ts"],
  };
  let planCalls = 0;
  const { value } = dependencies({
    codex: {
      async plan() {
        planCalls += 1;
        return { threadId: "thread-v2", plan: replanned, usage: null };
      },
      async implement() {
        throw new Error("must await approval");
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
  });

  const outcome = await new TaskController(value).run({
    config: parseProjectConfig(configInput),
    task: {
      id: "t_replan",
      title: "Delete legacy module",
      requirement: "Delete src/legacy.ts.",
    },
    claim: { runId: 19, workspacePath: "/tmp/worktree" },
    store,
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(planCalls, 1);
  assert.equal(
    (await store.readJson<{ version: number }>("codex/plan.json")).version,
    2,
  );
  assert.equal(await store.exists("codex/legacy-plan-rejected.json"), true);
});

test("reviews a pure rename without requesting deletion approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_rename");
  let receivedReviewPrompt = "";
  const { value, calls } = dependencies({
    git: {
      async collect() {
        return {
          changedFiles: ["src/new.ts", "src/old.ts"],
          deletedFiles: [],
          renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }],
          diff: "renamed",
        };
      },
      async restoreDeleted() {
        calls.restore += 1;
      },
      async commit() {
        return "rename123";
      },
    },
    claude: {
      async review(input) {
        receivedReviewPrompt = input.prompt;
        return review;
      },
    },
  });

  const outcome = await new TaskController(value).run({
    config: parseProjectConfig(configInput),
    task: { id: "t_rename", title: "Rename module", requirement: "Rename it." },
    claim: { runId: 16, workspacePath: "/tmp/worktree" },
    store,
  });

  assert.equal(outcome.status, "completed");
  assert.equal(calls.restore, 0);
  assert.match(receivedReviewPrompt, /src\/old\.ts -> src\/new\.ts/);
});

test("blocks unapproved file deletions discovered after implementation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_3");
  const { value, calls } = dependencies({
    git: {
      async collect() {
        return {
          changedFiles: ["src/legacy.ts"],
          deletedFiles: ["src/legacy.ts"],
          renamedFiles: [],
          diff: "deleted",
        };
      },
      async restoreDeleted(_cwd, paths) {
        assert.deepEqual(paths, ["src/legacy.ts"]);
        calls.restore += 1;
      },
      async commit() {
        throw new Error("must not commit");
      },
    },
  });
  const controller = new TaskController(value);

  const outcome = await controller.run({
    config: parseProjectConfig(configInput),
    task: { id: "t_3", title: "Cleanup", requirement: "Refactor." },
    claim: { runId: 12, workspacePath: "/tmp/worktree" },
    store,
  });

  assert.equal(outcome.status, "blocked");
  assert.equal(calls.block, 1);
  assert.equal(calls.complete, 0);
  assert.equal(calls.restore, 1);
});

test("allows only deletions bound to the explicitly approved plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_4");
  const deletionPlan: CodexPlan = {
    ...plan,
    files: ["src/legacy.ts"],
    fileDeletions: ["src/legacy.ts"],
  };
  const { value, calls } = dependencies({
    codex: {
      async plan() {
        return { threadId: "thread-4", plan: deletionPlan, usage: null };
      },
      async implement() {
        calls.implement += 1;
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
    git: {
      async collect() {
        return {
          changedFiles: ["src/legacy.ts"],
          deletedFiles: ["src/legacy.ts"],
          renamedFiles: [],
          diff: "deleted",
        };
      },
      async restoreDeleted() {
        calls.restore += 1;
      },
      async commit() {
        return "delete123";
      },
    },
  });
  const controller = new TaskController(value);
  const input = {
    config: parseProjectConfig(configInput),
    task: { id: "t_4", title: "Delete legacy", requirement: "Delete legacy." },
    claim: { runId: 13, workspacePath: "/tmp/worktree" },
    store,
  };

  assert.equal((await controller.run(input)).status, "blocked");
  await new OperatorControls(store).approve("plan", "huolin");
  assert.equal((await controller.run(input)).status, "completed");
  assert.equal(calls.restore, 0);
});

test("restores and blocks multiple deletions even when the plan was approved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const store = new ArtifactStore(root, "crm", "t_5");
  const deletionPlan: CodexPlan = {
    ...plan,
    files: ["src/legacy-a.ts", "src/legacy-b.ts"],
    fileDeletions: ["src/legacy-a.ts"],
  };
  const { value, calls } = dependencies({
    codex: {
      async plan() {
        return { threadId: "thread-5", plan: deletionPlan, usage: null };
      },
      async implement() {
        calls.implement += 1;
        return { ...implementation, usage: null };
      },
      desktopThreadUrl(id) {
        return `codex://threads/${id}`;
      },
    },
    git: {
      async collect() {
        return {
          changedFiles: [...deletionPlan.files],
          deletedFiles: [...deletionPlan.files],
          renamedFiles: [],
          diff: "deleted two files",
        };
      },
      async restoreDeleted(_cwd, paths) {
        calls.restore += 1;
        assert.deepEqual(paths, deletionPlan.files);
      },
      async commit() {
        throw new Error("must not commit");
      },
    },
  });
  const controller = new TaskController(value);
  const input = {
    config: parseProjectConfig(configInput),
    task: { id: "t_5", title: "Delete old files", requirement: "Cleanup." },
    claim: { runId: 14, workspacePath: "/tmp/worktree" },
    store,
  };

  assert.equal((await controller.run(input)).status, "blocked");
  await new OperatorControls(store).approve("plan", "huolin");
  const outcome = await controller.run(input);

  assert.equal(outcome.status, "blocked");
  assert.match(outcome.reason ?? "", /batch deletion/);
  assert.equal(calls.restore, 1);
});

test("promotes a digest-approved knowledge proposal before completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controller-"));
  const vault = await mkdtemp(path.join(os.tmpdir(), "ai-dev-vault-"));
  const store = new ArtifactStore(root, "crm", "t_6");
  const knowledge = new KnowledgeWriter({
    vaultPath: vault,
    projectPath: "AI Dev/Projects/crm",
  });
  const { value, calls } = dependencies({
    claude: {
      async review() {
        return {
          ...review,
          knowledgeRecommendation: "rule",
        };
      },
    },
    knowledge,
  });
  const controller = new TaskController(value);
  const input = {
    config: parseProjectConfig({
      ...configInput,
      knowledge: {
        ...configInput.knowledge,
        vault_path: vault,
      },
    }),
    task: { id: "t_6", title: "Order rule", requirement: "Add order rule." },
    claim: { runId: 15, workspacePath: "/tmp/worktree" },
    store,
  };

  assert.equal((await controller.run(input)).status, "blocked");
  await new OperatorControls(store).approve("knowledge", "huolin");
  assert.equal((await controller.run(input)).status, "completed");

  const promoted = await store.readJson<{ path: string }>(
    "knowledge/promoted.json",
  );
  assert.match(await readFile(promoted.path, "utf8"), /status: approved/);
  assert.equal(calls.complete, 1);
});
