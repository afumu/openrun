# 持久化编码 Agent 运行时设计方案

**目标：**把当前 Vercel Sandbox 演示项目重构成一个可长期使用的编码 Agent 运行时。它需要能复用长期存在的 Vercel Sandbox 工作区，用本地 SQLite 保存会话历史，并允许 CLI 新建、检索、继续之前的会话。

**状态：**待审核设计稿。你确认之前，不进入开发实现。

## 一、背景

当前项目还是一个最小演示版本：

- Agent 入口文件直接命名为 DeepSeek Agent，但 DeepSeek 实际上只应该是一个可配置的模型供应商。
- 现在的 sandbox 工具把“写文件”和“执行命令”塞在一个粗粒度工具里，不适合后续做完整编码 Agent。
- 当前 sandbox 执行方式偏一次性，文件不适合作为长期工作区保存。
- CLI 运行过程不会保存消息历史、工具调用历史和 sandbox 元数据。

目标形态更接近一个 Agent 平台里的编码 Agent：它应该有稳定的工作区、独立的文件/搜索/编辑/命令工具，并且能保存本地历史，方便恢复和继续。

## 二、核心决策

### 1. 模型供应商不是 Agent

DeepSeek 是模型供应商，不是 Agent 身份。Agent 应该按能力命名，例如 `coding`。

运行时使用统一的模型客户端接口：

```ts
type ModelClient = {
  createMessage(input: {
    model: string;
    messages: AgentMessage[];
    tools: ToolDefinition[];
  }): Promise<ModelResponse>;
};
```

第一版实现一个 OpenAI 兼容客户端，用配置接入 DeepSeek：

```json
{
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseURL": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  }
}
```

这样后续要换 OpenAI、Qwen、Moonshot 或其他 OpenAI 兼容服务，只改 provider 配置，不改 Agent 结构。

### 2. 工作区默认长期存在

默认工作区模式应该是 `persistent`。CLI 退出时可以停止当前 VM session 来控制成本，但 Vercel Sandbox 的文件系统要通过 snapshot 保存下来，下次启动时继续使用。

默认 sandbox 行为：

```ts
{
  mode: 'persistent',
  sandboxName: 'openrun-default-workspace',
  persistent: true,
  keepLastSnapshots: { count: 1, deleteEvicted: true },
  snapshotExpiration: 0,
  stopOnExit: true
}
```

Vercel Sandbox 里要区分两个层级：

- `Sandbox`：长期存在的命名资源，保存配置和快照。
- `Session`：一次正在运行的 VM 实例。

CLI 应该创建或获取一个命名 sandbox，在当前 session 里工作，退出时停止 session。下次运行 CLI 时，通过同一个 sandbox name 恢复之前保存的文件系统。

### 3. SQLite 在本地保存会话索引和事件流

Vercel Sandbox 保存真实项目文件。本地 SQLite 保存 Agent 的会话索引、事件流和 workspace 元数据。SQLite 不是代码仓库，也不是完整文件快照；它的责任是让 CLI 能恢复上下文、列出历史会话、继续会话。

默认 SQLite 路径：

```txt
.openrun/openrun.sqlite
```

`.openrun/` 必须加入 `.gitignore`，避免把本地运行历史、工具输出或会话数据提交到仓库。

SQLite 保存这些信息：

- Conversation：用户可见的一次任务或会话。
- Conversation event：追加式事件流，包括 user、assistant、tool result、system、progress、summary。
- Sandbox workspace 元数据
- token、耗时、状态、错误等统计信息

SQLite 不保存这些信息：

- 真实 API key
- `.env` 文件内容
- 无限制的完整命令输出
- 传给命令的 secret env 值

工具输出写入 SQLite 前需要截断，避免数据库无限膨胀。

第一版不单独建 `sandbox_sessions` 和 `workspace_snapshots` 表。当前 Vercel runtime 的启动停止属于运行时临时状态；文件持久化只需要在 workspace 记录最后一次 snapshot id。

