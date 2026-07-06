import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAgentConfig } from '../../src/config/agent-config.js';

describe('loadAgentConfig', () => {
  it('returns the default coding agent configuration when no config file exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-config-'));

    try {
      const config = await loadAgentConfig(cwd);

      expect(config).toMatchObject({
        defaultAgent: 'coding',
        storage: {
          sqlitePath: '.openrun/openrun.sqlite',
        },
        providers: {
          deepseek: {
            type: 'openai-compatible',
            baseURL: 'https://api.deepseek.com',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
          },
        },
        agents: {
          coding: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            maxToolSteps: 20,
            tools: ['filesystem', 'shell'],
            workspace: 'default',
          },
        },
        workspaces: {
          default: {
            mode: 'persistent',
            runtime: 'node24',
            networkPolicy: 'deny-all',
            stopOnExit: true,
            snapshotExpiration: 0,
            keepLastSnapshots: {
              count: 1,
              deleteEvicted: true,
            },
          },
        },
      });
      expect(config.workspaces.default.sandboxName).toContain('openrun-');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('merges agent.config.json over defaults without losing nested defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-config-'));

    try {
      await writeFile(
        join(cwd, 'agent.config.json'),
        JSON.stringify({
          storage: { sqlitePath: '.openrun/custom.sqlite' },
          providers: {
            local: {
              type: 'openai-compatible',
              baseURL: 'http://localhost:11434/v1',
              apiKeyEnv: 'LOCAL_MODEL_KEY',
            },
          },
          agents: {
            coding: {
              provider: 'local',
              model: 'qwen-coder',
              maxToolSteps: 7,
            },
          },
          workspaces: {
            default: {
              sandboxName: 'custom-sandbox',
              networkPolicy: 'allow-all',
            },
          },
        }),
      );

      const config = await loadAgentConfig(cwd);

      expect(config.storage.sqlitePath).toBe('.openrun/custom.sqlite');
      expect(config.agents.coding).toMatchObject({
        provider: 'local',
        model: 'qwen-coder',
        maxToolSteps: 7,
        tools: ['filesystem', 'shell'],
        workspace: 'default',
      });
      expect(config.workspaces.default).toMatchObject({
        sandboxName: 'custom-sandbox',
        mode: 'persistent',
        runtime: 'node24',
        networkPolicy: 'allow-all',
        stopOnExit: true,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
