import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import type { ArtifactStore } from "../artifacts/store.js";
import {
  digestCodexPlan,
  digestPlanAnswers,
  type CodexPlanV2,
} from "../workflow/plan-contract.js";
import {
  reduceWorkflowState,
  type WorkflowState,
} from "../workflow/state.js";

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

export interface AppliedOperatorCommand {
  state: WorkflowState;
  status: "applied" | "rejected";
  detail: Record<string, unknown>;
}

const commandTypes = new Set<OperatorCommandType>([
  "approve_plan",
  "approve_knowledge",
  "pause",
  "resume",
  "retry",
  "reprepare",
  "rereview",
]);

function isCommandId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function parseCommand(value: unknown): OperatorCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid operator command");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.commandId !== "string" ||
    !isCommandId(input.commandId) ||
    typeof input.type !== "string" ||
    !commandTypes.has(input.type as OperatorCommandType) ||
    typeof input.requestedBy !== "string" ||
    input.requestedBy.length === 0 ||
    typeof input.requestedAt !== "string" ||
    input.payload === null ||
    typeof input.payload !== "object" ||
    Array.isArray(input.payload)
  ) {
    throw new Error("invalid operator command");
  }
  return {
    commandId: input.commandId,
    type: input.type as OperatorCommandType,
    requestedBy: input.requestedBy,
    requestedAt: input.requestedAt,
    payload: input.payload as Record<string, unknown>,
  };
}

