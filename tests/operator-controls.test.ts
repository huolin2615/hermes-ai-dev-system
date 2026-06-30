import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { OperatorControls } from "../src/operator/controls.js";
import { createWorkflowState } from "../src/workflow/state.js";

const plan = {
  version: 2,
  summary: "Change one file",
  assumptions: [],
  files: ["src/app.ts"],
  tests: [],
  capabilities: {
    network: false,
    dependencyInstall: false,
    externalWrite: false,
  },
  fileDeletions: [],
  questions: [],
  knowledgeNeeds: [],
} as const;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-controls-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  await store.writeJson("state.json", createWorkflowState("t_1", "crm", 2));
  return { store, controls: new OperatorControls(store) };
}

test("queues an auditable plan approval without writing approval state", async () => {
  const { store, controls } = await setup();
  await store.writeJson("codex/plan.json", plan);

  const command = await controls.approve(
    "plan",
    "huolin",
    "approved exact changes",
  );

  assert.equal(command.type, "approve_plan");
  assert.equal(command.requestedBy, "huolin");
  assert.match(String(command.payload.planDigest), /^[a-f0-9]{64}$/);
  assert.match(String(command.payload.answersDigest), /^[a-f0-9]{64}$/);
  assert.equal(await store.exists("approvals/plan.json"), false);
});

test("requires and persists answers for every plan question", async () => {
  const { store, controls } = await setup();
  await store.writeJson("codex/plan.json", {
    ...plan,
    questions: [
      {
        id: "target_runtime",
        prompt: "Which runtime should be targeted?",
        required: true,
      },
    ],
  });

  await assert.rejects(
    controls.approve("plan", "huolin", "", {}),
    /missing answer for required plan question: target_runtime/,
  );
  const command = await controls.approve("plan", "huolin", "", {
    target_runtime: "Node.js 22",
  });

  assert.deepEqual(
    command.payload.answers,
    { target_runtime: "Node.js 22" },
  );
  assert.match(String(command.payload.answersDigest), /^[a-f0-9]{64}$/);
});

test("pause and resume enqueue without directly mutating workflow state", async () => {
  const { store, controls } = await setup();
  await store.writeJson("state.json", {
    ...createWorkflowState("t_1", "crm", 2),
    stage: "blocked",
    blockedFrom: "implementing",
    blockedReason: "human takeover requested",
  });

  await controls.requestPause("huolin");
  await controls.resume("huolin");

  const state = await store.readJson<{ stage: string }>("state.json");
  assert.equal(state.stage, "blocked");
  assert.equal(await store.exists("operator/pause.json"), false);
});

test("reprepare queues without retiring the thread before worker consumption", async () => {
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
  assert.equal(state.stage, "blocked");
  assert.equal(state.codexThreadId, "thread-old");
});

test("rereview requires prior verification evidence", async () => {
  const { controls } = await setup();
  await assert.rejects(controls.rereview("huolin"), /verification evidence/);
});
