export type WorkflowStage =
  | "context_preparing"
  | "planning"
  | "awaiting_plan_approval"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "knowledge"
  | "finalizing"
  | "blocked"
  | "completed";

export interface WorkflowState {
  version: 1;
  taskId: string;
  projectId: string;
  stage: WorkflowStage;
  codexThreadId?: string;
  repairAttempts: number;
  maxFixCycles: number;
  blockedReason?: string | undefined;
  blockedFrom?: Exclude<WorkflowStage, "blocked" | "completed"> | undefined;
  updatedAt: string;
}

export type WorkflowEvent =
  | { type: "CONTEXT_PREPARED" }
  | { type: "PLAN_READY"; threadId: string; requiresApproval: boolean }
  | { type: "APPROVED"; gate: "plan" | "knowledge" | "cleanup" }
  | { type: "IMPLEMENTATION_DONE" }
  | { type: "VERIFICATION_PASSED" }
  | { type: "VERIFICATION_FAILED" }
  | { type: "REVIEW_PASSED" }
  | { type: "REVIEW_BLOCKED" }
  | { type: "FIX_DONE" }
  | { type: "KNOWLEDGE_HANDLED" }
  | { type: "FINALIZED" }
  | { type: "BLOCK"; reason: string };

export function createWorkflowState(
  taskId: string,
  projectId: string,
  maxFixCycles = 2,
): WorkflowState {
  return {
    version: 1,
    taskId,
    projectId,
    stage: "context_preparing",
    repairAttempts: 0,
    maxFixCycles,
    updatedAt: new Date().toISOString(),
  };
}

function invalid(state: WorkflowState, event: WorkflowEvent): never {
  throw new Error(`invalid workflow transition: ${state.stage} + ${event.type}`);
}

function updated(state: WorkflowState, patch: Partial<WorkflowState>): WorkflowState {
  return {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

function beginRepair(state: WorkflowState, reason: string): WorkflowState {
  if (state.stage !== "verifying" && state.stage !== "reviewing") {
    throw new Error(`cannot begin repair from ${state.stage}`);
  }
  if (state.repairAttempts >= state.maxFixCycles) {
    return updated(state, {
      stage: "blocked",
      blockedFrom: state.stage,
      blockedReason: `${reason} repair budget exhausted`,
    });
  }
  return updated(state, {
    stage: "fixing",
    repairAttempts: state.repairAttempts + 1,
    blockedReason: undefined,
    blockedFrom: undefined,
  });
}

export function reduceWorkflowState(
  state: WorkflowState,
  event: WorkflowEvent,
): WorkflowState {
  if (event.type === "BLOCK") {
    return updated(state, {
      stage: "blocked",
      blockedFrom:
        state.stage === "blocked" || state.stage === "completed"
          ? state.blockedFrom
          : state.stage,
      blockedReason: event.reason,
    });
  }

  switch (state.stage) {
    case "context_preparing":
      return event.type === "CONTEXT_PREPARED"
        ? updated(state, { stage: "planning" })
        : invalid(state, event);
    case "planning":
      return event.type === "PLAN_READY"
        ? updated(state, {
            stage: event.requiresApproval ? "awaiting_plan_approval" : "implementing",
            codexThreadId: event.threadId,
            blockedFrom: undefined,
          })
        : invalid(state, event);
    case "awaiting_plan_approval":
      return event.type === "APPROVED" && event.gate === "plan"
        ? updated(state, {
            stage: "implementing",
            blockedReason: undefined,
            blockedFrom: undefined,
          })
        : invalid(state, event);
    case "implementing":
      return event.type === "IMPLEMENTATION_DONE"
        ? updated(state, { stage: "verifying" })
        : invalid(state, event);
    case "verifying":
      if (event.type === "VERIFICATION_PASSED") {
        return updated(state, { stage: "reviewing" });
      }
      return event.type === "VERIFICATION_FAILED"
        ? beginRepair(state, "verification")
        : invalid(state, event);
    case "reviewing":
      if (event.type === "REVIEW_PASSED") {
        return updated(state, { stage: "knowledge" });
      }
      return event.type === "REVIEW_BLOCKED"
        ? beginRepair(state, "review")
        : invalid(state, event);
    case "fixing":
      return event.type === "FIX_DONE"
        ? updated(state, { stage: "verifying" })
        : invalid(state, event);
    case "knowledge":
      return event.type === "KNOWLEDGE_HANDLED"
        ? updated(state, { stage: "finalizing" })
        : invalid(state, event);
    case "finalizing":
      return event.type === "FINALIZED"
        ? updated(state, { stage: "completed" })
        : invalid(state, event);
    case "blocked":
      if (event.type === "APPROVED" && event.gate === "knowledge") {
        return updated(state, {
          stage: "knowledge",
          blockedReason: undefined,
          blockedFrom: undefined,
        });
      }
      return invalid(state, event);
    case "completed":
      return invalid(state, event);
  }
}
