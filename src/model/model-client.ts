export type ModelToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
};

export type ModelResponse = {
  id?: string;
  content: string;
  toolCalls: ModelToolCall[];
  usage?: unknown;
  raw?: unknown;
};

export type CreateMessageInput = {
  model: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
};

export type CreateMessageStreamCallbacks = {
  onContentDelta?(delta: string): void | Promise<void>;
};

export type ModelClient = {
  createMessage(input: CreateMessageInput): Promise<ModelResponse>;
  createMessageStream?(
    input: CreateMessageInput,
    callbacks?: CreateMessageStreamCallbacks,
  ): Promise<ModelResponse>;
};
