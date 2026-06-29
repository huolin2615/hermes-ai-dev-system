import assert from "node:assert/strict";
import test from "node:test";

import { assessPlanRisk } from "../src/workflow/risk.js";

test("allows a small scoped change to continue automatically", () => {
  const result = assessPlanRisk({
    files: ["src/orders.ts", "tests/orders.test.ts"],
    requiresNetwork: false,
    operations: [],
  });

  assert.deepEqual(result, { level: "low", requiresApproval: false, reasons: [] });
});

test("requires approval for sensitive paths and external operations", () => {
  const result = assessPlanRisk({
    files: ["migrations/001.sql", ".github/workflows/ci.yml"],
    requiresNetwork: true,
    operations: ["install_dependency", "push"],
  });

  assert.equal(result.level, "high");
  assert.equal(result.requiresApproval, true);
  assert.match(result.reasons.join("\n"), /migration/i);
  assert.match(result.reasons.join("\n"), /network/i);
  assert.match(result.reasons.join("\n"), /push/i);
});

test("requires approval for every planned file deletion", () => {
  const result = assessPlanRisk({
    files: ["src/legacy.ts"],
    requiresNetwork: false,
    operations: ["delete_file"],
  });

  assert.equal(result.requiresApproval, true);
  assert.match(result.reasons.join("\n"), /delete_file/);
});

test("requires approval when the plan spans more than five files", () => {
  const result = assessPlanRisk({
    files: Array.from({ length: 6 }, (_, index) => `src/file-${index}.ts`),
    requiresNetwork: false,
    operations: [],
  });

  assert.equal(result.requiresApproval, true);
  assert.match(result.reasons[0] ?? "", /more than 5/i);
});
