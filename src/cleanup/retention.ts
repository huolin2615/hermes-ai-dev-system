import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { ProjectConfig } from "../config/project.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RetentionStatus {
  status: "retained" | "warning" | "expired";
  daysRemaining: number;
  artifactPath: string;
}

export function classifyRetention(input: {
  completedAt: string;
  now: Date;
  taskArtifactsDays: number;
  warnBeforeDays: number;
  artifactPath?: string;
}): RetentionStatus {
  const completedAt = new Date(input.completedAt);
  if (Number.isNaN(completedAt.getTime())) {
    throw new Error(`invalid completion timestamp: ${input.completedAt}`);
  }
  const expiresAt =
    completedAt.getTime() + input.taskArtifactsDays * DAY_MS;
  const daysRemaining = Math.ceil(
    (expiresAt - input.now.getTime()) / DAY_MS,
  );
  return {
    status:
      daysRemaining <= 0
        ? "expired"
        : daysRemaining <= input.warnBeforeDays
          ? "warning"
          : "retained",
    daysRemaining,
    artifactPath: input.artifactPath ?? "",
  };
}

export async function scanRetention(
  runtimeRoot: string,
  projects: Array<Pick<ProjectConfig, "hermes" | "retention">>,
  now = new Date(),
): Promise<RetentionStatus[]> {
  const statuses: RetentionStatus[] = [];
  for (const project of projects) {
    const boardRoot = path.join(runtimeRoot, project.hermes.board);
    let entries;
    try {
      entries = await readdir(boardRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactPath = path.join(boardRoot, entry.name);
      try {
        const manifest = JSON.parse(
          await readFile(path.join(artifactPath, "manifest.json"), "utf8"),
        ) as { completedAt?: unknown };
        if (typeof manifest.completedAt !== "string") continue;
        statuses.push(
          classifyRetention({
            completedAt: manifest.completedAt,
            now,
            taskArtifactsDays: project.retention.taskArtifactsDays,
            warnBeforeDays: project.retention.warnBeforeDays,
            artifactPath,
          }),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return statuses.sort((left, right) =>
    left.artifactPath.localeCompare(right.artifactPath),
  );
}
