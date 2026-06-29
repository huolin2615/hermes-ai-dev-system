import assert from "node:assert/strict";
import test from "node:test";

import { renderLaunchdPlist } from "../src/runtime/launchd.js";

test("renders an argv-based macOS user service without a shell", () => {
  const plist = renderLaunchdPlist({
    label: "com.example.ai-dev",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/ai dev/dist/cli.js",
    configDirectory: "/opt/ai dev/config/projects",
    runtimeRoot: "/opt/ai dev/runtime",
    workingDirectory: "/opt/ai dev",
    stdoutPath: "/opt/ai dev/log/worker.out",
    stderrPath: "/opt/ai dev/log/worker.err",
    pollSeconds: 30,
  });

  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<string>\/opt\/ai dev\/dist\/cli.js<\/string>/);
  assert.doesNotMatch(plist, /\/bin\/sh|-c<\/string>/);
});

test("rejects relative service paths", () => {
  assert.throws(
    () =>
      renderLaunchdPlist({
        label: "com.example.ai-dev",
        nodePath: "node",
        cliPath: "/opt/cli.js",
        configDirectory: "/opt/config",
        runtimeRoot: "/opt/runtime",
        workingDirectory: "/opt",
        stdoutPath: "/opt/out",
        stderrPath: "/opt/err",
        pollSeconds: 30,
      }),
    /absolute path/,
  );
});
