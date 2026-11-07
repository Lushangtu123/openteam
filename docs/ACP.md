# ACP Support Design

## Goal

Let OpenTeam route work from web AI roles to a local ACP-capable coding or office agent without granting arbitrary web pages direct access to the user's local machine.

## Proposed Architecture

OpenTeam should keep the existing local-control daemon as the only browser-to-local bridge. ACP support should be implemented behind that daemon:

1. The extension connects only to `127.0.0.1` OpenTeam control daemon as it does today.
2. The daemon owns ACP process or WebSocket configuration.
3. The browser sends high-level `agent.*` commands through the existing authenticated `/command` channel.
4. The daemon translates those commands to ACP requests and streams results back to the extension.

This avoids exposing an arbitrary ACP WebSocket URL directly to AI web pages or content scripts.

## Implemented MVP

- Local agent config is loaded by the daemon from `~/.openteam/acp-agents.json`, or from the `OPENTEAM_ACP_AGENTS` environment variable.
- Daemon capabilities are exposed through the existing token-authenticated `/command` channel:
  - `agent.list`
  - `agent.run`
  - `agent.cancel`
  - `agent.read`
- `agent.run` supports ACP-over-WebSocket endpoints such as a `stdio-to-ws` bridge.
- `agent.run` enforces a per-agent working directory allowlist before sending any prompt to the ACP endpoint.
- `openteamcli agent list` and `openteamcli agent run --agent <id> --content <prompt> --cwd <path>` expose the MVP locally.

Example config:

```json
{
  "agents": [
    {
      "id": "opencode",
      "name": "OpenCode",
      "type": "websocket",
      "url": "ws://127.0.0.1:3030",
      "enabled": true,
      "cwdAllowlist": ["/Users/me/workspace/project"]
    }
  ]
}
```

The default JSON-RPC method sent to the ACP endpoint is `session/prompt` with `{ "prompt": "...", "cwd": "..." }`. Advanced bridges can override the method with `runMethod` in the agent config.

## Remaining UI Follow-Up

- Add team page UI for local agent selection and run status.
- Require explicit user action before sending page-derived prompts from the web UI to a local ACP agent.

## Security Boundaries

- ACP is disabled by default.
- Commands run only through the daemon token-authenticated control channel.
- The daemon should enforce workspace allowlists and reject paths outside approved roots.
- Content scripts should never receive raw local filesystem output unless the user requested that run.
- Store only run metadata and user-visible output in the extension store; do not persist secrets.

## Local agents as group members (implemented, November 2026)

A local agent (Claude Code, Codex, Gemini CLI, or anything that speaks ACP over stdio) can be a member of an OpenTeam group: it gets the member's prompt like an API member does, works in one folder, and its reply streams into the chat. Web members can plan and review; the local agent does the work in the repository.

### Setup

1. Add the agent to the daemon's config (`~/.openteam/acp-agents.json`, read again on every use, so no restart):
   ```bash
   openteamcli agent add --preset claude-code --cwd ~/projects/app
   openteamcli agent add --preset codex --cwd ~/projects/app
   openteamcli agent add --id mine --name "My agent" --command "node /path/agent.mjs --acp" --cwd ~/projects/app
   ```
   Presets: `claude-code` (`npx -y @zed-industries/claude-code-acp`), `codex` (`npx -y @zed-industries/codex-acp`), `gemini` (`gemini --experimental-acp`). `--cwd` takes one or more folders (comma-separated); they must exist. `openteamcli agent remove <id>` removes one.
2. Start the daemon (`openteamcli daemon start`) and turn on 本机智能体控制 in OpenTeam's settings.
3. In 添加大模型, choose 接口格式 → 本机智能体（ACP）: the agent list comes from the daemon, and 工作目录 offers its allowed folders (a subfolder is fine). 测试 checks that the agent is listed and the folder allowed.
4. Add a member with that model, like any API model.

### What happens on a run

- **Approval first.** Before anything is sent to the agent, the chat shows a card with the folder and the whole task (which may contain text from web members); nothing runs until the user clicks 允许执行. 拒绝 ends the reply with "你拒绝了这次执行。".
- **The agent's permissions are the user's.** Every `session/request_permission` the agent sends (editing a file, running a command, per the agent's own permission rules) appears as a card with the agent's own options; the run waits for the answer. A stopped reply answers "cancelled".
- **Files stay in the folder.** The daemon answers `fs/read_text_file` and `fs/write_text_file` only for absolute paths inside the run's folder, symbolic links included; anything else is an error for the agent. OpenTeam does not offer a terminal (`terminal: false`); agents that run commands themselves ask permission for them.
- **The reply** is the agent's message text, with lines for each tool call (🛠), permission decision (✅ / ⛔) and file written (📝).
- **No automatic retries.** A failed run is shown as failed; what an agent did cannot be undone by sending it again. Stop cancels the run (`session/cancel`, then the process ends).
- **Runs do not hold requests open.** The page's send returns at once; the run's reply arrives through store updates. A run started by the extension is cancelled if the extension disconnects, and gets 30 minutes at most.
- Local agents are only used as members: persona generation and auto-planning pick an API model.

### Protocol notes

- The extension talks to the daemon over its existing WebSocket (the daemon checks the extension's Origin): `{type:"request", request:{id, action, payload}}` with actions `agent.list`, `agent.run` (answers `{runId}` at once), `agent.permission` (`runId`, `permissionId`, `optionId`) and `agent.cancel`; the daemon answers `{type:"response", response}` and streams `{type:"agent-event", runId, event}` with `started`, `text`, `tool`, `plan`, `file`, `permission`, `done`, `error` and `cancelled`.
- ACP over stdio (`packages/openteamcli/acp-stdio.mjs`): `initialize` (protocol 1, `fs.readTextFile`/`writeTextFile`), `session/new` (`cwd`, no MCP servers), `session/prompt` (one text part), `session/update` notifications (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`), and the client methods above.
- Tests use a stand-in agent (`packages/openteamcli/test-fixtures/mock-acp-agent.mjs`). Checked in Chrome for Testing with the real daemon and that agent: adding it in 添加大模型, the run card, the agent's permission card, the file written in the folder, the streamed reply, and a refused run.

## Follow-Up Tasks

- Try the presets with signed-in Claude Code, Codex and Gemini CLI, including agents that ask to authenticate (`authenticate`), and long runs.
- Offer "allow for this project" so a project's tasks for a local agent do not each need a click.
