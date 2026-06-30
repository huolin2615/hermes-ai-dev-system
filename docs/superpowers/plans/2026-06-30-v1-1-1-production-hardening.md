# Hermes AI Dev V1.1.1 Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the currently working V1 local loop into a crash-recoverable, auditable single-user production loop that passes two real smoke tasks without unplanned human repair.

**Architecture:** Preserve Hermes as the task authority and make the TypeScript worker the sole workflow-state writer. Replace free-form plan risk data, process-local event sequencing, direct operator state mutation, and overwrite-style errors with typed immutable records. Keep Codex, Claude, Git and knowledge implementations behind their existing adapters.

**Tech Stack:** TypeScript 6, Node.js 22, Zod 4, `@openai/codex-sdk`, Hermes CLI, Claude Code CLI, Node test runner, YAML.

---

## Execution constraints

- Start from commit `172afec`.
- Preserve all current unstaged changes. In particular, do not restore the two deleted `2026-06-29-git-rename-classification` documents and do not overwrite the in-progress Git/Claude smoke fixes.
- Stage and commit only the files named by the current task.
- Do not push, merge, install a service, clean worktrees, or delete artifacts.
- Run commands with argv semantics; do not introduce shell-string verification commands.
- Use `env CI=true pnpm test` for the full test suite and `env CI=true pnpm check` for the final gate.

## Target file map

- `src/workflow/plan-contract.ts`: versioned Codex plan schemas and migration.
- `src/workflow/review-policy.ts`: deterministic Claude verdict normalization.
- `src/workflow/state.ts`: workflow state v2 and v1 migration.
- `src/artifacts/store.ts`: typed UUID event records.
- `src/operator/commands.ts`: immutable operator command queue.
- `src/operator/controls.ts`: command producer; no state writes.
- `src/artifacts/errors.ts`: append-only active/resolved error records.
- `src/artifacts/metrics.ts`: stage timing, usage and budget evaluation.
- `src/runtime/repo-lease.ts`: non-deleting per-repository write lease.
- `src/cleanup/retention.ts`: retention warnings and cleanup proposals.
- `src/runtime/audit.ts`: task invariant audit used by smoke acceptance.
- Existing controller, worker, service, CLI and tests integrate these units.

### Task 1: Finish the in-flight Git evidence and Claude output fixes

**Files:**
- Modify: `src/git/adapter.ts`
- Modify: `src/claude/adapter.ts`
- Modify: `src/workflow/controller.ts`
- Create: `src/workflow/review-policy.ts`
- Modify: `tests/git-adapter.test.ts`
- Modify: `tests/claude-adapter.test.ts`
- Modify: `tests/task-controller.test.ts`

- [x] **Step 1: Add committed rename and deletion evidence tests**

Add tests that exercise `collect(cwd, "main")` with null-separated Git output:

```ts
test("classifies committed renames against the configured base branch", async () => {
  const adapter = new GitAdapter(async ({ argv }) => {
    if (argv.includes("status")) return result("");
    if (argv.includes("--name-status")) {
      return result("R100\u0000src/old-name.ts\u0000src/new-name.ts\u0000");
    }
    return result("diff --git a/src/old-name.ts b/src/new-name.ts\n");
  });

  const facts = await adapter.collect("/tmp/worktree", "main");

  assert.deepEqual(facts.changedFiles, [
    "src/new-name.ts",
    "src/old-name.ts",
  ]);
  assert.deepEqual(facts.deletedFiles, []);
  assert.deepEqual(facts.renamedFiles, [{
    from: "src/old-name.ts",
    to: "src/new-name.ts",
  }]);
});
```

Run:

```bash
env CI=true pnpm test:compile
node --test .test-dist/tests/git-adapter.test.js
```

Expected: the new rename test fails until base-ref collection is complete.

- [x] **Step 2: Complete base-ref collection without test casts**

Expose this exact public method:

```ts
async collect(cwd: string, baseRef = "HEAD"): Promise<GitFacts>
```

Collect and merge:

```ts
git status --porcelain=v1 -z
git diff --name-status -z --find-renames <baseRef>
git diff --binary <baseRef>
```

Reject truncated or malformed rename output. Record explicit `R` entries in
`renamedFiles`, include both paths in `changedFiles`, and keep both paths out of
`deletedFiles`; only explicit `D` entries enter the deletion approval gate. Pass
`config.repo.baseBranch` from every controller collection and deletion
restoration call. Remove the temporary `as unknown as` cast from the test.