### 4. CLI 可以新建会话，也可以继续历史会话

CLI 启动时需要支持三种工作流：

1. 不带任何参数：默认进入一个新的会话。不要自动续接最近会话，避免上下文串台。
2. 带 prompt：使用默认 persistent sandbox 创建一个新的会话，并把 prompt 作为第一轮用户输入。
3. 显式选择已有 conversation，继续执行。

第一版可以先用命令行参数加一个最小输入循环，不必立刻做完整交互式 TUI：

```bash
npm run dev
npm run dev -- "fix the bug"
npm run dev -- --list-sessions
npm run dev -- --continue <conversation-id> "continue from here"
npm run dev -- --workspace openrun-default-workspace "run tests"
```

后续可以加入交互式选择：

```bash
npm run dev -- --continue
```

如果用户只传 `--continue`，没有传 conversation id，CLI 应该列出最近的 conversations，让用户选择一个继续。这个能力可以后续用一个小的 prompt 库实现，第一版可以先不做交互，只支持显式 `--continue <conversation-id>`。

关键默认值：

```txt
无参数 = 新建会话
带 prompt = 新建会话并执行第一轮
--continue <conversation-id> = 继续指定会话
--continue 不带 id = 后续版本进入历史选择器
```

### 5. 文件工具优先使用 `sandbox.fs`

Vercel 已经提供 `sandbox.fs`，它是一个接近 Node `fs/promises` 的文件系统 API。文件读写、目录读取、文件信息、移动、复制、删除这些能力都应该走 `sandbox.fs`，不要让模型拼 shell 命令来做。

文件工具映射：

```txt
list_directory       -> sandbox.fs.readdir()
read_file            -> sandbox.fs.readFile()
get_file_info        -> sandbox.fs.stat() / sandbox.fs.lstat() / sandbox.fs.exists()
write_file           -> sandbox.fs.writeFile()
append_file          -> sandbox.fs.appendFile()
edit_file            -> readFile + 精确替换 + writeFile
batch_edit_file      -> 读取一次 + 校验所有替换 + 写入一次
search_files         -> sandbox.fs.readdir() 递归遍历
search_code          -> sandbox.fs.readdir() + sandbox.fs.readFile()
```

命令工具映射：

```txt
run_command          -> sandbox.runCommand()
```

`run_command` 只负责执行真实进程，例如 `npm test`、`node script.js`、`python main.py`。它不应该作为读文件、写文件、编辑文件的主要方式。

## 三、目标目录结构

```txt
src/
  cli.ts

  config/
    load-local-env.ts
    agent-config.ts

  model/
    model-client.ts
    openai-compatible-client.ts

  agent/
    coding-agent.ts
    agent-loop.ts
    prompts.ts
    types.ts

  sandbox/
    sandbox-manager.ts
    vercel-sandbox-adapter.ts
    workspace.ts

  storage/
    sqlite-store.ts
    schema.ts
    migrations.ts

  tools/
    tool-registry.ts
    tool-types.ts
    filesystem/
      list-directory.ts
      read-file.ts
      get-file-info.ts
      write-file.ts
      append-file.ts
      edit-file.ts
      batch-edit-file.ts
      search-files.ts
      search-code.ts
    shell/
      run-command.ts

tests/
  agent/
  config/
  sandbox/
  storage/
  tools/
```

## 四、配置文件

在项目根目录新增 `agent.config.json`：

```json
{
  "defaultAgent": "coding",
  "storage": {
    "sqlitePath": ".openrun/openrun.sqlite"
  },
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseURL": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "agents": {
    "coding": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "maxToolSteps": 20,
      "tools": ["filesystem", "shell"],
      "workspace": "default"
    }
  },
  "workspaces": {
    "default": {
      "sandboxName": "openrun-default-workspace",
      "mode": "persistent",
      "runtime": "node24",
      "networkPolicy": "deny-all",
      "timeoutMs": 600000,
      "stopOnExit": true,
      "snapshotExpiration": 0,
      "keepLastSnapshots": {
        "count": 1,
        "deleteEvicted": true
      }
    }
  }
}
```

