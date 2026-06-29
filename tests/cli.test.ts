import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readAnswersFile } from "../src/cli.js";

test("reads non-empty plan answers from an absolute JSON file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-cli-"));
  const target = path.join(root, "answers.json");
  await writeFile(
    target,
    JSON.stringify({ target_runtime: "Node.js 22" }),
    "utf8",
  );

  assert.deepEqual(await readAnswersFile(target), {
    target_runtime: "Node.js 22",
  });
});

test("rejects relative answer files and empty answers", async () => {
  await assert.rejects(
    readAnswersFile("answers.json"),
    /absolute path/,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-cli-"));
  const target = path.join(root, "answers.json");
  await writeFile(target, JSON.stringify({ target_runtime: " " }), "utf8");
  await assert.rejects(readAnswersFile(target), /non-empty string answers/);
});
