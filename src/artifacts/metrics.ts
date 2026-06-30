import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import type { ProjectConfig } from "../config/project.js";
import type { WorkflowStage } from "../workflow/state.js";
import type { ArtifactStore } from "./store.js";

export interface StageMetric {
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

interface StageStart {
  metricId: string;
  stage: WorkflowStage;
  attempt: number;
  startedAt: string;
  completed: boolean;
}

interface OperatorWaitStart {
  waitId: string;
  gate: string;
  startedAt: string;
  completed: boolean;
}

interface OperatorWaitMetric {
  waitId: string;
  gate: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export type BudgetStatus = "ok" | "warning" | "exceeded";
export type BudgetMetric =
  | "active_duration"
  | "codex_input_tokens"
  | "codex_output_tokens";

export interface MetricsClock {
  now(): Date;
}

const systemClock: MetricsClock = {
  now: () => new Date(),
};

async function files(
  store: ArtifactStore,
  directory: string,
): Promise<string[]> {
  try {
    return (await readdir(store.resolve(directory)))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function signal(
  metric: BudgetMetric,
  value: number,
  limit: number,
  warningRatio: number,
): { metric: BudgetMetric; status: Exclude<BudgetStatus, "ok"> } | null {
  if (value >= limit) return { metric, status: "exceeded" };
  if (value >= limit * warningRatio) return { metric, status: "warning" };
  return null;
}

export class TaskMetrics {
  constructor(
    private readonly store: ArtifactStore,
    private readonly budgets: ProjectConfig["budgets"],
    private readonly clock: MetricsClock = systemClock,
  ) {}

  async startStage(stage: WorkflowStage): Promise<void> {
    if (await this.store.exists("metrics/active-stage.json")) {
      const active = await this.store.readJson<StageStart>(
        "metrics/active-stage.json",
      );
      if (!active.completed) {
        if (active.stage === stage) return;
        throw new Error(
          `cannot start ${stage}; stage ${active.stage} is still active`,
        );
      }
    }
    const attempts = (await this.stageStartHistory()).filter(
      (record) => record.stage === stage,
    ).length;
    const start: StageStart = {
      metricId: randomUUID(),
      stage,
      attempt: attempts + 1,
      startedAt: this.clock.now().toISOString(),
      completed: false,
    };
    await this.store.writeJson(
      `metrics/stage-starts/${start.metricId}.json`,
      start,
    );
    await this.store.writeJson("metrics/active-stage.json", start);
  }

  async finishStage(
    stage: WorkflowStage,
    usage: {
      inputTokens: number;
      cachedInputTokens?: number;
      outputTokens: number;
      reasoningTokens?: number;
      claudeCalls?: number;
      claudeNormalizations?: number;
    } = { inputTokens: 0, outputTokens: 0 },
  ): Promise<StageMetric> {
    const active = await this.store.readJson<StageStart>(
      "metrics/active-stage.json",
    );
    if (active.stage !== stage) {
      throw new Error(
        `cannot finish ${stage}; active stage is ${active.stage}`,
      );
    }
    const metricPath = `metrics/stages/${active.metricId}.json`;
    if (active.completed && (await this.store.exists(metricPath))) {
      return this.store.readJson<StageMetric>(metricPath);
    }
    const completedAt = this.clock.now();
    const metric: StageMetric = {
      metricId: active.metricId,
      stage,
      attempt: active.attempt,
      startedAt: active.startedAt,
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(
        0,
        completedAt.getTime() - new Date(active.startedAt).getTime(),
      ),
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
      claudeCalls: usage.claudeCalls ?? 0,
      claudeNormalizations: usage.claudeNormalizations ?? 0,
    };
    if (!(await this.store.exists(metricPath))) {
      await this.store.writeJson(metricPath, metric);
    }
    await this.store.writeJson("metrics/active-stage.json", {
      ...active,
      completed: true,
    });
    return metric;
  }

  async startOperatorWait(gate: string): Promise<void> {
    if (await this.store.exists("metrics/active-wait.json")) {
      const active = await this.store.readJson<OperatorWaitStart>(
        "metrics/active-wait.json",
      );
      if (!active.completed) {
        if (active.gate === gate) return;
        throw new Error(
          `cannot start ${gate} wait; ${active.gate} wait is active`,
        );
      }
    }
    const start: OperatorWaitStart = {
      waitId: randomUUID(),
      gate,
      startedAt: this.clock.now().toISOString(),
      completed: false,
    };
    await this.store.writeJson(
      `metrics/wait-starts/${start.waitId}.json`,
      start,
    );
    await this.store.writeJson("metrics/active-wait.json", start);
  }

  async activeOperatorWait(): Promise<string | null> {
    if (!(await this.store.exists("metrics/active-wait.json"))) return null;
    const active = await this.store.readJson<OperatorWaitStart>(
      "metrics/active-wait.json",
    );
    return active.completed ? null : active.gate;
  }

  async finishOperatorWait(gate: string): Promise<void> {
    const active = await this.store.readJson<OperatorWaitStart>(
      "metrics/active-wait.json",
    );
    if (active.gate !== gate) {
      throw new Error(
        `cannot finish ${gate} wait; active wait is ${active.gate}`,
      );
    }
    const metricPath = `metrics/waits/${active.waitId}.json`;
    if (active.completed && (await this.store.exists(metricPath))) return;
    const completedAt = this.clock.now();
    const metric: OperatorWaitMetric = {
      waitId: active.waitId,
      gate,
      startedAt: active.startedAt,
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(
        0,
        completedAt.getTime() - new Date(active.startedAt).getTime(),
      ),
    };
    if (!(await this.store.exists(metricPath))) {
      await this.store.writeJson(metricPath, metric);
    }
    await this.store.writeJson("metrics/active-wait.json", {
      ...active,
      completed: true,
    });
  }

  async stageHistory(): Promise<StageMetric[]> {
    const history: StageMetric[] = [];
    for (const file of await files(this.store, "metrics/stages")) {
      history.push(
        await this.store.readJson<StageMetric>(`metrics/stages/${file}`),
      );
    }
    return history.sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) ||
        left.metricId.localeCompare(right.metricId),
    );
  }

  async summary(): Promise<{
    activeDurationMs: number;
    operatorWaitDurationMs: number;
    budgetStatus: BudgetStatus;
    budgetSignals: Array<{
      metric: BudgetMetric;
      status: Exclude<BudgetStatus, "ok">;
    }>;
    claudeCalls: number;
    claudeNormalizations: number;
    verificationDurationMs: number;
  }> {
    const stages = await this.stageHistory();
    const waits: OperatorWaitMetric[] = [];
    for (const file of await files(this.store, "metrics/waits")) {
      waits.push(
        await this.store.readJson<OperatorWaitMetric>(
          `metrics/waits/${file}`,
        ),
      );
    }
    const activeDurationMs = stages.reduce(
      (total, metric) => total + metric.durationMs,
      0,
    );
    const operatorWaitDurationMs = waits.reduce(
      (total, metric) => total + metric.durationMs,
      0,
    );
    const inputTokens = stages.reduce(
      (total, metric) => total + metric.inputTokens,
      0,
    );
    const outputTokens = stages.reduce(
      (total, metric) => total + metric.outputTokens,
      0,
    );
    const claudeCalls = stages.reduce(
      (total, metric) => total + (metric.claudeCalls ?? 0),
      0,
    );
    const claudeNormalizations = stages.reduce(
      (total, metric) => total + (metric.claudeNormalizations ?? 0),
      0,
    );
    const verificationDurationMs = stages
      .filter((metric) => metric.stage === "verifying")
      .reduce((total, metric) => total + metric.durationMs, 0);
    const budgetSignals = [
      signal(
        "active_duration",
        activeDurationMs,
        this.budgets.maxActiveMinutes * 60_000,
        this.budgets.warningRatio,
      ),
      signal(
        "codex_input_tokens",
        inputTokens,
        this.budgets.maxCodexInputTokens,
        this.budgets.warningRatio,
      ),
      signal(
        "codex_output_tokens",
        outputTokens,
        this.budgets.maxCodexOutputTokens,
        this.budgets.warningRatio,
      ),
    ].filter(
      (
        value,
      ): value is {
        metric: BudgetMetric;
        status: Exclude<BudgetStatus, "ok">;
      } => value !== null,
    );
    const budgetStatus: BudgetStatus = budgetSignals.some(
      (entry) => entry.status === "exceeded",
    )
      ? "exceeded"
      : budgetSignals.length > 0
        ? "warning"
        : "ok";
    return {
      activeDurationMs,
      operatorWaitDurationMs,
      budgetStatus,
      budgetSignals,
      claudeCalls,
      claudeNormalizations,
      verificationDurationMs,
    };
  }

  private async stageStartHistory(): Promise<StageStart[]> {
    const starts: StageStart[] = [];
    for (const file of await files(this.store, "metrics/stage-starts")) {
      starts.push(
        await this.store.readJson<StageStart>(
          `metrics/stage-starts/${file}`,
        ),
      );
    }
    return starts;
  }
}
