import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { runCodingAgent, type CodingAgentEvent } from '../agent/coding-agent.js';
import { loadAgentConfig, type OpenRunConfig, type WorkspaceConfig } from '../config/agent-config.js';
import { loadLocalEnv } from '../config/load-local-env.js';
import { OpenAICompatibleClient } from '../model/openai-compatible-client.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import type { ConversationRecord, SqliteStore, WorkspaceRecord } from '../storage/sqlite-store.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { parseCliArgs } from './args.js';

const EXIT_COMMANDS = new Set(['/exit', 'exit', 'quit', '.exit', ':q']);

export type RunCliOptions = {
  argv: string[];
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  isInteractive?: boolean;
};

export async function runCli(options: RunCliOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let store: SqliteStore | undefined;

  try {
    loadLocalEnv(cwd);

    const args = parseCliArgs(options.argv);
    const config = await loadAgentConfig(cwd);
    const sqlitePath = resolveSqlitePath(cwd, config);
    const storage = await import('../storage/sqlite-store.js');
    store = await storage.SqliteStore.open(sqlitePath);
    store.migrate();
    const activeStore = store;

    if (args.command === 'list-sessions') {
      writeSessionList(stdout, activeStore.listConversations());
      return 0;
    }

    const agentName = config.defaultAgent;
    const agent = config.agents[agentName];

    if (!agent) {
      throw new Error(`Agent is not configured: ${agentName}`);
    }

    if (!config.providers[agent.provider]) {
      throw new Error(`Provider is not configured: ${agent.provider}`);
    }

    const conversation = args.continueConversationId
      ? activeStore.getConversationById(args.continueConversationId)
      : undefined;
    const existingWorkspaceRecord = conversation
      ? activeStore.getWorkspaceById(conversation.workspaceId)
      : undefined;

    if (
      existingWorkspaceRecord &&
      args.workspaceName &&
      args.workspaceName !== existingWorkspaceRecord.name
    ) {
      throw new Error(
        `Conversation ${conversation?.id} belongs to workspace ${existingWorkspaceRecord.name}, not ${args.workspaceName}`,
      );
    }

    const workspaceName = existingWorkspaceRecord?.name ?? args.workspaceName ?? agent.workspace;
    const workspaceConfig = resolveWorkspaceConfig(config, workspaceName);
    const workspaceRecord =
      existingWorkspaceRecord ??
      activeStore.upsertWorkspace({
        name: workspaceName,
        sandboxName: workspaceConfig.sandboxName,
        mode: workspaceConfig.mode,
        runtime: workspaceConfig.runtime,
        networkPolicyJson: JSON.stringify(workspaceConfig.networkPolicy),
        persistent: workspaceConfig.mode === 'persistent',
        snapshotExpiration: workspaceConfig.snapshotExpiration,
        lastSnapshotId: null,
      });
    const model = conversation?.model ?? agent.model;
    const providerName = conversation?.providerName ?? agent.provider;
    const sandboxHandle = await new SandboxManager().start(workspaceConfig);
    let modelClient: OpenAICompatibleClient | undefined;

    try {
      let activeConversation = conversation;

      const runPrompt = async (prompt: string): Promise<ConversationRecord> => {
        if (!activeConversation) {
          activeConversation = createConversation(activeStore, {
            workspace: workspaceRecord,
            agentName,
            providerName,
            model,
            prompt,
          });
        }

        modelClient ??= createModelClient(config, providerName);
        const conversationForPrompt = activeConversation;
        const output = createRunOutput(stdout);

        const answer = await runCodingAgent({
          prompt,
          conversationId: conversationForPrompt.id,
          model,
          maxToolSteps: agent.maxToolSteps,
          modelClient,
          store: activeStore,
          workspace: sandboxHandle.workspace,
          tools: createToolRegistry(sandboxHandle.workspace),
          onEvent: (event) => output.writeEvent(event),
        });

        output.finish(answer);
        return conversationForPrompt;
      };

      if (args.prompt) {
        const currentConversation = await runPrompt(args.prompt);
        stdout.write(`conversation: ${currentConversation.id}\n`);
        return 0;
      }

      if (!activeConversation) {
        activeConversation = createConversation(activeStore, {
          workspace: workspaceRecord,
          agentName,
          providerName,
          model,
        });
      }

      const promptReader = createPromptReader(options, stdout);

      try {
        stdout.write(`conversation: ${activeConversation.id}\n`);

        while (true) {
          const prompt = await promptReader.read();

          if (prompt === undefined) {
            return 0;
          }

          if (prompt === '') {
            continue;
          }

          if (isExitCommand(prompt)) {
            return 0;
          }

          const currentConversation = await runPrompt(prompt);
          activeConversation = activeStore.getConversationById(currentConversation.id);
        }
      } finally {
        promptReader.close();
      }
    } finally {
      await sandboxHandle.stop();
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

function createRunOutput(stdout: Writable): {
  writeEvent(event: CodingAgentEvent): void;
  finish(fallbackAnswer: string): void;
} {
  let wroteAssistantContent = false;
  let lastOutputWasAssistantContent = false;

  const writeToolLine = (line: string) => {
    if (lastOutputWasAssistantContent) {
      stdout.write('\n');
    }

    stdout.write(`${line}\n`);
    lastOutputWasAssistantContent = false;
  };

  return {
    writeEvent(event) {
      if (event.type === 'assistant_delta') {
        stdout.write(event.content);
        wroteAssistantContent = true;
        lastOutputWasAssistantContent = true;
        return;
      }

      if (event.type === 'tool_start') {
        writeToolLine(formatToolStart(event));
        return;
      }

      writeToolLine(
        event.isError
          ? `[tool] failed ${event.toolName}`
          : `[tool] done ${event.toolName}`,
      );
    },
    finish(fallbackAnswer) {
      if (!wroteAssistantContent) {
        stdout.write(`${fallbackAnswer}\n`);
        return;
      }

      if (lastOutputWasAssistantContent) {
        stdout.write('\n');
      }
    },
  };
}

function formatToolStart(event: Extract<CodingAgentEvent, { type: 'tool_start' }>): string {
  const summary = summarizeToolArguments(event.toolName, event.arguments);
  return summary ? `[tool] ${event.toolName} ${summary}` : `[tool] ${event.toolName}`;
}

function summarizeToolArguments(toolName: string, rawArguments: string): string {
  let args: Record<string, unknown>;

  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    return '';
  }

  if (toolName === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : '';
    const commandArgs = Array.isArray(args.args)
      ? args.args.filter((value): value is string => typeof value === 'string').join(' ')
      : '';
    return truncateOutputSummary([command, commandArgs].filter(Boolean).join(' '));
  }

  if (typeof args.path === 'string') {
    return truncateOutputSummary(args.path);
  }

  if (typeof args.query === 'string') {
    return truncateOutputSummary(`query="${args.query}"`);
  }

  if (typeof args.glob === 'string') {
    return truncateOutputSummary(`glob="${args.glob}"`);
  }

  return '';
}

function truncateOutputSummary(value: string, maxChars = 80): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
}

function isExitCommand(prompt: string): boolean {
  return EXIT_COMMANDS.has(prompt.trim().toLowerCase());
}

function createPromptReader(
  options: RunCliOptions,
  stdout: Writable,
): { read(): Promise<string | undefined>; close(): void } {
  const stdin = options.stdin ?? process.stdin;
  const isInteractive =
    options.isInteractive ?? Boolean((stdin as Readable & { isTTY?: boolean }).isTTY);

  if (!isInteractive) {
    return {
      async read() {
        return undefined;
      },
      close() {},
    };
  }

  const readline = createInterface({
    input: stdin,
    output: stdout,
    prompt: '> ',
  });
  const pendingLines: string[] = [];
  let closed = false;
  let waiting: ((value: string | undefined) => void) | undefined;

  readline.on('line', (line) => {
    const normalized = line.trim();

    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(normalized);
      return;
    }

    pendingLines.push(normalized);
  });
  readline.on('close', () => {
    closed = true;

    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(undefined);
    }
  });

  return {
    async read() {
      const line = pendingLines.shift();

      if (line !== undefined) {
        return line;
      }

      if (closed) {
        return undefined;
      }

      readline.prompt();
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      readline.close();
    },
  };
}

