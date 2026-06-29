import { spawn } from "node:child_process";

import { redactSecrets } from "../security/redact.js";

export interface RunCommandOptions {
  argv: [string, ...string[]];
  cwd?: string;
  env?: NodeJS.ProcessEnv | undefined;
  input?: string | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputTruncated: boolean;
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const [command, ...args] = options.argv;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputTruncated = false;
    let capturedBytes = 0;
    let timedOut = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
      if (chunk.length > remaining) {
        outputTruncated = true;
      }
      const kept = chunk.subarray(0, remaining);
      capturedBytes += kept.length;
      if (target === "stdout") {
        stdout = Buffer.concat([stdout, kept]);
      } else {
        stderr = Buffer.concat([stderr, kept]);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.stdin.on("error", () => {
      // The process may exit before consuming stdin; its exit status remains authoritative.
    });
    child.stdin.end(options.input);

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      const spawnMessage = spawnError ? `${spawnError.message}\n` : "";
      resolve({
        stdout: redactSecrets(stdout.toString("utf8")),
        stderr: redactSecrets(`${stderr.toString("utf8")}${spawnMessage}`),
        exitCode: spawnError ? 127 : exitCode,
        signal,
        timedOut,
        outputTruncated,
      });
    };

    const terminate = (): void => {
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? 5_000);
      forceKill.unref();
    };

    const abort = (): void => {
      terminate();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }

    child.on("error", (error) => finish(null, null, error));
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
  });
}
