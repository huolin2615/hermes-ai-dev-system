import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp.js";

test("exposes only the intended non-destructive Hermes MCP tools", async () => {
  let approval:
    | {
        projectId: string;
        taskId: string;
        gate: "plan" | "knowledge";
        approvedBy: string;
        note: string;
        answers: Record<string, string>;
      }
    | undefined;
  const service = {
    async submit() {
      return { taskId: "t_1", branch: "codex/test" };
    },
    async status() {
      return {
        projectId: "crm",
        taskId: "t_1",
        hermesStatus: "ready",
        workflowStage: null,
        worktreePath: null,
        branch: null,
        codexThreadId: null,
        codexDesktopUrl: null,
        artifactPath: "/tmp/artifacts",
      };
    },
    async approve(
      projectId: string,
      taskId: string,
      gate: "plan" | "knowledge",
      approvedBy: string,
      note = "",
      answers: Record<string, string> = {},
    ) {
      approval = {
        projectId,
        taskId,
        gate,
        approvedBy,
        note,
        answers,
      };
    },
    async operate() {},
  };
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "ai_dev_approve_plan",
    "ai_dev_pause",
    "ai_dev_status",
    "ai_dev_submit",
  ]);
  assert.equal(names.some((name) => name.includes("cleanup")), false);
  await client.callTool({
    name: "ai_dev_approve_plan",
    arguments: {
      projectId: "crm",
      taskId: "t_1",
      approvedBy: "huolin",
      note: "Use the chosen runtime",
      answers: { target_runtime: "Node.js 22" },
    },
  });
  assert.deepEqual(approval, {
    projectId: "crm",
    taskId: "t_1",
    gate: "plan",
    approvedBy: "huolin",
    note: "Use the chosen runtime",
    answers: { target_runtime: "Node.js 22" },
  });
  await client.close();
  await server.close();
});
