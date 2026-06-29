import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "../process/runner.js";

export interface LaunchdOptions {
  label: string;
  nodePath: string;
  cliPath: string;
  configDirectory: string;
  runtimeRoot: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  pollSeconds: number;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertAbsolute(name: string, value: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

export function renderLaunchdPlist(options: LaunchdOptions): string {
  for (const [name, value] of Object.entries({
    nodePath: options.nodePath,
    cliPath: options.cliPath,
    configDirectory: options.configDirectory,
    runtimeRoot: options.runtimeRoot,
    workingDirectory: options.workingDirectory,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
  })) {
    assertAbsolute(name, value);
  }
  if (!/^[A-Za-z0-9.-]+$/.test(options.label)) {
    throw new Error("launchd label contains unsupported characters");
  }
  if (!Number.isInteger(options.pollSeconds) || options.pollSeconds < 1) {
    throw new Error("pollSeconds must be a positive integer");
  }
  const argumentsList = [
    options.nodePath,
    options.cliPath,
    "worker",
    "--config-dir",
    options.configDirectory,
    "--runtime-dir",
    options.runtimeRoot,
    "--poll-seconds",
    String(options.pollSeconds),
  ]
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(options.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentsList,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(options.workingDirectory)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(options.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(options.stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function installLaunchdService(
  plistPath: string,
  options: LaunchdOptions,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("launchd service installation requires macOS");
  }
  assertAbsolute("plistPath", plistPath);
  await mkdir(path.dirname(plistPath), { recursive: true });
  await mkdir(path.dirname(options.stdoutPath), { recursive: true });
  await mkdir(path.dirname(options.stderrPath), { recursive: true });
  await writeFile(plistPath, renderLaunchdPlist(options), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("unable to determine the macOS user id");
  }
  const result = await runCommand({
    argv: [
      "launchctl",
      "bootstrap",
      `gui/${uid}`,
      plistPath,
    ],
    timeoutMs: 30_000,
    maxOutputBytes: 100_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `launchctl bootstrap failed: ${result.stderr || result.stdout}`,
    );
  }
}
