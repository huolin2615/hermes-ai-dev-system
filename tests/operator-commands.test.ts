import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import {
  applyOperatorCommand,
  OperatorCommandQueue,
  type OperatorCommand,
} from "../src/operator/commands.js";
import { createWorkflowState } from "../src/workflow/state.js";

test("returns only commands without a result in stable order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-commands-"));
  const store = new ArtifactStore(root, "crm", "t_1");
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

  assert.deepEqual(
    pending.map((command) => command.commandId),
    [resume.commandId],
  );
});

test("completion is immutable and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-commands-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const queue = new OperatorCommandQueue(store);
  const command = await queue.enqueue({
    type: "retry",
    requestedBy: "huolin",
    payload: { note: "try again" },
  });

  await queue.complete(command.commandId, "applied", { stateRevision: 5 });
  await queue.complete(command.commandId, "rejected", {
    stateRevision: 6,
    reason: "must not overwrite",
  });

  const result = await store.readJson<{
    commandId: string;
    status: string;
    stateRevision: number;
    detail: Record<string, unknown>;
    completedAt: string;
  }>(`operator/results/${command.commandId}.json`);
  assert.deepEqual(result, {
    commandId: command.commandId,
    status: "applied",
    stateRevision: 5,
    detail: {},
    completedAt: result.completedAt,
  });
});

test("rejects an invalid command id before resolving a result path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-commands-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const queue = new OperatorCommandQueue(store);

  await assert.rejects(
    queue.complete("../outside", "rejected", { stateRevision: 0 }),
    /invalid command id/,
  );
});

test("rejects invalid-stage commands without changing state revision", () => {
  const state = createWorkflowState("t_1", "crm", 2);
  const command: OperatorCommand = {
    commandId: "11111111-1111-4111-8111-111111111111",
    type: "resume",
    requestedBy: "huolin",
    requestedAt: "2026-06-30T00:00:00.000Z",
    payload: {},
  };

  const result = applyOperatorCommand(state, command, undefined, undefined);

  assert.equal(result.status, "rejected");
  assert.equal(result.state, state);
  assert.equal(result.state.revision, state.revision);
});

test("applies pause then resume with one revision per command", () => {
  const initial = createWorkflowState("t_1", "crm", 2);
  const pause: OperatorCommand = {
    commandId: "11111111-1111-4111-8111-111111111111",
    type: "pause",
    requestedBy: "huolin",
    requestedAt: "2026-06-30T00:00:00.000Z",
    payload: {},
  };
  const paused = applyOperatorCommand(initial, pause, undefined, undefined);
  const resume: OperatorCommand = {
    ...pause,
    commandId: "22222222-2222-4222-8222-222222222222",
    type: "resume",
  };
  const resumed = applyOperatorCommand(
    paused.state,
    resume,
    undefined,
    undefined,
  );

  assert.equal(paused.status, "applied");
  assert.equal(paused.state.stage, "blocked");
  assert.equal(resumed.status, "applied");
  assert.equal(resumed.state.stage, "context_preparing");
  assert.equal(resumed.state.revision, initial.revision + 2);
});
