import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';

import { SandboxWorkspace, type WorkspaceFileSystem, type WorkspaceCommandResult } from './workspace.js';

export type SandboxWorkspaceConfig = {
  sandboxName: string;
  mode: 'persistent' | 'ephemeral';
  runtime: string;
  networkPolicy: NetworkPolicy;
  timeoutMs: number;
  stopOnExit: boolean;
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
  }): Promise<WorkspaceCommandResult>;
  stop(): Promise<unknown>;
};

export type GetOrCreateSandbox = (params: {
  name: string;
  runtime: string;
  timeout: number;
  persistent: boolean;
  networkPolicy: NetworkPolicy;
  snapshotExpiration: number;
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
      keepLastSnapshots: config.keepLastSnapshots,
      resume: true,
    });

    const workspace = new SandboxWorkspace({
      workspaceRoot: '/vercel/sandbox',
      fs: sandbox.fs,
      runSandboxCommand: (input) => sandbox.runCommand(input),
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
