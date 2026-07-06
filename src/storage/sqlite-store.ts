import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';

export type WorkspaceRecord = {
  id: string;
  name: string;
  sandboxName: string;
  vercelSandboxId: string | null;
  mode: string;
  runtime: string;
  networkPolicyJson: string;
  persistent: boolean;
  snapshotExpiration: number | null;
  lastSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UpsertWorkspaceInput = {
  name: string;
  sandboxName: string;
  vercelSandboxId?: string | null;
  mode: string;
  runtime: string;
  networkPolicyJson: string;
  persistent: boolean;
  snapshotExpiration?: number | null;
  lastSnapshotId?: string | null;
};

export type ConversationRecord = {
  id: string;
  workspaceId: string;
  title: string | null;
  status: string;
  agentName: string;
  providerName: string;
  model: string;
  firstPrompt: string | null;
  summary: string | null;
  messageCount: number;
  lastEventId: string | null;
  usageJson: unknown | null;
  metadataJson: unknown | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
};

export type CreateConversationInput = {
  workspaceId: string;
  agentName: string;
  providerName: string;
  model: string;
  firstPrompt?: string | null;
  title?: string | null;
  metadataJson?: unknown;
};

export type ConversationEventRecord = {
  id: string;
  conversationId: string;
  parentEventId: string | null;
  sequenceNumber: number;
  eventType: string;
  role: string | null;
  model: string | null;
  providerMessageId: string | null;
  toolCallId: string | null;
  toolName: string | null;
  isError: boolean;
  contentText: string | null;
  eventJson: unknown;
  usageJson: unknown | null;
  cwd: string | null;
  gitBranch: string | null;
  createdAt: string;
};

export type AppendEventInput = {
  conversationId: string;
  parentEventId?: string | null;
  eventType: string;
  role?: string | null;
  model?: string | null;
  providerMessageId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  isError?: boolean;
  contentText?: string | null;
  eventJson: unknown;
  usageJson?: unknown;
  cwd?: string | null;
  gitBranch?: string | null;
};

type TableRow = {
  name: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  sandbox_name: string;
  vercel_sandbox_id: string | null;
  mode: string;
  runtime: string;
  network_policy_json: string;
  persistent: number;
  snapshot_expiration: number | null;
  last_snapshot_id: string | null;
  created_at: string;
  updated_at: string;
};

type ConversationRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  status: string;
  agent_name: string;
  provider_name: string;
  model: string;
  first_prompt: string | null;
  summary: string | null;
  message_count: number;
  last_event_id: string | null;
  usage_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
};

type ConversationEventRow = {
  id: string;
  conversation_id: string;
  parent_event_id: string | null;
  sequence_number: number;
  event_type: string;
  role: string | null;
  model: string | null;
  provider_message_id: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: number;
  content_text: string | null;
  event_json: string;
  usage_json: string | null;
  cwd: string | null;
  git_branch: string | null;
  created_at: string;
};

export class SqliteStore {
  private readonly db: Database;
  private readonly path: string;

  private constructor(path: string, db: Database) {
    this.path = path;
    this.db = db;
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  static async open(path: string): Promise<SqliteStore> {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }

    const SQL = await initSqlJs();
    const data = path !== ':memory:' && existsSync(path) ? readFileSync(path) : undefined;
    return new SqliteStore(path, data ? new SQL.Database(data) : new SQL.Database());
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        sandbox_name TEXT NOT NULL UNIQUE,
        vercel_sandbox_id TEXT,
        mode TEXT NOT NULL,
        runtime TEXT NOT NULL,
        network_policy_json TEXT NOT NULL,
        persistent INTEGER NOT NULL,
        snapshot_expiration INTEGER,
        last_snapshot_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        model TEXT NOT NULL,
        first_prompt TEXT,
        summary TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_event_id TEXT,
        usage_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        archived_at TEXT,
        FOREIGN KEY (workspace_id) REFERENCES sandbox_workspaces(id)
      );

