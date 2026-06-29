import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectConfigs } from "../config/registry.js";
import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/runner.js";
import { WorkerHealthStore } from "./health.js";

type Executor = (options: RunCommandOptions) => Promise<CommandResult>;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  version?: string;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

function version(value: string): string | undefined {
  return value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function majorMinor(value: string | undefined): string | undefined {
  return value?.split(".").slice(0, 2).join(".");
}

async function commandCheck(
  name: string,
  argv: [string, ...string[]],
  execute: Executor,
): Promise<DoctorCheck> {
  const result = await execute({
    argv,
    timeoutMs: 10_000,
    maxOutputBytes: 100_000,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const parsed = version(output);
  return {
    name,
    ok: result.exitCode === 0,
    ...(parsed ? { version: parsed } : {}),
    detail:
      result.exitCode === 0
        ? output || "available"
        : output || `exit ${result.exitCode ?? result.signal ?? "unknown"}`,
  };
}

async function installedSdkVersion(): Promise<string | undefined> {
  let directory = path.dirname(
    fileURLToPath(import.meta.resolve("@openai/codex-sdk")),
  );
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const candidate = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ) as { name?: string; version?: string };
      if (candidate.name === "@openai/codex-sdk") {
        return candidate.version ? version(candidate.version) : undefined;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function atLeast(
  actual: string | undefined,
  minimumMajor: number,
  minimumMinor: number,
): boolean {
  if (!actual) return false;
  const [major = 0, minor = 0] = actual.split(".").map(Number);
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

export async function runDoctor(
  input: {
    configDirectory: string;
    runtimeRoot: string;
    staleAfterMs?: number;
  },
  execute: Executor = runCommand,
): Promise<DoctorReport> {
  const checks = await Promise.all([
    commandCheck("Hermes CLI", ["hermes", "--version"], execute),
    commandCheck("Codex CLI", ["codex", "--version"], execute),
    commandCheck("Claude Code", ["claude", "--version"], execute),
  ]);
  const sdkVersion = await installedSdkVersion();
  const hermes = checks.find((check) => check.name === "Hermes CLI");
  const codex = checks.find((check) => check.name === "Codex CLI");
  const claude = checks.find((check) => check.name === "Claude Code");
  checks.push({
    name: "Hermes compatibility",
    ok: atLeast(hermes?.version, 0, 17),
    detail: `Hermes ${hermes?.version ?? "unknown"}; tested baseline >=0.17`,
  });
  checks.push({
    name: "Codex SDK compatibility",
    ok:
      sdkVersion !== undefined &&
      majorMinor(sdkVersion) === majorMinor(codex?.version),
    ...(sdkVersion ? { version: sdkVersion } : {}),
    detail: `SDK ${sdkVersion ?? "unknown"}; CLI ${codex?.version ?? "unknown"}; major.minor must match`,
  });
  checks.push({
    name: "Claude Code compatibility",
    ok: atLeast(claude?.version, 2, 1),
    detail: `Claude Code ${claude?.version ?? "unknown"}; tested baseline >=2.1`,
  });
  checks.push({
    name: "Node.js",
    ok: Number(process.versions.node.split(".")[0]) >= 22,
    version: process.versions.node,
    detail: "requires Node.js 22 or newer",
  });

  try {
    const configs = await loadProjectConfigs(input.configDirectory);
    checks.push({
      name: "Project configuration",
      ok: configs.length > 0,
      detail: `${configs.length} project configuration(s) loaded`,
    });
  } catch (error) {
    checks.push({
      name: "Project configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const inspected = await new WorkerHealthStore(input.runtimeRoot).inspect(
      input.staleAfterMs ?? 5 * 60_000,
    );
    checks.push({
      name: "Worker heartbeat",
      ok: !inspected.stale && inspected.health.status !== "error",
      detail: `${inspected.health.status}; updated ${inspected.health.updatedAt}`,
    });
  } catch (error) {
    checks.push({
      name: "Worker heartbeat",
      ok: false,
      detail:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "worker has not written health status yet"
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
