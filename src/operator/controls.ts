import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ArtifactStore } from "../artifacts/store.js";
import {
  digestCodexPlan,
  parseCodexPlan,
  type CodexPlanV2,
} from "../workflow/plan-contract.js";
import type { WorkflowStage, WorkflowState } from "../workflow/state.js";

export type ApprovalGate = "plan" | "knowledge";

export interface PlanApprovalPayload {
  planDigest: string;
  approvedBy: string;
  approvedAt: string;
  answers: Record<string, string>;
}

function now(): string {
  return new Date().toISOString();
}

function digest(value: unknown): string {
  const source =
    typeof value === "string" || value instanceof Uint8Array
      ? value
      : JSON.stringify(value);
  return createHash("sha256").update(source).digest("hex");
}

function resumableStage(state: WorkflowState): WorkflowStage {
  if (!state.blockedFrom) {
    throw new Error("blocked task has no resumable stage; use reprepare");
  }
  if (state.blockedReason?.includes("repair budget exhausted")) {
    return "fixing";
  }
  return state.blockedFrom;
}

export class OperatorControls {
  constructor(private readonly store: ArtifactStore) {}

  async approve(
    gate: ApprovalGate,
    approvedBy: string,
    note = "",
    answers: Record<string, string> = {},
  ): Promise<void> {
    if (gate === "plan" && !(await this.store.exists("codex/plan.json"))) {
      throw new Error("cannot approve a plan before Codex produced one");
    }
    if (
      gate === "knowledge" &&
      !(await this.store.exists("knowledge/proposal.json"))
    ) {
      throw new Error("cannot approve knowledge before a proposal exists");
    }
    const plan =
      gate === "plan"
        ? parseCodexPlan(
            await this.store.readJson<unknown>("codex/plan.json"),
          )
        : undefined;
    const approvedAnswers = plan
      ? requiredPlanAnswers(plan, answers)
      : undefined;
    const planDigest = plan ? digestCodexPlan(plan) : undefined;
    const proposalDigest =
      gate === "knowledge"
        ? digest(
            await readFile(
              (
                await this.store.readJson<{ path: string }>(
                  "knowledge/proposal.json",
                )
              ).path,
            ),
          )
        : undefined;
    await this.store.writeJson(`approvals/${gate}.json`, {
      gate,
      approvedBy,
      note,
      approvedAt: now(),
      ...(planDigest ? { planDigest } : {}),
      ...(approvedAnswers ? { answers: approvedAnswers } : {}),
      ...(proposalDigest ? { proposalDigest } : {}),
    });
    await this.store.appendEvent({
      type: "operator_approval",
      gate,
      approvedBy,
    });
  }

  async requestPause(requestedBy: string, note = ""): Promise<void> {
    await this.store.writeJson("operator/pause.json", {
      active: true,
      requestedBy,
      note,
      requestedAt: now(),
    });
    await this.store.appendEvent({ type: "pause_requested", requestedBy });
  }

  async resume(resumedBy: string): Promise<void> {
    await this.store.writeJson("operator/pause.json", {
      active: false,
      resumedBy,
      resumedAt: now(),
    });
    const state = await this.store.readJson<WorkflowState>("state.json");
    if (
      state.stage === "blocked" &&
      state.blockedReason === "human takeover requested"
    ) {
      await this.store.writeJson("state.json", {
        ...state,
        stage: resumableStage(state),
        blockedReason: undefined,
        blockedFrom: undefined,
        updatedAt: now(),
      });
    }
    await this.store.appendEvent({ type: "resumed", resumedBy });
  }

  async retry(requestedBy: string): Promise<void> {
    const state = await this.store.readJson<WorkflowState>("state.json");
    if (state.stage !== "blocked") {
      throw new Error("retry is only valid for a blocked task");
    }
    const retryAfterBudget = state.blockedReason?.includes(
      "repair budget exhausted",
    );
    await this.store.writeJson("state.json", {
      ...state,
      stage: resumableStage(state),
      repairAttempts: retryAfterBudget
        ? Math.max(0, state.repairAttempts - 1)
        : state.repairAttempts,
      blockedReason: undefined,
      blockedFrom: undefined,
      updatedAt: now(),
    });
    await this.store.appendEvent({ type: "retry_requested", requestedBy });
  }

  async reprepare(requestedBy: string): Promise<void> {
    const state = await this.store.readJson<WorkflowState>("state.json");
    const { codexThreadId: _oldThread, ...rest } = state;
    await this.store.writeJson("state.json", {
      ...rest,
      stage: "context_preparing",
      repairAttempts: 0,
      blockedReason: undefined,
      blockedFrom: undefined,
      updatedAt: now(),
    });
    await this.store.appendEvent({ type: "reprepare_requested", requestedBy });
  }

  async rereview(requestedBy: string): Promise<void> {
    if (!(await this.store.exists("verification/latest.json"))) {
      throw new Error("cannot re-review before verification evidence exists");
    }
    const state = await this.store.readJson<WorkflowState>("state.json");
    await this.store.writeJson("state.json", {
      ...state,
      stage: "reviewing",
      blockedReason: undefined,
      blockedFrom: undefined,
      updatedAt: now(),
    });
    await this.store.appendEvent({ type: "rereview_requested", requestedBy });
  }
}

function requiredPlanAnswers(
  plan: CodexPlanV2,
  answers: Record<string, string>,
): Record<string, string> {
  const approvedAnswers: Record<string, string> = {};
  for (const question of plan.questions) {
    const answer = answers[question.id]?.trim();
    if (!answer) {
      throw new Error(
        `missing answer for required plan question: ${question.id}`,
      );
    }
    approvedAnswers[question.id] = answer;
  }
  return approvedAnswers;
}