      CREATE TABLE IF NOT EXISTS conversation_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        parent_event_id TEXT,
        sequence_number INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        role TEXT,
        model TEXT,
        provider_message_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        content_text TEXT,
        event_json TEXT NOT NULL,
        usage_json TEXT,
        cwd TEXT,
        git_branch TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id),
        FOREIGN KEY (parent_event_id) REFERENCES conversation_events(id),
        UNIQUE (conversation_id, sequence_number)
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
        ON conversations(updated_at);

      CREATE INDEX IF NOT EXISTS idx_conversation_events_order
        ON conversation_events(conversation_id, sequence_number);

      CREATE INDEX IF NOT EXISTS idx_conversation_events_parent
        ON conversation_events(conversation_id, parent_event_id);

      CREATE INDEX IF NOT EXISTS idx_conversation_events_tool
        ON conversation_events(conversation_id, tool_name);
    `);
    this.save();
  }

  close(): void {
    this.save();
    this.db.close();
  }

  listTables(): string[] {
    return this.all<TableRow>(
      `
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
      `,
    ).map((row) => row.name);
  }

  upsertWorkspace(input: UpsertWorkspaceInput): WorkspaceRecord {
    const now = new Date().toISOString();
    const existing = this.get<WorkspaceRow>(
      'SELECT * FROM sandbox_workspaces WHERE name = ?',
      [input.name],
    );

    if (existing) {
      this.run(
        `
          UPDATE sandbox_workspaces
          SET sandbox_name = ?,
              vercel_sandbox_id = ?,
              mode = ?,
              runtime = ?,
              network_policy_json = ?,
              persistent = ?,
              snapshot_expiration = ?,
              last_snapshot_id = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [
          input.sandboxName,
          input.vercelSandboxId ?? null,
          input.mode,
          input.runtime,
          input.networkPolicyJson,
          input.persistent ? 1 : 0,
          input.snapshotExpiration ?? null,
          input.lastSnapshotId ?? null,
          now,
          existing.id,
        ],
      );

      return this.getWorkspaceById(existing.id);
    }

    const id = createId('ws');
    this.run(
      `
        INSERT INTO sandbox_workspaces (
          id,
          name,
          sandbox_name,
          vercel_sandbox_id,
          mode,
          runtime,
          network_policy_json,
          persistent,
          snapshot_expiration,
          last_snapshot_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.name,
        input.sandboxName,
        input.vercelSandboxId ?? null,
        input.mode,
        input.runtime,
        input.networkPolicyJson,
        input.persistent ? 1 : 0,
        input.snapshotExpiration ?? null,
        input.lastSnapshotId ?? null,
        now,
        now,
      ],
    );

    return this.getWorkspaceById(id);
  }

  createConversation(input: CreateConversationInput): ConversationRecord {
    const now = new Date().toISOString();
    const id = createId('conv');

    this.run(
      `
        INSERT INTO conversations (
          id,
          workspace_id,
          title,
          status,
          agent_name,
          provider_name,
          model,
          first_prompt,
          summary,
          message_count,
          last_event_id,
          usage_json,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.workspaceId,
        input.title ?? makeTitle(input.firstPrompt),
        'active',
        input.agentName,
        input.providerName,
        input.model,
        input.firstPrompt ?? null,
        null,
        0,
        null,
        null,
        stringifyOptionalJson(input.metadataJson),
        now,
        now,
      ],
    );

    return this.getConversationById(id);
  }

  appendEvent(input: AppendEventInput): ConversationEventRecord {
    const now = new Date().toISOString();
    const id = createId('evt');
    const sequenceNumber = this.nextSequenceNumber(input.conversationId);

    this.run(
      `
        INSERT INTO conversation_events (
          id,
          conversation_id,
          parent_event_id,
          sequence_number,
          event_type,
          role,
          model,
          provider_message_id,
          tool_call_id,
          tool_name,
          is_error,
          content_text,
          event_json,
          usage_json,
          cwd,
          git_branch,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.conversationId,
        input.parentEventId ?? null,
        sequenceNumber,
        input.eventType,
        input.role ?? null,
        input.model ?? null,
        input.providerMessageId ?? null,
        input.toolCallId ?? null,
        input.toolName ?? null,
        input.isError ? 1 : 0,
        input.contentText ?? null,
        JSON.stringify(input.eventJson),
        stringifyOptionalJson(input.usageJson),
        input.cwd ?? null,
        input.gitBranch ?? null,
        now,
      ],
    );

    this.run(
      `
        UPDATE conversations
        SET message_count = message_count + ?,
            last_event_id = ?,
            updated_at = ?
        WHERE id = ?
      `,
      [shouldCountMessage(input.eventType) ? 1 : 0, id, now, input.conversationId],
    );

    return this.getEventById(id);
  }

  listEvents(conversationId: string): ConversationEventRecord[] {
    return this.all<ConversationEventRow>(
      `
        SELECT *
        FROM conversation_events
        WHERE conversation_id = ?
        ORDER BY sequence_number ASC
      `,
      [conversationId],
    ).map((row) => mapEventRow(row));
  }

  listConversations(): ConversationRecord[] {
    return this.all<ConversationRow>(
      `
        SELECT *
        FROM conversations
        ORDER BY updated_at DESC
      `,
    ).map((row) => mapConversationRow(row));
  }

  getConversationById(id: string): ConversationRecord {
    const row = this.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);

    if (!row) {
      throw new Error(`Conversation not found: ${id}`);
    }

    return mapConversationRow(row);
  }

  getWorkspaceById(id: string): WorkspaceRecord {
    const row = this.get<WorkspaceRow>('SELECT * FROM sandbox_workspaces WHERE id = ?', [id]);

    if (!row) {
      throw new Error(`Workspace not found: ${id}`);
    }

    return mapWorkspaceRow(row);
  }

  getWorkspaceByName(name: string): WorkspaceRecord | undefined {
    const row = this.get<WorkspaceRow>(
      'SELECT * FROM sandbox_workspaces WHERE name = ?',
      [name],
    );

    return row ? mapWorkspaceRow(row) : undefined;
  }

  private getEventById(id: string): ConversationEventRecord {
    const row = this.get<ConversationEventRow>(
      'SELECT * FROM conversation_events WHERE id = ?',
      [id],
    );

    if (!row) {
      throw new Error(`Conversation event not found: ${id}`);
    }

    return mapEventRow(row);
  }

  private nextSequenceNumber(conversationId: string): number {
    const row = this.get<{ next_sequence_number: number }>(
      `
        SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence_number
        FROM conversation_events
        WHERE conversation_id = ?
      `,
      [conversationId],
    );

    return row?.next_sequence_number ?? 1;
  }

  private run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
    this.save();
  }

  private get<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | undefined {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);
      return statement.step() ? (statement.getAsObject() as T) : undefined;
    } finally {
      statement.free();
    }
  }

  private all<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.db.prepare(sql);
    const rows: T[] = [];

    try {
      statement.bind(params);

      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }

      return rows;
    } finally {
      statement.free();
    }
  }

  private save(): void {
    if (this.path === ':memory:') {
      return;
    }

    writeFileSync(this.path, Buffer.from(this.db.export()));
  }
}

function mapWorkspaceRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    sandboxName: row.sandbox_name,
    vercelSandboxId: row.vercel_sandbox_id,
    mode: row.mode,
    runtime: row.runtime,
    networkPolicyJson: row.network_policy_json,
    persistent: row.persistent === 1,
    snapshotExpiration: row.snapshot_expiration,
    lastSnapshotId: row.last_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status,
    agentName: row.agent_name,
    providerName: row.provider_name,
    model: row.model,
    firstPrompt: row.first_prompt,
    summary: row.summary,
    messageCount: row.message_count,
    lastEventId: row.last_event_id,
    usageJson: parseOptionalJson(row.usage_json),
    metadataJson: parseOptionalJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
  };
}

function mapEventRow(row: ConversationEventRow): ConversationEventRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentEventId: row.parent_event_id,
    sequenceNumber: row.sequence_number,
    eventType: row.event_type,
    role: row.role,
    model: row.model,
    providerMessageId: row.provider_message_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    isError: row.is_error === 1,
    contentText: row.content_text,
    eventJson: JSON.parse(row.event_json) as unknown,
    usageJson: parseOptionalJson(row.usage_json),
    cwd: row.cwd,
    gitBranch: row.git_branch,
    createdAt: row.created_at,
  };
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function makeTitle(prompt: string | null | undefined): string | null {
  if (!prompt) {
    return null;
  }

  return prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
}

function stringifyOptionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseOptionalJson(value: string | null): unknown | null {
  return value === null ? null : (JSON.parse(value) as unknown);
}

function shouldCountMessage(eventType: string): boolean {
  return eventType !== 'progress';
}
