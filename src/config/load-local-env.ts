import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'dotenv';

const LOCAL_ENV_FILES = ['.env.local', '.env'];

export function loadLocalEnv(cwd = process.cwd()): void {
  for (const fileName of LOCAL_ENV_FILES) {
    const filePath = join(cwd, fileName);

    if (!existsSync(filePath)) {
      continue;
    }

    const parsed = parse(readFileSync(filePath));

    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