- [x] **Step 3: Add Claude semantic consistency tests**

Add:

```ts
test("turns pass-with-comments plus blockers into BLOCK", async () => {
  const review = await new ClaudeReviewAdapter(async () =>
    success(JSON.stringify({
      structured_output: {
        verdict: "PASS_WITH_COMMENTS",
        blockers: [{
          id: "MISSING_COMMIT",
          severity: "high",
          file: null,
          line: null,
          evidence: "Required commit is missing.",
          requiredFix: "Create the controller-owned commit.",
        }],
        suggestions: [],
        missingTests: [],
        knowledgeRecommendation: "none",
        riskLevel: "medium",
        finalSummary: "Implementation has one blocker.",
      },
    })),
  ).review({
    cwd: "/tmp/worktree",
    prompt: "Review bundle",
    model: "sonnet",
    maxTurns: 8,
  });

  assert.equal(review.verdict, "BLOCK");
});
```

Also preserve tests for direct objects, JSON-encoded strings, fenced JSON and one normalization retry.

- [x] **Step 4: Extract deterministic review normalization**

Create `src/workflow/review-policy.ts`:

```ts
import type { ClaudeReview } from "../claude/adapter.js";

export function normalizeReviewVerdict(review: ClaudeReview): ClaudeReview {
  if (review.blockers.length === 0) return review;
  return { ...review, verdict: "BLOCK" };
}
```

Apply it after Zod validation in `ClaudeReviewAdapter`. Do not perform a third Claude call. If the initial parse and single normalization call both fail, throw with the schema issues and persist the raw CLI output through the worker error path.

- [x] **Step 5: Verify and commit only the smoke-fix files**

Run:

```bash
env CI=true pnpm test
```

Expected: all tests pass.

Commit:

```bash
git add src/git/adapter.ts src/claude/adapter.ts src/workflow/controller.ts src/workflow/review-policy.ts tests/git-adapter.test.ts tests/claude-adapter.test.ts
git commit -m "fix: harden git evidence and claude review parsing"
```

### Task 2: Introduce the typed Codex plan v2 contract

**Files:**
- Create: `src/workflow/plan-contract.ts`
- Modify: `src/codex/adapter.ts`
- Modify: `src/operator/controls.ts`
- Modify: `src/workflow/controller.ts`
- Modify: `src/runtime/service.ts`
- Modify: `src/mcp.ts`
- Modify: `src/cli.ts`
- Test: `tests/plan-contract.test.ts`
- Modify: `tests/codex-adapter.test.ts`
- Modify: `tests/operator-controls.test.ts`
- Modify: `tests/task-controller.test.ts`
- Modify: `tests/mcp.test.ts`

- [x] **Step 1: Write plan migration and validation tests**

Create tests for:

```ts
test("migrates a v1 plan to typed v2 capabilities", () => {
  const migrated = parseCodexPlan({
    summary: "Change one file",
    assumptions: [],
    files: ["src/app.ts"],
    tests: ["pnpm test"],
    requiresNetwork: false,
    operations: [],
    questions: [],
    knowledgeNeeds: [],
  });

  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.capabilities, {
    network: false,
    dependencyInstall: false,
    externalWrite: false,
  });
  assert.deepEqual(migrated.fileDeletions, []);
});

test("rejects more than one requested deletion", () => {
  assert.throws(
    () => parseCodexPlan({
      version: 2,
      summary: "Delete old files",
      assumptions: [],
      files: ["a.ts", "b.ts"],
      tests: [],
      capabilities: {
        network: false,
        dependencyInstall: false,
        externalWrite: false,
      },
      fileDeletions: ["a.ts", "b.ts"],
      questions: [],
      knowledgeNeeds: [],
    }),
    /at most 1/,
  );
});
```

Run the new test and confirm failure because `parseCodexPlan` does not exist.

- [x] **Step 2: Implement the versioned plan contract**

Export:

```ts
export interface CodexPlanV2 {
  version: 2;
  summary: string;
  assumptions: string[];
  files: string[];
  tests: string[];
  capabilities: {
    network: boolean;
    dependencyInstall: boolean;
    externalWrite: boolean;
  };
  fileDeletions: string[];
  questions: Array<{
    id: string;
    prompt: string;
    required: true;
  }>;
  knowledgeNeeds: string[];
}

export function parseCodexPlan(input: unknown): CodexPlanV2;
export function codexPlanJsonSchema(): Record<string, unknown>;
export function digestCodexPlan(plan: CodexPlanV2): string;
```

