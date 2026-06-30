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

const validV2Config = {
  ...validConfig,
  schema_version: 2,
  budgets: {
    max_active_minutes: 90,
    max_codex_input_tokens: 6_000_000,
    max_codex_output_tokens: 60_000,
    warning_ratio: 0.75,
  },
  retention: {
    task_artifacts_days: 45,
    warn_before_days: 10,
  },
} as const;

test("parses a strict v1 project configuration", () => {
  const config = parseProjectConfig(validConfig);

  assert.equal(config.schemaVersion, 2);
  assert.equal(config.id, "crm-frontend");
  assert.equal(config.review.maxFixCycles, 2);
  assert.equal(config.codex.turnTimeoutSeconds, 1800);
  assert.deepEqual(config.verification.commands[0]?.argv, ["pnpm", "test"]);
});

test("normalizes v1 config with hardening defaults", () => {
  const config = parseProjectConfig(validConfig);

  assert.equal(config.schemaVersion, 2);
  assert.deepEqual(config.budgets, {
    maxActiveMinutes: 60,
    maxCodexInputTokens: 5_000_000,
    maxCodexOutputTokens: 50_000,
    warningRatio: 0.8,
  });
  assert.deepEqual(config.retention, {
    taskArtifactsDays: 30,
    warnBeforeDays: 7,
  });
});

test("normalizes explicit v2 budgets and retention", () => {
  const config = parseProjectConfig(validV2Config);

  assert.deepEqual(config.budgets, {
    maxActiveMinutes: 90,
    maxCodexInputTokens: 6_000_000,
    maxCodexOutputTokens: 60_000,
    warningRatio: 0.75,
  });
  assert.deepEqual(config.retention, {
    taskArtifactsDays: 45,
    warnBeforeDays: 10,
  });
});

test("rejects a warning ratio outside zero and one", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...validV2Config,
        budgets: {
          ...validV2Config.budgets,
          warning_ratio: 1.2,
        },
      }),
    /budgets\.warning_ratio/,
  );
});

test("requires retention warning to precede artifact expiry", () => {
  assert.throws(
    () =>
      parseProjectConfig({
        ...validV2Config,
        retention: {
          task_artifacts_days: 30,
          warn_before_days: 30,
        },
      }),
    /retention\.warn_before_days/,
  );
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
