import { afterEach, describe, expect, it, vi } from 'vitest';

import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import { startPreview } from '../../src/tools/preview.js';

describe('startPreview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes the port, starts a detached service, and returns the preview URL', async () => {
    const ensurePort = vi.fn().mockResolvedValue(undefined);
    const getDomain = vi.fn((port: number) => `https://preview-${port}.vercel.run`);
    const runSandboxCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(''),
      stderr: vi.fn().mockResolvedValue(''),
    });
    const fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const workspace = new SandboxWorkspace({
      workspaceRoot: '/vercel/sandbox',
      fs: SandboxWorkspace.local({ workspaceRoot: process.cwd() }).fs,
      runSandboxCommand,
      getDomain,
      ensurePort,
    });

    const result = await startPreview(workspace, {
      command: 'npm',
      args: ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '5173'],
      cwd: '.',
      port: 5173,
      startupTimeoutMs: 1_000,
    });

    expect(ensurePort).toHaveBeenCalledWith(5173);
    expect(runSandboxCommand).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'sh',
      args: expect.arrayContaining(['-lc']),
      cwd: '/vercel/sandbox',
      detached: true,
    }));
    expect(String(runSandboxCommand.mock.calls[0][0].args[1])).toContain(
      ".openrun/previews/5173.log",
    );
    expect(fetch).toHaveBeenCalledWith('https://preview-5173.vercel.run/', {
      method: 'GET',
    });
    expect(result).toMatchObject({
      port: 5173,
      url: 'https://preview-5173.vercel.run',
      status: 'ready',
      logPath: '.openrun/previews/5173.log',
      command: 'npm',
      args: ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '5173'],
    });
  });

  it('returns a starting status when readiness does not complete in time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('not ready')));
    const workspace = new SandboxWorkspace({
      workspaceRoot: '/vercel/sandbox',
      fs: SandboxWorkspace.local({ workspaceRoot: process.cwd() }).fs,
      runSandboxCommand: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: vi.fn().mockResolvedValue(''),
        stderr: vi.fn().mockResolvedValue(''),
      }),
      getDomain: (port) => `https://preview-${port}.vercel.run`,
      ensurePort: vi.fn().mockResolvedValue(undefined),
    });

    const result = await startPreview(workspace, {
      command: 'npm',
      args: ['run', 'dev'],
      port: 3000,
      startupTimeoutMs: 1,
    });

    expect(result).toMatchObject({
      port: 3000,
      url: 'https://preview-3000.vercel.run',
      status: 'starting',
      logPath: '.openrun/previews/3000.log',
    });
  });
});
