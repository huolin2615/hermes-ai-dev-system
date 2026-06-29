import type { VerificationCommand } from "../config/project.js";
import {
  runCommand,
  type CommandResult,
  type RunCommandOptions,
} from "../process/runner.js";

export type VerificationCommandExecutor = (
  options: RunCommandOptions,
) => Promise<CommandResult>;

export interface VerificationCommandResult extends CommandResult {
  id: string;
  argv: string[];
  required: boolean;
  durationMs: number;
  passed: boolean;
}

export interface VerificationResult {
  allRequiredPassed: boolean;
  commands: VerificationCommandResult[];
}

export class VerificationRunner {
  constructor(private readonly execute: VerificationCommandExecutor = runCommand) {}

  async run(
    commands: VerificationCommand[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<VerificationResult> {
    const results: VerificationCommandResult[] = [];
    for (const command of commands) {
      const started = Date.now();
      const result = await this.execute({
        argv: command.argv as [string, ...string[]],
        cwd,
        timeoutMs: command.timeoutSeconds * 1_000,
        maxOutputBytes: 2_000_000,
        signal,
      });
      results.push({
        id: command.id,
        argv: [...command.argv],
        required: command.required,
        durationMs: Date.now() - started,
        passed: result.exitCode === 0 && !result.timedOut,
        ...result,
      });
    }
    return {
      allRequiredPassed: results.every((result) => !result.required || result.passed),
      commands: results,
    };
  }
}
