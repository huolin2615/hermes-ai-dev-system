import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RepoWriteLease } from "../src/runtime/repo-lease.js";

test("only one task can own a repository write lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-lease-"));
  const first = new RepoWriteLease(root, "crm");
  const second = new RepoWriteLease(root, "crm");

  const owner = await first.acquire("t_1", 101);
  await assert.rejects(second.acquire("t_2", 202), /lease is held/);

  await first.release(owner);
  const available = path.join(
    root,
    "leases",
    "crm",
    "repo.lease.available",
  );
  assert.equal((await stat(available)).isFile(), true);
  const next = await second.acquire("t_2", 202);
  assert.equal(next.taskId, "t_2");
});

test("reclaims only a proven stale exact owner and preserves an audit record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-lease-"));
  const lease = new RepoWriteLease(root, "crm", async () => false);
  const owner = await lease.acquire("t_1", 999_999);

  const diagnosis = await lease.diagnose(false);
  assert.equal(diagnosis.stale, true);
  assert.equal(diagnosis.ownerTaskId, "t_1");

  await lease.reclaimStale(owner, "huolin", false);

  assert.equal(
    (
      await readdir(path.join(root, "leases", "reclaims"))
    ).filter((entry) => entry.endsWith(".json")).length,
    1,
  );
  assert.equal(
    (
      await stat(
        path.join(root, "leases", "crm", "repo.lease.available"),
      )
    ).isFile(),
    true,
  );
});

test("rejects live or mismatched stale lease reclaim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-lease-"));
  const live = new RepoWriteLease(root, "crm", async () => true);
  const owner = await live.acquire("t_1", 101);
  await assert.rejects(
    live.reclaimStale(owner, "huolin", false),
    /process is still alive/,
  );

  const stale = new RepoWriteLease(root, "crm", async () => false);
  await assert.rejects(
    stale.reclaimStale(
      { ...owner, taskId: "t_other" },
      "huolin",
      false,
    ),
    /owner does not match/,
  );
});

test("requires proof that the Hermes task run is inactive before reclaim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-dev-lease-"));
  const lease = new RepoWriteLease(root, "crm", async () => false);
  const owner = await lease.acquire("t_active", 999_999);
  const diagnose = lease.diagnose.bind(lease) as (
    taskRunActive?: boolean,
  ) => ReturnType<RepoWriteLease["diagnose"]>;
  const reclaim = lease.reclaimStale.bind(lease) as (
    leaseOwner: typeof owner,
    approvedBy: string,
    taskRunActive: boolean,
  ) => ReturnType<RepoWriteLease["reclaimStale"]>;

  const diagnosis = await diagnose(true);
  assert.equal(diagnosis.processAlive, false);
  assert.equal(diagnosis.stale, false);
  await assert.rejects(
    reclaim(owner, "huolin", true),
    /task run is still active/,
  );
  assert.equal((await lease.diagnose()).ownerTaskId, "t_active");
});
