import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProjectConfig, parseProjectConfig } from "../src/config/project.js";

const validConfig = {
  schema_version: 1,
  id: "crm-frontend",
  repo: {
    path: "/tmp/crm-frontend",
    base_branch: "main",
    require_clean: true,
  },
  hermes: {
    board: "crm-frontend",
    assignee: "ai-dev",
  },
  codex: {
    network: false,
    reasoning_effort: "high",
  },
  review: {
    model: "sonnet",
    max_fix_cycles: 2,
    max_turns: 8,
  },
  verification: {
    commands: [
      {
        id: "test",
        argv: ["pnpm", "test"],
        required: true,
        timeout_seconds: 600,
      },
    ],
  },
  knowledge: {
    vault_path: "/tmp/vault",
    project_path: "AI Dev/Projects/crm-frontend",
    task_logs: "auto",
    reusable_knowledge: "ask",
  },
  ci: {
    mode: "local",
  },
} as const;

test("parses a strict v1 project configuration", () => {
  const config = parseProjectConfig(validConfig);

  assert.equal(config.id, "crm-frontend");
  assert.equal(config.review.maxFixCycles, 2);
  assert.equal(config.codex.turnTimeoutSeconds, 1800);
  assert.deepEqual(config.verification.commands[0]?.argv, ["pnpm", "test"]);
});

test("rejects shell-string verification commands", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...validConfig,
        verification: {
          commands: [
            {
              id: "test",
              command: "pnpm test && rm -rf /",
              required: true,
              timeout_seconds: 600,
            },
          ],
        },
      }),
    /verification\.commands/,
  );
});

test("rejects relative repository and vault paths", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...validConfig,
        repo: { ...validConfig.repo, path: "../crm" },
      }),
    /repo\.path/,
  );

  assert.throws(
    () =>
      parseProjectConfig({
        ...validConfig,
        knowledge: { ...validConfig.knowledge, vault_path: "./vault" },
      }),
    /knowledge\.vault_path/,
  );
});

test("rejects unsupported GitHub Actions mode in v1", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...validConfig,
        ci: { mode: "github_actions" },
      }),
    /ci\.mode/,
  );
});

test("loads YAML project configuration from disk", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-dev-config-"));
  const configPath = path.join(directory, "project.yml");
  await writeFile(
    configPath,
    [
      "schema_version: 1",
      "id: crm-frontend",
      "repo:",
      "  path: /tmp/crm-frontend",
      "  base_branch: main",
      "  require_clean: true",
      "hermes:",
      "  board: crm-frontend",
      "  assignee: ai-dev",
      "codex:",
      "  network: false",
      "  reasoning_effort: high",
      "review:",
      "  model: sonnet",
      "  max_fix_cycles: 2",
      "  max_turns: 8",
      "verification:",
      "  commands: []",
      "knowledge:",
      "  vault_path: /tmp/vault",
      "  project_path: AI Dev/Projects/crm-frontend",
      "  task_logs: auto",
      "  reusable_knowledge: ask",
      "ci:",
      "  mode: local",
      "",
    ].join("\n"),
  );

  const config = await loadProjectConfig(configPath);

  assert.equal(config.id, "crm-frontend");
});
