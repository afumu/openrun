[![English](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)

# OpenRun

OpenRun 是一个 Coding Agent 平台原型。它把大模型 Agent、代码读写工具、命令执行工具和 Vercel Sandbox 组合在一起，让 Agent 可以在隔离的云端沙箱里读取代码、修改文件、运行命令和返回结果。

这个项目的目标是提供一个最小但完整的基础架构：外部 Agent 平台负责对话、工具调度和会话管理，真正的代码执行发生在 Vercel Sandbox 容器中。这样可以把本机环境和不可信代码隔离开，同时保留长期会话、文件状态和执行历史。

当前版本已经包含：

- OpenAI-compatible 模型接入，默认配置 DeepSeek。
- Vercel Sandbox 工作区启动、恢复和命令执行。
- Coding Agent 常用工具：读取文件、写文件、追加文件、单次编辑、多次编辑、搜索文件、搜索代码、运行命令、启动预览服务。
- 多轮 CLI 对话，支持流式输出和工具调用状态展示。
- 本地 SQLite 会话存储，用于保存 conversations 和事件流。
- 默认 persistent sandbox 配置，让同一个工作区可以跨 CLI 运行继续使用。

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

## Preview Web Apps

当 Agent 构建 Web 应用时，可以在 Vercel Sandbox 内启动服务，并返回一个可直接访问的公开预览链接。

简单 HTML、静态页面或小型 demo 默认使用 Vite：

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

更复杂的应用，例如多页面、API route、服务端渲染、登录权限或后台系统，默认使用 Next.js：

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

`start_preview` 工具会暴露 sandbox 端口、以 detached 模式启动服务、等待服务可访问，并返回 URL。服务日志会写到 `.openrun/previews/<port>.log`，避免把大量日志刷到控制台。

预览服务只在 sandbox session 存活期间可用。默认 `stopOnExit: true`，CLI 退出会停止 sandbox 和预览进程；如果希望预览链接在 CLI 退出后继续可用，可以把 workspace 配置里的 `stopOnExit` 改成 `false`，并设置更长的 `timeoutMs`。

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

## SWE-bench Pro Smoke Test

运行 public test split 的前 5 条，用当前 OpenRun Agent 生成官方评测所需的 patch JSON：

```bash
npm run swebench:pro -- --limit 5 --max-tool-steps 80
```

输出默认写到：

```txt
.openrun/swebench-pro/first5/raw_samples.jsonl
.openrun/swebench-pro/first5/openrun_patches.json
```

然后用官方评测仓库打分：

```bash
git clone https://github.com/scaleapi/SWE-bench_Pro-os.git .openrun/SWE-bench_Pro-os
cd .openrun/SWE-bench_Pro-os
pip install -r requirements.txt
python swe_bench_pro_eval.py \
  --raw_sample_path ../swebench-pro/first5/raw_samples.jsonl \
  --patch_path ../swebench-pro/first5/openrun_patches.json \
  --output_dir ../swebench-pro/first5/eval \
  --scripts_dir run_scripts \
  --num_workers 2 \
  --dockerhub_username jefzda \
  --use_local_docker
```

生成 patch 阶段会为每条 instance 使用一个专门的 Vercel Sandbox，并临时把网络策略设为 `allow-all`，以便克隆待测 GitHub 仓库。默认 sandbox timeout 是 45 分钟，以兼容 Vercel Hobby plan 限制。