环境变量仍然从 `.env.local`、`.env` 或 shell export 读取。

## 五、SQLite 数据结构

### 1. 参考结论

这次不再把一次 CLI 执行直接建模成 `run`，也不在第一版里过度拆分 turn、step、tool call 表。本机 Claude Code 的会话存储更接近“会话索引 + 追加式事件日志”，这个模型更适合第一版。

本机 Claude Code 观察结果，只看字段结构，不读取具体对话内容：

```txt
~/.claude/projects/<project-key>/
  sessions-index.json
  <session-id>.jsonl
```

`sessions-index.json` 是项目级会话列表索引，结构大致是：

```txt
version
originalPath
entries[]
  sessionId
  fullPath
  fileMtime
  firstPrompt
  summary
  messageCount
  created
  modified
  gitBranch
  projectPath
  isSidechain
```

`<session-id>.jsonl` 是会话事件流，一行一个事件。常见字段是：

```txt
uuid
parentUuid
sessionId
type
timestamp
cwd
gitBranch
message
toolUseResult
```

常见事件类型：

```txt
user
assistant
system
progress
file-history-snapshot
```

`message.content` 里常见 block 类型：

```txt
text
thinking
tool_use
tool_result
```

它的核心思路是：

- 会话列表信息单独做轻量索引，方便快速展示历史会话。
- 会话正文用 append-only JSONL 保存，不为每一种事件提前建关系表。
- `parentUuid` 记录事件父子关系，文件顺序或序号记录事件发生顺序。
- 工具调用和工具结果也作为消息事件的一部分保存，先保证可恢复，再考虑后续统计索引。

对本项目的启发：

- SQLite 里用 `conversations` 代替 `sessions-index.json`。
- SQLite 里用 `conversation_events` 代替每个会话的 `.jsonl`。
- 第一版不要拆 `turns`、`agent_steps`、`tool_invocations`、`tool_results`。
- 第一版不要建 `sandbox_sessions`、`workspace_snapshots`。
- 如果以后确实需要更强的工具统计或分支，再从事件流派生索引表，而不是一开始就把 schema 做重。

同时参考 Cline、OpenAI Agents SDK、VS Code Chat Sessions 和 Microsoft Agent Framework 的会话设计后，建议保留下面的原则：

- Cline 把 task 当成自包含工作单元：保存完整对话、代码变更、命令执行、决策、token 成本，并支持中断后恢复。
- OpenAI Agents SDK 的 session 模型会在每次运行前加载历史，在运行后写入新的 user、assistant、tool call、tool result。
- VS Code Chat Sessions 把 session 作为用户可切换、可归档、可删除、可 fork 的对象。
- Microsoft Agent Framework 把 storage 的职责定义为：决定会话历史放在哪里、每次加载多少历史、是否能可靠恢复。

因此本项目第一版应该把 `conversation` 作为用户可见对象，把 `conversation_event` 作为可回放上下文账本。其他结构化表都先不做。

参考资料：

