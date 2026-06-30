import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import type { WorkflowStage } from "../workflow/state.js";
import type { ArtifactStore } from "./store.js";

export interface TaskErrorRecord {
  errorId: string;
  stage: WorkflowStage;
  code: string;
  message: string;
  occurredAt: string;
  resolvedAt?: string;
  resolution?: string;
}

interface ErrorResolution {
  errorId: string;
  resolvedAt: string;
  resolution: string;
}

function assertErrorId(errorId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      errorId,
    )
  ) {
    throw new Error(`invalid task error id: ${errorId}`);
  }
}

async function jsonFiles(
  store: ArtifactStore,
  directory: string,
): Promise<string[]> {
  try {
    return (await readdir(store.resolve(directory)))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class TaskErrorStore {
  constructor(private readonly store: ArtifactStore) {}

  async record(
    input: Omit<TaskErrorRecord, "errorId" | "occurredAt">,
  ): Promise<TaskErrorRecord> {
    if (!input.code.trim() || !input.message.trim()) {
      throw new Error("task error code and message are required");
    }
    const record: TaskErrorRecord = {
      errorId: randomUUID(),
      stage: input.stage,
      code: input.code.trim(),
      message: input.message.trim(),
      occurredAt: new Date().toISOString(),
    };
    await this.store.writeJson(`errors/${record.errorId}.json`, record);
    return record;
  }

  async resolve(errorId: string, resolution: string): Promise<void> {
    assertErrorId(errorId);
    const errorPath = `errors/${errorId}.json`;
    if (!(await this.store.exists(errorPath))) {
      throw new Error(`task error does not exist: ${errorId}`);
    }
    const resolutionPath = `errors/resolutions/${errorId}.json`;
    if (await this.store.exists(resolutionPath)) return;
    const record: ErrorResolution = {
      errorId,
      resolvedAt: new Date().toISOString(),
      resolution: resolution.trim(),
    };
    await this.store.writeJson(resolutionPath, record);
  }

  async resolveStage(
    stage: WorkflowStage,
    resolution: string,
  ): Promise<void> {
    for (const error of await this.active()) {
      if (error.stage === stage) {
        await this.resolve(error.errorId, resolution);
      }
    }
  }

  async active(): Promise<TaskErrorRecord[]> {
    return (await this.history()).filter((record) => !record.resolvedAt);
  }

  async history(): Promise<TaskErrorRecord[]> {
    const records: TaskErrorRecord[] = [];
    for (const file of await jsonFiles(this.store, "errors")) {
      const record = await this.store.readJson<TaskErrorRecord>(
        `errors/${file}`,
      );
      const resolutionPath = `errors/resolutions/${record.errorId}.json`;
      if (await this.store.exists(resolutionPath)) {
        const resolution =
          await this.store.readJson<ErrorResolution>(resolutionPath);
        records.push({
          ...record,
          resolvedAt: resolution.resolvedAt,
          resolution: resolution.resolution,
        });
      } else {
        records.push(record);
      }
    }
    return records.sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.errorId.localeCompare(right.errorId),
    );
  }
}
