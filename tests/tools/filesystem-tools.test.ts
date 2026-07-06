import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import {
  batchEditFile,
  editFile,
  listDirectory,
  readFile,
  searchCode,
  searchFiles,
  writeFile as writeWorkspaceFile,
} from '../../src/tools/filesystem.js';

describe('filesystem tools', () => {
  let root: string;
  let workspace: SandboxWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openrun-workspace-'));
    workspace = SandboxWorkspace.local({ workspaceRoot: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects paths that escape the workspace root', async () => {
    await expect(readFile(workspace, { path: '../secret.txt' })).rejects.toThrow(
      'Path escapes workspace root',
    );
    await expect(readFile(workspace, { path: '/etc/passwd' })).rejects.toThrow(
      'Path escapes workspace root',
    );
  });

  it('writes, reads, edits, and batch edits a file through sandbox.fs', async () => {
    await writeWorkspaceFile(workspace, {
      path: 'src/main.js',
      content: 'const name = "OpenRun";\nconsole.log(name);\n',
      overwrite: false,
    });

    await expect(
      writeWorkspaceFile(workspace, {
        path: 'src/main.js',
        content: 'nope',
        overwrite: false,
      }),
    ).rejects.toThrow('File already exists');

    expect(await readFile(workspace, { path: 'src/main.js', startLine: 2 })).toMatchObject({
      content: '2: console.log(name);\n',
      startLine: 2,
      endLine: 2,
      truncated: false,
    });

    await editFile(workspace, {
      path: 'src/main.js',
      oldText: 'OpenRun',
      newText: 'Sandbox',
    });
    await batchEditFile(workspace, {
      path: 'src/main.js',
      edits: [
        { oldText: 'const name', newText: 'const label' },
        { oldText: 'console.log(name)', newText: 'console.log(label)' },
      ],
    });

    expect(await readFile(workspace, { path: 'src/main.js' })).toMatchObject({
      content: '1: const label = "Sandbox";\n2: console.log(label);\n',
    });
  });

  it('fails edit operations before writing when a replacement is ambiguous', async () => {
    await writeWorkspaceFile(workspace, {
      path: 'repeat.txt',
      content: 'same\nsame\n',
    });

    await expect(
      editFile(workspace, {
        path: 'repeat.txt',
        oldText: 'same',
        newText: 'different',
      }),
    ).rejects.toThrow('must match exactly once');

    expect(await readFile(workspace, { path: 'repeat.txt' })).toMatchObject({
      content: '1: same\n2: same\n',
    });
  });

  it('lists files and searches code while skipping ignored paths', async () => {
    await writeFile(join(root, 'README.md'), 'hello openrun\n');
    await writeWorkspaceFile(workspace, {
      path: 'src/app.ts',
      content: 'export const tool = "read_file";\n',
    });
    await writeWorkspaceFile(workspace, {
      path: 'node_modules/pkg/index.js',
      content: 'read_file should be ignored\n',
    });
    await writeWorkspaceFile(workspace, {
      path: '.env',
      content: 'SECRET=read_file\n',
    });

    expect(await listDirectory(workspace, { path: '.', depth: 2 })).toMatchObject({
      entries: expect.arrayContaining([
        { path: 'README.md', type: 'file' },
        { path: 'src', type: 'directory' },
        { path: 'src/app.ts', type: 'file' },
      ]),
    });

    expect(await searchFiles(workspace, { query: 'app', maxResults: 10 })).toEqual({
      matches: [{ path: 'src/app.ts', type: 'file' }],
      truncated: false,
    });

    expect(await searchCode(workspace, { query: 'read_file', maxResults: 10 })).toEqual({
      matches: [
        {
          path: 'src/app.ts',
          lineNumber: 1,
          line: 'export const tool = "read_file";',
        },
      ],
      truncated: false,
    });
  });
});
