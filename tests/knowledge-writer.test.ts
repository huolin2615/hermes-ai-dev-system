import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { KnowledgeWriter } from "../src/knowledge/writer.js";

test("writes an idempotent task log and project index wikilink", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "ai-dev-knowledge-"));
  const writer = new KnowledgeWriter({
    vaultPath: vault,
    projectPath: "AI Dev/Projects/crm",
  });

  const notePath = await writer.writeTaskLog({
    taskId: "t_123",
    projectId: "crm",
    title: "Order Filters",
    summary: "Added server-side filters.",
    repoPath: "/tmp/crm",
    branch: "codex/crm-order-filters",
    changedFiles: ["src/orders.ts"],
    verification: ["pnpm test: PASS"],
    reviewSummary: "PASS",
  });
  await writer.writeTaskLog({
    taskId: "t_123",
    projectId: "crm",
    title: "Order Filters",
    summary: "Updated summary.",
    repoPath: "/tmp/crm",
    branch: "codex/crm-order-filters",
    changedFiles: ["src/orders.ts"],
    verification: ["pnpm test: PASS"],
    reviewSummary: "PASS",
  });

  const note = await readFile(notePath, "utf8");
  const index = await readFile(
    path.join(vault, "AI Dev", "Projects", "crm", "Project Index.md"),
    "utf8",
  );
  assert.match(note, /task_id: t_123/);
  assert.match(note, /Updated summary/);
  assert.equal((index.match(/\[\[Runs\/t_123 Order Filters\]\]/g) ?? []).length, 1);
});

test("writes reusable knowledge to Proposals until approved", async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), "ai-dev-knowledge-"));
  const writer = new KnowledgeWriter({
    vaultPath: vault,
    projectPath: "AI Dev/Projects/crm",
  });

  const proposal = await writer.writeProposal({
    taskId: "t_123",
    projectId: "crm",
    kind: "pattern",
    title: "Server Pagination",
    content: "Use cursor pagination for large datasets.",
    sources: ["Runs/t_123 Order Filters"],
  });

  assert.match(proposal, /Proposals/);
  assert.match(await readFile(proposal, "utf8"), /status: proposed/);
});

test("promotes approved knowledge without deleting the proposal audit file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-vault-"));
  const writer = new KnowledgeWriter({
    vaultPath: root,
    projectPath: "AI Dev/Projects/crm",
  });
  const proposalPath = await writer.writeProposal({
    taskId: "t_3",
    projectId: "crm",
    kind: "rule",
    title: "Validate filters",
    content: "Validate filters at the API boundary.",
    sources: ["Runs/t_3 Validate filters"],
  });

  const promotedPath = await writer.promoteProposal({
    proposalPath,
    approvedBy: "huolin",
  });

  assert.match(await readFile(promotedPath, "utf8"), /status: approved/);
  assert.match(await readFile(promotedPath, "utf8"), /approved_by: "?huolin"?/);
  assert.match(await readFile(proposalPath, "utf8"), /status: proposed/);
});
