import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export interface RepoLeaseOwner {
  projectId: string;
  taskId: string;
  pid: number;
  acquiredAt: string;
  ownerPath: string;
}

export interface LeaseDiagnosis {
  projectId: string;
  available: boolean;
  ownerTaskId: string | null;
  pid: number | null;
  acquiredAt: string | null;
  ownerPath: string | null;
  processAlive: boolean;
  taskRunActive: boolean | null;
  stale: boolean;
}

export class RepoLeaseHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoLeaseHeldError";
  }
}

type ProcessProbe = (pid: number) => Promise<boolean>;

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return value;
}

async function defaultProcessProbe(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function ownerFile(taskId: string, pid: number): string {
  return `repo.lease.${safeSegment(taskId, "task id")}.${pid}`;
}

export class RepoWriteLease {
  private readonly leaseRoot: string;
  private readonly projectDirectory: string;
  private readonly availablePath: string;

  constructor(
    runtimeRoot: string,
    private readonly projectId: string,
    private readonly processProbe: ProcessProbe = defaultProcessProbe,
  ) {
    safeSegment(projectId, "project id");
    this.leaseRoot = path.join(runtimeRoot, "leases");
    this.projectDirectory = path.join(this.leaseRoot, projectId);
    this.availablePath = path.join(
      this.projectDirectory,
      "repo.lease.available",
    );
  }

  async acquire(taskId: string, pid: number): Promise<RepoLeaseOwner> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("lease pid must be a positive integer");
    }
    await this.initialize();
    const acquiredAt = new Date().toISOString();
    const ownerPath = path.join(
      this.projectDirectory,
      ownerFile(taskId, pid),
    );
    try {
      await stat(ownerPath);
      throw new RepoLeaseHeldError(
        `repository lease is held by ${taskId} (${pid})`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(this.availablePath, ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const diagnosis = await this.diagnose();
      throw new RepoLeaseHeldError(
        diagnosis.ownerTaskId
          ? `repository lease is held by ${diagnosis.ownerTaskId} (${diagnosis.pid})`
          : "repository lease is held or unavailable",
      );
    }
    const owner: RepoLeaseOwner = {
      projectId: this.projectId,
      taskId,
      pid,
      acquiredAt,
      ownerPath,
    };
    await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return owner;
  }

  async release(owner: RepoLeaseOwner): Promise<void> {
    this.assertExactOwner(owner);
    if (await this.pathExists(this.availablePath)) {
      throw new Error("cannot release lease while available token exists");
    }
    await rename(owner.ownerPath, this.availablePath);
  }

  async diagnose(
    taskRunActive: boolean | null = null,
  ): Promise<LeaseDiagnosis> {
    let entries: string[];
    try {
      entries = await readdir(this.projectDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.availableDiagnosis();
      }
      throw error;
    }
    const owners = entries.filter(
      (entry) =>
        entry.startsWith("repo.lease.") &&
        entry !== "repo.lease.available",
    );
    if (owners.length === 0) return this.availableDiagnosis();
    if (owners.length > 1) {
      throw new Error(
        `multiple repository lease owners found for ${this.projectId}`,
      );
    }
    const filename = owners[0] ?? "";
    const match = filename.match(/^repo\.lease\.(.+)\.(\d+)$/);
    if (!match) throw new Error(`invalid repository lease owner: ${filename}`);
    const ownerTaskId = match[1] ?? "";
    const pid = Number(match[2]);
    const ownerPath = path.join(this.projectDirectory, filename);
    const owner = await this.readOwner(ownerPath);
    const processAlive = await this.processProbe(pid);
    return {
      projectId: this.projectId,
      available: false,
      ownerTaskId,
      pid,
      acquiredAt:
        owner?.acquiredAt ?? (await stat(ownerPath)).mtime.toISOString(),
      ownerPath,
      processAlive,
      taskRunActive,
      stale: !processAlive && taskRunActive === false,
    };
  }

  async reclaimStale(
    owner: RepoLeaseOwner,
    approvedBy: string,
    taskRunActive: boolean,
  ): Promise<RepoLeaseOwner> {
    this.assertExactOwner(owner);
    if (!approvedBy.trim()) throw new Error("approvedBy is required");
    if (taskRunActive) {
      throw new Error("Hermes task run is still active");
    }
    const diagnosis = await this.diagnose(false);
    if (
      diagnosis.ownerTaskId !== owner.taskId ||
      diagnosis.pid !== owner.pid ||
      diagnosis.ownerPath !== owner.ownerPath
    ) {
      throw new Error("lease owner does not match the current owner");
    }
    if (diagnosis.processAlive || !diagnosis.stale) {
      throw new Error("lease owner process is still alive");
    }
    const reclaimDirectory = path.join(this.leaseRoot, "reclaims");
    await mkdir(reclaimDirectory, { recursive: true });
    const auditPath = path.join(reclaimDirectory, `${randomUUID()}.json`);
    await writeFile(
      auditPath,
      `${JSON.stringify(
        {
          projectId: this.projectId,
          taskId: owner.taskId,
          pid: owner.pid,
          ownerPath: owner.ownerPath,
          approvedBy: approvedBy.trim(),
          approvedAt: new Date().toISOString(),
          processAlive: false,
          taskRunActive: false,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    if (await this.pathExists(this.availablePath)) {
      throw new Error("cannot reclaim while available token exists");
    }
    await rename(owner.ownerPath, this.availablePath);
    return owner;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.leaseRoot, { recursive: true });
    try {
      await mkdir(this.projectDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    await writeFile(
      this.availablePath,
      `${JSON.stringify({
        projectId: this.projectId,
        status: "available",
        initializedAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }

  private assertExactOwner(owner: RepoLeaseOwner): void {
    const expectedPath = path.join(
      this.projectDirectory,
      ownerFile(owner.taskId, owner.pid),
    );
    if (
      owner.projectId !== this.projectId ||
      owner.ownerPath !== expectedPath
    ) {
      throw new Error("lease owner does not match the exact owner path");
    }
  }

  private availableDiagnosis(): LeaseDiagnosis {
    return {
      projectId: this.projectId,
      available: true,
      ownerTaskId: null,
      pid: null,
      acquiredAt: null,
      ownerPath: null,
      processAlive: false,
      taskRunActive: null,
      stale: false,
    };
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async readOwner(ownerPath: string): Promise<RepoLeaseOwner | null> {
    try {
      const value = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<
        RepoLeaseOwner
      >;
      return typeof value.acquiredAt === "string"
        ? (value as RepoLeaseOwner)
        : null;
    } catch {
      return null;
    }
  }
}