The v1 migration maps recognized capability strings only. It never infers a deletion target from the general `files` list:

```ts
const dependencyInstall = operations.includes("install_dependency");
const externalWrite = operations.some((operation) =>
  ["push", "create_pr", "deploy", "external_write"].includes(operation),
);
const fileDeletions: string[] = [];
```

Do not infer approval from descriptive operation sentences. A persisted v1 plan that requested deletion must return to planning and produce a v2 plan with one exact deletion path.

- [x] **Step 3: Update Codex prompts and adapter output**

Use `codexPlanJsonSchema()` in `CodexAdapter.plan`. Add this instruction to the plan and implementation prompts:

```text
The TypeScript controller owns git staging and commits.
Do not run git add, git commit, git push, merge, deploy, or write the knowledge vault.
Declare requested network, dependency installation, external writes, and one exact file deletion through the typed fields only.
```

The controller must reject `externalWrite=true` in V1.1.1 even after plan approval.

- [x] **Step 4: Bind required question answers to approval**

Change plan approval input:

```ts
interface PlanApprovalPayload {
  planDigest: string;
  answersDigest: string;
  approvedBy: string;
  approvedAt: string;
  answers: Record<string, string>;
}
```

Validation:

```ts
for (const question of plan.questions) {
  if (!approval.answers[question.id]?.trim()) {
    throw new Error(`missing answer for required plan question: ${question.id}`);
  }
}
```

Append the answers to the implementation prompt under `# Approved answers`.
Compute `answersDigest` from the key-sorted answer map and reject the command or
persisted approval when the digest does not match.

- [x] **Step 5: Verify and commit**

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/workflow/plan-contract.ts src/codex/adapter.ts src/operator/controls.ts src/workflow/controller.ts tests/plan-contract.test.ts tests/codex-adapter.test.ts tests/operator-controls.test.ts
git commit -m "feat: add typed codex plan approvals"
```

### Task 3: Upgrade workflow state and event records

**Files:**
- Modify: `src/workflow/state.ts`
- Modify: `src/artifacts/store.ts`
- Modify: `src/workflow/controller.ts`
- Modify: `tests/workflow-state.test.ts`
- Modify: `tests/artifacts.test.ts`
- Modify: `tests/task-controller.test.ts`

- [x] **Step 1: Write v1 migration and event uniqueness tests**

Add:

```ts
test("migrates v1 state and starts revision at zero", () => {
  const state = parseWorkflowState({
    version: 1,
    taskId: "t_1",
    projectId: "crm",
    stage: "planning",
    repairAttempts: 0,
    maxFixCycles: 2,
    updatedAt: "2026-06-30T00:00:00.000Z",
  });

  assert.equal(state.version, 2);
  assert.equal(state.revision, 0);
});

test("event identity does not depend on process-local sequence", async () => {
  const first = new ArtifactStore(root, "crm", "t_1");
  const second = new ArtifactStore(root, "crm", "t_1");
  await Promise.all([
    first.appendWorkflowEvent("worker", 1, "state_changed", {}),
    second.appendWorkflowEvent("operator", 1, "pause_requested", {}),
  ]);
  const events = await first.readWorkflowEvents();
  assert.equal(new Set(events.map((event) => event.eventId)).size, 2);
});
```

- [x] **Step 2: Implement state v2**

Export:

```ts
export interface WorkflowState {
  version: 2;
  revision: number;
  taskId: string;
  projectId: string;
  stage: WorkflowStage;
  codexThreadId?: string;
  repairAttempts: number;
  maxFixCycles: number;
  blockedReason?: string;
  blockedFrom?: Exclude<WorkflowStage, "blocked" | "completed">;
  updatedAt: string;
}

export function parseWorkflowState(input: unknown): WorkflowState;
```

Every reducer result increments `revision` exactly once:

```ts
return {
  ...state,
  ...patch,
  revision: state.revision + 1,
  updatedAt: new Date().toISOString(),
};
```

- [x] **Step 3: Replace sequence events with UUID events**

Add to `ArtifactStore`:

```ts
export interface WorkflowEventRecord {
  eventId: string;
  timestamp: string;
  actor: "worker" | "operator" | "hermes";
  stateRevision: number;
  type: string;
  payload: Record<string, unknown>;
}

