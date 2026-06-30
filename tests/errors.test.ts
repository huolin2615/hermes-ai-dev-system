import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifacts/store.js";
import { TaskErrorStore } from "../src/artifacts/errors.js";

test("completed recovery resolves the prior active error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-errors-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const errors = new TaskErrorStore(store);
  const recorded = await errors.record({
    stage: "reviewing",
    code: "CLAUDE_INVALID_OUTPUT",
    message: "Expected object.",
  });
  assert.equal((await errors.active()).length, 1);

  await errors.resolve(recorded.errorId, "review succeeded on retry");

  assert.deepEqual(await errors.active(), []);
  assert.match(
    (await errors.history())[0]?.resolvedAt ?? "",
    /^\d{4}-\d{2}-\d{2}T/,
  );
});

test("resolution is immutable and resolving a stage is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-errors-"));
  const store = new ArtifactStore(root, "crm", "t_1");
  const errors = new TaskErrorStore(store);
  const first = await errors.record({
    stage: "planning",
    code: "CODEX_TIMEOUT",
    message: "Timed out.",
  });
  await errors.record({
    stage: "reviewing",
    code: "CLAUDE_TIMEOUT",
    message: "Timed out.",
  });

  await errors.resolveStage("planning", "planning succeeded");
  await errors.resolve(first.errorId, "must not overwrite");

  const history = await errors.history();
  assert.equal((await errors.active()).length, 1);
  assert.equal(
    history.find((entry) => entry.errorId === first.errorId)?.resolution,
    "planning succeeded",
  );
});
