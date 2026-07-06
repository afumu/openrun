import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';

import { SandboxWorkspace, type WorkspaceFileSystem, type WorkspaceCommandResult } from './workspace.js';

export type SandboxWorkspaceConfig = {
  sandboxName: string;
  mode: 'persistent' | 'ephemeral';
  runtime: string;
  networkPolicy: NetworkPolicy;
  timeoutMs: number;
  stopOnExit: boolean;
  ports: number[];
  preview: {
    defaultPort: number;
    startupTimeoutMs: number;
  };
  snapshotExpiration: number;
  keepLastSnapshots: {
    count: number;
    deleteEvicted?: boolean;
    expiration?: number;
  };
};

export type SandboxLike = {
  name: string;
  fs: WorkspaceFileSystem;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    detached?: boolean;
  }): Promise<WorkspaceCommandResult>;
  routes?: Array<{ port: number }>;
  domain(port: number): string;
  update(params: { ports?: number[] }): Promise<void>;
  stop(): Promise<unknown>;
};

export type GetOrCreateSandbox = (params: {
  name: string;
  runtime: string;
  timeout: number;
  persistent: boolean;
  networkPolicy: NetworkPolicy;
  snapshotExpiration: number;
  ports: number[];
  keepLastSnapshots: {
    count: number;
    deleteEvicted?: boolean;
    expiration?: number;
  };
  resume: true;
}) => Promise<SandboxLike>;

export type SandboxHandle = {
  sandboxName: string;
  workspace: SandboxWorkspace;
  stop(): Promise<void>;
};

export class SandboxManager {
  private readonly getOrCreate: GetOrCreateSandbox;

  constructor(dependencies: { getOrCreate?: GetOrCreateSandbox } = {}) {
    this.getOrCreate = dependencies.getOrCreate ?? createVercelSandbox;
  }

  async start(config: SandboxWorkspaceConfig): Promise<SandboxHandle> {
    const sandbox = await this.getOrCreate({
      name: config.sandboxName,
      runtime: config.runtime,
      timeout: config.timeoutMs,
      persistent: config.mode === 'persistent',
      networkPolicy: config.networkPolicy,
      snapshotExpiration: config.snapshotExpiration,
      ports: config.ports,
      keepLastSnapshots: config.keepLastSnapshots,
      resume: true,
    });
    let exposedPorts = uniquePorts((sandbox.routes ?? []).map((route) => route.port));
    const ensurePorts = async (ports: number[]) => {
      const nextPorts = uniquePorts([...exposedPorts, ...ports]);

      if (samePorts(exposedPorts, nextPorts)) {
        return;
      }

      if (nextPorts.length > 4) {
        throw new Error(
          `Vercel Sandbox supports at most 4 exposed ports; configured ports: ${exposedPorts.join(', ')}`,
        );
      }

      await sandbox.update({ ports: nextPorts });
      exposedPorts = nextPorts;
    };
    const ensurePort = async (port: number) => {
      await ensurePorts([port]);
    };

    await ensurePorts(config.ports);

    const workspace = new SandboxWorkspace({
      workspaceRoot: '/vercel/sandbox',
      fs: sandbox.fs,
      runSandboxCommand: (input) => sandbox.runCommand(input),
      getDomain: (port) => sandbox.domain(port),
      ensurePort,
    });

    return {
      sandboxName: sandbox.name,
      workspace,
      async stop() {
        if (config.stopOnExit) {
          await sandbox.stop();
        }
      },
    };
  }
}

function uniquePorts(ports: number[]): number[] {
  return [...new Set(ports)];
}

function samePorts(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((port, index) => port === right[index]);
}

async function createVercelSandbox(
  params: Parameters<GetOrCreateSandbox>[0],
): Promise<SandboxLike> {
  const credentials = getVercelAccessTokenCredentials();

  return Sandbox.getOrCreate({
    ...credentials,
    ...params,
  });
}

function getVercelAccessTokenCredentials():
  | { teamId: string; projectId: string; token: string }
  | Record<string, never> {
  const { VERCEL_TEAM_ID, VERCEL_PROJECT_ID, VERCEL_TOKEN } = process.env;

  if (VERCEL_TEAM_ID && VERCEL_PROJECT_ID && VERCEL_TOKEN) {
    return {
      teamId: VERCEL_TEAM_ID,
      projectId: VERCEL_PROJECT_ID,
      token: VERCEL_TOKEN,
    };
  }

  return {};
}