async appendWorkflowEvent(
  actor: "worker" | "operator" | "hermes",
  stateRevision: number,
  type: string,
  payload: Record<string, unknown>,
): Promise<WorkflowEventRecord>;

async readWorkflowEvents(): Promise<WorkflowEventRecord[]>;
```

Generate `eventId` with `randomUUID()`. Preserve legacy event lines when reading by assigning a deterministic synthetic identity:

```ts
eventId: `legacy-${record.timestamp}-${record.sequence ?? index}`
```

Sort by timestamp and then eventId.

- [x] **Step 4: Integrate state parsing and events**

`TaskController.readState` must call `parseWorkflowState`. `persist` writes state first and then appends an event with the new revision. Do not rewrite old `events.jsonl`.

- [x] **Step 5: Verify and commit**

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/workflow/state.ts src/artifacts/store.ts src/workflow/controller.ts tests/workflow-state.test.ts tests/artifacts.test.ts
git commit -m "feat: version workflow state and events"
```

### Task 4: Make operator actions an immutable command queue

**Files:**
- Create: `src/operator/commands.ts`
- Modify: `src/operator/controls.ts`
- Modify: `src/runtime/service.ts`
- Modify: `src/workflow/controller.ts`
- Modify: `src/mcp.ts`
- Modify: `src/cli.ts`
- Modify: `src/artifacts/store.ts`
- Modify: `README.md`
- Test: `tests/operator-commands.test.ts`
- Test: `tests/cli.test.ts`
- Modify: `tests/operator-controls.test.ts`
- Modify: `tests/task-controller.test.ts`

- [x] **Step 1: Write queue ordering and idempotency tests**

Create:

```ts
test("returns only commands without a result in stable order", async () => {
  const queue = new OperatorCommandQueue(store);
  const pause = await queue.enqueue({
    type: "pause",
    requestedBy: "huolin",
    payload: {},
  });
  const resume = await queue.enqueue({
    type: "resume",
    requestedBy: "huolin",
    payload: {},
  });
  await queue.complete(pause.commandId, "applied", { stateRevision: 4 });

  const pending = await queue.pending();
  assert.deepEqual(pending.map((command) => command.commandId), [
    resume.commandId,
  ]);
});
```

Run and confirm failure because the queue does not exist.

- [x] **Step 2: Implement immutable command and result files**

Export:

```ts
export type OperatorCommandType =
  | "approve_plan"
  | "approve_knowledge"
  | "pause"
  | "resume"
  | "retry"
  | "reprepare"
  | "rereview";

export interface OperatorCommand {
  commandId: string;
  type: OperatorCommandType;
  requestedBy: string;
  requestedAt: string;
  payload: Record<string, unknown>;
}

export interface OperatorCommandResult {
  commandId: string;
  status: "applied" | "rejected";
  stateRevision: number;
  detail: Record<string, unknown>;
  completedAt: string;
}

export class OperatorCommandQueue {
  enqueue(input: Omit<OperatorCommand, "commandId" | "requestedAt">):
    Promise<OperatorCommand>;
  pending(): Promise<OperatorCommand[]>;
  complete(
    commandId: string,
    status: "applied" | "rejected",
    detail: Record<string, unknown>,
  ): Promise<void>;
}
```

Write commands to `operator/commands/<commandId>.json` and results to `operator/results/<commandId>.json`. Never delete either file.

- [x] **Step 3: Make controls enqueue only**

`OperatorControls` must not read or write `state.json`. Its methods validate input, snapshot required digests, and enqueue commands.

Plan approval CLI adds:

```text
--answers-file /absolute/path/to/answers.json
```

The JSON object maps question IDs to non-empty answers. An empty questions list accepts an omitted answers file.

- [x] **Step 4: Consume commands at workflow boundaries**

At the top of every controller loop:

```ts
interface AppliedOperatorCommand {
  state: WorkflowState;
  status: "applied" | "rejected";
  detail: Record<string, unknown>;
}

function applyOperatorCommand(
  state: WorkflowState,
  command: OperatorCommand,
  plan: CodexPlanV2 | undefined,
  knowledgeProposal: { path: string; digest: string } | undefined,
): AppliedOperatorCommand;

for (const command of await commandQueue.pending()) {
  const result = applyOperatorCommand(state, command, plan, knowledgeProposal);
  state = result.state;
  await persist(store, state);
  await commandQueue.complete(command.commandId, result.status, result.detail);
}
```

Repeated controller runs see the result and do not reapply a command. Invalid stage commands produce a rejected result and leave state unchanged.

