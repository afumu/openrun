export type CliArgs =
  | {
      command: 'list-sessions';
      workspaceName?: string;
    }
  | {
      command: 'run';
      prompt?: string;
      continueConversationId?: string;
      workspaceName?: string;
    };

export function parseCliArgs(argv: string[]): CliArgs {
  const remaining = [...argv];
  let workspaceName: string | undefined;
  let continueConversationId: string | undefined;
  let listSessions = false;
  const promptParts: string[] = [];

  while (remaining.length > 0) {
    const current = remaining.shift();

    if (current === undefined) {
      break;
    }

    if (current === '--list-sessions') {
      listSessions = true;
      continue;
    }

    if (current === '--workspace') {
      workspaceName = takeValue('--workspace', remaining);
      continue;
    }

    if (current === '--continue') {
      const next = remaining[0];

      if (next && !next.startsWith('--')) {
        continueConversationId = remaining.shift();
      } else {
        throw new Error('Missing conversation id for --continue. Run --list-sessions first.');
      }
      continue;
    }

    promptParts.push(current, ...remaining);
    break;
  }

  if (listSessions) {
    return {
      command: 'list-sessions',
      workspaceName,
    };
  }

  const prompt = promptParts.join(' ').trim() || undefined;

  return {
    command: 'run',
    prompt,
    continueConversationId,
    workspaceName,
  };
}

function takeValue(flag: string, remaining: string[]): string {
  const value = remaining.shift();

  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}
