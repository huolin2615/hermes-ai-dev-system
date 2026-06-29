import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/runner.js";

export type GitCommandExecutor = (
  options: RunCommandOptions,
) => Promise<CommandResult>;

export interface GitFacts {
  changedFiles: string[];
  deletedFiles: string[];
  diff: string;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function parsePorcelain(value: string): {
  changedFiles: string[];
  deletedFiles: string[];
} {
  const records = value.split("\0").filter(Boolean);
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    changedFiles.push(file);

    if (status.includes("D")) {
      deletedFiles.push(file);
    }
    if (status.includes("R")) {
      const oldPath = records[index + 1];
      if (oldPath) {
        deletedFiles.push(oldPath);
        index += 1;
      }
    }
  }
  return {
    changedFiles: uniqueSorted(changedFiles),
    deletedFiles: uniqueSorted(deletedFiles),
  };
}

export class GitAdapter {
  constructor(private readonly execute: GitCommandExecutor = runCommand) {}

  private async git(cwd: string, args: string[]): Promise<CommandResult> {
    const result = await this.execute({
      argv: ["git", ...args],
      cwd,
      timeoutMs: 120_000,
      maxOutputBytes: 5_000_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  async isClean(cwd: string): Promise<boolean> {
    const result = await this.git(cwd, ["status", "--porcelain=v1", "-z"]);
    return result.stdout.length === 0;
  }

  async assertRepoReady(
    cwd: string,
    baseBranch: string,
    requireClean: boolean,
  ): Promise<void> {
    await this.git(cwd, ["rev-parse", "--verify", "HEAD"]);
    const branch = (
      await this.git(cwd, ["branch", "--show-current"])
    ).stdout.trim();
    if (branch !== baseBranch) {
      throw new Error(
        `repository must be on base branch ${baseBranch}; current branch is ${branch || "detached HEAD"}`,
      );
    }
    if (requireClean && !(await this.isClean(cwd))) {
      throw new Error(`repository has uncommitted changes: ${cwd}`);
    }
  }

  async assertBranchName(cwd: string, branch: string): Promise<void> {
    await this.git(cwd, ["check-ref-format", "--branch", branch]);
  }

  async collect(cwd: string): Promise<GitFacts> {
    const status = await this.git(cwd, ["status", "--porcelain=v1", "-z"]);
    const diff = await this.git(cwd, ["diff", "--binary", "HEAD"]);
    if (status.outputTruncated || diff.outputTruncated) {
      throw new Error("git evidence exceeded the configured capture limit");
    }
    return {
      ...parsePorcelain(status.stdout),
      diff: diff.stdout,
    };
  }

  async restoreDeleted(cwd: string, relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      if (
        pathIsUnsafe(relativePath)
      ) {
        throw new Error(`unsafe deleted path: ${relativePath}`);
      }
      await this.git(cwd, [
        "restore",
        "--source=HEAD",
        "--worktree",
        "--",
        relativePath,
      ]);
    }
  }

  async commit(cwd: string, message: string): Promise<string> {
    if (await this.isClean(cwd)) {
      return (await this.git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    }
    await this.git(cwd, ["add", "--all"]);
    await this.git(cwd, ["commit", "-m", message]);
    return (await this.git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  }
}

function pathIsUnsafe(relativePath: string): boolean {
  return (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..") ||
    /[*?[\]{}]/.test(relativePath)
  );
}
