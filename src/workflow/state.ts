import { z } from "zod";

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

const workflowStageSchema = z.enum([
  "context_preparing",
  "planning",
  "awaiting_plan_approval",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "knowledge",
  "finalizing",
  "blocked",
  "completed",
]);

const blockedFromSchema = z.enum([
  "context_preparing",
  "planning",
  "awaiting_plan_approval",
  "implementing",
  "verifying",
  "reviewing",
  "fixing",
  "knowledge",
  "finalizing",
]);

export interface WorkflowState {
  version: 2;
  revision: number;
  taskId: string;
  projectId: string;
  stage: WorkflowStage;
  codexThreadId?: string | undefined;
  repairAttempts: number;
  maxFixCycles: number;
  blockedReason?: string | undefined;
  blockedFrom?: Exclude<WorkflowStage, "blocked" | "completed"> | undefined;
  updatedAt: string;
}

const sharedStateShape = {
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  stage: workflowStageSchema,
  codexThreadId: z.string().min(1).optional(),
  repairAttempts: z.number().int().nonnegative(),
  maxFixCycles: z.number().int().nonnegative(),
  blockedReason: z.string().optional(),
  blockedFrom: blockedFromSchema.optional(),
  updatedAt: z.string().min(1),
};

const workflowStateV1Schema = z.strictObject({
  version: z.literal(1),
  ...sharedStateShape,
});

const workflowStateV2Schema = z.strictObject({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  ...sharedStateShape,
});

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
    version: 2,
    revision: 0,
    taskId,
    projectId,
    stage: "context_preparing",
    repairAttempts: 0,
    maxFixCycles,
    updatedAt: new Date().toISOString(),
  };
}

export function parseWorkflowState(input: unknown): WorkflowState {
  if (
    input !== null &&
    typeof input === "object" &&
    "version" in input &&
    input.version === 2
  ) {
    return workflowStateV2Schema.parse(input);
  }
  const legacy = workflowStateV1Schema.parse(input);
  return {
    ...legacy,
    version: 2,
    revision: 0,
  };
}

function invalid(state: WorkflowState, event: WorkflowEvent): never {
  throw new Error(`invalid workflow transition: ${state.stage} + ${event.type}`);
}

function updated(state: WorkflowState, patch: Partial<WorkflowState>): WorkflowState {
  return {
    ...state,
    ...patch,
    revision: state.revision + 1,
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
