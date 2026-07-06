import { z } from 'zod';

import type { SandboxWorkspace } from '../sandbox/workspace.js';
import type { ModelToolDefinition } from '../model/model-client.js';
import {
  appendFile,
  batchEditFile,
  editFile,
  getFileInfo,
  listDirectory,
  readFile,
  searchCode,
  searchFiles,
  writeFile,
} from './filesystem.js';
import { startPreview } from './preview.js';
import { runCommand } from './shell.js';

export type ToolResult = unknown;

export type RegisteredTool = {
  definition: ModelToolDefinition;
  execute(rawArguments: string): Promise<ToolResult>;
};

export type ToolRegistry = {
  definitions: ModelToolDefinition[];
  execute(name: string, rawArguments: string): Promise<ToolResult>;
};

export function createToolRegistry(workspace: SandboxWorkspace): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();

  for (const tool of [
    createTool('list_directory', 'List files and directories in the sandbox workspace.', listDirectorySchema, (args) => listDirectory(workspace, args)),
    createTool('read_file', 'Read a file from the sandbox workspace with line numbers.', readFileSchema, (args) => readFile(workspace, args)),
    createTool('get_file_info', 'Get file metadata in the sandbox workspace.', getFileInfoSchema, (args) => getFileInfo(workspace, args)),
    createTool('write_file', 'Write a UTF-8 text file in the sandbox workspace.', writeFileSchema, (args) => writeFile(workspace, args)),
    createTool('append_file', 'Append UTF-8 text to a file in the sandbox workspace.', appendFileSchema, (args) => appendFile(workspace, args)),
    createTool('edit_file', 'Replace exactly one text span in a file.', editFileSchema, (args) => editFile(workspace, args)),
    createTool('batch_edit_file', 'Apply multiple exact replacements to a file atomically.', batchEditFileSchema, (args) => batchEditFile(workspace, args)),
    createTool('search_files', 'Search file and directory paths in the sandbox workspace.', searchFilesSchema, (args) => searchFiles(workspace, args)),
    createTool('search_code', 'Search text file contents in the sandbox workspace.', searchCodeSchema, (args) => searchCode(workspace, args)),
    createTool('run_command', 'Run a command process in the sandbox workspace.', runCommandSchema, (args) => runCommand(workspace, args)),
    createTool('start_preview', 'Start a web preview server in the sandbox and return a public URL.', startPreviewSchema, (args) => startPreview(workspace, args)),
  ]) {
    tools.set(tool.definition.function.name, tool);
  }

  return {
    definitions: [...tools.values()].map((tool) => tool.definition),
    async execute(name, rawArguments) {
      const tool = tools.get(name);

      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      return tool.execute(rawArguments);
    },
  };
}

function createTool<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  execute: (args: z.infer<T>) => Promise<ToolResult>,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: zodObjectToJsonSchema(schema),
      },
    },
    async execute(rawArguments) {
      let parsed: unknown;

      try {
        parsed = rawArguments ? JSON.parse(rawArguments) : {};
      } catch {
        throw new Error(`Tool arguments for ${name} must be valid JSON`);
      }

      return execute(schema.parse(parsed));
    },
  };
}

const listDirectorySchema = z.object({
  path: z.string().optional(),
  depth: z.number().int().positive().optional(),
  maxEntries: z.number().int().positive().optional(),
});

const readFileSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
});

const getFileInfoSchema = z.object({
  path: z.string().min(1),
  followSymlink: z.boolean().optional(),
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().optional(),
});

const appendFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const editFileSchema = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
});

const batchEditFileSchema = z.object({
  path: z.string().min(1),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })).min(1),
});

const searchFilesSchema = z.object({
  path: z.string().optional(),
  query: z.string().optional(),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
});

const searchCodeSchema = z.object({
  path: z.string().optional(),
  query: z.string().min(1),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
  maxCharsPerResult: z.number().int().positive().optional(),
});

const runCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  detached: z.boolean().optional(),
  maxOutputChars: z.number().int().positive().optional(),
});

const startPreviewSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  port: z.number().int().min(1).max(65535),
  env: z.record(z.string(), z.string()).optional(),
  waitForPath: z.string().optional(),
  startupTimeoutMs: z.number().int().positive().optional(),
});

function zodObjectToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema);

  if (typeof jsonSchema === 'boolean') {
    return {};
  }

  return jsonSchema as Record<string, unknown>;
}
