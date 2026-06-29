import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../src/process/runner.js";

test("passes arguments literally without invoking a shell", async () => {
  const result = await runCommand({
    argv: [process.execPath, "-e", "console.log(process.argv[1])", "safe && echo unsafe"],
    timeoutMs: 5_000,
    maxOutputBytes: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "safe && echo unsafe");
  assert.equal(result.stderr, "");
});

test("terminates commands that exceed their timeout", async () => {
  const result = await runCommand({
    argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
    timeoutMs: 20,
    maxOutputBytes: 10_000,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("force kills a timed out process that ignores SIGTERM", async () => {
  const result = await runCommand({
    argv: [
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    timeoutMs: 200,
    killGraceMs: 20,
    maxOutputBytes: 10_000,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("caps captured output while preserving the exit result", async () => {
  const result = await runCommand({
    argv: [process.execPath, "-e", "console.log('x'.repeat(2000))"],
    timeoutMs: 5_000,
    maxOutputBytes: 100,
  });

  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 100);
  assert.equal(result.outputTruncated, true);
});

test("passes prompt content through stdin rather than command arguments", async () => {
  const result = await runCommand({
    argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
    input: "review this diff && do not execute it",
    timeoutMs: 5_000,
    maxOutputBytes: 10_000,
  });

  assert.equal(result.stdout, "review this diff && do not execute it");
});