function updatedState(
  state: WorkflowState,
  patch: Partial<WorkflowState>,
): WorkflowState {
  return {
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

function rejected(
  state: WorkflowState,
  reason: string,
): AppliedOperatorCommand {
  return {
    state,
    status: "rejected",
    detail: { stateRevision: state.revision, reason },
  };
}

function applied(
  state: WorkflowState,
  detail: Record<string, unknown> = {},
): AppliedOperatorCommand {
  return {
    state,
    status: "applied",
    detail: { stateRevision: state.revision, ...detail },
  };
}

function stringPayload(
  command: OperatorCommand,
  key: string,
): string | undefined {
  const value = command.payload[key];
  return typeof value === "string" ? value : undefined;
}

function answerPayload(command: OperatorCommand): Record<string, string> {
  const value = command.payload.answers;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function applyOperatorCommand(
  state: WorkflowState,
  command: OperatorCommand,
  plan: CodexPlanV2 | undefined,
  knowledgeProposal: { path: string; digest: string } | undefined,
): AppliedOperatorCommand {
  switch (command.type) {
    case "approve_plan": {
      if (state.stage !== "awaiting_plan_approval") {
        return rejected(state, "plan approval is not valid in the current stage");
      }
      if (!plan) return rejected(state, "no current plan to approve");
      if (plan.capabilities.externalWrite) {
        return rejected(state, "external writes are not supported in V1.1.1");
      }
      const expectedDigest = digestCodexPlan(plan);
      if (stringPayload(command, "planDigest") !== expectedDigest) {
        return rejected(state, "plan changed after approval was requested");
      }
      const answers = answerPayload(command);
      if (
        stringPayload(command, "answersDigest") !==
        digestPlanAnswers(answers)
      ) {
        return rejected(state, "plan approval answers changed after approval");
      }
      for (const question of plan.questions) {
        if (!answers[question.id]?.trim()) {
          return rejected(
            state,
            `missing answer for required plan question: ${question.id}`,
          );
        }
      }
      const next = reduceWorkflowState(state, {
        type: "APPROVED",
        gate: "plan",
      });
      return applied(next, {
        gate: "plan",
        approval: {
          commandId: command.commandId,
          planDigest: expectedDigest,
          answersDigest: digestPlanAnswers(answers),
          approvedBy: command.requestedBy,
          approvedAt: command.requestedAt,
          note: stringPayload(command, "note") ?? "",
          answers,
        },
      });
    }
    case "approve_knowledge": {
      if (
        state.stage !== "blocked" ||
        state.blockedReason !== "knowledge approval required"
      ) {
        return rejected(
          state,
          "knowledge approval is not valid in the current stage",
        );
      }
      if (!knowledgeProposal) {
        return rejected(state, "no current knowledge proposal to approve");
      }
      if (
        stringPayload(command, "proposalDigest") !==
          knowledgeProposal.digest ||
        stringPayload(command, "proposalPath") !== knowledgeProposal.path
      ) {
        return rejected(
          state,
          "knowledge proposal changed after approval was requested",
        );
      }
      const next = updatedState(state, {
        stage: "knowledge",
        blockedReason: undefined,
        blockedFrom: undefined,
      });
      return applied(next, {
        gate: "knowledge",
        approval: {
          commandId: command.commandId,
          proposalDigest: knowledgeProposal.digest,
          approvedBy: command.requestedBy,
          approvedAt: command.requestedAt,
          note: stringPayload(command, "note") ?? "",
        },
      });
    }
    case "pause": {
      if (state.stage === "blocked" || state.stage === "completed") {
        return rejected(state, "pause is not valid in the current stage");
      }
      return applied(
        reduceWorkflowState(state, {
          type: "BLOCK",
          reason: "human takeover requested",
        }),
      );
    }
    case "resume": {
      if (
        state.stage !== "blocked" ||
        state.blockedReason !== "human takeover requested" ||
        !state.blockedFrom
      ) {
        return rejected(state, "resume requires a human-takeover block");
      }
      return applied(
        updatedState(state, {
          stage: state.blockedFrom,
          blockedReason: undefined,
          blockedFrom: undefined,
        }),
      );
    }
    case "retry": {
      if (state.stage !== "blocked" || !state.blockedFrom) {
        return rejected(state, "retry requires a blocked workflow stage");
      }
      const retryAfterBudget = state.blockedReason?.includes(
        "repair budget exhausted",
      );
      return applied(
        updatedState(state, {
          stage: retryAfterBudget ? "fixing" : state.blockedFrom,
          repairAttempts: retryAfterBudget
            ? Math.max(0, state.repairAttempts - 1)
            : state.repairAttempts,
          blockedReason: undefined,
          blockedFrom: undefined,
        }),
      );
    }
    case "reprepare": {
      if (state.stage === "completed") {
        return rejected(state, "reprepare is not valid after completion");
      }
      return applied(
        updatedState(state, {
          stage: "context_preparing",
          codexThreadId: undefined,
          repairAttempts: 0,
          blockedReason: undefined,
          blockedFrom: undefined,
        }),
      );
    }
    case "rereview": {
      if (
        !["blocked", "knowledge", "finalizing"].includes(state.stage) ||
        !stringPayload(command, "verificationDigest")
      ) {
        return rejected(
          state,
          "rereview requires verification evidence before completion",
        );
      }
      return applied(
        updatedState(state, {
          stage: "reviewing",
          blockedReason: undefined,
          blockedFrom: undefined,
        }),
      );
    }
  }
}

export class OperatorCommandQueue {
  private lastRequestedAtMs = 0;

  constructor(private readonly store: ArtifactStore) {}

  async enqueue(
    input: Omit<OperatorCommand, "commandId" | "requestedAt">,
  ): Promise<OperatorCommand> {
    if (
      !commandTypes.has(input.type) ||
      input.requestedBy.trim().length === 0
    ) {
      throw new Error("invalid operator command");
    }
    const requestedAtMs = Math.max(Date.now(), this.lastRequestedAtMs + 1);
    this.lastRequestedAtMs = requestedAtMs;
    const command: OperatorCommand = {
      commandId: randomUUID(),
      type: input.type,
      requestedBy: input.requestedBy.trim(),
      requestedAt: new Date(requestedAtMs).toISOString(),
      payload: input.payload,
    };
    await this.store.writeJson(
      `operator/commands/${command.commandId}.json`,
      command,
    );
    return command;
  }

  async pending(): Promise<OperatorCommand[]> {
    let files: string[];
    try {
      files = await readdir(this.store.resolve("operator/commands"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const commands: OperatorCommand[] = [];
    for (const file of files.filter((entry) => entry.endsWith(".json"))) {
      const command = parseCommand(
        await this.store.readJson<unknown>(`operator/commands/${file}`),
      );
      if (
        !(await this.store.exists(
          `operator/results/${command.commandId}.json`,
        ))
      ) {
        commands.push(command);
      }
    }
    return commands.sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.commandId.localeCompare(right.commandId),
    );
  }

  async complete(
    commandId: string,
    status: "applied" | "rejected",
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!isCommandId(commandId)) {
      throw new Error(`invalid command id: ${commandId}`);
    }
    const commandPath = `operator/commands/${commandId}.json`;
    if (!(await this.store.exists(commandPath))) {
      throw new Error(`operator command does not exist: ${commandId}`);
    }
    const resultPath = `operator/results/${commandId}.json`;
    if (await this.store.exists(resultPath)) return;
    const stateRevision = detail.stateRevision;
    if (
      typeof stateRevision !== "number" ||
      !Number.isInteger(stateRevision) ||
      stateRevision < 0
    ) {
      throw new Error("operator command result requires a stateRevision");
    }
    const resultDetail = { ...detail };
    delete resultDetail.stateRevision;
    const result: OperatorCommandResult = {
      commandId,
      status,
      stateRevision,
      detail: resultDetail,
      completedAt: new Date().toISOString(),
    };
    await this.store.writeJson(resultPath, result);
  }
}