- [x] **Step 5: Update service and MCP responses**

Return `{ commandId, status: "queued" }` from operator actions. Hermes unblock happens only after a valid resume/retry/approval command is queued.

- [x] **Step 6: Verify and commit**

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/operator/commands.ts src/operator/controls.ts src/runtime/service.ts src/workflow/controller.ts src/mcp.ts src/cli.ts tests/operator-commands.test.ts tests/operator-controls.test.ts tests/task-controller.test.ts
git commit -m "feat: queue immutable operator commands"
```

### Task 5: Add config v2 budgets and retention defaults

**Files:**
- Modify: `src/config/project.ts`
- Modify: `config/projects/example.yaml.disabled`
- Modify: `config/projects/simple-todo-web.yaml`
- Modify: `tests/config.test.ts`

- [x] **Step 1: Write version compatibility tests**

Add:

```ts
test("normalizes v1 config with hardening defaults", () => {
  const config = parseProjectConfig(validV1Config);
  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.budgets, {
    maxActiveMinutes: 60,
    maxCodexInputTokens: 5_000_000,
    maxCodexOutputTokens: 50_000,
    warningRatio: 0.8,
  });
  assert.deepEqual(config.retention, {
    taskArtifactsDays: 30,
    warnBeforeDays: 7,
  });
});

test("rejects a warning ratio outside zero and one", () => {
  assert.throws(
    () => parseProjectConfig({
      ...validV2Config,
      budgets: { ...validV2Config.budgets, warning_ratio: 1.2 },
    }),
    /warning_ratio/,
  );
});
```

- [x] **Step 2: Extend the normalized project config**

Normalize both file versions to:

```ts
interface ProjectConfig {
  schemaVersion: 2;
  // existing fields remain
  budgets: {
    maxActiveMinutes: number;
    maxCodexInputTokens: number;
    maxCodexOutputTokens: number;
    warningRatio: number;
  };
  retention: {
    taskArtifactsDays: number;
    warnBeforeDays: number;
  };
}
```

Use the defaults asserted above. Require `warnBeforeDays < taskArtifactsDays`.

- [x] **Step 3: Update examples**

Add:

```yaml
budgets:
  max_active_minutes: 60
  max_codex_input_tokens: 5000000
  max_codex_output_tokens: 50000
  warning_ratio: 0.8

retention:
  task_artifacts_days: 30
  warn_before_days: 7
```

Do not change repository paths or verification commands in `simple-todo-web.yaml`.

- [x] **Step 4: Verify and commit** — verification passed; included in the consolidated V1.1.1 hardening commit.

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/config/project.ts config/projects/example.yaml.disabled config/projects/simple-todo-web.yaml tests/config.test.ts
git commit -m "feat: configure task budgets and retention"
```

### Task 6: Add active/resolved errors and stage metrics

**Files:**
- Create: `src/artifacts/errors.ts`
- Create: `src/artifacts/metrics.ts`
- Modify: `src/workflow/controller.ts`
- Modify: `src/runtime/worker.ts`
- Modify: `src/runtime/service.ts`
- Test: `tests/errors.test.ts`
- Test: `tests/metrics.test.ts`
- Modify: `tests/task-controller.test.ts`
- Modify: `tests/worker.test.ts`
- Modify: `tests/mcp.test.ts`

- [x] **Step 1: Write append-only error lifecycle tests**

Create:

```ts
test("completed recovery resolves the prior active error", async () => {
  const errors = new TaskErrorStore(store);
  const recorded = await errors.record({
    stage: "reviewing",
    code: "CLAUDE_INVALID_OUTPUT",
    message: "Expected object.",
  });
  assert.equal((await errors.active()).length, 1);

  await errors.resolve(recorded.errorId, "review succeeded on retry");

  assert.deepEqual(await errors.active(), []);
  assert.match(
    (await errors.history())[0]?.resolvedAt ?? "",
    /^\d{4}-\d{2}-\d{2}T/,
  );
});
```

- [x] **Step 2: Implement error records**

Write immutable records to:

```text
errors/<errorId>.json
errors/resolutions/<errorId>.json
```

`active()` subtracts IDs with a resolution file. Do not overwrite or delete the legacy `error.json`; status ignores it after the migration.

Export:

