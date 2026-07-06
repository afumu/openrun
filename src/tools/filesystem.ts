import path from 'node:path';

import { SandboxWorkspace } from '../sandbox/workspace.js';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.vercel',
  'coverage',
  '.openrun',
]);

const DEFAULT_IGNORED_FILES = new Set(['.env', '.env.local']);

type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export type DirectoryEntry = {
  path: string;
  type: EntryType;
};

export async function listDirectory(
  workspace: SandboxWorkspace,
  input: { path?: string; depth?: number; maxEntries?: number },
): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  const root = workspace.resolvePath(input.path);
  const maxDepth = input.depth ?? 1;
  const maxEntries = input.maxEntries ?? 200;
  const entries: DirectoryEntry[] = [];

  await walkDirectory(workspace, root, 0, maxDepth, maxEntries, entries, true);

  return {
    entries,
    truncated: entries.length >= maxEntries,
  };
}

export async function readFile(
  workspace: SandboxWorkspace,
  input: { path: string; startLine?: number; endLine?: number; maxChars?: number },
): Promise<{
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}> {
  const resolved = workspace.resolvePath(input.path);
  const content = String(await workspace.fs.readFile(resolved, 'utf8'));
  const lines = content.split('\n');

  if (lines.at(-1) === '') {
    lines.pop();
  }
  const startLine = Math.max(input.startLine ?? 1, 1);
  const endLine = Math.min(input.endLine ?? lines.length, lines.length);
  const selected = lines.slice(startLine - 1, endLine);
  const numbered = selected
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
  const withTrailingNewline = numbered.length > 0 ? `${numbered}\n` : '';
  const maxChars = input.maxChars ?? 20_000;
  const truncated = withTrailingNewline.length > maxChars;

  return {
    path: workspace.relativePath(resolved),
    content: truncated ? withTrailingNewline.slice(0, maxChars) : withTrailingNewline,
    startLine,
    endLine,
    truncated,
  };
}

export async function writeFile(
  workspace: SandboxWorkspace,
  input: { path: string; content: string; overwrite?: boolean },
): Promise<{ path: string; bytesWritten: number }> {
  const resolved = workspace.resolvePath(input.path);

  if (input.overwrite === false && (await workspace.exists(resolved))) {
    throw new Error(`File already exists: ${input.path}`);
  }

  await workspace.fs.mkdir(path.dirname(resolved), { recursive: true });
  await workspace.fs.writeFile(resolved, input.content);

  return {
    path: workspace.relativePath(resolved),
    bytesWritten: Buffer.byteLength(input.content),
  };
}

export async function appendFile(
  workspace: SandboxWorkspace,
  input: { path: string; content: string },
): Promise<{ path: string; bytesWritten: number }> {
  const resolved = workspace.resolvePath(input.path);

  await workspace.fs.mkdir(path.dirname(resolved), { recursive: true });
  await workspace.fs.appendFile(resolved, input.content);

  return {
    path: workspace.relativePath(resolved),
    bytesWritten: Buffer.byteLength(input.content),
  };
}

export async function getFileInfo(
  workspace: SandboxWorkspace,
  input: { path: string; followSymlink?: boolean },
): Promise<{ path: string; exists: boolean; type?: EntryType; size?: number; mode?: number }> {
  const resolved = workspace.resolvePath(input.path);

  if (!(await workspace.exists(resolved))) {
    return { path: workspace.relativePath(resolved), exists: false };
  }

  const stat = input.followSymlink === false
    ? await workspace.fs.lstat(resolved)
    : await workspace.fs.stat(resolved);

  return {
    path: workspace.relativePath(resolved),
    exists: true,
    type: statToType(stat),
    size: stat.size,
    mode: stat.mode,
  };
}

export async function editFile(
  workspace: SandboxWorkspace,
  input: { path: string; oldText: string; newText: string },
): Promise<{ path: string; replacements: number }> {
  const resolved = workspace.resolvePath(input.path);
  const content = String(await workspace.fs.readFile(resolved, 'utf8'));
  const occurrences = countOccurrences(content, input.oldText);

  if (occurrences !== 1) {
    throw new Error(`oldText must match exactly once; matched ${occurrences} times`);
  }

  await workspace.fs.writeFile(resolved, content.replace(input.oldText, input.newText));

  return {
    path: workspace.relativePath(resolved),
    replacements: 1,
  };
}

