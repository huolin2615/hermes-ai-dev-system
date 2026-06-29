import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { OperatorControls } from "../src/operator/controls.js";
import { createWorkflowState } from "../src/workflow/state.js";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controls-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  await store.writeJson("state.json", createWorkflowState("t_1", "crm", 2));
  return { store, controls: new OperatorControls(store) };
}

test("records auditable plan approval without deleting artifacts", async () => {
  const { store, controls } = await setup();
  await store.writeJson("codex/plan.json", { summary: "plan" });

  await controls.approve("plan", "huolin", "approved exact changes");

  const approval = await store.readJson<{
    approvedBy: string;
    planDigest: string;
  }>(
    "approvals/plan.json",
  );
  assert.equal(approval.approvedBy, "huolin");
  assert.match(approval.planDigest, /^[a-f0-9]{64}$/);
});

test("pause and resume preserve the interrupted workflow stage", async () => {
  const { store, controls } = await setup();
  await store.writeJson("state.json", {
    ...createWorkflowState("t_1", "crm", 2),
    stage: "blocked",
    blockedFrom: "implementing",
    blockedReason: "human takeover requested",
  });

  await controls.requestPause("huolin");
  await controls.resume("huolin");

  const pause = await store.readJson<{ active: boolean }>("operator/pause.json");
  const state = await store.readJson<{ stage: string }>("state.json");
  assert.equal(pause.active, false);
  assert.equal(state.stage, "implementing");
});

test("reprepare starts context again and retires the previous thread id", async () => {
  const { store, controls } = await setup();
  await store.writeJson("state.json", {
    ...createWorkflowState("t_1", "crm", 2),
    stage: "blocked",
    codexThreadId: "thread-old",
    blockedFrom: "reviewing",
    blockedReason: "operator input required",
  });

  await controls.reprepare("huolin");

  const state = await store.readJson<Record<string, unknown>>("state.json");
  assert.equal(state.stage, "context_preparing");
  assert.equal("codexThreadId" in state, false);
});

test("rereview requires prior verification evidence", async () => {
  const { controls } = await setup();
  await assert.rejects(controls.rereview("huolin"), /verification evidence/);
});
