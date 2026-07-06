# Preview Service Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenRun Coding Agent 在写完 Web 项目后，可以自动启动 Vercel Sandbox 内的预览服务，并直接返回可访问链接。

**Architecture:** 第一版只提供一个高层工具 `start_preview`，它负责暴露端口、启动 detached 服务、等待服务 ready、返回 URL 和日志路径。Agent 的项目创建策略写入系统提示：用户明确要求简单 HTML/静态页面时使用 Vite；更复杂的应用、需要路由/API/服务端能力时使用 Next.js。

**Tech Stack:** TypeScript, `@vercel/sandbox`, Vercel Sandbox `ports` / `domain(port)` / `update({ ports })`, Vitest, Zod, SQLite event storage.

---

## 设计结论

### 1. 只做一个工具：`start_preview`

用户体验目标是“写完代码后直接给我可访问链接”，所以第一版不要拆成 `start_preview_server` 和 `get_preview_url` 两个工具。

工具职责：

1. 确保 sandbox 暴露目标端口。
2. 以 detached 模式启动服务。
3. 把服务日志写到 sandbox 工作区内。
4. 等待公开 URL ready。
5. 返回 URL、端口、状态、日志路径。

建议工具 schema：

```ts
const startPreviewSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  port: z.number().int().min(1).max(65535),
  env: z.record(z.string(), z.string()).optional(),
  waitForPath: z.string().default('/'),
  startupTimeoutMs: z.number().int().positive().default(30_000),
});
```

返回结构：

```ts
type StartPreviewResult = {
  port: number;
  url: string;
  status: 'ready' | 'starting';
  logPath: string;
  command: string;
  args: string[];
  waitedMs: number;
};
```

`status: 'starting'` 的意义：如果 readiness check 超时，但服务进程已经 detached 启动，工具仍返回 URL 和日志路径，让 Agent 可以告诉用户“服务正在启动，可以稍后刷新；日志在这里”。

### 2. 项目创建策略

Agent 需要把框架选择作为固定规则写入系统提示，而不是每次靠模型猜。

规则：

- 用户明确说“简单 HTML”、“静态页面”、“单页小 demo”、“不需要复杂框架”时，使用 Vite，优先 vanilla 或 vanilla-ts。
- 用户要求“复杂应用”、“后台系统”、“多页面”、“登录/权限”、“API route”、“服务端渲染”、“全栈应用”、“数据库接入”时，使用 Next.js。
- 如果用户指定框架，以用户指定为准。
- 如果工作区已有项目，以现有项目技术栈为准，不要重新脚手架。
- 启动预览时必须监听 `0.0.0.0`，不能只监听 `localhost`。

建议启动命令：

```txt
Vite: npm run dev -- --host 0.0.0.0 --port 5173
Next.js: npm run dev -- --hostname 0.0.0.0 --port 3000
```

建议默认端口：

```txt
5173: Vite
3000: Next.js
8000: Python/FastAPI
4173: Vite preview
```

Vercel Sandbox 当前最多暴露 4 个端口，所以默认只放这 4 个。

### 3. 生命周期策略

第一版不做复杂进程管理。

- `start_preview` 每次调用都会启动一次 detached 命令。
- 不在第一版做 `stop_preview`、`list_previews`、`read_preview_logs`。
- 日志统一写入 `.openrun/previews/<port>.log`。
- CLI 退出时如果 `stopOnExit: true`，sandbox 会停止，预览服务也会停止。
- 如果用户希望链接保持更久，需要配置 `stopOnExit: false` 和更长 `timeoutMs`。

后续版本再考虑：

- `stop_preview`
- `list_previews`
- `read_preview_logs`
- SQLite 记录 preview process metadata
- 同端口自动复用/重启策略

---

## 文件结构

### 需要修改的文件

- `src/config/agent-config.ts`
  - 给 workspace schema 增加 `ports` 和 `preview` 配置。

- `agent.config.json`
  - 给默认 workspace 加上常用端口和 preview 默认值。

- `src/sandbox/sandbox-manager.ts`
  - 创建 sandbox 时传 `ports`。
  - 让 `SandboxLike` 暴露 `domain(port)`、`update({ ports })` 和当前 routes/ports。

