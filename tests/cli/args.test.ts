import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('starts a new conversation when no arguments are provided', () => {
    expect(parseCliArgs([])).toEqual({
      command: 'run',
      prompt: undefined,
      continueConversationId: undefined,
      workspaceName: undefined,
    });
  });

  it('starts a new conversation with a prompt', () => {
    expect(parseCliArgs(['write', 'a', 'file'])).toEqual({
      command: 'run',
      prompt: 'write a file',
      continueConversationId: undefined,
      workspaceName: undefined,
    });
  });

  it('lists sessions', () => {
    expect(parseCliArgs(['--list-sessions'])).toEqual({
      command: 'list-sessions',
      workspaceName: undefined,
    });
  });

  it('continues a selected conversation and keeps the rest as prompt', () => {
    expect(parseCliArgs(['--continue', 'conv_123', 'run', 'tests'])).toEqual({
      command: 'run',
      prompt: 'run tests',
      continueConversationId: 'conv_123',
      workspaceName: undefined,
    });
  });

  it('requires a conversation id when continue is used', () => {
    expect(() => parseCliArgs(['--continue'])).toThrow(
      'Missing conversation id for --continue',
    );
  });

  it('parses workspace selection', () => {
    expect(parseCliArgs(['--workspace', 'feature-a', 'run', 'tests'])).toEqual({
      command: 'run',
      prompt: 'run tests',
      continueConversationId: undefined,
      workspaceName: 'feature-a',
    });
  });
});
