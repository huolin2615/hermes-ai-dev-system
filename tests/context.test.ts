import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildKnowledgeContext } from "../src/context/knowledge.js";

test("ranks matching Obsidian notes and records verifiable sources", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "ai-dev-vault-"));
  const project = path.join(vault, "AI Dev", "Projects", "crm");
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "Order Pagination.md"),
    "---\ntags: [orders, pagination]\n---\n# Order Pagination\nUse server-side pagination.\n",
  );
  await writeFile(path.join(project, "Unrelated.md"), "# Colors\nUse blue.\n");

  const result = await buildKnowledgeContext({
    vaultPath: vault,
    projectPath: "AI Dev/Projects/crm",
    query: "orders pagination",
    maxExcerpts: 10,
    maxBytes: 10_000,
  });

  assert.equal(result.entries[0]?.relativePath, "AI Dev/Projects/crm/Order Pagination.md");
  assert.match(result.markdown, /server-side pagination/);
  assert.match(result.entries[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
});

test("excludes Obsidian internals and unapproved proposals", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "ai-dev-vault-"));
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await mkdir(path.join(vault, "AI Dev", "Projects", "crm", "Proposals"), {
    recursive: true,
  });
  await writeFile(path.join(vault, ".obsidian", "secret.md"), "orders pagination");
  await writeFile(
    path.join(vault, "AI Dev", "Projects", "crm", "Proposals", "Draft.md"),
    "orders pagination",
  );

  const result = await buildKnowledgeContext({
    vaultPath: vault,
    projectPath: "AI Dev/Projects/crm",
    query: "orders pagination",
    maxExcerpts: 10,
    maxBytes: 10_000,
  });

  assert.deepEqual(result.entries, []);
});
