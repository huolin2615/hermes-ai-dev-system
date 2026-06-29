import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

function safeName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function readOptional(target: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export class KnowledgeWriter {
  private readonly projectRoot: string;

  constructor(input: { vaultPath: string; projectPath: string }) {
    this.projectRoot = path.resolve(input.vaultPath, input.projectPath);
  }

  async writeTaskLog(input: {
    taskId: string;
    projectId: string;
    title: string;
    summary: string;
    repoPath: string;
    branch: string;
    changedFiles: string[];
    verification: string[];
    reviewSummary: string;
  }): Promise<string> {
    const title = safeName(input.title);
    const noteName = `${safeName(input.taskId)} ${title}`;
    const notePath = path.join(this.projectRoot, "Runs", `${noteName}.md`);
    const frontmatter = stringify({
      type: "ai-dev-run",
      project: input.projectId,
      task_id: input.taskId,
      status: "completed",
      source_repo: input.repoPath,
      branch: input.branch,
      validated_at: new Date().toISOString(),
    }).trimEnd();
    const content = [
      "---",
      frontmatter,
      "---",
      "",
      `# ${input.title}`,
      "",
      "## Summary",
      "",
      input.summary,
      "",
      "## Changed files",
      "",
      ...(input.changedFiles.length > 0
        ? input.changedFiles.map((file) => `- \`${file}\``)
        : ["- None"]),
      "",
      "## Verification",
      "",
      ...(input.verification.length > 0
        ? input.verification.map((item) => `- ${item}`)
        : ["- Not configured"]),
      "",
      "## Claude Review",
      "",
      input.reviewSummary,
      "",
      `Related: [[Project Index]]`,
      "",
    ].join("\n");
    await atomicWrite(notePath, content);

    const indexPath = path.join(this.projectRoot, "Project Index.md");
    const link = `- [[Runs/${noteName}]]`;
    const current = await readOptional(indexPath);
    if (!current.includes(link)) {
      const base = current || `# ${input.projectId} Project Index\n\n## Runs\n`;
      await atomicWrite(indexPath, `${base.trimEnd()}\n${link}\n`);
    }
    return notePath;
  }

  async writeProposal(input: {
    taskId: string;
    projectId: string;
    kind: "decision" | "pattern" | "rule";
    title: string;
    content: string;
    sources: string[];
  }): Promise<string> {
    const filename = `${safeName(input.taskId)}-${input.kind}-${safeName(input.title)}.md`;
    const target = path.join(this.projectRoot, "Proposals", filename);
    const frontmatter = stringify({
      type: `ai-dev-${input.kind}`,
      project: input.projectId,
      task_id: input.taskId,
      status: "proposed",
      created_at: new Date().toISOString(),
    }).trimEnd();
    const content = [
      "---",
      frontmatter,
      "---",
      "",
      `# ${input.title}`,
      "",
      input.content,
      "",
      "## Sources",
      "",
      ...input.sources.map((source) => `- [[${source}]]`),
      "",
      "Related: [[Project Index]]",
      "",
    ].join("\n");
    await atomicWrite(target, content);
    return target;
  }

  async promoteProposal(input: {
    proposalPath: string;
    approvedBy: string;
  }): Promise<string> {
    const proposalsRoot = path.join(this.projectRoot, "Proposals");
    const resolved = path.resolve(input.proposalPath);
    if (!resolved.startsWith(`${proposalsRoot}${path.sep}`)) {
      throw new Error("knowledge proposal path is outside the project Proposals directory");
    }
    const proposal = await readFile(resolved, "utf8");
    if (!/^status:\s*proposed\s*$/m.test(proposal)) {
      throw new Error("knowledge proposal is not in proposed state");
    }
    const approved = proposal
      .replace(/^status:\s*proposed\s*$/m, "status: approved")
      .replace(
        /^created_at:.*$/m,
        (line) =>
          `${line}\napproved_at: ${JSON.stringify(new Date().toISOString())}\napproved_by: ${JSON.stringify(input.approvedBy)}`,
      );
    const target = path.join(this.projectRoot, "Knowledge", path.basename(resolved));
    await atomicWrite(target, approved);
    return target;
  }
}
