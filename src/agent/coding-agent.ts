import type {
  CreateMessageInput,
  ModelClient,
  ModelMessage,
  ModelResponse,
} from '../model/model-client.js';
import type { SandboxWorkspace } from '../sandbox/workspace.js';
import type { SqliteStore } from '../storage/sqlite-store.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

const DEFAULT_SYSTEM_PROMPT = [
  'You are OpenRun, a coding agent running inside a Vercel Sandbox workspace.',
  'Use filesystem tools for reading and editing files.',
  'Use run_command only for executing processes such as tests or scripts.',
  'Do not put real secrets into files, command arguments, or tool environment variables.',
].join('\n');

export type RunCodingAgentOptions = {
  prompt?: string;
  conversationId: string;
  model: string;
  maxToolSteps: number;
  modelClient: ModelClient;
  store: SqliteStore;
  workspace: SandboxWorkspace;
  tools: ToolRegistry;
  systemPrompt?: string;
  onEvent?(event: CodingAgentEvent): void | Promise<void>;
};

export type CodingAgentEvent =
  | {
      type: 'assistant_delta';
      content: string;
    }
  | {
      type: 'tool_start';
      toolCallId: string;
      toolName: string;
      arguments: string;
    }
  | {
      type: 'tool_finish';
      toolCallId: string;
      toolName: string;
      isError: boolean;
    };

export async function runCodingAgent(options: RunCodingAgentOptions): Promise<string> {
  let parentEventId = latestEventId(options.store, options.conversationId);

  if (options.prompt) {
    const userEvent = options.store.appendEvent({
      conversationId: options.conversationId,
      parentEventId,
      eventType: 'user',
      role: 'user',
      contentText: options.prompt,
      eventJson: {
        role: 'user',
        content: options.prompt,
      },
      cwd: options.workspace.workspaceRoot,
    });
    parentEventId = userEvent.id;
  }

  const messages = buildModelMessages(options.store, options.conversationId, options.systemPrompt);

  for (let step = 0; step < options.maxToolSteps; step += 1) {
    const response = await createModelResponse(options, {
      model: options.model,
      messages,
      tools: options.tools.definitions,
    });
    const assistantEvent = options.store.appendEvent({
      conversationId: options.conversationId,
      parentEventId,
      eventType: 'assistant',
      role: 'assistant',
      model: options.model,
      providerMessageId: response.id,
      contentText: response.content,
      eventJson: response.raw ?? response,
      usageJson: response.usage,
      cwd: options.workspace.workspaceRoot,
    });
    parentEventId = assistantEvent.id;
    messages.push(responseToAssistantMessage(response));

    if (response.toolCalls.length === 0) {
      return response.content;
    }

    for (const toolCall of response.toolCalls) {
      let toolResult: unknown;
      let isError = false;

      await emit(options, {
        type: 'tool_start',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        arguments: toolCall.arguments,
      });

      try {
        toolResult = await options.tools.execute(toolCall.name, toolCall.arguments);
      } catch (error) {
        isError = true;
        toolResult = {
          error: error instanceof Error ? error.message : String(error),
        };
      }

      await emit(options, {
        type: 'tool_finish',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError,
      });

      const toolContent = stringifyForModel(toolResult);
      const toolEvent = options.store.appendEvent({
        conversationId: options.conversationId,
        parentEventId: assistantEvent.id,
        eventType: 'tool_result',
        role: 'tool',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError,
        contentText: truncate(toolContent, 500),
        eventJson: toolResult,
        cwd: options.workspace.workspaceRoot,
      });
      parentEventId = toolEvent.id;
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        content: toolContent,
      });
    }
  }

  throw new Error(`Agent exceeded maxToolSteps (${options.maxToolSteps})`);
}

async function createModelResponse(
  options: RunCodingAgentOptions,
  input: CreateMessageInput,
): Promise<ModelResponse> {
  if (options.modelClient.createMessageStream) {
    return options.modelClient.createMessageStream(input, {
      onContentDelta: async (delta) => {
        await emit(options, {
          type: 'assistant_delta',
          content: delta,
        });
      },
    });
  }

  const response = await options.modelClient.createMessage(input);

  if (response.content) {
    await emit(options, {
      type: 'assistant_delta',
      content: response.content,
    });
  }

  return response;
}

async function emit(options: RunCodingAgentOptions, event: CodingAgentEvent): Promise<void> {
  await options.onEvent?.(event);
}

function buildModelMessages(
  store: SqliteStore,
  conversationId: string,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
    },
  ];

  for (const event of store.listEvents(conversationId)) {
    if (event.eventType === 'user') {
      messages.push({
        role: 'user',
        content: event.contentText ?? extractContentText(event.eventJson),
      });
    } else if (event.eventType === 'assistant') {
      messages.push(eventJsonToAssistantMessage(event.eventJson, event.contentText));
    } else if (event.eventType === 'tool_result') {
      messages.push({
        role: 'tool',
        toolCallId: event.toolCallId ?? undefined,
        content: stringifyForModel(event.eventJson),
      });
    } else if (event.eventType === 'summary') {
      messages.push({
        role: 'system',
        content: event.contentText ?? extractContentText(event.eventJson),
      });
    }
  }

  return messages;
}

function responseToAssistantMessage(response: ModelResponse): ModelMessage {
  return {
    role: 'assistant',
    content: response.content,
    toolCalls: response.toolCalls,
  };
}

function eventJsonToAssistantMessage(eventJson: unknown, fallbackContent: string | null): ModelMessage {
  if (isModelResponse(eventJson)) {
    return responseToAssistantMessage(eventJson);
  }

  return {
    role: 'assistant',
    content: fallbackContent ?? extractContentText(eventJson),
  };
}

function isModelResponse(value: unknown): value is ModelResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'toolCalls' in value &&
    Array.isArray((value as { toolCalls: unknown }).toolCalls)
  );
}

function latestEventId(store: SqliteStore, conversationId: string): string | null {
  return store.getConversationById(conversationId).lastEventId;
}

function stringifyForModel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function extractContentText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && 'content' in value) {
    const content = (value as { content: unknown }).content;

    if (typeof content === 'string') {
      return content;
    }
  }

  return JSON.stringify(value);
}