export async function batchEditFile(
  workspace: SandboxWorkspace,
  input: { path: string; edits: Array<{ oldText: string; newText: string }> },
): Promise<{ path: string; replacements: number }> {
  const resolved = workspace.resolvePath(input.path);
  const original = String(await workspace.fs.readFile(resolved, 'utf8'));
  let proposed = original;

  for (const edit of input.edits) {
    const occurrences = countOccurrences(proposed, edit.oldText);

    if (occurrences !== 1) {
      throw new Error(`oldText must match exactly once; matched ${occurrences} times`);
    }

    proposed = proposed.replace(edit.oldText, edit.newText);
  }

  await workspace.fs.writeFile(resolved, proposed);

  return {
    path: workspace.relativePath(resolved),
    replacements: input.edits.length,
  };
}

export async function searchFiles(
  workspace: SandboxWorkspace,
  input: { path?: string; query?: string; glob?: string; maxResults?: number },
): Promise<{ matches: DirectoryEntry[]; truncated: boolean }> {
  const root = workspace.resolvePath(input.path);
  const maxResults = input.maxResults ?? 100;
  const matches: DirectoryEntry[] = [];
  const query = input.query?.toLowerCase();

  await walkAllFiles(workspace, root, maxResults, async (entry) => {
    if (query && !entry.path.toLowerCase().includes(query)) {
      return;
    }

    matches.push(entry);
  });

  return {
    matches,
    truncated: matches.length >= maxResults,
  };
}

export async function searchCode(
  workspace: SandboxWorkspace,
  input: {
    path?: string;
    query: string;
    caseSensitive?: boolean;
    maxResults?: number;
    maxCharsPerResult?: number;
  },
): Promise<{
  matches: Array<{ path: string; lineNumber: number; line: string }>;
  truncated: boolean;
}> {
  const root = workspace.resolvePath(input.path);
  const maxResults = input.maxResults ?? 100;
  const maxCharsPerResult = input.maxCharsPerResult ?? 500;
  const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();

  await walkAllFiles(workspace, root, maxResults, async (entry, absolutePath) => {
    if (matches.length >= maxResults || entry.type !== 'file') {
      return;
    }

    const text = String(await workspace.fs.readFile(absolutePath, 'utf8'));
    const lines = text.split('\n');

    lines.forEach((line, index) => {
      if (matches.length >= maxResults) {
        return;
      }

      const haystack = input.caseSensitive ? line : line.toLowerCase();

      if (haystack.includes(needle)) {
        matches.push({
          path: entry.path,
          lineNumber: index + 1,
          line: line.slice(0, maxCharsPerResult),
        });
      }
    });
  });

  return {
    matches,
    truncated: matches.length >= maxResults,
  };
}

async function walkDirectory(
  workspace: SandboxWorkspace,
  absolutePath: string,
  currentDepth: number,
  maxDepth: number,
  maxEntries: number,
  entries: DirectoryEntry[],
  skipIgnored: boolean,
): Promise<void> {
  if (entries.length >= maxEntries || currentDepth >= maxDepth) {
    return;
  }

  const dirents = await workspace.fs.readdir(absolutePath, { withFileTypes: true });

  for (const dirent of dirents as Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>) {
    if (entries.length >= maxEntries) {
      return;
    }

    if (skipIgnored && isIgnoredName(dirent.name, dirent.isDirectory())) {
      continue;
    }

    const child = path.join(absolutePath, dirent.name);
    const entry: DirectoryEntry = {
      path: workspace.relativePath(child),
      type: direntToType(dirent),
    };
    entries.push(entry);

    if (dirent.isDirectory()) {
      await walkDirectory(workspace, child, currentDepth + 1, maxDepth, maxEntries, entries, skipIgnored);
    }
  }
}

async function walkAllFiles(
  workspace: SandboxWorkspace,
  absoluteRoot: string,
  maxResults: number,
  onEntry: (entry: DirectoryEntry, absolutePath: string) => Promise<void>,
): Promise<void> {
  const entries: DirectoryEntry[] = [];
  await walkDirectory(workspace, absoluteRoot, 0, Number.MAX_SAFE_INTEGER, maxResults, entries, true);

  for (const entry of entries) {
    if (entries.length >= maxResults) {
      break;
    }

    await onEntry(entry, workspace.resolvePath(entry.path));
  }
}

function isIgnoredName(name: string, isDirectory: boolean): boolean {
  return isDirectory ? DEFAULT_IGNORED_DIRS.has(name) : DEFAULT_IGNORED_FILES.has(name);
}

function direntToType(dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

function statToType(stat: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function countOccurrences(content: string, search: string): number {
  if (search === '') {
    return 0;
  }

  let count = 0;
  let index = 0;

  while (true) {
    const found = content.indexOf(search, index);

    if (found === -1) {
      return count;
    }

    count += 1;
    index = found + search.length;
  }
}
