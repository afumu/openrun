import { SandboxWorkspace } from '../sandbox/workspace.js';

export type RunCommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
};

export type RunCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  originalStdoutLength: number;
  originalStderrLength: number;
};

export async function runCommand(
  workspace: SandboxWorkspace,
  input: RunCommandInput,
): Promise<RunCommandResult> {
  const cwd = workspace.resolvePath(input.cwd ?? '.');
  const command = await workspace.runCommand({
    cmd: input.command,
    args: input.args ?? [],
    cwd,
    env: input.env ?? {},
    timeoutMs: input.timeoutMs,
  });
  const stdout = await command.stdout();
  const stderr = await command.stderr();
  const maxOutputChars = input.maxOutputChars ?? 20_000;
  const truncatedStdout = stdout.slice(0, maxOutputChars);
  const truncatedStderr = stderr.slice(0, maxOutputChars);

  return {
    exitCode: command.exitCode,
    stdout: truncatedStdout,
    stderr: truncatedStderr,
    truncated: stdout.length > maxOutputChars || stderr.length > maxOutputChars,
    originalStdoutLength: stdout.length,
    originalStderrLength: stderr.length,
  };
}