- [Cline Tasks](https://docs.cline.bot/core-workflows/task-management)
- [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-python/sessions/)
- [OpenAI Agents SDK Advanced SQLite Session](https://openai.github.io/openai-agents-python/sessions/advanced_sqlite_session/)
- [VS Code Chat Sessions](https://code.visualstudio.com/docs/chat/chat-sessions)
- [Microsoft Agent Framework Storage](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/storage)

### 2. 概念关系

```txt
workspace
  └─ conversation
      └─ conversation_event
```

解释：

- `workspace`：对应一个长期存在的 Vercel Sandbox 工作区。
- `conversation`：用户看到的一次任务或会话，比如“实现登录功能”。
- `conversation_event`：一条追加式事件，比如 user 输入、assistant 输出、工具结果、进度事件、summary。

### 3. 第一版数据库表

```sql
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
```

### 4. 表关联关系

第一版只有三张核心表，关系尽量保持简单：

```txt
sandbox_workspaces.id
  └─ conversations.workspace_id

conversations.id
  └─ conversation_events.conversation_id

conversation_events.id
  └─ conversation_events.parent_event_id
```

关系说明：

| 关系 | 类型 | 含义 |
| --- | --- | --- |
| `sandbox_workspaces.id -> conversations.workspace_id` | 一对多 | 一个长期 Vercel Sandbox 工作区可以承载多个 conversation。真实文件放在 workspace，聊天历史放在 conversation。 |
| `conversations.id -> conversation_events.conversation_id` | 一对多 | 一个 conversation 下面有一串按 `sequence_number` 排序的事件。恢复上下文时主要读取这条事件流。 |
| `conversation_events.id -> conversation_events.parent_event_id` | 自关联 | 可选父事件。比如某条 `tool_result` 可以指向触发它的 assistant event；某条 progress 可以指向正在执行的工具事件。第一版恢复上下文不依赖它，只用它辅助调试。 |
| `conversations.last_event_id -> conversation_events.id` | 逻辑关联 | 指向当前会话最后一条事件，用于快速展示和更新。第一版可以不声明外键，避免写入顺序上的循环依赖。 |
| `sandbox_workspaces.last_snapshot_id` | 外部关联 | 指向 Vercel 侧的最后一次 snapshot id，不在本地单独建 `workspace_snapshots` 表。 |

读取历史会话列表时：

```sql
SELECT *
FROM conversations
ORDER BY updated_at DESC;
```

恢复某个会话上下文时：

```sql
SELECT *
FROM conversation_events
WHERE conversation_id = ?
ORDER BY sequence_number ASC;
```

查某个会话里跑过哪些工具时：

```sql
SELECT *
FROM conversation_events
WHERE conversation_id = ?
  AND event_type = 'tool_result'
ORDER BY sequence_number ASC;
```

### 5. 字段说明

#### `sandbox_workspaces`

这张表记录本地项目和 Vercel Sandbox 长期工作区之间的绑定关系。

| 字段 | 含义 |
| --- | --- |
| `id` | 本地 workspace id，例如 `ws_xxx`。作为 SQLite 内部主键使用。 |
| `name` | 本地配置里的 workspace 名称，例如 `default` 或 `openrun-main`。要求唯一。 |
| `sandbox_name` | Vercel Sandbox 的命名资源名称。CLI 下次启动时用它恢复同一个远端工作区。 |
| `vercel_sandbox_id` | Vercel 返回的 sandbox id。如果 SDK 只依赖 name，也可以为空。 |
| `mode` | 工作区模式，例如 `persistent` 或 `ephemeral`。第一版默认使用 `persistent`。 |
| `runtime` | Vercel Sandbox runtime，例如 `node24`。 |
| `network_policy_json` | 网络策略 JSON 字符串，例如是否允许外网访问。 |
| `persistent` | 是否持久化，SQLite 里用 `1` / `0` 表示布尔值。 |
| `snapshot_expiration` | Vercel snapshot 过期策略。`0` 表示按配置长期保留。 |
| `last_snapshot_id` | Vercel 侧最后一次 snapshot id。第一版只保存最后一个，不单独建 snapshot 历史表。 |
| `created_at` | 本地记录创建时间，使用 ISO 字符串。 |
| `updated_at` | 本地记录最后更新时间，使用 ISO 字符串。 |

#### `conversations`

这张表相当于 Claude Code 的 `sessions-index.json`，用于快速列出、搜索、继续会话。

| 字段 | 含义 |
| --- | --- |
| `id` | conversation id，例如 `conv_xxx`。用户执行 `--continue <conversation-id>` 时使用它。 |
| `workspace_id` | 所属 workspace，外键指向 `sandbox_workspaces.id`。 |
| `title` | 会话标题。可以由第一条 prompt 截断生成，后续也可以让模型生成更好的标题。 |
| `status` | 会话状态：`active`、`completed`、`failed`、`cancelled`、`archived`。 |
| `agent_name` | Agent 名称，例如 `coding`。不要写成模型供应商名。 |
| `provider_name` | 模型供应商名称，例如 `deepseek`。 |
| `model` | 实际使用的模型，例如 `deepseek-v4-flash`。 |
| `first_prompt` | 第一条用户输入。用于列表预览和快速理解会话主题，可以按长度截断保存。 |
| `summary` | 会话摘要。第一版可以为空；后续长会话压缩时写入。 |
| `message_count` | 列表展示用计数。推荐统计 `user`、`assistant`、`tool_result`、`summary` 这些上下文事件，不统计纯 `progress`。 |
| `last_event_id` | 最后一条事件 id。用于快速定位最新状态，是逻辑关联。 |
| `usage_json` | 会话累计 token、耗时、成本等统计信息，例如 `{ "inputTokens": 1000, "outputTokens": 300 }`。 |
| `metadata_json` | 扩展信息 JSON，例如 CLI 参数、本地项目路径 key、当前 git branch 等。 |
| `created_at` | 会话创建时间。 |
| `updated_at` | 会话最后更新时间。列历史会话时按它倒序。 |
| `completed_at` | 会话完成时间。未完成时为空。 |
| `archived_at` | 会话归档时间。未归档时为空。 |

#### `conversation_events`

这张表相当于 Claude Code 的 `<session-id>.jsonl`，是一条 append-only 事件流。恢复上下文时，以它为准。

| 字段 | 含义 |
| --- | --- |
| `id` | event id，例如 `evt_xxx`。 |
| `conversation_id` | 所属会话，外键指向 `conversations.id`。 |
| `parent_event_id` | 父事件 id，可为空。用于表示事件之间的因果关系，不影响按顺序恢复上下文。 |
| `sequence_number` | 会话内递增序号，从 1 开始。恢复上下文时按它排序。 |
| `event_type` | 事件类型，例如 `user`、`assistant`、`tool_result`、`system`、`progress`、`summary`。 |
| `role` | 转成模型消息时使用的角色，例如 `user`、`assistant`、`system`、`tool`。不是所有事件都需要 role。 |
| `model` | 产生该事件的模型。通常 assistant event 会记录。 |
| `provider_message_id` | 模型供应商返回的 message id 或 response id，用于排查问题。 |
| `tool_call_id` | 工具调用 id。`tool_result` event 用它对应 assistant event 里的 tool use block。 |
| `tool_name` | 工具名称，例如 `read_file`、`edit_file`、`run_command`。主要用于搜索和调试。 |
| `is_error` | 事件是否表示错误。SQLite 里用 `1` / `0`。 |
| `content_text` | 文本预览或规范化文本。列表展示、搜索时用；大内容可以截断。 |
| `event_json` | 原始事件 JSON。保存 provider message、tool result、stdout/stderr 摘要等完整结构。大型输出仍要按存储限制截断。 |
| `usage_json` | 单条事件的 token 或耗时统计。通常 assistant event 或 tool_result event 会有。 |
| `cwd` | 事件发生时的工作目录。 |
| `git_branch` | 事件发生时的 git 分支。 |
| `created_at` | 事件创建时间。 |

事件写入例子：

```txt
用户输入
  event_type: user
  role: user
  content_text: 用户输入内容
  event_json: 原始 user message

模型回复并请求工具
  event_type: assistant
  role: assistant
  event_json: assistant message，里面可以包含 text 和 tool_use blocks

工具执行结果
  event_type: tool_result
  role: tool
  tool_call_id: 对应 assistant tool_use block 的 id
  tool_name: run_command
  content_text: 工具结果摘要
  event_json: 工具结果、stdout、stderr、截断信息
```

#### 索引

| 索引 | 用途 |
| --- | --- |
| `idx_conversations_updated_at` | 支持 `--list-sessions` 按最近更新时间倒序列出会话。 |
| `idx_conversation_events_order` | 支持恢复上下文时按 `sequence_number` 快速读取事件流。 |
| `idx_conversation_events_parent` | 支持按父事件查看关联事件，例如某个 assistant event 触发了哪些结果。 |
| `idx_conversation_events_tool` | 支持按工具名查询某个会话里执行过的工具。 |

### 6. 状态枚举

Conversation 状态：

```txt
active
completed
failed
cancelled
archived
```

Conversation event 类型：

```txt
system
user
assistant
tool_result
progress
summary
```

说明：第一版可以不单独保存 `tool_use` 事件。模型返回的 tool use block 保存在 assistant event 的 `event_json` 里；工具执行完成后，再追加一条 `tool_result` event。

## 六、CLI 启动流程

### 1. 无参数启动：默认新建会话

```txt
1. 加载 .env.local 和 .env。
2. 加载 agent.config.json。
3. 打开 SQLite，并执行 migrations。
4. 解析当前选择的 agent 和 workspace。
5. SandboxManager 调用 Sandbox.getOrCreate({ name, persistent: true })。
6. 创建 conversation，状态为 active。
7. 进入最小交互式输入循环，等待用户输入第一条 prompt。
8. 用户输入后写入一条 user 类型 conversation_event，并启动 agent loop。
9. 如果用户直接退出，推荐删除空 conversation，避免历史列表噪声。
10. 如果 stopOnExit 为 true，停止当前 Vercel runtime。
```

### 2. 带 prompt 启动：新建会话并执行

和无参数启动相同，但第 7 步不进入等待，而是直接把命令行 prompt 写成第一条 user event。

```bash
npm run dev -- "fix the bug"
```

执行结果：

```txt
conversation: conv_xxx
event: evt_xxx
```

### 3. 继续已有会话

```txt
1. 加载 SQLite。
2. 找到用户指定的 conversations 记录。
3. 加载关联 workspace 和 sandbox_name。
4. 使用 Sandbox.getOrCreate({ name, persistent: true }) 获取或恢复 sandbox。
5. 从 conversation_events 按 sequence_number 恢复上下文。
6. 如果命令里带了新 prompt，则追加 user event 并执行。
7. 如果命令里没有新 prompt，则进入最小交互式输入循环。
8. 新增内容全部追加到同一个 conversation 的 conversation_events。
9. 如果 stopOnExit 为 true，停止当前 Vercel runtime。
```

第一版不再使用“继续写入同一条执行记录”的设计。继续历史会话时，应该保持同一个 `conversation_id`，并继续向它的事件流追加记录。

### 4. 列出和选择历史会话

第一版：

```bash
npm run dev -- --list-sessions
npm run dev -- --continue <conversation-id> "run the tests again"
```

后续版本：

```bash
npm run dev -- --continue
```

当 `--continue` 不带 id 时，CLI 可以按 `conversations.updated_at DESC` 列出最近会话，并显示：

```txt
conversation id
title
status
workspace
last updated
last user prompt preview
token usage
```

## 七、Agent 循环

编码 Agent 的循环逻辑：

```txt
events = 从 conversation_events 按 sequence_number 恢复历史
model_messages = system prompt + events 投影出来的 user/assistant/tool_result 消息

for step in 1..maxToolSteps:
  response = model.createMessage(model_messages, tools)
  将完整 assistant response 保存为 assistant 类型 conversation_event

  if response 是最终回答:
    更新 conversation.updated_at
    更新 conversations.message_count / usage_json / last_event_id
    返回最终回答

  for each tool call:
    执行 tool
    保存 tool_result 类型 conversation_event
    将 tool_result 追加进下一轮 model_messages

如果超过 maxToolSteps:
  标记 conversation 为 failed
```

`conversation_events` 是恢复上下文的唯一账本。工具调用和工具结果都先存在事件流里；如果后续要做复杂报表，再从事件流派生索引表。

上下文压缩第一版可以先不做；后续当 conversation 变长时，可以新增 `summary` 类型的 `conversation_event`，并在恢复上下文时只加载 summary 加最近 N 条事件。

默认限制：

```txt
maxToolSteps: 20
maxOutputCharsPerTool: 20000
commandTimeoutMs: 120000
sandboxTimeoutMs: 600000
```

## 八、工具定义

### `read_file`

```ts
{
  path: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}
```

读取文件内容。返回结果应该带行号，支持按行读取，避免一次性塞入过多上下文。

### `list_directory`

```ts
{
  path?: string;
  depth?: number;
  maxEntries?: number;
}
```

列出目录和文件，返回基础类型信息。

### `get_file_info`

```ts
{
  path: string;
  followSymlink?: boolean;
}
```

返回文件是否存在、类型、大小、时间戳和权限等信息。

### `write_file`

```ts
{
  path: string;
  content: string;
  overwrite?: boolean;
}
```

写入文件。若 `overwrite` 为 false 且文件已存在，则工具失败。

### `append_file`

```ts
{
  path: string;
  content: string;
}
```

向文件追加文本。文件不存在时可以创建。

### `edit_file`

```ts
{
  path: string;
  oldText: string;
  newText: string;
}
```

对文件做精确替换。`oldText` 必须只匹配一次：

```txt
匹配 0 次：失败
匹配 1 次：替换并写回
匹配多次：失败
```

### `batch_edit_file`

```ts
{
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}
```

批量精确替换。必须先校验所有 edit 都能唯一匹配，全部通过后再一次性写回。任何一个 edit 校验失败，都不能产生部分写入。

### `search_files`

```ts
{
  path?: string;
  query?: string;
  glob?: string;
  maxResults?: number;
}
```

搜索文件名和路径，默认跳过噪声目录。

### `search_code`

```ts
{
  path?: string;
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
  maxCharsPerResult?: number;
}
```

搜索文本文件内容。第一版使用 `sandbox.fs` 递归读取和匹配，后续再考虑 `rg`/`grep` shell backend。

### `run_command`

```ts
{
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputChars?: number;
}
```

使用 `sandbox.runCommand()` 执行命令。它只负责执行进程，不负责写文件。

## 九、路径安全

所有文件系统工具都必须经过 `SandboxWorkspace`。

规则：

```txt
workspaceRoot = /vercel/sandbox
拒绝空 path
相对路径解析到 workspaceRoot 下
绝对路径必须仍然位于 workspaceRoot 下
拒绝通过 .. 跳出 workspace
已有路径尽量用 realpath 检查 symlink escape
新建文件时校验父目录
```

第一版不允许工具操作 `/vercel/sandbox` 之外的路径。

## 十、搜索默认规则

默认忽略目录：

```txt
node_modules
.git
dist
.next
.vercel
coverage
.openrun
```

默认忽略文件：

```txt
.env
.env.local
```

Agent 默认不应该读取本地 secret 文件。以后如果要开放，需要引入显式权限配置。

## 十一、存储安全

SQLite 输出限制：

```txt
max stored stdout: 20000 chars
max stored stderr: 20000 chars
max stored result_json: 20000 chars
```

当输出被截断时，保存元数据：

```json
{
  "truncated": true,
  "originalLength": 123456
}
```

CLI 当前运行可以打印完整输出，但数据库里只保存有边界的输出。

## 十二、用户可见 CLI 命令

第一版命令：

```bash
npm run dev
npm run dev -- "implement a small script"
npm run dev -- --list-sessions
npm run dev -- --continue <conversation-id> "continue the previous work"
npm run dev -- --workspace openrun-default-workspace "run tests"
```

命令语义：

```txt
npm run dev
  默认创建新 conversation，并进入最小交互式输入循环。

npm run dev -- "prompt"
  创建新 conversation，并把 prompt 作为第一条 user event。

npm run dev -- --continue <conversation-id> "prompt"
  在指定 conversation 里追加一条 user event。
```

后续命令：

```bash
npm run dev -- --continue
npm run dev -- --list-workspaces
npm run dev -- --new-workspace my-feature
npm run dev -- --keep-alive "start dev server"
```

## 十三、测试策略

必须覆盖这些测试：

```txt
配置能正确加载默认 provider、agent 和 workspace
SQLite migrations 能创建预期表结构
无参数 CLI 会默认创建新 conversation
带 prompt CLI 会创建新 conversation 和第一条 user event
continue 模式会在同一个 conversation 下追加 event
conversation_events 会按 sequence_number 保存 user、assistant、tool result、summary
恢复上下文时只依赖 conversation_events
工具输出会作为 tool_result event 保存并截断
SandboxManager 默认使用 persistent true
SandboxManager 在配置要求时会停止当前 Vercel runtime
workspace 会拒绝 ../ 路径逃逸
workspace 会拒绝 /vercel/sandbox 之外的绝对路径
read_file 能返回带行号的片段
write_file 会尊重 overwrite=false
edit_file 在 oldText 匹配 0 次时失败
edit_file 在 oldText 匹配多次时失败
batch_edit_file 校验失败时不会部分写入
search_files 会跳过默认忽略目录
search_code 会跳过 .env 文件
run_command 会截断存储输出
agent loop 能处理多轮 tool calls
agent loop 超过 maxToolSteps 后会失败
```

## 十四、审核通过后的实现顺序

1. 增加 `agent.config.json` 配置加载器。
2. 增加 SQLite 存储层、schema 和 migrations。
3. 增加通用 `ModelClient` 和 OpenAI 兼容实现。
4. 把 DeepSeek-specific Agent 命名改成 `coding-agent`。
5. 增加默认 persistent 的 `SandboxManager`。
6. 增加基于 `sandbox.fs` 的 `SandboxWorkspace`。
7. 增加 `ToolRegistry` 和文件系统工具。
8. 增加 shell 类 `run_command` 工具。
9. 增加带 event-log storage hooks 的多步 agent loop。
10. 增加 CLI 参数：默认新建会话、列出 sessions、继续 conversation、选择 workspace。
11. 更新 README。

## 十五、第一版不做的范围

第一版不包含：

```txt
Web UI
GitHub PR 创建
多 Agent 协作
Vercel Drive beta
Preview server 生命周期 UI
远程托管 SQLite
团队共享
精致交互式 TUI
```

## 十六、待审核问题

1. 无参数启动后，是立刻创建 conversation 并进入最小交互式输入循环，还是等用户输入第一条 prompt 后再落库？推荐先创建，退出时删除空 conversation。
2. `--continue` 不带 id 时，第一版是直接报错，还是就实现一个简单的历史选择器？推荐第一版先报错并提示 `--list-sessions`。
3. 第一版是否需要事件搜索索引？推荐先不做，后续用 SQLite FTS 或派生表补上。
4. 默认 workspace name 应该是全局固定的 `openrun-default-workspace`，还是根据当前项目目录生成，避免多个项目冲突？
5. SQLite 路径是否只使用 `.openrun/openrun.sqlite`，还是允许 `OPENRUN_SQLITE_PATH` 覆盖？

推荐默认值：

```txt
无参数启动先创建新 conversation，退出时删除空 conversation
--continue 不带 id 第一版先报错并提示 --list-sessions
第一版不建 branch/fork 表，也不建工具统计派生表
默认 workspace name 根据项目目录生成，避免冲突
允许 OPENRUN_SQLITE_PATH 覆盖 SQLite 路径
```
