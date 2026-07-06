# OpenRun Vercel Sandbox Coding Agent

OpenRun 是一个最小可运行的 Vercel Sandbox Coding Agent。模型供应商通过 OpenAI-compatible 接口配置，Agent 本身叫 `coding`，执行代码时使用长期存在的 Vercel Sandbox 工作区，并把会话历史写入本地 SQLite。

## 1. Install

```bash
npm install
```

## 2. Configure Environment

不要把真实 key 写进仓库。推荐用本地 `.env.local` 管理，CLI 会自动读取 `.env.local` 和 `.env`：

```dotenv
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

Vercel Sandbox 鉴权二选一：

```bash
vercel link
vercel env pull
```

或者在外部服务器上使用 access token：

```dotenv
VERCEL_TEAM_ID=team_xxx
VERCEL_PROJECT_ID=prj_xxx
VERCEL_TOKEN=your-vercel-access-token
```

模型、Agent、workspace 和 SQLite 路径在 `agent.config.json` 里配置：

```json
{
  "defaultAgent": "coding",
  "storage": {
    "sqlitePath": ".openrun/openrun.sqlite"
  }
}
```

`.openrun/` 是本地运行历史目录，已经加入 `.gitignore`。

## 3. Run The Agent

```bash
npm run dev -- "Write a tiny JavaScript file, run it in the sandbox, and tell me the output."
```

默认不传 prompt 时会立刻创建一个新的 conversation，并进入交互式会话。后续每一行输入都会继续同一个 Agent 上下文，输入 `/exit`、`exit`、`quit`、`.exit` 或 `:q` 退出：

```bash
npm run dev
```

对话过程中，Assistant 内容会流式输出；工具调用只显示简短状态，例如 `[tool] read_file src/index.ts` 和 `[tool] done read_file`，不会把完整工具结果刷到控制台。

列出历史会话：

```bash
npm run dev -- --list-sessions
```

继续指定会话：

```bash
npm run dev -- --continue <conversation-id>
```

也可以直接对指定会话执行一轮：

```bash
npm run dev -- --continue <conversation-id> "run tests again"
```

## Storage Model

SQLite 默认写到：

```txt
.openrun/openrun.sqlite
```

第一版只有三张核心表：

```txt
sandbox_workspaces
conversations
conversation_events
```

关系是：

```txt
sandbox_workspaces.id -> conversations.workspace_id
conversations.id -> conversation_events.conversation_id
conversation_events.id -> conversation_events.parent_event_id
```

`conversations` 类似 Claude Code 的 `sessions-index.json`，用于快速列出历史会话；`conversation_events` 类似每个 session 的 JSONL 事件流，用来恢复上下文。

## Code Map

- `src/cli.ts`: 命令行入口。
- `src/cli/app.ts`: CLI 编排逻辑。
- `src/config/agent-config.ts`: `agent.config.json` 加载和默认配置。
- `src/storage/sqlite-store.ts`: SQLite schema、会话索引和事件流。
- `src/agent/coding-agent.ts`: 通用 Coding Agent loop。
- `src/model/openai-compatible-client.ts`: OpenAI-compatible 模型客户端。
- `src/sandbox/sandbox-manager.ts`: 命名 persistent Vercel Sandbox 启动/恢复。
- `src/sandbox/workspace.ts`: sandbox 工作区和路径安全。
- `src/tools/`: 文件系统工具和命令工具。

## Safety Defaults

- `persistent: true`: 默认使用命名 sandbox，文件系统可以跨 CLI 运行恢复。
- `networkPolicy: "deny-all"`: 默认禁止 sandbox 访问公网。
- Secret 不会自动注入 sandbox。不要把生产 API key 放进 tool call 的 `env` 或写入 sandbox 文件。
- 工具输出写入 SQLite 前会截断，避免本地数据库无限增长。

## Checks

```bash
npm test
npm run typecheck
npm run build
```
