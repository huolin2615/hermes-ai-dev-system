import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowState,
  parseWorkflowState,
  reduceWorkflowState,
} from "../src/workflow/state.js";

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

test("moves through the automatic happy path", () => {
  let state = createWorkflowState("task-1", "crm-frontend");
  const initialRevision = state.revision;

  state = reduceWorkflowState(state, { type: "CONTEXT_PREPARED" });
  state = reduceWorkflowState(state, {
    type: "PLAN_READY",
    threadId: "thread-1",
    requiresApproval: false,
  });
  state = reduceWorkflowState(state, { type: "IMPLEMENTATION_DONE" });
  state = reduceWorkflowState(state, { type: "VERIFICATION_PASSED" });
  state = reduceWorkflowState(state, { type: "REVIEW_PASSED" });
  state = reduceWorkflowState(state, { type: "KNOWLEDGE_HANDLED" });
  state = reduceWorkflowState(state, { type: "FINALIZED" });

  assert.equal(state.stage, "completed");
  assert.equal(state.codexThreadId, "thread-1");
  assert.equal(state.revision, initialRevision + 7);
});

test("pauses a risky plan for approval and resumes", () => {
  let state = createWorkflowState("task-2", "crm-frontend");
  state = reduceWorkflowState(state, { type: "CONTEXT_PREPARED" });
  state = reduceWorkflowState(state, {
    type: "PLAN_READY",
    threadId: "thread-2",
    requiresApproval: true,
  });

  assert.equal(state.stage, "awaiting_plan_approval");

  state = reduceWorkflowState(state, { type: "APPROVED", gate: "plan" });
  assert.equal(state.stage, "implementing");
});

test("blocks after the configured repair budget is exhausted", () => {
  let state = createWorkflowState("task-3", "crm-frontend", 2);
  state = { ...state, stage: "reviewing" };
  state = reduceWorkflowState(state, { type: "REVIEW_BLOCKED" });
  state = { ...state, stage: "reviewing" };
  state = reduceWorkflowState(state, { type: "REVIEW_BLOCKED" });
  state = { ...state, stage: "reviewing" };
  state = reduceWorkflowState(state, { type: "REVIEW_BLOCKED" });

  assert.equal(state.stage, "blocked");
  assert.equal(state.blockedReason, "review repair budget exhausted");
});

test("rejects invalid transitions instead of silently skipping stages", () => {
  const state = createWorkflowState("task-4", "crm-frontend");

  assert.throws(
    () => reduceWorkflowState(state, { type: "IMPLEMENTATION_DONE" }),
    /invalid workflow transition/,
  );
});

test("increments revision exactly once for a block transition", () => {
  const state = createWorkflowState("task-5", "crm-frontend");
  const blocked = reduceWorkflowState(state, {
    type: "BLOCK",
    reason: "operator input required",
  });

  assert.equal(blocked.revision, state.revision + 1);
});