```ts
export interface TaskErrorRecord {
  errorId: string;
  stage: WorkflowStage;
  code: string;
  message: string;
  occurredAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export class TaskErrorStore {
  record(input: Omit<TaskErrorRecord, "errorId" | "occurredAt">):
    Promise<TaskErrorRecord>;
  resolve(errorId: string, resolution: string): Promise<void>;
  active(): Promise<TaskErrorRecord[]>;
  history(): Promise<TaskErrorRecord[]>;
}
```

- [x] **Step 3: Write stage metrics and budget tests**

Add:

```ts
test("excludes operator wait time from active duration", async () => {
  const metrics = new TaskMetrics(store, config.budgets, fakeClock);
  await metrics.startStage("planning");
  fakeClock.advance(1_000);
  await metrics.finishStage("planning", { inputTokens: 100, outputTokens: 10 });
  await metrics.startOperatorWait("plan");
  fakeClock.advance(10_000);
  await metrics.finishOperatorWait("plan");

  const summary = await metrics.summary();
  assert.equal(summary.activeDurationMs, 1_000);
  assert.equal(summary.operatorWaitDurationMs, 10_000);
});
```

- [x] **Step 4: Implement stage metrics and budget evaluation**

Use immutable stage attempt records:

```ts
interface StageMetric {
  metricId: string;
  stage: WorkflowStage;
  attempt: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  claudeCalls: number;
  claudeNormalizations: number;
}
```

Return budget status:

```ts
export type BudgetStatus = "ok" | "warning" | "exceeded";

export class TaskMetrics {
  startStage(stage: WorkflowStage): Promise<void>;
  finishStage(
    stage: WorkflowStage,
    usage?: {
      inputTokens: number;
      cachedInputTokens?: number;
      outputTokens: number;
      reasoningTokens?: number;
      claudeCalls?: number;
      claudeNormalizations?: number;
    },
  ): Promise<StageMetric>;
  startOperatorWait(gate: string): Promise<void>;
  finishOperatorWait(gate: string): Promise<void>;
  summary(): Promise<{
    activeDurationMs: number;
    operatorWaitDurationMs: number;
    claudeCalls: number;
    claudeNormalizations: number;
    verificationDurationMs: number;
    budgetStatus: BudgetStatus;
  }>;
}
```

Check budget after each stage. `warning` appends an event and Hermes comment once per metric type. `exceeded` blocks before starting the next stage.

- [x] **Step 5: Integrate worker errors and status**

Worker exceptions call `TaskErrorStore.record`. A successful retry of the same stage resolves active errors for that stage. `TaskStatus` returns:

```ts
activeErrors: TaskErrorRecord[];
budgetStatus: BudgetStatus;
activeDurationMs: number;
operatorWaitDurationMs: number;
```

- [x] **Step 6: Verify and commit** — verification passed; included in the consolidated V1.1.1 hardening commit.

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/artifacts/errors.ts src/artifacts/metrics.ts src/workflow/controller.ts src/runtime/worker.ts src/runtime/service.ts tests/errors.test.ts tests/metrics.test.ts tests/task-controller.test.ts
git commit -m "feat: track task errors metrics and budgets"
```

### Task 7: Serialize repository writes with a non-deleting lease

**Files:**
- Create: `src/runtime/repo-lease.ts`
- Modify: `src/runtime/worker.ts`
- Modify: `src/runtime/doctor.ts`
- Modify: `src/runtime/service.ts`
- Modify: `src/cli.ts`
- Test: `tests/repo-lease.test.ts`
- Modify: `tests/worker.test.ts`
- Modify: `tests/doctor.test.ts`

- [x] **Step 1: Write lease contention and release tests**

Create:

```ts
test("only one task can own a repository write lease", async () => {
  const first = new RepoWriteLease(root, "crm");
  const second = new RepoWriteLease(root, "crm");

  const owner = await first.acquire("t_1", 101);
  await assert.rejects(second.acquire("t_2", 202), /lease is held/);

  await first.release(owner);
  const next = await second.acquire("t_2", 202);
  assert.equal(next.taskId, "t_2");
});
```

Assert that release uses rename and leaves `repo.lease.available` present.

- [x] **Step 2: Implement the atomic rename lease**

Store leases under:

```text
<runtime>/leases/<project-id>/repo.lease.available
<runtime>/leases/<project-id>/repo.lease.<task-id>.<pid>
```

On first initialization, create `repo.lease.available` with `writeFile(..., { flag: "wx" })`. Acquire renames available to owner. Release renames the exact owner back to available. No remove, unlink or recursive operation is allowed.

Use:

```ts
export interface RepoLeaseOwner {
  projectId: string;
  taskId: string;
  pid: number;
  acquiredAt: string;
  ownerPath: string;
}

