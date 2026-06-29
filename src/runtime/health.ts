import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkerHealth {
  version: 1;
  status:
    | "starting"
    | "idle"
    | "running"
    | "completed"
    | "blocked"
    | "stopped"
    | "error";
  pid: number;
  updatedAt: string;
  projectId?: string;
  taskId?: string;
  startedAt?: string;
  lastDurationMs?: number;
  lastError?: string;
}

export class WorkerHealthStore {
  readonly filePath: string;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, "worker-health.json");
  }

  async write(
    status: WorkerHealth["status"],
    details: Omit<Partial<WorkerHealth>, "version" | "status" | "pid" | "updatedAt"> = {},
  ): Promise<WorkerHealth> {
    const value: WorkerHealth = {
      version: 1,
      status,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ...details,
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
    return value;
  }

  async read(): Promise<WorkerHealth> {
    return JSON.parse(await readFile(this.filePath, "utf8")) as WorkerHealth;
  }

  async inspect(staleAfterMs: number): Promise<{
    health: WorkerHealth;
    stale: boolean;
  }> {
    const health = await this.read();
    return {
      health,
      stale:
        Date.now() - new Date(health.updatedAt).getTime() > staleAfterMs,
    };
  }
}
