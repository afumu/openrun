import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const mocks = vi.hoisted(() => ({
  runCodingAgent: vi.fn(),
  startSandbox: vi.fn(),
  stopSandbox: vi.fn(),
  createModelClient: vi.fn(),
}));

vi.mock('../../src/agent/coding-agent.js', () => ({
  runCodingAgent: mocks.runCodingAgent,
}));

vi.mock('../../src/model/openai-compatible-client.js', () => ({
  OpenAICompatibleClient: mocks.createModelClient,
}));

vi.mock('../../src/sandbox/sandbox-manager.js', () => ({
  SandboxManager: vi.fn(() => ({
    start: mocks.startSandbox,
  })),
}));

describe('runCli interactive conversation loop', () => {
  afterEach(() => {
    vi.resetAllMocks();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENRUN_SQLITE_PATH;
  });

  it('creates a new conversation immediately when launched without arguments', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-cli-'));
    const stdout = new StringWritable();
    const stderr = new StringWritable();
    const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
    const { runCli } = await import('../../src/cli/app.js');

    try {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      mocks.startSandbox.mockResolvedValue({
        workspace,
        stop: mocks.stopSandbox,
      });
      mocks.createModelClient.mockReturnValue({ createMessage: vi.fn() });

      const exitCode = await runCli({
        argv: [],
        cwd,
        stdin: Readable.from(['/exit\n']),
        stdout,
        stderr,
        isInteractive: true,
      });

      const store = await SqliteStore.open(join(cwd, '.openrun', 'openrun.sqlite'));

      try {
        const conversations = store.listConversations();

        expect(exitCode).toBe(0);
        expect(stderr.text()).toBe('');
        expect(mocks.startSandbox).toHaveBeenCalledTimes(1);
        expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
        expect(mocks.runCodingAgent).not.toHaveBeenCalled();
        expect(conversations).toHaveLength(1);
        expect(conversations[0]).toMatchObject({
          firstPrompt: null,
          messageCount: 0,
        });
        expect(stdout.text()).toContain(`conversation: ${conversations[0].id}`);
      } finally {
        store.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps reading prompts into the same conversation until the user exits', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-cli-'));
    const stdout = new StringWritable();
    const stderr = new StringWritable();
    const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
    const { runCli } = await import('../../src/cli/app.js');

    try {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      mocks.startSandbox.mockResolvedValue({
        workspace,
        stop: mocks.stopSandbox,
      });
      mocks.createModelClient.mockReturnValue({ createMessage: vi.fn() });
      mocks.runCodingAgent
        .mockResolvedValueOnce('first answer')
        .mockResolvedValueOnce('second answer');

      const exitCode = await runCli({
        argv: [],
        cwd,
        stdin: Readable.from(['first prompt\n', 'second prompt\n', '/exit\n']),
        stdout,
        stderr,
        isInteractive: true,
      });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe('');
      expect(mocks.startSandbox).toHaveBeenCalledTimes(1);
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
      expect(mocks.runCodingAgent).toHaveBeenCalledTimes(2);

      const firstCall = mocks.runCodingAgent.mock.calls[0][0];
      const secondCall = mocks.runCodingAgent.mock.calls[1][0];
      expect(firstCall.prompt).toBe('first prompt');
      expect(secondCall.prompt).toBe('second prompt');
      expect(secondCall.conversationId).toBe(firstCall.conversationId);
      expect(stdout.text()).toContain('conversation: ');
      expect(stdout.text()).toContain('first answer');
      expect(stdout.text()).toContain('second answer');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('continues an existing conversation in interactive mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-cli-'));
    const stdout = new StringWritable();
    const stderr = new StringWritable();
    const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
    const conversationId = await createStoredConversation(cwd);
    const { runCli } = await import('../../src/cli/app.js');

    try {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      mocks.startSandbox.mockResolvedValue({
        workspace,
        stop: mocks.stopSandbox,
      });
      mocks.createModelClient.mockReturnValue({ createMessage: vi.fn() });
      mocks.runCodingAgent.mockResolvedValue('continued answer');

      const exitCode = await runCli({
        argv: ['--continue', conversationId],
        cwd,
        stdin: Readable.from(['next prompt\n', '/exit\n']),
        stdout,
        stderr,
        isInteractive: true,
      });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe('');
      expect(mocks.startSandbox).toHaveBeenCalledTimes(1);
      expect(mocks.stopSandbox).toHaveBeenCalledTimes(1);
      expect(mocks.runCodingAgent).toHaveBeenCalledTimes(1);
      expect(mocks.runCodingAgent.mock.calls[0][0]).toMatchObject({
        conversationId,
        prompt: 'next prompt',
      });
      expect(stdout.text()).toContain(`conversation: ${conversationId}`);
      expect(stdout.text()).toContain('continued answer');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('streams assistant text and compact tool status lines to stdout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-cli-'));
    const stdout = new StringWritable();
    const stderr = new StringWritable();
    const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
    const { runCli } = await import('../../src/cli/app.js');

    try {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      mocks.startSandbox.mockResolvedValue({
        workspace,
        stop: mocks.stopSandbox,
      });
      mocks.createModelClient.mockReturnValue({ createMessage: vi.fn() });
      mocks.runCodingAgent.mockImplementation(async (options) => {
        options.onEvent?.({ type: 'assistant_delta', content: 'hel' });
        options.onEvent?.({ type: 'assistant_delta', content: 'lo' });
        options.onEvent?.({
          type: 'tool_start',
          toolCallId: 'call_1',
          toolName: 'write_file',
          arguments: JSON.stringify({
            path: 'created.js',
            content: 'very long file content that should not be printed',
          }),
        });
        options.onEvent?.({
          type: 'tool_finish',
          toolCallId: 'call_1',
          toolName: 'write_file',
          isError: false,
        });
        return 'hello';
      });

      const exitCode = await runCli({
        argv: [],
        cwd,
        stdin: Readable.from(['stream please\n', '/exit\n']),
        stdout,
        stderr,
        isInteractive: true,
      });

      const output = stdout.text();
      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe('');
      expect(output).toContain('hello\n');
      expect(output).toContain('[tool] write_file created.js\n');
      expect(output).toContain('[tool] done write_file\n');
      expect(output).not.toContain('very long file content');
      expect(output.match(/hello/g)).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function createStoredConversation(cwd: string): Promise<string> {
  const store = await SqliteStore.open(join(cwd, '.openrun', 'openrun.sqlite'));

  try {
    store.migrate();
    const workspace = store.upsertWorkspace({
      name: 'default',
      sandboxName: 'openrun-test',
      mode: 'persistent',
      runtime: 'node24',
      networkPolicyJson: JSON.stringify('deny-all'),
      persistent: true,
      snapshotExpiration: 0,
      lastSnapshotId: null,
    });
    const conversation = store.createConversation({
      workspaceId: workspace.id,
      agentName: 'coding',
      providerName: 'deepseek',
      model: 'deepseek-v4-flash',
      firstPrompt: 'previous prompt',
    });

    store.appendEvent({
      conversationId: conversation.id,
      eventType: 'user',
      role: 'user',
      contentText: 'previous prompt',
      eventJson: { role: 'user', content: 'previous prompt' },
    });

    return conversation.id;
  } finally {
    store.close();
  }
}

class StringWritable extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
