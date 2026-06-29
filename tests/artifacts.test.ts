import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { redactSecrets } from "../src/security/redact.js";

test("writes task JSON atomically and appends UUID workflow events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-artifacts-"));
  const store = new ArtifactStore(root, "crm", "task-1");

  await store.writeJson("state.json", { stage: "planning" });
  await store.appendWorkflowEvent("worker", 1, "stage_started", {
    stage: "planning",
  });
  await store.appendWorkflowEvent("worker", 2, "stage_completed", {
    stage: "planning",
  });

  assert.deepEqual(await store.readJson("state.json"), { stage: "planning" });
  const events = await store.readWorkflowEvents();
  assert.deepEqual(events.map((event) => event.stateRevision), [1, 2]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 2);
});

test("event identity does not depend on process-local sequence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-artifacts-"));
  const first = new ArtifactStore(root, "crm", "task-1");
  const second = new ArtifactStore(root, "crm", "task-1");

  await Promise.all([
    first.appendWorkflowEvent("worker", 1, "state_changed", {}),
    second.appendWorkflowEvent("operator", 1, "pause_requested", {}),
  ]);

  const events = await first.readWorkflowEvents();
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 2);
});

test("reads legacy sequence events with deterministic synthetic identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-artifacts-"));
  const store = new ArtifactStore(root, "crm", "task-1");
  await store.writeText(
    "events.jsonl",
    [
      JSON.stringify({
        sequence: 2,
        timestamp: "2026-06-30T00:00:02.000Z",
        type: "state_changed",
        stage: "planning",
      }),
      JSON.stringify({
        sequence: 1,
        timestamp: "2026-06-30T00:00:01.000Z",
        type: "state_changed",
        stage: "context_preparing",
      }),
      "",
    ].join("\n"),
  );

  const events = await store.readWorkflowEvents();

  assert.deepEqual(
    events.map((event) => event.eventId),
    [
      "legacy-2026-06-30T00:00:01.000Z-1",
      "legacy-2026-06-30T00:00:02.000Z-2",
    ],
  );
  assert.deepEqual(events[0]?.payload, { stage: "context_preparing" });
});

test("rejects artifact paths that escape the task directory", () => {
  const store = new ArtifactStore("/tmp/artifacts", "crm", "task-1");

  assert.throws(() => store.resolve("../other-task/state.json"), /escapes task directory/);
  assert.throws(() => store.resolve("/tmp/absolute.json"), /relative path/);
});

test("redacts common credentials before logs are persisted", () => {
  const value = redactSecrets(
    "Authorization: Bearer abc.def.ghi\nOPENAI_API_KEY=sk-live-secret\nsafe=value",
  );

  assert.doesNotMatch(value, /abc\.def\.ghi/);
  assert.doesNotMatch(value, /sk-live-secret/);
  assert.match(value, /safe=value/);
});