function createConversation(
  store: SqliteStore,
  input: {
    workspace: WorkspaceRecord;
    agentName: string;
    providerName: string;
    model: string;
    prompt?: string;
  },
): ConversationRecord {
  return store.createConversation({
    workspaceId: input.workspace.id,
    agentName: input.agentName,
    providerName: input.providerName,
    model: input.model,
    firstPrompt: input.prompt ?? null,
  });
}

function createModelClient(config: OpenRunConfig, providerName: string): OpenAICompatibleClient {
  const provider = config.providers[providerName];

  if (!provider) {
    throw new Error(`Provider is not configured: ${providerName}`);
  }

  const apiKey = process.env[provider.apiKeyEnv];

  if (!apiKey) {
    throw new Error(`Missing ${provider.apiKeyEnv}`);
  }

  return new OpenAICompatibleClient({
    apiKey,
    baseURL: provider.baseURL,
  });
}

function resolveWorkspaceConfig(config: OpenRunConfig, workspaceName: string): WorkspaceConfig {
  const workspace = config.workspaces[workspaceName];

  if (!workspace) {
    throw new Error(`Workspace is not configured: ${workspaceName}`);
  }

  return workspace;
}

function resolveSqlitePath(cwd: string, config: OpenRunConfig): string {
  const fromEnv = process.env.OPENRUN_SQLITE_PATH;
  const configured = fromEnv || config.storage.sqlitePath;
  return resolve(cwd, configured);
}

function writeSessionList(stdout: Writable, conversations: ConversationRecord[]): void {
  if (conversations.length === 0) {
    stdout.write('No conversations found.\n');
    return;
  }

  for (const conversation of conversations) {
    stdout.write(
      [
        conversation.id,
        conversation.status,
        conversation.updatedAt,
        conversation.title ?? conversation.firstPrompt ?? '(untitled)',
      ].join('\t'),
    );
    stdout.write('\n');
  }
}
