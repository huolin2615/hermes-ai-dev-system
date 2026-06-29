import { readdir } from "node:fs/promises";
import path from "node:path";

import { loadProjectConfig, type ProjectConfig } from "./project.js";

export async function loadProjectConfigs(
  configDirectory: string,
): Promise<ProjectConfig[]> {
  const entries = await readdir(configDirectory, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")),
    )
    .map((entry) => path.join(configDirectory, entry.name))
    .sort();
  const configs = await Promise.all(files.map(loadProjectConfig));
  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.id)) {
      throw new Error(`duplicate project id: ${config.id}`);
    }
    seen.add(config.id);
  }
  return configs;
}

export async function findProjectConfig(
  configDirectory: string,
  projectId: string,
): Promise<ProjectConfig> {
  const configs = await loadProjectConfigs(configDirectory);
  const config = configs.find((candidate) => candidate.id === projectId);
  if (!config) {
    throw new Error(`unknown project id: ${projectId}`);
  }
  return config;
}
