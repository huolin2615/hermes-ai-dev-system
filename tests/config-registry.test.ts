import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfigs } from "../src/config/registry.js";

function yaml(id: string): string {
  return `
schema_version: 1
id: ${id}
repo:
  path: /tmp/${id}
  base_branch: main
  require_clean: true
hermes:
  board: ${id}
  assignee: ai-dev
codex:
  network: false
  reasoning_effort: high
review:
  model: sonnet
  max_fix_cycles: 2
  max_turns: 8
verification:
  commands: []
knowledge:
  vault_path: /tmp/vault
  project_path: AI/${id}
  task_logs: auto
  reusable_knowledge: ask
ci:
  mode: local
`;
}

test("loads project YAML files in deterministic order", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-dev-configs-"));
  await writeFile(path.join(directory, "b.yaml"), yaml("beta"));
  await writeFile(path.join(directory, "a.yml"), yaml("alpha"));
  await writeFile(path.join(directory, "README.md"), "ignored");

  const configs = await loadProjectConfigs(directory);

  assert.deepEqual(
    configs.map((config) => config.id),
    ["alpha", "beta"],
  );
});

test("rejects duplicate project ids", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-dev-configs-"));
  await writeFile(path.join(directory, "a.yaml"), yaml("same"));
  await writeFile(path.join(directory, "b.yaml"), yaml("same"));

  await assert.rejects(loadProjectConfigs(directory), /duplicate project id/);
});
