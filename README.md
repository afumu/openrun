[![中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-blue.svg)](./README.zh-CN.md)

# OpenRun

OpenRun is a prototype Coding Agent platform. It combines LLM agents, code read/write tools, command execution tools, and Vercel Sandbox so agents can read code, modify files, run commands, and return results from an isolated cloud sandbox.

The goal of this project is to provide a minimal but complete foundation: the external agent platform handles conversation, tool orchestration, and session management, while the actual code execution happens inside a Vercel Sandbox container. This keeps the local machine isolated from untrusted code while preserving long-running sessions, file state, and execution history.

The current version includes:

- OpenAI-compatible model integration, with DeepSeek configured by default.
- Vercel Sandbox workspace startup, resume, and command execution.
- Common Coding Agent tools: read files, write files, append files, single edits, multi-edits, file search, code search, command execution, and preview server startup.
- Multi-turn CLI conversations with streaming output and tool-call status display.
- Local SQLite session storage for conversations and event streams.
- A persistent sandbox configuration by default, so the same workspace can continue across CLI runs.

## 1. Install

```bash
npm install
```

## 2. Configure Environment

Do not commit real keys to the repository. The recommended setup is to use a local `.env.local`; the CLI automatically loads both `.env.local` and `.env`:

```dotenv
DEEPSEEK_API_KEY=your-deepseek-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

Choose one of the following ways to authenticate Vercel Sandbox:

```bash
vercel link
vercel env pull
```

Or use an access token on an external server:

```dotenv
VERCEL_TEAM_ID=team_xxx
VERCEL_PROJECT_ID=prj_xxx
VERCEL_TOKEN=your-vercel-access-token
```

Models, agents, workspaces, and the SQLite path are configured in `agent.config.json`:

```json
{
  "defaultAgent": "coding",
  "storage": {
    "sqlitePath": ".openrun/openrun.sqlite"
  }
}
```

`.openrun/` is the local runtime history directory and is already included in `.gitignore`.

## 3. Run The Agent

```bash
npm run dev -- "Write a tiny JavaScript file, run it in the sandbox, and tell me the output."
```

When no prompt is provided, the CLI immediately creates a new conversation and enters an interactive session. Each following input line continues the same agent context. Enter `/exit`, `exit`, `quit`, `.exit`, or `:q` to leave:

```bash
npm run dev
```

During the conversation, assistant content streams to the terminal. Tool calls only display short status lines, such as `[tool] read_file src/index.ts` and `[tool] done read_file`, instead of printing full tool results to the console.

List previous sessions:

```bash
npm run dev -- --list-sessions
```

Continue a specific session:

```bash
npm run dev -- --continue <conversation-id>
```

You can also run a single turn against a specific session:

```bash
npm run dev -- --continue <conversation-id> "run tests again"
```

## Preview Web Apps

When the agent builds a web application, it can start a service inside Vercel Sandbox and return a public preview URL that can be opened directly.

Simple HTML pages, static sites, and small demos use Vite by default:

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

More complex applications, such as multi-page apps, API routes, server-side rendering, authentication, or admin systems, use Next.js by default:

```bash
npm run dev -- --hostname 0.0.0.0 --port 3000
```

The `start_preview` tool exposes the sandbox port, starts the service in detached mode, waits until the service is reachable, and returns the URL. Service logs are written to `.openrun/previews/<port>.log` to avoid flooding the console.

Preview services are only available while the sandbox session is alive. By default, `stopOnExit: true`, so leaving the CLI stops both the sandbox and preview processes. To keep preview URLs available after the CLI exits, set the workspace `stopOnExit` option to `false` and use a longer `timeoutMs`.

## Storage Model

SQLite is written to the following path by default:

```txt
.openrun/openrun.sqlite
```

The first version has three core tables:

```txt
sandbox_workspaces
conversations
conversation_events
```

The relationship is:

```txt
sandbox_workspaces.id -> conversations.workspace_id
conversations.id -> conversation_events.conversation_id
conversation_events.id -> conversation_events.parent_event_id
```

`conversations` is similar to Claude Code's `sessions-index.json` and is used to list previous sessions quickly. `conversation_events` is similar to a JSONL event stream for each session and is used to restore context.

## Code Map

- `src/cli.ts`: CLI entry point.
- `src/cli/app.ts`: CLI orchestration logic.
- `src/config/agent-config.ts`: `agent.config.json` loading and default configuration.
- `src/storage/sqlite-store.ts`: SQLite schema, session index, and event stream.
- `src/agent/coding-agent.ts`: General Coding Agent loop.
- `src/model/openai-compatible-client.ts`: OpenAI-compatible model client.
- `src/sandbox/sandbox-manager.ts`: Named persistent Vercel Sandbox startup and resume.
- `src/sandbox/workspace.ts`: Sandbox workspace and path safety.
- `src/tools/`: File system tools and command tools.

## Safety Defaults

- `persistent: true`: named sandboxes are used by default, so the file system can be restored across CLI runs.
- `networkPolicy: "deny-all"`: sandbox network access is denied by default.
- Secrets are not automatically injected into the sandbox. Do not put production API keys in tool-call `env` values or write them to sandbox files.
- Tool output is truncated before being written to SQLite to prevent unbounded local database growth.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

## SWE-bench Pro Smoke Test

Run the first 5 examples from the public test split and use the current OpenRun Agent to generate the patch JSON required by the official evaluator:

```bash
npm run swebench:pro -- --limit 5 --max-tool-steps 80
```

Output is written to the following paths by default:

```txt
.openrun/swebench-pro/first5/raw_samples.jsonl
.openrun/swebench-pro/first5/openrun_patches.json
```

Then score the results with the official evaluation repository:

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

During patch generation, each instance uses a dedicated Vercel Sandbox and temporarily sets the network policy to `allow-all` so it can clone the target GitHub repository. The default sandbox timeout is 45 minutes to stay compatible with the Vercel Hobby plan limit.
