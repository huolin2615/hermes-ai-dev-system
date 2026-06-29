import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../process/runner.js";

export type CleanupTargetType = "file" | "worktree";
export type CleanupStatus = "pending" | "approved" | "executed";

export interface CleanupRequest {
  id: string;
  taskId: string;
  targetType: CleanupTargetType;
  targetPath: string;
  reason: string;
  status: CleanupStatus;
  requestedAt: string;
  approvedAt?: string;
  executedAt?: string;
}

export type CleanupExecutor = (request: CleanupRequest) => Promise<void>;

function validateTarget(type: CleanupTargetType, targetPath: string): void {
  if (type !== "file" && type !== "worktree") {
    throw new Error("unsupported cleanup target type");
  }
  if (!path.isAbsolute(targetPath)) {
    throw new Error("cleanup target must be an absolute path");
  }
  if (/[*?[\]{}]/.test(targetPath)) {
    throw new Error("cleanup target must not contain a wildcard");
  }
}

async function defaultCleanup(request: CleanupRequest): Promise<void> {
  if (request.targetType === "file") {
    await unlink(request.targetPath);
    return;
  }
  const result = await runCommand({
    argv: ["git", "-C", request.targetPath, "worktree", "remove", request.targetPath],
    timeoutMs: 60_000,
    maxOutputBytes: 100_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`worktree cleanup failed: ${result.stderr || result.stdout}`);
  }
}

export class CleanupApprovalStore {
  constructor(
    private readonly root: string,
    private readonly executeTarget: CleanupExecutor = defaultCleanup,
  ) {}

  private requestPath(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      throw new Error("invalid cleanup request id");
    }
    return path.join(this.root, `${id}.json`);
  }

  private async write(request: CleanupRequest): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.requestPath(request.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async read(id: string): Promise<CleanupRequest> {
    return JSON.parse(await readFile(this.requestPath(id), "utf8")) as CleanupRequest;
  }

  async request(input: {
    taskId: string;
    targetType: CleanupTargetType;
    targetPath: string;
    reason: string;
  }): Promise<CleanupRequest> {
    validateTarget(input.targetType, input.targetPath);
    if (input.targetType === "file") {
      try {
        const target = await lstat(input.targetPath);
        if (target.isDirectory()) {
          throw new Error("file cleanup target must not be a directory");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const request: CleanupRequest = {
      id: randomUUID(),
      ...input,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    await this.write(request);
    return request;
  }

  async approve(id: string): Promise<CleanupRequest> {
    const request = await this.read(id);
    if (request.status !== "pending") {
      throw new Error(`cleanup request is already ${request.status}`);
    }
    const approved: CleanupRequest = {
      ...request,
      status: "approved",
      approvedAt: new Date().toISOString(),
    };
    await this.write(approved);
    return approved;
  }

  async execute(id: string): Promise<CleanupRequest> {
    const request = await this.read(id);
    if (request.status === "pending") {
      throw new Error("cleanup request is not approved");
    }
    if (request.status === "executed") {
      throw new Error("cleanup request was already executed");
    }
    await this.executeTarget(request);
    const executed: CleanupRequest = {
      ...request,
      status: "executed",
      executedAt: new Date().toISOString(),
    };
    await this.write(executed);
    return executed;
  }
}
