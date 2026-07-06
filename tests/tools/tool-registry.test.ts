import { describe, expect, it } from 'vitest';

import { SandboxWorkspace } from '../../src/sandbox/workspace.js';
import { createToolRegistry } from '../../src/tools/tool-registry.js';

describe('createToolRegistry', () => {
  it('registers the preview startup tool', () => {
    const workspace = SandboxWorkspace.local({ workspaceRoot: process.cwd() });
    const registry = createToolRegistry(workspace);

    expect(registry.definitions.map((definition) => definition.function.name)).toContain(
      'start_preview',
    );
  });
});
