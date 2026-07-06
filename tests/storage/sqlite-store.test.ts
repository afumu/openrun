import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SqliteStore } from '../../src/storage/sqlite-store.js';

describe('SqliteStore', () => {
  it('creates the workspace, conversation, and append-only event tables', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-store-'));
    const store = await SqliteStore.open(join(cwd, 'openrun.sqlite'));

    try {
      store.migrate();

      const tables = store.listTables();

      expect(tables).toEqual([
        'conversation_events',
        'conversations',
        'sandbox_workspaces',
      ]);
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records a conversation index and restores its ordered event stream', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openrun-store-'));
    const store = await SqliteStore.open(join(cwd, 'openrun.sqlite'));

    try {
      store.migrate();
      const workspace = store.upsertWorkspace({
        name: 'default',
        sandboxName: 'openrun-test',
        vercelSandboxId: 'sbx_123',
        mode: 'persistent',
        runtime: 'node24',
        networkPolicyJson: JSON.stringify('deny-all'),
        persistent: true,
        snapshotExpiration: 0,
        lastSnapshotId: 'snap_1',
      });
      const conversation = store.createConversation({
        workspaceId: workspace.id,
        agentName: 'coding',
        providerName: 'deepseek',
        model: 'deepseek-v4-flash',
        firstPrompt: 'write a tiny file',
      });

      const userEvent = store.appendEvent({
        conversationId: conversation.id,
        eventType: 'user',
        role: 'user',
        contentText: 'write a tiny file',
        eventJson: { role: 'user', content: 'write a tiny file' },
        cwd: '/vercel/sandbox',
        gitBranch: 'main',
      });
      const assistantEvent = store.appendEvent({
        conversationId: conversation.id,
        parentEventId: userEvent.id,
        eventType: 'assistant',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        providerMessageId: 'msg_1',
        contentText: 'I will write the file.',
        eventJson: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will write the file.' }],
        },
        usageJson: { inputTokens: 12, outputTokens: 7 },
      });
      const toolEvent = store.appendEvent({
        conversationId: conversation.id,
        parentEventId: assistantEvent.id,
        eventType: 'tool_result',
        role: 'tool',
        toolCallId: 'call_1',
        toolName: 'write_file',
        contentText: 'created hello.js',
        eventJson: { ok: true, path: 'hello.js' },
      });

      const restored = store.listEvents(conversation.id);
      const listed = store.listConversations();

      expect(restored.map((event) => event.id)).toEqual([
        userEvent.id,
        assistantEvent.id,
        toolEvent.id,
      ]);
      expect(restored.map((event) => event.sequenceNumber)).toEqual([1, 2, 3]);
      expect(restored[2]).toMatchObject({
        parentEventId: assistantEvent.id,
        eventType: 'tool_result',
        role: 'tool',
        toolCallId: 'call_1',
        toolName: 'write_file',
        contentText: 'created hello.js',
        eventJson: { ok: true, path: 'hello.js' },
      });
      expect(listed[0]).toMatchObject({
        id: conversation.id,
        workspaceId: workspace.id,
        firstPrompt: 'write a tiny file',
        messageCount: 3,
        lastEventId: toolEvent.id,
      });
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