export class RepoWriteLease {
  acquire(taskId: string, pid: number): Promise<RepoLeaseOwner>;
  release(owner: RepoLeaseOwner): Promise<void>;
  diagnose(taskRunActive?: boolean): Promise<LeaseDiagnosis>;
  reclaimStale(
    owner: RepoLeaseOwner,
    approvedBy: string,
    taskRunActive: boolean,
  ): Promise<RepoLeaseOwner>;
}
```

`reclaimStale` first proves `processAlive=false` and the Hermes task run is not
active, writes an immutable audit record under `leases/reclaims/<uuid>.json`,
then renames the exact owner file back to `repo.lease.available`.

- [x] **Step 3: Integrate worker acquisition**

Order:

1. list ready task
2. acquire lease using task ID
3. claim Hermes task
4. run controller
5. release in `finally`

If claim fails, release immediately. If lease is held, leave the task ready and continue scanning another project.

- [x] **Step 4: Add doctor stale reporting**

Doctor reports:

```ts
interface LeaseDiagnosis {
  projectId: string;
  ownerTaskId: string;
  pid: number;
  processAlive: boolean;
  stale: boolean;
}
```

`stale=true` only when the PID does not exist and Hermes confirms the task run is
not active. Doctor never reclaims the lease.

- [x] **Step 5: Add explicit stale lease reclaim**

Add:

```bash
node dist/cli.js lease-reclaim \
  --project simple-todo-web \
  --owner-task t_45d8a6dd \
  --by huolin
```

The command rejects a live PID, an active Hermes run, a mismatched owner task,
or a non-stale diagnosis. It never deletes a lock file.

- [x] **Step 6: Verify and commit** — verification passed; included in the consolidated V1.1.1 hardening commit.

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/runtime/repo-lease.ts src/runtime/worker.ts src/runtime/doctor.ts src/runtime/service.ts src/cli.ts tests/repo-lease.test.ts tests/worker.test.ts tests/doctor.test.ts
git commit -m "feat: serialize repository write tasks"
```

### Task 8: Add retention warnings and a task invariant audit

**Files:**
- Create: `src/cleanup/retention.ts`
- Create: `src/runtime/audit.ts`
- Modify: `src/runtime/service.ts`
- Modify: `src/runtime/doctor.ts`
- Modify: `src/cli.ts`
- Test: `tests/retention.test.ts`
- Test: `tests/audit.test.ts`

- [x] **Step 1: Write retention classification tests**

Add:

```ts
test("warns before expiry without creating a cleanup request", async () => {
  const result = classifyRetention({
    completedAt: "2026-06-01T00:00:00.000Z",
    now: new Date("2026-06-25T00:00:00.000Z"),
    taskArtifactsDays: 30,
    warnBeforeDays: 7,
  });
  assert.equal(result.status, "warning");
  assert.equal(result.daysRemaining, 6);
});
```

No retention function may call `CleanupApprovalStore.execute`.

- [x] **Step 2: Implement retention reporting**

Return:

```ts
interface RetentionStatus {
  status: "retained" | "warning" | "expired";
  daysRemaining: number;
  artifactPath: string;
}
```

`doctor` lists warnings and expired task roots. The operator must still create one cleanup request for one exact worktree or file.

- [x] **Step 3: Write invariant audit tests**

Add:

```ts
test("fails a completed task with active errors or pending commands", async () => {
  const report = await auditTask(store);
  assert.deepEqual(report.violations.map((item) => item.code), [
    "COMPLETED_WITH_ACTIVE_ERROR",
    "COMPLETED_WITH_PENDING_COMMAND",
  ]);
  assert.equal(report.ok, false);
});
```

- [x] **Step 4: Implement task audit**

Audit:

- state parses as v2
- event IDs unique
- event revisions never exceed state revision
- completed state has manifest and summary
- completed state has no active error
- completed state has no pending command
- no unresolved deletion request
- manifest commit resolves in worktree
- changed files equal Git evidence against base branch
- budget summary exists

Export:

```ts
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

export function auditTask(
  store: ArtifactStore,
  input: {
    worktreePath: string;
    baseBranch: string;
  },
): Promise<TaskAuditReport>;
```

Expose:

```bash
node dist/cli.js audit --project simple-todo-web --task <task-id>
```

