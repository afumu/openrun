import { describe, expect, it, vi } from 'vitest';

import { SandboxManager } from '../../src/sandbox/sandbox-manager.js';

describe('SandboxManager', () => {
  it('starts a named persistent sandbox and exposes it as a workspace', async () => {
    const stop = vi.fn().mockResolvedValue({ snapshot: { id: 'snap_1' } });
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue('ok'),
      stderr: vi.fn().mockResolvedValue(''),
    });
    const getOrCreate = vi.fn().mockResolvedValue({
      name: 'openrun-test',
      fs: { readFile: vi.fn() },
      runCommand,
      stop,
    });
    const manager = new SandboxManager({ getOrCreate });

    const handle = await manager.start({
      sandboxName: 'openrun-test',
      mode: 'persistent',
      runtime: 'node24',
      networkPolicy: 'deny-all',
      timeoutMs: 600_000,
      stopOnExit: true,
      ports: [3000, 5173, 8000, 4173],
      preview: {
        defaultPort: 5173,
        startupTimeoutMs: 30_000,
      },
      snapshotExpiration: 0,
      keepLastSnapshots: {
        count: 1,
        deleteEvicted: true,
      },
    });

    expect(getOrCreate).toHaveBeenCalledWith({
      name: 'openrun-test',
      runtime: 'node24',
      timeout: 600_000,
      persistent: true,
      networkPolicy: 'deny-all',
      snapshotExpiration: 0,
      keepLastSnapshots: {
        count: 1,
        deleteEvicted: true,
      },
      ports: [3000, 5173, 8000, 4173],
      resume: true,
    });

    await handle.workspace.runCommand({
      cmd: 'node',
      args: ['main.js'],
      cwd: '/vercel/sandbox',
      env: {},
    });
    await handle.stop();

    expect(runCommand).toHaveBeenCalledWith({
      cmd: 'node',
      args: ['main.js'],
      cwd: '/vercel/sandbox',
      env: {},
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not stop the sandbox when stopOnExit is false', async () => {
    const stop = vi.fn().mockResolvedValue({});
    const getOrCreate = vi.fn().mockResolvedValue({
      name: 'openrun-test',
      fs: {},
      runCommand: vi.fn(),
      stop,
    });
    const manager = new SandboxManager({ getOrCreate });

    const handle = await manager.start({
      sandboxName: 'openrun-test',
      mode: 'persistent',
      runtime: 'node24',
      networkPolicy: 'deny-all',
      timeoutMs: 600_000,
      stopOnExit: false,
      ports: [3000, 5173, 8000, 4173],
      preview: { defaultPort: 5173, startupTimeoutMs: 30_000 },
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    });

    await handle.stop();

    expect(stop).not.toHaveBeenCalled();
  });

  it('passes exposed ports and resolves preview domains', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const domain = vi.fn((port: number) => `https://preview-${port}.vercel.run`);
    const getOrCreate = vi.fn().mockResolvedValue({
      name: 'openrun-test',
      fs: {},
      runCommand: vi.fn(),
      stop: vi.fn(),
      update,
      domain,
    });
    const manager = new SandboxManager({ getOrCreate });

    const handle = await manager.start({
      sandboxName: 'openrun-test',
      mode: 'persistent',
      runtime: 'node24',
      networkPolicy: 'deny-all',
      timeoutMs: 600_000,
      stopOnExit: true,
      ports: [3000, 5173],
      preview: {
        defaultPort: 5173,
        startupTimeoutMs: 30_000,
      },
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
    });

    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      ports: [3000, 5173],
    }));
    expect(handle.workspace.domain(5173)).toBe('https://preview-5173.vercel.run');

    await handle.workspace.ensurePort(8000);
    expect(update).toHaveBeenCalledWith({ ports: [3000, 5173, 8000] });
  });
});
