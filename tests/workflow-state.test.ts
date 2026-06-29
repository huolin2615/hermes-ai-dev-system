import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowState,
  reduceWorkflowState,
} from "../src/workflow/state.js";

test("moves through the automatic happy path", () => {
  let state = createWorkflowState("task-1", "crm-frontend");

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
