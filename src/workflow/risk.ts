export interface PlanRiskInput {
  files: string[];
  requiresNetwork: boolean;
  operations: string[];
}

export interface PlanRiskAssessment {
  level: "low" | "high";
  requiresApproval: boolean;
  reasons: string[];
}

const sensitivePathPatterns: Array<[RegExp, string]> = [
  [/(^|\/)migrations?(\/|$)|\.(sql)$/i, "migration or database schema change"],
  [/(^|\/)(auth|authentication|permissions?|secrets?)(\/|$)/i, "authentication or permission change"],
  [/(^|\/)\.github\/workflows\//i, "deployment or CI workflow change"],
  [/(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i, "dependency change"],
];

const sensitiveOperations = new Set([
  "delete_file",
  "install_dependency",
  "push",
  "create_pr",
  "deploy",
  "external_write",
]);

export function assessPlanRisk(input: PlanRiskInput): PlanRiskAssessment {
  const reasons: string[] = [];

  if (input.files.length > 5) {
    reasons.push("plan touches more than 5 files");
  }

  for (const file of input.files) {
    for (const [pattern, reason] of sensitivePathPatterns) {
      if (pattern.test(file) && !reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }

  if (input.requiresNetwork) {
    reasons.push("network access requested");
  }

  for (const operation of input.operations) {
    if (sensitiveOperations.has(operation)) {
      reasons.push(`sensitive operation requested: ${operation}`);
    }
  }

  return {
    level: reasons.length === 0 ? "low" : "high",
    requiresApproval: reasons.length > 0,
    reasons,
  };
}
