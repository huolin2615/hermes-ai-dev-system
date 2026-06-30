import assert from "node:assert/strict";
import test from "node:test";

import { classifyRetention } from "../src/cleanup/retention.js";

test("warns before expiry without creating a cleanup request", () => {
  const result = classifyRetention({
    completedAt: "2026-06-01T00:00:00.000Z",
    now: new Date("2026-06-25T00:00:00.000Z"),
    taskArtifactsDays: 30,
    warnBeforeDays: 7,
  });

  assert.equal(result.status, "warning");
  assert.equal(result.daysRemaining, 6);
});

test("classifies retained and expired artifacts without side effects", () => {
  assert.equal(
    classifyRetention({
      completedAt: "2026-06-01T00:00:00.000Z",
      now: new Date("2026-06-10T00:00:00.000Z"),
      taskArtifactsDays: 30,
      warnBeforeDays: 7,
    }).status,
    "retained",
  );
  const expired = classifyRetention({
    completedAt: "2026-06-01T00:00:00.000Z",
    now: new Date("2026-07-02T00:00:00.000Z"),
    taskArtifactsDays: 30,
    warnBeforeDays: 7,
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.daysRemaining, -1);
});
