import assert from "node:assert/strict";
import test from "node:test";

import {
  digestCodexPlan,
  parseCodexPlan,
} from "../src/workflow/plan-contract.js";

test("migrates a v1 plan to typed v2 capabilities", () => {
  const migrated = parseCodexPlan({
    summary: "Change one file",
    assumptions: [],
    files: ["src/app.ts"],
    tests: ["pnpm test"],
    requiresNetwork: false,
    operations: [],
    questions: [],
    knowledgeNeeds: [],
  });

  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.capabilities, {
    network: false,
    dependencyInstall: false,
    externalWrite: false,
  });
  assert.deepEqual(migrated.fileDeletions, []);
});

test("maps only recognized v1 capability identifiers", () => {
  const migrated = parseCodexPlan({
    summary: "Update dependencies",
    assumptions: [],
    files: ["package.json"],
    tests: [],
    requiresNetwork: true,
    operations: [
      "install_dependency",
      "push",
      "maybe deploy this later",
      "delete old files if needed",
    ],
    questions: ["Which package version?"],
    knowledgeNeeds: [],
  });

  assert.deepEqual(migrated.capabilities, {
    network: true,
    dependencyInstall: true,
    externalWrite: true,
  });
  assert.deepEqual(migrated.fileDeletions, []);
  assert.deepEqual(migrated.questions, [
    {
      id: "question_1",
      prompt: "Which package version?",
      required: true,
    },
  ]);
});

test("requires legacy deletion plans to be replanned as v2", () => {
  assert.throws(
    () =>
      parseCodexPlan({
        summary: "Delete one file",
        assumptions: [],
        files: ["src/legacy.ts"],
        tests: [],
        requiresNetwork: false,
        operations: ["delete_file"],
        questions: [],
        knowledgeNeeds: [],
      }),
    /replanned as v2/,
  );
});

test("rejects more than one requested deletion", () => {
  assert.throws(
    () =>
      parseCodexPlan({
        version: 2,
        summary: "Delete old files",
        assumptions: [],
        files: ["a.ts", "b.ts"],
        tests: [],
        capabilities: {
          network: false,
          dependencyInstall: false,
          externalWrite: false,
        },
        fileDeletions: ["a.ts", "b.ts"],
        questions: [],
        knowledgeNeeds: [],
      }),
    /at most 1/,
  );
});

test("rejects unsafe deletion paths and produces a stable digest", () => {
  const valid = parseCodexPlan({
    version: 2,
    summary: "Delete one exact file",
    assumptions: [],
    files: ["src/legacy.ts"],
    tests: [],
    capabilities: {
      network: false,
      dependencyInstall: false,
      externalWrite: false,
    },
    fileDeletions: ["src/legacy.ts"],
    questions: [],
    knowledgeNeeds: [],
  });

  assert.equal(digestCodexPlan(valid), digestCodexPlan({ ...valid }));
  assert.match(digestCodexPlan(valid), /^[a-f0-9]{64}$/);
  assert.throws(
    () => parseCodexPlan({ ...valid, fileDeletions: ["../legacy.ts"] }),
    /safe relative file path/,
  );
});
