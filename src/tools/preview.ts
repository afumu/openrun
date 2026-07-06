import { SandboxWorkspace } from '../sandbox/workspace.js';

export type StartPreviewInput = {
  command: string;
  args?: string[];
  cwd?: string;
  port: number;
  env?: Record<string, string>;
  waitForPath?: string;
  startupTimeoutMs?: number;
};

export type StartPreviewResult = {
  port: number;
  url: string;
  status: 'ready' | 'starting';
  logPath: string;
  command: string;
  args: string[];
  waitedMs: number;
};

export async function startPreview(
  workspace: SandboxWorkspace,
  input: StartPreviewInput,
): Promise<StartPreviewResult> {
  await workspace.ensurePort(input.port);

  const args = input.args ?? [];
  const logPath = `.openrun/previews/${input.port}.log`;
  const commandText = shellJoin([input.command, ...args]);
  const wrappedCommand = [
    'mkdir -p .openrun/previews',
    `: > ${shellEscape(logPath)}`,
    `(${commandText}) >> ${shellEscape(logPath)} 2>&1`,
  ].join(' && ');
  const cwd = workspace.resolvePath(input.cwd ?? '.');

  await workspace.runCommand({
    cmd: 'sh',
    args: ['-lc', wrappedCommand],
    cwd,
    env: input.env ?? {},
    detached: true,
  });

  const url = workspace.domain(input.port);
  const timeoutMs = input.startupTimeoutMs ?? 30_000;
  const waitedMs = await waitForPreview(url, input.waitForPath ?? '/', timeoutMs);

  return {
    port: input.port,
    url,
    status: waitedMs < timeoutMs ? 'ready' : 'starting',
    logPath,
    command: input.command,
    args,
    waitedMs,
  };
}

async function waitForPreview(
  url: string,
  waitForPath: string,
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();
  const target = new URL(waitForPath, ensureTrailingSlash(url)).toString();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(target, { method: 'GET' });

      if (response.status < 500) {
        return Date.now() - startedAt;
      }
    } catch {
      // The preview server is still booting.
    }

    const elapsedMs = Date.now() - startedAt;
    const remainingMs = timeoutMs - elapsedMs;

    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(250, remainingMs));
  }

  return timeoutMs;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellJoin(parts: string[]): string {
  return parts.map(shellEscape).join(' ');
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
