import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { z } from 'zod';

const providerSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().min(1),
  apiKeyEnv: z.string().min(1),
});

const agentSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  maxToolSteps: z.number().int().positive().default(20),
  tools: z.array(z.string().min(1)).default(['filesystem', 'shell']),
  workspace: z.string().min(1).default('default'),
});

const workspaceSchema = z.object({
  sandboxName: z.string().min(1),
  mode: z.enum(['persistent', 'ephemeral']).default('persistent'),
  runtime: z.string().min(1).default('node24'),
  networkPolicy: z.enum(['deny-all', 'allow-all']).default('deny-all'),
  timeoutMs: z.number().int().positive().default(600_000),
  stopOnExit: z.boolean().default(true),
  ports: z.array(z.number().int().min(1).max(65535)).max(4).default([3000, 5173, 8000, 4173]),
  preview: z
    .object({
      defaultPort: z.number().int().min(1).max(65535).default(5173),
      startupTimeoutMs: z.number().int().positive().default(30_000),
    })
    .default({
      defaultPort: 5173,
      startupTimeoutMs: 30_000,
    }),
  snapshotExpiration: z.number().int().min(0).default(0),
  keepLastSnapshots: z
    .object({
      count: z.number().int().min(1).max(10).default(1),
      deleteEvicted: z.boolean().default(true),
      expiration: z.number().int().min(0).optional(),
    })
    .default({ count: 1, deleteEvicted: true }),
});

const configSchema = z.object({
  defaultAgent: z.string().min(1),
  storage: z.object({
    sqlitePath: z.string().min(1),
  }),
  providers: z.record(z.string(), providerSchema),
  agents: z.record(z.string(), agentSchema),
  workspaces: z.record(z.string(), workspaceSchema),
});

const partialProviderSchema = providerSchema.partial();
const partialAgentSchema = agentSchema.partial();
const partialWorkspaceSchema = workspaceSchema.partial({
  keepLastSnapshots: true,
});

const userConfigSchema = z
  .object({
    defaultAgent: z.string().min(1).optional(),
    storage: z
      .object({
        sqlitePath: z.string().min(1).optional(),
      })
      .optional(),
    providers: z.record(z.string(), partialProviderSchema).optional(),
    agents: z.record(z.string(), partialAgentSchema).optional(),
    workspaces: z.record(z.string(), partialWorkspaceSchema).optional(),
  })
  .strict();

export type ProviderConfig = z.infer<typeof providerSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type OpenRunConfig = z.infer<typeof configSchema>;

export async function loadAgentConfig(cwd = process.cwd()): Promise<OpenRunConfig> {
  const defaults = createDefaultAgentConfig(cwd);
  const rawUserConfig = await readOptionalJson(join(cwd, 'agent.config.json'));

  if (!rawUserConfig) {
    return configSchema.parse(defaults);
  }

  const userConfig = userConfigSchema.parse(rawUserConfig);
  return configSchema.parse(mergeConfig(defaults, userConfig));
}

export function createDefaultAgentConfig(cwd = process.cwd()): OpenRunConfig {
  const projectName = sanitizeName(basename(cwd) || 'workspace');

  return {
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
        sandboxName: `openrun-${projectName}`,
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
      },
    },
  };
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function mergeConfig(
  defaults: OpenRunConfig,
  userConfig: z.infer<typeof userConfigSchema>,
): unknown {
  return {
    ...defaults,
    ...withoutUndefined({
      defaultAgent: userConfig.defaultAgent,
    }),
    storage: {
      ...defaults.storage,
      ...withoutUndefined(userConfig.storage ?? {}),
    },
    providers: mergeRecords(defaults.providers, userConfig.providers),
    agents: mergeRecords(defaults.agents, userConfig.agents),
    workspaces: mergeRecords(defaults.workspaces, userConfig.workspaces),
  };
}

function mergeRecords<T extends Record<string, unknown>>(
  defaults: Record<string, T>,
  overrides?: Record<string, Partial<T>>,
): Record<string, T> {
  const merged: Record<string, T> = { ...defaults };

  for (const [key, value] of Object.entries(overrides ?? {})) {
    merged[key] = {
      ...(merged[key] ?? {}),
      ...withoutUndefined(value),
    } as T;
  }

  return merged;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

function sanitizeName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'workspace';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
