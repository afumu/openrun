import { describe, expect, it, vi } from 'vitest';

import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import { runCommand } from '../../src/tools/shell.js';

describe('runCommand', () => {
  it('runs a command in the sandbox workspace and truncates stored output', async () => {
    const runSandboxCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue('a'.repeat(12)),
      stderr: vi.fn().mockResolvedValue('warning'),
    });
    const workspace = new SandboxWorkspace({
      workspaceRoot: '/vercel/sandbox',
      fs: SandboxWorkspace.local({ workspaceRoot: process.cwd() }).fs,
      runSandboxCommand,
    });

    const result = await runCommand(workspace, {
      command: 'node',
      args: ['script.js'],
      cwd: '.',
      env: { NODE_ENV: 'test' },
      timeoutMs: 10_000,
      maxOutputChars: 5,
    });

    expect(runSandboxCommand).toHaveBeenCalledWith({
      cmd: 'node',
      args: ['script.js'],
      cwd: '/vercel/sandbox',
      env: { NODE_ENV: 'test' },
      timeoutMs: 10_000,
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: 'aaaaa',
      stderr: 'warni',
      truncated: true,
      originalStdoutLength: 12,
      originalStderrLength: 7,
    });
  });

  it('passes detached mode to sandbox commands', async () => {
    const runSandboxCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(''),
      stderr: vi.fn().mockResolvedValue(''),
    });
    const workspace = new SandboxWorkspace({
      workspaceRoot: '/vercel/sandbox',
      fs: SandboxWorkspace.local({ workspaceRoot: process.cwd() }).fs,
      runSandboxCommand,
    });

    await runCommand(workspace, {
      command: 'npm',
      args: ['run', 'dev'],
      cwd: '.',
      detached: true,
    });

    expect(runSandboxCommand).toHaveBeenCalledWith(expect.objectContaining({
      detached: true,
    }));
  });
});
