import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ArtifactStore } from "../artifacts/store.js";
import {
  digestCodexPlan,
  digestPlanAnswers,
  parseCodexPlan,
  type CodexPlanV2,
} from "../workflow/plan-contract.js";
import {
  OperatorCommandQueue,
  type OperatorCommand,
} from "./commands.js";

export type ApprovalGate = "plan" | "knowledge";

export interface PlanApprovalPayload {
  planDigest: string;
  answersDigest: string;
  approvedBy: string;
  approvedAt: string;
  answers: Record<string, string>;
}

function digest(value: unknown): string {
  const source =
    typeof value === "string" || value instanceof Uint8Array
      ? value
      : JSON.stringify(value);
  return createHash("sha256").update(source).digest("hex");
}

export class OperatorControls {
  private readonly queue: OperatorCommandQueue;

  constructor(private readonly store: ArtifactStore) {
    this.queue = new OperatorCommandQueue(store);
  }

  async approve(
    gate: ApprovalGate,
    approvedBy: string,
    note = "",
    answers: Record<string, string> = {},
  ): Promise<OperatorCommand> {
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
    const proposal =
      gate === "knowledge"
        ? await this.store.readJson<{ path: string }>(
            "knowledge/proposal.json",
          )
        : undefined;
    return this.queue.enqueue({
      type: gate === "plan" ? "approve_plan" : "approve_knowledge",
      requestedBy: approvedBy,
      payload: {
        note,
        ...(planDigest ? { planDigest } : {}),
        ...(approvedAnswers ? { answers: approvedAnswers } : {}),
        ...(approvedAnswers
          ? { answersDigest: digestPlanAnswers(approvedAnswers) }
          : {}),
        ...(proposalDigest ? { proposalDigest } : {}),
        ...(proposal ? { proposalPath: proposal.path } : {}),
      },
    });
  }

  async requestPause(
    requestedBy: string,
    note = "",
  ): Promise<OperatorCommand> {
    return this.queue.enqueue({
      type: "pause",
      requestedBy,
      payload: { note },
    });
  }

  async resume(
    resumedBy: string,
    note = "",
  ): Promise<OperatorCommand> {
    return this.queue.enqueue({
      type: "resume",
      requestedBy: resumedBy,
      payload: { note },
    });
  }

  async retry(
    requestedBy: string,
    note = "",
  ): Promise<OperatorCommand> {
    return this.queue.enqueue({
      type: "retry",
      requestedBy,
      payload: { note },
    });
  }

  async reprepare(
    requestedBy: string,
    note = "",
  ): Promise<OperatorCommand> {
    return this.queue.enqueue({
      type: "reprepare",
      requestedBy,
      payload: { note },
    });
  }

  async rereview(
    requestedBy: string,
    note = "",
  ): Promise<OperatorCommand> {
    if (!(await this.store.exists("verification/latest.json"))) {
      throw new Error("cannot re-review before verification evidence exists");
    }
    const verificationDigest = digest(
      await readFile(this.store.resolve("verification/latest.json")),
    );
    return this.queue.enqueue({
      type: "rereview",
      requestedBy,
      payload: { note, verificationDigest },
    });
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
