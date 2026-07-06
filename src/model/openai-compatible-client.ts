import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import type {
  CreateMessageInput,
  CreateMessageStreamCallbacks,
  ModelClient,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
} from './model-client.js';

export type OpenAICompatibleClientOptions = {
  apiKey: string;
  baseURL: string;
};

export class OpenAICompatibleClient implements ModelClient {
  private readonly client: OpenAI;

  constructor(options: OpenAICompatibleClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
  }

  async createMessage(input: CreateMessageInput): Promise<ModelResponse> {
    const response = await this.client.chat.completions.create({
      model: input.model,
      messages: input.messages.map(toOpenAIMessage),
      tools: input.tools as ChatCompletionTool[],
      tool_choice: 'auto',
    });
    const message = response.choices[0]?.message;

    if (!message) {
      throw new Error('Model did not return a message');
    }

    return {
      id: response.id,
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: (message.tool_calls ?? [])
        .filter((toolCall) => toolCall.type === 'function')
        .map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      usage: response.usage,
      raw: message,
    };
  }

  async createMessageStream(
    input: CreateMessageInput,
    callbacks: CreateMessageStreamCallbacks = {},
  ): Promise<ModelResponse> {
    const stream = await this.client.chat.completions.create({
      model: input.model,
      messages: input.messages.map(toOpenAIMessage),
      tools: input.tools as ChatCompletionTool[],
      tool_choice: 'auto',
      stream: true,
    });
    let id: string | undefined;
    let content = '';
    const toolCalls = new Map<number, Partial<ModelToolCall> & { arguments: string }>();

    for await (const chunk of stream) {
      id ??= chunk.id;
      const delta = chunk.choices[0]?.delta;

      if (!delta) {
        continue;
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        await callbacks.onContentDelta?.(delta.content);
      }

      for (const toolCallDelta of delta.tool_calls ?? []) {
        const existing = toolCalls.get(toolCallDelta.index) ?? { arguments: '' };

        if (toolCallDelta.id) {
          existing.id = toolCallDelta.id;
        }

        if (toolCallDelta.function?.name) {
          existing.name = toolCallDelta.function.name;
        }

        if (toolCallDelta.function?.arguments) {
          existing.arguments += toolCallDelta.function.arguments;
        }

        toolCalls.set(toolCallDelta.index, existing);
      }
    }

    const finalToolCalls = [...toolCalls.values()]
      .filter(isCompleteToolCall)
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }));

    return {
      id,
      content,
      toolCalls: finalToolCalls,
      raw: {
        content,
        toolCalls: finalToolCalls,
      },
    };
  }
}

function isCompleteToolCall(
  toolCall: Partial<ModelToolCall> & { arguments: string },
): toolCall is ModelToolCall {
  return Boolean(toolCall.id && toolCall.name);
}

function toOpenAIMessage(message: ModelMessage): ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    } as ChatCompletionMessageParam;
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      })),
    } as ChatCompletionMessageParam;
  }

  return {
    role: message.role,
    content: message.content,
  } as ChatCompletionMessageParam;
}
