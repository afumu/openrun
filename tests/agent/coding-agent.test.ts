import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCodingAgent, type CodingAgentEvent } from '../../src/agent/coding-agent.js';
import type { CreateMessageInput, ModelClient, ModelResponse } from '../../src/model/model-client.js';
import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';
import { createToolRegistry } from '../../src/tools/tool-registry.js';

describe('runCodingAgent', () => {
  it('stores user, assistant, tool result, and final assistant events', async () => {
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
        firstPrompt: 'create hello.js',
      });
      const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
      const modelClient = new ScriptedModelClient([
        {
          id: 'msg_tool',
          content: 'I will create the file.',
          toolCalls: [
            {
              id: 'call_1',
              name: 'write_file',
              arguments: JSON.stringify({
                path: 'hello.js',
                content: 'console.log("hello");\n',
              }),
            },
          ],
        },
        {
          id: 'msg_final',
          content: 'Created hello.js.',
          toolCalls: [],
        },
      ]);

      const answer = await runCodingAgent({
        prompt: 'create hello.js',
        conversationId: conversation.id,
        model: 'test-model',
        maxToolSteps: 5,
        modelClient,
        store,
        workspace,
        tools: createToolRegistry(workspace),
      });

      expect(answer).toBe('Created hello.js.');
      expect(await workspace.fs.readFile(workspace.resolvePath('hello.js'), 'utf8')).toBe(
        'console.log("hello");\n',
      );

      const events = store.listEvents(conversation.id);
      expect(events.map((event) => event.eventType)).toEqual([
        'user',
        'assistant',
        'tool_result',
        'assistant',
      ]);
      expect(events[2]).toMatchObject({
        parentEventId: events[1].id,
        role: 'tool',
        toolCallId: 'call_1',
        toolName: 'write_file',
        isError: false,
      });
      expect(store.getConversationById(conversation.id)).toMatchObject({
        messageCount: 4,
        lastEventId: events[3].id,
      });
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits streaming assistant deltas and concise tool status events', async () => {
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
        firstPrompt: 'create hello.js',
      });
      const workspace = SandboxWorkspace.local({ workspaceRoot: join(cwd, 'workspace') });
      const modelClient = new StreamingScriptedModelClient([
        {
          deltas: ['I will ', 'write it.'],
          response: {
            id: 'msg_tool',
            content: 'I will write it.',
            toolCalls: [
              {
                id: 'call_1',
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'hello.js',
                  content: 'console.log("hello");\n',
                }),
              },
            ],
          },
        },
        {
          deltas: ['Created ', 'hello.js.'],
          response: {
            id: 'msg_final',
            content: 'Created hello.js.',
            toolCalls: [],
          },
        },
      ]);
      const events: CodingAgentEvent[] = [];

      const answer = await runCodingAgent({
        prompt: 'create hello.js',
        conversationId: conversation.id,
        model: 'test-model',
        maxToolSteps: 5,
        modelClient,
        store,
        workspace,
        tools: createToolRegistry(workspace),
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(answer).toBe('Created hello.js.');
      expect(events).toEqual([
        { type: 'assistant_delta', content: 'I will ' },
        { type: 'assistant_delta', content: 'write it.' },
        {
          type: 'tool_start',
          toolCallId: 'call_1',
          toolName: 'write_file',
          arguments: JSON.stringify({
            path: 'hello.js',
            content: 'console.log("hello");\n',
          }),
        },
        {
          type: 'tool_finish',
          toolCallId: 'call_1',
          toolName: 'write_file',
          isError: false,
        },
        { type: 'assistant_delta', content: 'Created ' },
        { type: 'assistant_delta', content: 'hello.js.' },
      ]);
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('instructs the model to choose Vite or Next.js and start previews', async () => {
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
        {
          id: 'msg_final',
          content: 'ok',
          toolCalls: [],
        },
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
});

class ScriptedModelClient implements ModelClient {
  private index = 0;
  readonly inputs: CreateMessageInput[] = [];

  constructor(private readonly responses: Awaited<ReturnType<ModelClient['createMessage']>>[]) {}

  async createMessage(input: CreateMessageInput): ReturnType<ModelClient['createMessage']> {
    this.inputs.push(input);
    const response = this.responses[this.index];
    this.index += 1;

    if (!response) {
      throw new Error('No scripted model response left');
    }

    return response;
  }
}

class StreamingScriptedModelClient implements ModelClient {
  private index = 0;

  constructor(
    private readonly responses: Array<{
      deltas: string[];
      response: ModelResponse;
    }>,
  ) {}

  async createMessage(): Promise<ModelResponse> {
    throw new Error('Expected streaming model path');
  }

  async createMessageStream(
    _input: CreateMessageInput,
    callbacks?: { onContentDelta?(delta: string): void | Promise<void> },
  ): Promise<ModelResponse> {
    const response = this.responses[this.index];
    this.index += 1;

    if (!response) {
      throw new Error('No scripted model response left');
    }

    for (const delta of response.deltas) {
      await callbacks?.onContentDelta?.(delta);
    }

    return response.response;
  }
}