- `src/sandbox/workspace.ts`
  - 增加 preview 相关抽象：`domain(port)`、`ensurePort(port)`。
  - 给 `RunWorkspaceCommandInput` 增加 `detached?: boolean`。

- `src/tools/shell.ts`
  - 给现有 `run_command` 增加可选 `detached`，保持向后兼容。

- `src/tools/preview.ts`
  - 新建 `startPreview(workspace, input)`。
  - 负责端口暴露、日志包装、detached 启动、ready 检查、返回 URL。

- `src/tools/tool-registry.ts`
  - 注册新工具 `start_preview`。

- `src/agent/coding-agent.ts`
  - 更新系统提示，加入框架选择和预览启动规则。

- `README.md`
  - 增加预览服务说明。

### 需要新增或修改的测试

- `tests/config/agent-config.test.ts`
  - 验证默认 ports 和 preview 配置。

- `tests/sandbox/sandbox-manager.test.ts`
  - 验证 `ports` 被传给 `Sandbox.getOrCreate`。
  - 验证 `workspace.domain(port)` 和 `workspace.ensurePort(port)` 行为。

- `tests/tools/shell-tool.test.ts`
  - 验证 `detached` 能传给 sandbox command runner。

- `tests/tools/preview-tool.test.ts`
  - 验证 `start_preview` 会确保端口、启动 detached 命令、返回 URL 和日志路径。

- `tests/tools/tool-registry.test.ts`
  - 验证 `start_preview` 注册到了工具列表。

---

## Task 1: Workspace Config Adds Ports And Preview Defaults

**Files:**
- Modify: `src/config/agent-config.ts`
- Modify: `agent.config.json`
- Test: `tests/config/agent-config.test.ts`

- [ ] **Step 1: Write failing config test**

Add expectations to `tests/config/agent-config.test.ts` default config test:

```ts
expect(config.workspaces.default).toMatchObject({
  ports: [3000, 5173, 8000, 4173],
  preview: {
    defaultPort: 5173,
    startupTimeoutMs: 30_000,
  },
});
```

Add expectations to merge test:

```ts
await writeFile(
  join(cwd, 'agent.config.json'),
  JSON.stringify({
    workspaces: {
      default: {
        ports: [3000],
        preview: {
          defaultPort: 3000,
          startupTimeoutMs: 10_000,
        },
      },
    },
  }),
);

expect(config.workspaces.default).toMatchObject({
  ports: [3000],
  preview: {
    defaultPort: 3000,
    startupTimeoutMs: 10_000,
  },
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm test -- tests/config/agent-config.test.ts --reporter=verbose
```

Expected: FAIL because `ports` and `preview` do not exist yet.

- [ ] **Step 3: Implement config schema**

In `src/config/agent-config.ts`, extend `workspaceSchema`:

```ts
const workspaceSchema = z.object({
  sandboxName: z.string().min(1),
  mode: z.enum(['persistent', 'ephemeral']).default('persistent'),
  runtime: z.string().min(1).default('node24'),
  networkPolicy: z.enum(['deny-all', 'allow-all']).default('deny-all'),
  timeoutMs: z.number().int().positive().default(600_000),
  stopOnExit: z.boolean().default(true),
  ports: z.array(z.number().int().min(1).max(65535)).max(4).default([3000, 5173, 8000, 4173]),
  preview: z.object({
    defaultPort: z.number().int().min(1).max(65535).default(5173),
    startupTimeoutMs: z.number().int().positive().default(30_000),
  }).default({
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
```

Update default config:

```ts
ports: [3000, 5173, 8000, 4173],
preview: {
  defaultPort: 5173,
  startupTimeoutMs: 30_000,
},
```

