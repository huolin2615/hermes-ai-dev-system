#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CleanupApprovalStore } from "./cleanup/approval.js";
import { runDoctor } from "./runtime/doctor.js";
import { installLaunchdService } from "./runtime/launchd.js";
import { AiDevService } from "./runtime/service.js";
import { AiDevWorker } from "./runtime/worker.js";

type Options = Record<string, string | boolean>;

function parseOptions(argv: string[]): { command: string; options: Options } {
  const [command = "help", ...rest] = argv;
  const options: Options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = next;
      index += 1;
    }
  }
  return { command, options };
}

function stringOption(
  options: Options,
  name: string,
  fallback?: string,
): string {
  const value = options[name] ?? fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

export async function readAnswersFile(
  target: string,
): Promise<Record<string, string>> {
  if (!path.isAbsolute(target)) {
    throw new Error("--answers-file must be an absolute path");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch {
    throw new Error("--answers-file must contain valid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    )
  ) {
    throw new Error(
      "--answers-file must contain an object of non-empty string answers",
    );
  }
  return parsed as Record<string, string>;
}

async function answersFileOption(
  options: Options,
): Promise<Record<string, string>> {
  const target = options["answers-file"];
  if (target === undefined) return {};
  if (typeof target !== "string") {
    throw new Error("--answers-file must be an absolute path");
  }
  return readAnswersFile(target);
}

function directories(options: Options): {
  configDirectory: string;
  runtimeRoot: string;
} {
  return {
    configDirectory: path.resolve(
      stringOption(options, "config-dir", "config/projects"),
    ),
    runtimeRoot: path.resolve(stringOption(options, "runtime-dir", ".ai-dev")),
  };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(): void {
  process.stdout.write(
    [
      "ai-dev commands:",
      "  worker [--once] [--poll-seconds 30]",
      "  submit --project ID --title TEXT (--requirement TEXT | --requirement-file PATH) --idempotency-key KEY",
      "  status --project ID --task TASK",
      "  approve-plan --project ID --task TASK --by NAME [--note TEXT] [--answers-file ABSOLUTE]",
      "  approve-knowledge --project ID --task TASK --by NAME [--note TEXT]",
      "  pause|resume|retry|reprepare|rereview --project ID --task TASK --by NAME [--note TEXT]",
      "  cleanup-request --task TASK --target-type file|worktree --target-path ABSOLUTE --reason TEXT",
      "  cleanup-approve --request ID",
      "  cleanup-execute --request ID",
      "  doctor",
      "  service-install --plist-path ABSOLUTE --node-path ABSOLUTE --cli-path ABSOLUTE --log-dir ABSOLUTE",
      "",
      "Global options: --config-dir PATH --runtime-dir PATH",
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, options } = parseOptions(argv);
  if (command === "help" || command === "--help") {
    help();
    return 0;
  }
  const { configDirectory, runtimeRoot } = directories(options);
  const service = new AiDevService(configDirectory, runtimeRoot);

  switch (command) {
    case "worker": {
      const worker = new AiDevWorker(configDirectory, runtimeRoot);
      if (options.once === true) {
        const result = await worker.runOnce();
        output(result);
        return result.status === "error" ? 1 : 0;
      }
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      const seconds = Number(stringOption(options, "poll-seconds", "30"));
      await worker.runLoop(seconds * 1_000, controller.signal);
      return 0;
    }
    case "submit": {
      const requirement = options["requirement-file"]
        ? await readFile(
            path.resolve(stringOption(options, "requirement-file")),
            "utf8",
          )
        : stringOption(options, "requirement");
      const result = await service.submit({
        projectId: stringOption(options, "project"),
        title: stringOption(options, "title"),
        requirement,
        idempotencyKey: stringOption(options, "idempotency-key"),
        ...(typeof options.branch === "string"
          ? { branch: options.branch }
          : {}),
      });
      output(result);
      return 0;
    }
    case "status":
      output(
        await service.status(
          stringOption(options, "project"),
          stringOption(options, "task"),
        ),
      );
      return 0;
    case "approve-plan":
    case "approve-knowledge":
      output(
        await service.approve(
          stringOption(options, "project"),
          stringOption(options, "task"),
          command === "approve-plan" ? "plan" : "knowledge",
          stringOption(options, "by"),
          stringOption(options, "note", ""),
          command === "approve-plan"
            ? await answersFileOption(options)
            : {},
        ),
      );
      return 0;
    case "pause":
    case "resume":
    case "retry":
    case "reprepare":
    case "rereview":
      output(
        await service.operate(
          stringOption(options, "project"),
          stringOption(options, "task"),
          command,
          stringOption(options, "by"),
          stringOption(options, "note", ""),
        ),
      );
      return 0;
    case "cleanup-request": {
      const cleanup = new CleanupApprovalStore(
        path.join(runtimeRoot, "cleanup-requests"),
      );
      const targetType = stringOption(options, "target-type");
      if (targetType !== "file" && targetType !== "worktree") {
        throw new Error("--target-type must be file or worktree");
      }
      output(
        await cleanup.request({
          taskId: stringOption(options, "task"),
          targetType,
          targetPath: stringOption(options, "target-path"),
          reason: stringOption(options, "reason"),
        }),
      );
      return 0;
    }
    case "cleanup-approve":
      output(
        await new CleanupApprovalStore(
          path.join(runtimeRoot, "cleanup-requests"),
        ).approve(stringOption(options, "request")),
      );
      return 0;
    case "cleanup-execute":
      output(
        await new CleanupApprovalStore(
          path.join(runtimeRoot, "cleanup-requests"),
        ).execute(stringOption(options, "request")),
      );
      return 0;
    case "doctor": {
      const report = await runDoctor({ configDirectory, runtimeRoot });
      output(report);
      return report.ok ? 0 : 1;
    }
    case "service-install": {
      const logDirectory = stringOption(options, "log-dir");
      if (!path.isAbsolute(logDirectory)) {
        throw new Error("--log-dir must be absolute");
      }
      await installLaunchdService(stringOption(options, "plist-path"), {
        label: stringOption(
          options,
          "label",
          "com.huolin.hermes-ai-dev-worker",
        ),
        nodePath: stringOption(options, "node-path"),
        cliPath: stringOption(options, "cli-path"),
        configDirectory,
        runtimeRoot,
        workingDirectory: stringOption(options, "working-dir", process.cwd()),
        stdoutPath: path.join(logDirectory, "worker.stdout.log"),
        stderrPath: path.join(logDirectory, "worker.stderr.log"),
        pollSeconds: Number(stringOption(options, "poll-seconds", "30")),
      });
      output({ ok: true, plistPath: stringOption(options, "plist-path") });
      return 0;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
