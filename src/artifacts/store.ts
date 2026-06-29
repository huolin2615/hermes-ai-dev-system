import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { redactSecrets } from "../security/redact.js";

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export class ArtifactStore {
  readonly taskRoot: string;
  private sequence: number | undefined;

  constructor(root: string, board: string, taskId: string) {
    this.taskRoot = path.resolve(
      root,
      safeSegment(board, "board"),
      safeSegment(taskId, "task id"),
    );
  }

  resolve(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error("artifact path must be a relative path");
    }
    const resolved = path.resolve(this.taskRoot, relativePath);
    if (resolved !== this.taskRoot && !resolved.startsWith(`${this.taskRoot}${path.sep}`)) {
      throw new Error("artifact path escapes task directory");
    }
    return resolved;
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async readJson<T = unknown>(relativePath: string): Promise<T> {
    return JSON.parse(await readFile(this.resolve(relativePath), "utf8")) as T;
  }

  async writeText(relativePath: string, value: string): Promise<void> {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, redactSecrets(value), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async nextSequence(): Promise<number> {
    if (this.sequence === undefined) {
      const eventsPath = this.resolve("events.jsonl");
      try {
        const file = await readFile(eventsPath, "utf8");
        this.sequence = file.split("\n").filter(Boolean).length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        this.sequence = 0;
      }
    }
    this.sequence += 1;
    return this.sequence;
  }

  async appendEvent(event: Record<string, unknown>): Promise<void> {
    const target = this.resolve("events.jsonl");
    await mkdir(path.dirname(target), { recursive: true });
    const sequence = await this.nextSequence();
    const record = redactSecrets(
      JSON.stringify({
        sequence,
        timestamp: new Date().toISOString(),
        ...event,
      }),
    );
    await appendFile(target, `${record}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(this.resolve(relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
