import {
  Codex,
  type Input,
  type ModelReasoningEffort,
  type RunResult,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { z } from "zod";

import {
  codexPlanJsonSchema,
  parseCodexPlan,
  type CodexPlanV2,
} from "../workflow/plan-contract.js";

const implementationSchema = z.strictObject({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()),
  testsSuggested: z.array(z.string()),
  residualRisks: z.array(z.string()),
  knowledgeCandidates: z.array(z.string()),
});

export type CodexPlan = CodexPlanV2;
export type CodexImplementationResult = z.infer<typeof implementationSchema>;

export interface CodexThreadLike {
  readonly id: string | null;
  run(input: Input, options?: TurnOptions): Promise<RunResult>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`invalid ${label}: response is not JSON`);
  }
}

function parseOutput<T>(
  response: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  const result = schema.safeParse(parseJson(response, label));
  if (!result.success) {
    throw new Error(
      `invalid ${label}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

function parsePlanOutput(response: string): CodexPlan {
  try {
    return parseCodexPlan(parseJson(response, "Codex plan output"));
  } catch (error) {
    throw new Error(
      `invalid Codex plan output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function threadOptions(input: {
  cwd: string;
  sandboxMode: "read-only" | "workspace-write";
  reasoningEffort: ModelReasoningEffort;
  network: boolean;
}): ThreadOptions {
  return {
    workingDirectory: input.cwd,
    sandboxMode: input.sandboxMode,
    approvalPolicy: "never",
    networkAccessEnabled: input.network,
    webSearchMode: input.network ? "cached" : "disabled",
    modelReasoningEffort: input.reasoningEffort,
  };
}

export class CodexAdapter {
  constructor(private readonly client: CodexClientLike = new Codex()) {}

  async plan(input: {
    cwd: string;
    prompt: string;
    reasoningEffort: ModelReasoningEffort;
    signal?: AbortSignal;
  }): Promise<{ threadId: string; plan: CodexPlan; usage: RunResult["usage"] }> {
    const thread = this.client.startThread(
      threadOptions({
        cwd: input.cwd,
        sandboxMode: "read-only",
        reasoningEffort: input.reasoningEffort,
        network: false,
      }),
    );
    const options: TurnOptions = { outputSchema: codexPlanJsonSchema() };
    if (input.signal) options.signal = input.signal;
    const turn = await thread.run(input.prompt, options);
    if (!thread.id) {
      throw new Error("Codex did not provide a thread id");
    }
    return {
      threadId: thread.id,
      plan: parsePlanOutput(turn.finalResponse),
      usage: turn.usage,
    };
  }

  async implement(input: {
    cwd: string;
    threadId: string;
    prompt: string;
    reasoningEffort: ModelReasoningEffort;
    network: boolean;
    signal?: AbortSignal;
  }): Promise<CodexImplementationResult & { usage: RunResult["usage"] }> {
    const thread = this.client.resumeThread(
      input.threadId,
      threadOptions({
        cwd: input.cwd,
        sandboxMode: "workspace-write",
        reasoningEffort: input.reasoningEffort,
        network: input.network,
      }),
    );
    const options: TurnOptions = {
      outputSchema: z.toJSONSchema(implementationSchema),
    };
    if (input.signal) options.signal = input.signal;
    const turn = await thread.run(input.prompt, options);
    return {
      ...parseOutput(
        turn.finalResponse,
        implementationSchema,
        "Codex implementation output",
      ),
      usage: turn.usage,
    };
  }

  desktopThreadUrl(threadId: string): string {
    return `codex://threads/${encodeURIComponent(threadId)}`;
  }
}
