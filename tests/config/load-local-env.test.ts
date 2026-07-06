import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { loadLocalEnv } from '../../src/config/load-local-env.js';

const touchedKeys = ['DEEPSEEK_API_KEY', 'FROM_DOTENV', 'SHARED_ENV_VALUE'];
const originalEnv = new Map<string, string | undefined>();

describe('loadLocalEnv', () => {
  afterEach(() => {
    for (const key of touchedKeys) {
      const originalValue = originalEnv.get(key);

      if (originalValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValue;
      }
    }
    originalEnv.clear();
  });

  it('loads .env.local before .env and keeps existing environment variables', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-env-'));

    try {
      rememberEnv();
      process.env.DEEPSEEK_API_KEY = 'from-shell';
      await writeFile(
        join(cwd, '.env'),
        'DEEPSEEK_API_KEY=from-env\nFROM_DOTENV=from-env\nSHARED_ENV_VALUE=from-env\n',
      );
      await writeFile(
        join(cwd, '.env.local'),
        'FROM_DOTENV=from-local\nSHARED_ENV_VALUE=from-local\n',
      );

      loadLocalEnv(cwd);

      expect(process.env.DEEPSEEK_API_KEY).toBe('from-shell');
      expect(process.env.FROM_DOTENV).toBe('from-local');
      expect(process.env.SHARED_ENV_VALUE).toBe('from-local');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function rememberEnv() {
  for (const key of touchedKeys) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
}