Update `agent.config.json` default workspace with the same fields.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- tests/config/agent-config.test.ts --reporter=verbose
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/agent-config.ts agent.config.json tests/config/agent-config.test.ts
git commit -m "feat: add preview port config"
```

---

## Task 2: Sandbox Workspace Exposes Ports And Domains

**Files:**
- Modify: `src/sandbox/sandbox-manager.ts`
- Modify: `src/sandbox/workspace.ts`
- Test: `tests/sandbox/sandbox-manager.test.ts`

- [ ] **Step 1: Write failing sandbox manager test**

Add a test case:

```ts
it('passes exposed ports and resolves preview domains', async () => {
  const update = vi.fn().mockResolvedValue(undefined);
  const domain = vi.fn((port: number) => `https://preview-${port}.vercel.run`);
  const getOrCreate = vi.fn().mockResolvedValue({
    name: 'openrun-test',
    fs: { readFile: vi.fn() },
    runCommand: vi.fn(),
    stop: vi.fn(),
    update,
    domain,
    routes: [{ port: 3000 }, { port: 5173 }],
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
```

- [ ] **Step 2: Run failing test**

```bash
npm test -- tests/sandbox/sandbox-manager.test.ts --reporter=verbose
```

Expected: FAIL because workspace has no `domain` or `ensurePort`.

- [ ] **Step 3: Extend sandbox abstractions**

In `src/sandbox/workspace.ts`, extend options and class:

```ts
export type RunWorkspaceCommandInput = {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  detached?: boolean;
};

export type SandboxWorkspaceOptions = {
  workspaceRoot: string;
  fs: WorkspaceFileSystem;
  runSandboxCommand?: (input: RunWorkspaceCommandInput) => Promise<WorkspaceCommandResult>;
  getDomain?: (port: number) => string;
  ensurePort?: (port: number) => Promise<void>;
};
```

Add methods:

```ts
domain(port: number): string {
  if (!this.getDomain) {
    throw new Error('Sandbox domain resolver is not configured');
  }

  return this.getDomain(port);
}

async ensurePort(port: number): Promise<void> {
  if (!this.ensureSandboxPort) {
    throw new Error('Sandbox port manager is not configured');
  }

  await this.ensureSandboxPort(port);
}
```

- [ ] **Step 4: Wire SandboxManager**

In `src/sandbox/sandbox-manager.ts`, extend types:

```ts
ports: number[];
preview: {
  defaultPort: number;
  startupTimeoutMs: number;
};
```

Extend `SandboxLike`:

```ts
routes: Array<{ port: number }>;
domain(port: number): string;
update(params: { ports?: number[] }): Promise<void>;
```

Pass ports to `Sandbox.getOrCreate`:

```ts
ports: config.ports,
```

Create `ensurePort` closure:

```ts
let exposedPorts = [...config.ports];

async function ensurePort(port: number): Promise<void> {
  if (exposedPorts.includes(port)) {
    return;
  }

  const nextPorts = [...exposedPorts, port];

  if (nextPorts.length > 4) {
    throw new Error(`Vercel Sandbox supports at most 4 exposed ports; configured ports: ${exposedPorts.join(', ')}`);
  }

  await sandbox.update({ ports: nextPorts });
  exposedPorts = nextPorts;
}
```

Pass to workspace:

```ts
getDomain: (port) => sandbox.domain(port),
ensurePort,
```

- [ ] **Step 5: Verify**

```bash
npm test -- tests/sandbox/sandbox-manager.test.ts --reporter=verbose
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/sandbox-manager.ts src/sandbox/workspace.ts tests/sandbox/sandbox-manager.test.ts
git commit -m "feat: expose sandbox preview ports"
```

---

## Task 3: Add Detached Command Support

**Files:**
- Modify: `src/tools/shell.ts`
- Modify: `src/tools/tool-registry.ts`
- Test: `tests/tools/shell-tool.test.ts`

- [ ] **Step 1: Write failing test**

Add test:

```ts
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
```

- [ ] **Step 2: Run failing test**

```bash
npm test -- tests/tools/shell-tool.test.ts --reporter=verbose
```

Expected: FAIL because `detached` is not in `RunCommandInput`.

- [ ] **Step 3: Implement**

In `src/tools/shell.ts`:

```ts
export type RunCommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  detached?: boolean;
  maxOutputChars?: number;
};
```

Pass through:

```ts
const command = await workspace.runCommand({
  cmd: input.command,
  args: input.args ?? [],
  cwd,
  env: input.env ?? {},
  timeoutMs: input.timeoutMs,
  detached: input.detached,
});
```

In `src/tools/tool-registry.ts`, extend `runCommandSchema`:

```ts
detached: z.boolean().optional(),
```

- [ ] **Step 4: Verify**

```bash
npm test -- tests/tools/shell-tool.test.ts --reporter=verbose
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/shell.ts src/tools/tool-registry.ts tests/tools/shell-tool.test.ts
git commit -m "feat: support detached commands"
```

---

## Task 4: Implement `start_preview`

**Files:**
- Create: `src/tools/preview.ts`
- Modify: `src/tools/tool-registry.ts`
- Test: `tests/tools/preview-tool.test.ts`

- [ ] **Step 1: Write failing preview test**

Create `tests/tools/preview-tool.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import { startPreview } from '../../src/tools/preview.js';

describe('startPreview', () => {
  it('exposes the port, starts a detached service, and returns the preview URL', async () => {
    const ensurePort = vi.fn().mockResolvedValue(undefined);
    const getDomain = vi.fn((port: number) => `https://preview-${port}.vercel.run`);
    const runSandboxCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: vi.fn().mockResolvedValue(''),
      stderr: vi.fn().mockResolvedValue(''),
    });
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
      startupTimeoutMs: 1,
    });

    expect(ensurePort).toHaveBeenCalledWith(5173);
    expect(runSandboxCommand).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'sh',
      detached: true,
      cwd: '/vercel/sandbox',
    }));
    expect(result).toMatchObject({
      port: 5173,
      url: 'https://preview-5173.vercel.run',
      logPath: '.openrun/previews/5173.log',
      command: 'npm',
      args: ['run', 'dev', '--', '--host', '0.0.0.0', '--port', '5173'],
    });
    expect(['ready', 'starting']).toContain(result.status);
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
npm test -- tests/tools/preview-tool.test.ts --reporter=verbose
```

Expected: FAIL because `src/tools/preview.ts` does not exist.

- [ ] **Step 3: Implement preview tool**

Create `src/tools/preview.ts`:

```ts
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

