import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { redactSecrets } from "../src/security/redact.js";

test("writes task JSON atomically and appends ordered events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-artifacts-"));
  const store = new ArtifactStore(root, "crm", "task-1");

  await store.writeJson("state.json", { stage: "planning" });
  await store.appendEvent({ type: "stage_started", stage: "planning" });
  await store.appendEvent({ type: "stage_completed", stage: "planning" });

  assert.deepEqual(await store.readJson("state.json"), { stage: "planning" });
  const events = (await readFile(store.resolve("events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { sequence: number });
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
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