Exit 0 only when `report.ok=true`.

- [x] **Step 5: Verify and commit** — verification passed; included in the consolidated V1.1.1 hardening commit.

Run:

```bash
env CI=true pnpm test
```

Commit:

```bash
git add src/cleanup/retention.ts src/runtime/audit.ts src/runtime/service.ts src/runtime/doctor.ts src/cli.ts tests/retention.test.ts tests/audit.test.ts
git commit -m "feat: audit task invariants and retention"
```

### Task 9: Add crash-recovery integration coverage

**Files:**
- Create: `tests/recovery.test.ts`
- Modify: `tests/task-controller.test.ts`

- [x] **Step 1: Build a fault-injectable dependency harness**

Use:

```ts
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
```

Adapters count calls and persist their normal artifacts before the injected crash point.

- [x] **Step 2: Test restart from every durable stage**

Generate one test case for:

```ts
const restartStages: WorkflowStage[] = [
  "planning",
  "implementing",
  "verifying",
  "reviewing",
  "knowledge",
  "finalizing",
];
```

For each stage:

1. run until injected crash
2. construct a new controller and artifact store instance
3. run again
4. assert completed
5. assert implementation, Review, knowledge promotion and commit counts never exceed their valid attempt counts

- [x] **Step 3: Test command replay**

Queue the same command file, restart before writing its result, and verify state revision advances once. The second run writes or recognizes the same command result without applying the transition twice.

- [x] **Step 4: Verify and commit** — verification passed; included in the consolidated V1.1.1 hardening commit.

Run:

```bash
env CI=true pnpm test:compile
node --test .test-dist/tests/recovery.test.js
env CI=true pnpm test
```

Commit:

```bash
git add tests/recovery.test.ts tests/task-controller.test.ts
git commit -m "test: cover workflow crash recovery"
```

### Task 10: Run the production hardening acceptance gate

**Files:**
- Modify: `docs/operations.md`
- Modify: `docs/roadmap-status.md`
- Create: `docs/smoke-v1.1.1.md`

- [x] **Step 1: Run the complete automated gate**

Run:

```bash
env CI=true pnpm check
node dist/cli.js doctor --config-dir config/projects --runtime-dir .ai-dev
```

Expected:

- typecheck exit 0
- all tests pass
- production build exit 0
- doctor reports compatible Hermes, Codex SDK/CLI, Claude, Node and project config
- an idle worker may be absent; record that as operational status, not a compatibility failure

- [x] **Step 2: Run smoke task A**

Submit a small low-risk feature to `simple-todo-web` using a unique idempotency key. Run the worker until it either awaits plan approval or completes. If approval is requested, answer every plan question through `--answers-file`.

Acceptance:

- task completes
- no reprepare, rereview or retry command is needed
- audit exits 0
- one controller-owned local commit is recorded
- no push, PR, merge or deployment occurs

- [x] **Step 3: Run smoke task B**

Submit a second independent low-risk feature with a new idempotency key and repeat the same flow.

Acceptance:

- second task also completes without unplanned operator repair
- its event IDs do not overlap task A
- repository lease is available after completion
- active error list is empty
- stage metrics separate active and operator-wait time

- [x] **Step 4: Document exact evidence**

Write `docs/smoke-v1.1.1.md` with:

- task IDs
- Codex thread links
- worktree paths
- final commit SHAs
- audit JSON summaries
- stage durations
- model usage
- approvals requested
- confirmation that no remote write occurred

- [x] **Step 5: Update route status**

Mark V1.1.1 complete only if both audits pass. Set V1.2 as the next milestone. Do not mark GitHub, BM25, workflow templates or V2 as implemented.

- [ ] **Step 6: Commit documentation**

Run:

```bash
git add docs/operations.md docs/roadmap-status.md docs/smoke-v1.1.1.md
git commit -m "docs: record v1.1.1 production acceptance"
```

## Final self-review checklist

- [x] Every design requirement in `2026-06-30-hermes-ai-dev-roadmap-design.md` section 3 maps to a task above.
- [x] Version 1 config, state and event artifacts remain readable.
- [x] No operator code path writes state directly.
- [x] No Codex prompt asks Codex to commit.
- [x] No retention or lease code deletes a file or directory.
- [x] No test requires network, GitHub, push, merge or deployment.
- [x] The final smoke gate is the only live-model acceptance step.
- [ ] `env CI=true pnpm check` passes after all commits.