async function waitForPreview(url: string, waitForPath: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  const target = new URL(waitForPath, url).toString();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(target, { method: 'GET' });

      if (response.status < 500) {
        return Date.now() - startedAt;
      }
    } catch {
      // Service is still booting.
    }

    await delay(500);
  }

  return timeoutMs;
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
```

- [ ] **Step 4: Register tool**

In `src/tools/tool-registry.ts`, import:

```ts
import { startPreview } from './preview.js';
```

Add to tool list:

```ts
createTool(
  'start_preview',
  'Start a web preview server in the sandbox and return a public URL.',
  startPreviewSchema,
  (args) => startPreview(workspace, args),
),
```

Add schema:

```ts
const startPreviewSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  port: z.number().int().min(1).max(65535),
  env: z.record(z.string(), z.string()).optional(),
  waitForPath: z.string().optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
});
```

- [ ] **Step 5: Verify**

```bash
npm test -- tests/tools/preview-tool.test.ts --reporter=verbose
npm test -- tests/tools --reporter=verbose
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/preview.ts src/tools/tool-registry.ts tests/tools/preview-tool.test.ts
git commit -m "feat: add preview startup tool"
```

---

## Task 5: Teach The Agent When To Use Vite Or Next.js

**Files:**
- Modify: `src/agent/coding-agent.ts`
- Test: `tests/agent/coding-agent.test.ts`

- [ ] **Step 1: Write failing test**

Add test that inspects the first system message sent to the model:

```ts
it('instructs the model to use Vite for simple HTML and Next.js for complex apps', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'openrun-agent-'));
  const store = await SqliteStore.open(join(cwd, 'openrun.sqlite'));

  try {
    store.migrate();
    const workspaceRecord = store.upsertWorkspace({
      name: 'default',
      sandboxName: 'openrun-test',
      mode: 'persistent',
      runtime: 'node24',
      networkPolicyJson: JSON.stringify('deny-all'),
      persistent: true,
      snapshotExpiration: 0,
    });
    const conversation = store.createConversation({
      workspaceId: workspaceRecord.id,
      agentName: 'coding',
      providerName: 'test-provider',
      model: 'test-model',
      firstPrompt: 'create a simple html app',
    });
    const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
    const modelClient = new ScriptedModelClient([
      { id: 'msg_final', content: 'ok', toolCalls: [] },
    ]);

    await runCodingAgent({
      prompt: 'create a simple html app',
      conversationId: conversation.id,
      model: 'test-model',
      maxToolSteps: 5,
      modelClient,
      store,
      workspace,
      tools: createToolRegistry(workspace),
    });

    const systemMessage = modelClient.inputs[0].messages[0].content;
    expect(systemMessage).toContain('simple HTML');
    expect(systemMessage).toContain('Vite');
    expect(systemMessage).toContain('Next.js');
    expect(systemMessage).toContain('start_preview');
    expect(systemMessage).toContain('0.0.0.0');
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
```

Update `ScriptedModelClient` test helper:

```ts
readonly inputs: CreateMessageInput[] = [];

async createMessage(input: CreateMessageInput): ReturnType<ModelClient['createMessage']> {
  this.inputs.push(input);
  ...
}
```

- [ ] **Step 2: Run failing test**

```bash
npm test -- tests/agent/coding-agent.test.ts --reporter=verbose
```

Expected: FAIL because current system prompt lacks preview/framework rules.

- [ ] **Step 3: Update system prompt**

In `src/agent/coding-agent.ts`, extend `DEFAULT_SYSTEM_PROMPT`:

```ts
'When building simple HTML, static pages, or small demos, prefer Vite and start it with start_preview on port 5173.',
'When building more complex apps that need routing, API routes, server rendering, auth, dashboards, or full-stack structure, prefer Next.js and start it with start_preview on port 3000.',
'Always bind preview servers to 0.0.0.0. For Vite use npm run dev -- --host 0.0.0.0 --port 5173. For Next.js use npm run dev -- --hostname 0.0.0.0 --port 3000.',
'After creating or changing a web app, use start_preview and return the preview URL to the user.',
```

- [ ] **Step 4: Verify**

```bash
npm test -- tests/agent/coding-agent.test.ts --reporter=verbose
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/coding-agent.ts tests/agent/coding-agent.test.ts
git commit -m "feat: guide preview app framework selection"
```

---

## Task 6: Document Preview Workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add README section**

Add this section after “Run The Agent”:

```md
## Preview Web Apps

When the agent builds a web app, it can start the app inside Vercel Sandbox and return a public preview URL.

Simple HTML or static demos should use Vite:

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

More complex applications should use Next.js:

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

The `start_preview` tool exposes the sandbox port, starts the service in detached mode, waits for readiness, and returns the URL.

Preview services only run while the sandbox session is alive. With `stopOnExit: true`, exiting the CLI stops the sandbox and the preview process. Use `stopOnExit: false` and a longer `timeoutMs` if you want previews to remain available after the CLI exits.
```

- [ ] **Step 2: Verify docs render**

Run:

```bash
sed -n '1,180p' README.md
```

Expected: README contains the preview section with valid fenced code blocks.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: explain preview workflow"
```

---

## Task 7: Full Verification

**Files:**
- No code changes unless verification finds a bug.

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: exit 0.

- [ ] **Step 4: Manual smoke test with real sandbox credentials**

Run:

```bash
npm run dev -- "Create a simple HTML page with Vite, start it in preview, and give me the URL."
```

Expected:

```txt
[tool] start_preview ...
Preview URL: https://...
```

Open the URL in a browser and confirm the app loads.

- [ ] **Step 5: Commit verification notes if docs changed**

If no docs changed during verification, do not create an empty commit.

---

## 风险和取舍

### 为什么第一版不做 `stop_preview`

用户当前目标是“写完项目后自动启动并返回链接”。停止和管理多个预览是后续增强，不是第一版闭环的必要条件。

### 为什么日志写到文件

预览服务日志可能非常吵。写到 `.openrun/previews/<port>.log` 可以避免污染对话，同时让 Agent 后续可以通过 `read_file` 查看日志。

### 为什么 readiness 超时不直接失败

有些框架首次启动会安装依赖、编译、拉包，30 秒内不一定 ready。返回 `status: 'starting'` 可以让用户先拿到 URL，也让 Agent 有机会继续读日志判断。

### 为什么默认暴露 4 个端口

Vercel Sandbox SDK 文档和本地类型都表明 `ports` 最多 4 个。默认覆盖最常见开发服务器：

```txt
3000, 5173, 8000, 4173
```

---

## 自检

- 覆盖了单工具 `start_preview` 的设计。
- 覆盖了简单 HTML 用 Vite、复杂应用用 Next.js 的 Agent 规则。
- 覆盖了 Vercel Sandbox `ports`、`domain(port)`、`update({ ports })`、`detached` 的接入点。
- 覆盖了配置、沙箱、workspace、工具注册、Agent prompt、README、测试。
- 没有开始实现生产代码；等待用户确认后再开发。
