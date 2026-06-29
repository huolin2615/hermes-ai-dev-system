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

export interface WorkflowEventRecord {
  eventId: string;
  timestamp: string;
  actor: "worker" | "operator" | "hermes";
  stateRevision: number;
  type: string;
  payload: Record<string, unknown>;
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

export class ArtifactStore {
  readonly taskRoot: string;

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

  async appendWorkflowEvent(
    actor: WorkflowEventRecord["actor"],
    stateRevision: number,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<WorkflowEventRecord> {
    const target = this.resolve("events.jsonl");
    await mkdir(path.dirname(target), { recursive: true });
    const record: WorkflowEventRecord = {
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      actor,
      stateRevision,
      type,
      payload,
    };
    await appendFile(
      target,
      `${redactSecrets(JSON.stringify(record))}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return record;
  }

  async readWorkflowEvents(): Promise<WorkflowEventRecord[]> {
    let source: string;
    try {
      source = await readFile(this.resolve("events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events = source
      .split("\n")
      .filter(Boolean)
      .map((line, index) => normalizeWorkflowEvent(JSON.parse(line), index));
    return events.sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.eventId.localeCompare(right.eventId),
    );
  }

  async appendEvent(event: Record<string, unknown>): Promise<void> {
    const { type, ...payload } = event;
    await this.appendWorkflowEvent(
      "operator",
      0,
      typeof type === "string" ? type : "legacy_event",
      payload,
    );
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

function normalizeWorkflowEvent(
  value: unknown,
  index: number,
): WorkflowEventRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid workflow event at line ${index + 1}`);
  }
  const record = value as Record<string, unknown>;
  const timestamp =
    typeof record.timestamp === "string"
      ? record.timestamp
      : new Date(0).toISOString();
  const type = typeof record.type === "string" ? record.type : "legacy_event";
  if (
    typeof record.eventId === "string" &&
    (record.actor === "worker" ||
      record.actor === "operator" ||
      record.actor === "hermes") &&
    typeof record.stateRevision === "number" &&
    record.payload !== null &&
    typeof record.payload === "object" &&
    !Array.isArray(record.payload)
  ) {
    return {
      eventId: record.eventId,
      timestamp,
      actor: record.actor,
      stateRevision: record.stateRevision,
      type,
      payload: record.payload as Record<string, unknown>,
    };
  }

  const {
    sequence,
    timestamp: _timestamp,
    type: _type,
    eventId: _eventId,
    actor: _actor,
    stateRevision: _stateRevision,
    payload: legacyPayload,
    ...legacyFields
  } = record;
  return {
    eventId: `legacy-${timestamp}-${String(sequence ?? index)}`,
    timestamp,
    actor:
      record.actor === "operator" || record.actor === "hermes"
        ? record.actor
        : "worker",
    stateRevision:
      typeof record.stateRevision === "number" ? record.stateRevision : 0,
    type,
    payload:
      legacyPayload !== null &&
      typeof legacyPayload === "object" &&
      !Array.isArray(legacyPayload)
        ? (legacyPayload as Record<string, unknown>)
        : legacyFields,
  };
}
