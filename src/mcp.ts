#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { AiDevService } from "./runtime/service.js";

interface AiDevServicePort {
  submit(input: {
    projectId: string;
    title: string;
    requirement: string;
    idempotencyKey: string;
  }): Promise<{ taskId: string; branch: string }>;
  status(
    projectId: string,
    taskId: string,
  ): Promise<Awaited<ReturnType<AiDevService["status"]>>>;
  approve(
    projectId: string,
    taskId: string,
    gate: "plan" | "knowledge",
    approvedBy: string,
    note?: string,
  ): Promise<void>;
  operate(
    projectId: string,
    taskId: string,
    operation: "pause" | "resume" | "retry" | "reprepare" | "rereview",
    requestedBy: string,
    note?: string,
  ): Promise<void>;
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMcpServer(service: AiDevServicePort): McpServer {
  const server = new McpServer({
    name: "hermes-ai-dev",
    version: "0.1.0",
  });

  server.registerTool(
    "ai_dev_submit",
    {
      description:
        "Create one Hermes task with an isolated Git worktree. Does not push or merge.",
      inputSchema: {
        projectId: z.string().min(1),
        title: z.string().min(1),
        requirement: z.string().min(1),
        idempotencyKey: z.string().min(1),
      },
    },
    async (input) => text(await service.submit(input)),
  );

  server.registerTool(
    "ai_dev_status",
    {
      description:
        "Return Hermes, worktree, artifact, and Codex Desktop thread status.",
      inputSchema: {
        projectId: z.string().min(1),
        taskId: z.string().min(1),
      },
    },
    async ({ projectId, taskId }) =>
      text(await service.status(projectId, taskId)),
  );

  server.registerTool(
    "ai_dev_approve_plan",
    {
      description:
        "Record an explicit human plan approval and return the Hermes task to ready.",
      inputSchema: {
        projectId: z.string().min(1),
        taskId: z.string().min(1),
        approvedBy: z.string().min(1),
        note: z.string().default(""),
      },
    },
    async ({ projectId, taskId, approvedBy, note }) => {
      await service.approve(projectId, taskId, "plan", approvedBy, note);
      return text({ ok: true });
    },
  );

  server.registerTool(
    "ai_dev_pause",
    {
      description:
        "Request a pause at the next workflow boundary for human takeover.",
      inputSchema: {
        projectId: z.string().min(1),
        taskId: z.string().min(1),
        requestedBy: z.string().min(1),
        note: z.string().default(""),
      },
    },
    async ({ projectId, taskId, requestedBy, note }) => {
      await service.operate(
        projectId,
        taskId,
        "pause",
        requestedBy,
        note,
      );
      return text({ ok: true });
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const service = new AiDevService(
    path.resolve(process.env.AI_DEV_CONFIG_DIR ?? "config/projects"),
    path.resolve(process.env.AI_DEV_RUNTIME_DIR ?? ".ai-dev"),
  );
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
