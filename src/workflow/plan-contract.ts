import { createHash } from "node:crypto";

import { z } from "zod";

const capabilitiesSchema = z.strictObject({
  network: z.boolean(),
  dependencyInstall: z.boolean(),
  externalWrite: z.boolean(),
});

const questionSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
  required: z.literal(true),
});

function isSafeRelativeFilePath(value: string): boolean {
  const segments = value.split("/");
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[A-Za-z]:/.test(value) &&
    !segments.some((segment) => segment === "" || segment === "." || segment === "..") &&
    !/[*?[\]{}]/.test(value)
  );
}

const deletionPathSchema = z
  .string()
  .refine(isSafeRelativeFilePath, "deletion target must be a safe relative file path");

const codexPlanV2Schema = z
  .strictObject({
    version: z.literal(2),
    summary: z.string().min(1),
    assumptions: z.array(z.string()),
    files: z.array(z.string()),
    tests: z.array(z.string()),
    capabilities: capabilitiesSchema,
    fileDeletions: z
      .array(deletionPathSchema)
      .max(1, "fileDeletions must contain at most 1 path"),
    questions: z.array(questionSchema),
    knowledgeNeeds: z.array(z.string()),
  })
  .superRefine((plan, context) => {
    if (
      plan.fileDeletions.length === 1 &&
      !plan.files.includes(plan.fileDeletions[0] ?? "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["fileDeletions", 0],
        message: "deletion target must also be declared in files",
      });
    }
    const questionIds = new Set<string>();
    for (const [index, question] of plan.questions.entries()) {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "id"],
          message: `duplicate question id: ${question.id}`,
        });
      }
      questionIds.add(question.id);
    }
  });

const codexPlanV1Schema = z.strictObject({
  summary: z.string().min(1),
  assumptions: z.array(z.string()),
  files: z.array(z.string()),
  tests: z.array(z.string()),
  requiresNetwork: z.boolean(),
  operations: z.array(z.string()),
  questions: z.array(z.string()),
  knowledgeNeeds: z.array(z.string()),
});

export interface CodexPlanV2 {
  version: 2;
  summary: string;
  assumptions: string[];
  files: string[];
  tests: string[];
  capabilities: {
    network: boolean;
    dependencyInstall: boolean;
    externalWrite: boolean;
  };
  fileDeletions: string[];
  questions: Array<{
    id: string;
    prompt: string;
    required: true;
  }>;
  knowledgeNeeds: string[];
}

export class LegacyPlanRequiresReplanError extends Error {
  constructor() {
    super("legacy deletion plan must be replanned as v2");
    this.name = "LegacyPlanRequiresReplanError";
  }
}

export function parseCodexPlan(input: unknown): CodexPlanV2 {
  if (
    input !== null &&
    typeof input === "object" &&
    "version" in input &&
    input.version === 2
  ) {
    return codexPlanV2Schema.parse(input);
  }

  const legacy = codexPlanV1Schema.parse(input);
  if (legacy.operations.includes("delete_file")) {
    throw new LegacyPlanRequiresReplanError();
  }
  const externalWriteOperations = new Set([
    "push",
    "create_pr",
    "deploy",
    "external_write",
  ]);
  return codexPlanV2Schema.parse({
    version: 2,
    summary: legacy.summary,
    assumptions: legacy.assumptions,
    files: legacy.files,
    tests: legacy.tests,
    capabilities: {
      network: legacy.requiresNetwork,
      dependencyInstall: legacy.operations.includes("install_dependency"),
      externalWrite: legacy.operations.some((operation) =>
        externalWriteOperations.has(operation),
      ),
    },
    fileDeletions: [],
    questions: legacy.questions.map((prompt, index) => ({
      id: `question_${index + 1}`,
      prompt,
      required: true as const,
    })),
    knowledgeNeeds: legacy.knowledgeNeeds,
  });
}

export function codexPlanJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(codexPlanV2Schema) as Record<string, unknown>;
}

export function digestCodexPlan(plan: CodexPlanV2): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}
