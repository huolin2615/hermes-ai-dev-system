import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { TaskMetrics } from "../src/artifacts/metrics.js";

class FakeClock {
  constructor(private value: number) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

const budgets = {
  maxActiveMinutes: 60,
  maxCodexInputTokens: 5_000_000,
  maxCodexOutputTokens: 50_000,
  warningRatio: 0.8,
};

test("excludes operator wait time from active duration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-metrics-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const clock = new FakeClock(Date.parse("2026-06-30T00:00:00.000Z"));
  const metrics = new TaskMetrics(store, budgets, clock);
  await metrics.startStage("planning");
  clock.advance(1_000);
  await metrics.finishStage("planning", {
    inputTokens: 100,
    outputTokens: 10,
  });
  await metrics.startOperatorWait("plan");
  clock.advance(10_000);
  await metrics.finishOperatorWait("plan");

  const summary = await metrics.summary();

  assert.equal(summary.activeDurationMs, 1_000);
  assert.equal(summary.operatorWaitDurationMs, 10_000);
  assert.equal(summary.budgetStatus, "ok");
});

test("returns warning and exceeded budget signals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-metrics-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const clock = new FakeClock(Date.parse("2026-06-30T00:00:00.000Z"));
  const metrics = new TaskMetrics(
    store,
    {
      maxActiveMinutes: 1,
      maxCodexInputTokens: 100,
      maxCodexOutputTokens: 100,
      warningRatio: 0.8,
    },
    clock,
  );
  await metrics.startStage("planning");
  clock.advance(50_000);
  await metrics.finishStage("planning", {
    inputTokens: 80,
    outputTokens: 101,
  });

  const summary = await metrics.summary();

  assert.equal(summary.budgetStatus, "exceeded");
  assert.deepEqual(summary.budgetSignals, [
    { metric: "active_duration", status: "warning" },
    { metric: "codex_input_tokens", status: "warning" },
    { metric: "codex_output_tokens", status: "exceeded" },
  ]);
});

test("stage finish is idempotent for crash recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-metrics-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const clock = new FakeClock(Date.parse("2026-06-30T00:00:00.000Z"));
  const metrics = new TaskMetrics(store, budgets, clock);
  await metrics.startStage("implementing");
  clock.advance(2_000);
  const first = await metrics.finishStage("implementing");
  const second = await metrics.finishStage("implementing");

  assert.deepEqual(second, first);
  assert.equal((await metrics.stageHistory()).length, 1);
});

test("summarizes Claude calls, normalization, and verification duration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-metrics-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const clock = new FakeClock(Date.parse("2026-06-30T00:00:00.000Z"));
  const metrics = new TaskMetrics(store, budgets, clock);
  await metrics.startStage("reviewing");
  clock.advance(3_000);
  await (
    metrics.finishStage as (
      stage: "reviewing",
      usage: Record<string, number>,
    ) => Promise<unknown>
  )("reviewing", {
    inputTokens: 0,
    outputTokens: 0,
    claudeCalls: 2,
    claudeNormalizations: 1,
  });
  await metrics.startStage("verifying");
  clock.advance(750);
  await metrics.finishStage("verifying");

  const summary = (await metrics.summary()) as unknown as {
    claudeCalls: number;
    claudeNormalizations: number;
    verificationDurationMs: number;
  };

  assert.equal(summary.claudeCalls, 2);
  assert.equal(summary.claudeNormalizations, 1);
  assert.equal(summary.verificationDurationMs, 750);
});
