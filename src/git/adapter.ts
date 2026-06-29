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
  renamedFiles: Array<{ from: string; to: string }>;
  diff: string;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function nullSeparatedRecords(value: string): string[] {
  if (value.length === 0) return [];
  if (!value.endsWith("\0")) {
    throw new Error("malformed null-separated git output");
  }
  return value.slice(0, -1).split("\0");
}

function uniqueSortedRenames(
  values: Array<{ from: string; to: string }>,
): Array<{ from: string; to: string }> {
  const renames = new Map<string, { from: string; to: string }>();
  for (const rename of values) {
    renames.set(`${rename.from}\0${rename.to}`, rename);
  }
  return [...renames.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function parsePorcelain(value: string): {
  changedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
} {
  const records = nullSeparatedRecords(value);
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ from: string; to: string }> = [];

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
      if (!oldPath) {
        throw new Error("malformed git rename output: source path is missing");
      }
      changedFiles.push(oldPath);
      renamedFiles.push({ from: oldPath, to: file });
      index += 1;
    }
  }
  return {
    changedFiles: uniqueSorted(changedFiles),
    deletedFiles: uniqueSorted(deletedFiles),
    renamedFiles: uniqueSortedRenames(renamedFiles),
  };
}

function parseNameStatus(value: string): {
  changedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
} {
  const records = nullSeparatedRecords(value);
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ from: string; to: string }> = [];

  for (let index = 0; index < records.length; ) {
    const status = records[index] ?? "";
    index += 1;
    const code = status.at(0);
    if (code === "R") {
      const from = records[index];
      const to = records[index + 1];
      if (!from || !to) {
        throw new Error("malformed git rename output: path pair is incomplete");
      }
      changedFiles.push(from, to);
      renamedFiles.push({ from, to });
      index += 2;
      continue;
    }

    const file = records[index];
    if (!code || !file) {
      throw new Error("malformed git name-status output");
    }
    changedFiles.push(file);
    if (code === "D") {
      deletedFiles.push(file);
    }
    index += 1;
  }

  return {
    changedFiles: uniqueSorted(changedFiles),
    deletedFiles: uniqueSorted(deletedFiles),
    renamedFiles: uniqueSortedRenames(renamedFiles),
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

  async collect(cwd: string, baseRef = "HEAD"): Promise<GitFacts> {
    const status = await this.git(cwd, ["status", "--porcelain=v1", "-z"]);
    const names = await this.git(cwd, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      baseRef,
    ]);
    const diff = await this.git(cwd, ["diff", "--binary", baseRef]);
    if (
      status.outputTruncated ||
      names.outputTruncated ||
      diff.outputTruncated
    ) {
      throw new Error("git evidence exceeded the configured capture limit");
    }
    const workingTree = parsePorcelain(status.stdout);
    const baseDiff = parseNameStatus(names.stdout);
    return {
      changedFiles: uniqueSorted([
        ...workingTree.changedFiles,
        ...baseDiff.changedFiles,
      ]),
      deletedFiles: uniqueSorted([
        ...workingTree.deletedFiles,
        ...baseDiff.deletedFiles,
      ]),
      renamedFiles: uniqueSortedRenames([
        ...workingTree.renamedFiles,
        ...baseDiff.renamedFiles,
      ]),
      diff: diff.stdout,
    };
  }

  async restoreDeleted(
    cwd: string,
    relativePaths: string[],
    sourceRef = "HEAD",
  ): Promise<void> {
    for (const relativePath of relativePaths) {
      if (
        pathIsUnsafe(relativePath)
      ) {
        throw new Error(`unsafe deleted path: ${relativePath}`);
      }
      await this.git(cwd, [
        "restore",
        `--source=${sourceRef}`,
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
