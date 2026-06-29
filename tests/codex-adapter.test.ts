import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexAdapter,
  type CodexClientLike,
  type CodexThreadLike,
} from "../src/codex/adapter.js";

function fakeThread(
  id: string,
  response: unknown,
  calls: Array<{ prompt: string; outputSchema: unknown }>,
): CodexThreadLike {
  return {
    id,
    async run(prompt, options) {
      calls.push({ prompt: String(prompt), outputSchema: options?.outputSchema });
      return {
        finalResponse: JSON.stringify(response),
        items: [],
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 1,
        },
      };
    },
  };
}

test("plans in a read-only thread and returns a persisted thread id", async () => {
  const threadOptions: unknown[] = [];
  const calls: Array<{ prompt: string; outputSchema: unknown }> = [];
  const client: CodexClientLike = {
    startThread(options) {
      threadOptions.push(options);
      return fakeThread(
        "thread-1",
        {
          version: 2,
          summary: "Add filters",
          assumptions: [],
          files: ["src/orders.ts"],
          tests: ["tests/orders.test.ts"],
          capabilities: {
            network: false,
            dependencyInstall: false,
            externalWrite: false,
          },
          fileDeletions: [],
          questions: [],
          knowledgeNeeds: [],
        },
        calls,
      );
    },
    resumeThread() {
      throw new Error("not expected");
    },
  };
  const adapter = new CodexAdapter(client);

  const result = await adapter.plan({
    cwd: "/tmp/worktree",
    prompt: "Plan the task",
    reasoningEffort: "high",
  });

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.plan.version, 2);
  assert.equal(result.plan.files[0], "src/orders.ts");
  assert.deepEqual(threadOptions[0], {
    workingDirectory: "/tmp/worktree",
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    modelReasoningEffort: "high",
  });
  assert.deepEqual(
    (
      calls[0]?.outputSchema as {
        properties?: { version?: { const?: number } };
      }
    ).properties?.version,
    { type: "number", const: 2 },
  );
});

test("resumes the same thread with workspace-write for implementation", async () => {
  const resumed: Array<{ id: string; options: unknown }> = [];
  const calls: Array<{ prompt: string; outputSchema: unknown }> = [];
  const client: CodexClientLike = {
    startThread() {
      throw new Error("not expected");
    },
    resumeThread(id, options) {
      resumed.push({ id, options });
      return fakeThread(
        id,
        {
          summary: "Implemented filters",
          changedFiles: ["src/orders.ts"],
          testsSuggested: ["tests/orders.test.ts"],
          residualRisks: [],
          knowledgeCandidates: [],
        },
        calls,
      );
    },
  };
  const adapter = new CodexAdapter(client);

  const result = await adapter.implement({
    cwd: "/tmp/worktree",
    threadId: "thread-1",
    prompt: "Implement the approved plan",
    reasoningEffort: "high",
    network: false,
  });

  assert.equal(result.summary, "Implemented filters");
  assert.deepEqual(resumed[0], {
    id: "thread-1",
    options: {
      workingDirectory: "/tmp/worktree",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      modelReasoningEffort: "high",
    },
  });
});

test("rejects malformed structured Codex output", async () => {
  const client: CodexClientLike = {
    startThread() {
      return fakeThread("thread-1", { summary: "missing fields" }, []);
    },
    resumeThread() {
      throw new Error("not expected");
    },
  };
  const adapter = new CodexAdapter(client);

  await assert.rejects(
    adapter.plan({
      cwd: "/tmp/worktree",
      prompt: "Plan",
      reasoningEffort: "high",
    }),
    /invalid Codex plan output/,
  );
});
