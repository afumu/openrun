import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

type DirentLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type StatsLike = {
  size: number;
  mode?: number;
  mtime?: Date;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export type WorkspaceFileSystem = {
  readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding }): Promise<string | Buffer>;
  writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void>;
  appendFile(path: string, data: string | Buffer | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | DirentLike[]>;
  stat(path: string): Promise<StatsLike>;
  lstat(path: string): Promise<StatsLike>;
  exists?(path: string): Promise<boolean>;
  realpath?(path: string): Promise<string>;
};

export type WorkspaceCommandResult = {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
};

export type RunWorkspaceCommandInput = {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
};

export type SandboxWorkspaceOptions = {
  workspaceRoot: string;
  fs: WorkspaceFileSystem;
  runSandboxCommand?: (input: RunWorkspaceCommandInput) => Promise<WorkspaceCommandResult>;
};

export class SandboxWorkspace {
  readonly workspaceRoot: string;
  readonly fs: WorkspaceFileSystem;
  private readonly runSandboxCommand?: (input: RunWorkspaceCommandInput) => Promise<WorkspaceCommandResult>;

  constructor(options: SandboxWorkspaceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.fs = options.fs;
    this.runSandboxCommand = options.runSandboxCommand;
  }

  static local(options: { workspaceRoot: string }): SandboxWorkspace {
    return new SandboxWorkspace({
      workspaceRoot: options.workspaceRoot,
      fs: createLocalFileSystem(),
    });
  }

  resolvePath(inputPath: string | undefined): string {
    const value = inputPath?.trim() || '.';
    const resolved = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(this.workspaceRoot, value);

    if (!isPathInside(this.workspaceRoot, resolved)) {
      throw new Error(`Path escapes workspace root: ${inputPath ?? ''}`);
    }

    return resolved;
  }

  relativePath(absolutePath: string): string {
    const relative = path.relative(this.workspaceRoot, absolutePath);
    return relative === '' ? '.' : normalizePathSeparators(relative);
  }

  async exists(inputPath: string): Promise<boolean> {
    const resolved = this.resolvePath(inputPath);

    if (this.fs.exists) {
      return this.fs.exists(resolved);
    }

    try {
      await this.fs.stat(resolved);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  async runCommand(input: RunWorkspaceCommandInput): Promise<WorkspaceCommandResult> {
    if (!this.runSandboxCommand) {
      throw new Error('Sandbox command runner is not configured');
    }

    return this.runSandboxCommand(input);
  }
}

function createLocalFileSystem(): WorkspaceFileSystem {
  return {
    async readFile(filePath, options) {
      return nodeFs.readFile(filePath, normalizeReadFileOptions(options));
    },
    async writeFile(filePath, data) {
      await nodeFs.mkdir(path.dirname(filePath), { recursive: true });
      await nodeFs.writeFile(filePath, data);
    },
    async appendFile(filePath, data) {
      await nodeFs.mkdir(path.dirname(filePath), { recursive: true });
      await nodeFs.appendFile(filePath, data);
    },
    mkdir: nodeFs.mkdir,
    readdir: nodeFs.readdir as WorkspaceFileSystem['readdir'],
    stat: nodeFs.stat,
    lstat: nodeFs.lstat,
    async exists(filePath) {
      try {
        await nodeFs.access(filePath);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return false;
        }

        throw error;
      }
    },
    realpath: nodeFs.realpath,
  };
}

function normalizeReadFileOptions(
  options: BufferEncoding | { encoding?: BufferEncoding } | undefined,
): BufferEncoding | { encoding?: BufferEncoding } | undefined {
  return options;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathSeparators(value: string): string {
  return value.split(path.sep).join('/');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
