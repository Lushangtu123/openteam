---
name: openteam-control
description: 当智能体需要通过本机 openteamcli 控制 OpenTeam：创建 AI 群聊、添加临时角色、发布任务、等待回复、读取结果，或继续已有群聊时使用。
---

# OpenTeam CLI 本机控制

## 概览

OpenTeam 通过已安装的 `openteamcli` 命令和本地 daemon 控制。不要直接点击浏览器界面，也不要绕过本地控制协议去调用 Chrome 扩展内部 API。

当任务需要多个 AI 角色在 OpenTeam 里讨论、评审、批判、头脑风暴、比较方案，或分别给出独立观点时，使用这个 skill。

## 本机命令要求

默认直接调用已安装到本机 PATH 里的 `openteamcli`。如果命令不存在，请提示用户先从 OpenTeam 的最新发布安装（需要 Node.js 18 或更高版本）：

```bash
npm install -g https://github.com/Lushangtu123/openteam/releases/latest/download/openteamcli.tgz
```

开发期可以在 OpenTeam 仓库里执行：

```bash
npm install -g ./packages/openteamcli
```

或者使用软链接安装：

```bash
npm link ./packages/openteamcli
```

## 先启动并检查连接

任何操作前先运行：

```bash
openteamcli daemon start
openteamcli doctor
```

`daemon start` 是幂等命令。如果 daemon 已经运行，它只会返回 `alreadyRunning`，不会重复启动后台进程。

如果结果里 `extension.connected` 是 `false`：

1. 请用户打开 OpenTeam 插件页面。
2. 确认设置里已开启 `本机智能体控制`。
3. 再运行一次 `doctor`。

如果 daemon 状态异常，优先运行：

```bash
openteamcli daemon restart
openteamcli doctor
```

在 macOS 上，如果 `doctor` 里 `launchAgent.installed` 是 `false`，可以建议用户运行 `openteamcli daemon install`，让 daemon 在登录时自动启动、崩溃后自动重启（`openteamcli daemon uninstall` 可以去掉）。它会改动用户的登录项，所以不要自行运行，先问用户。`launchAgent.hint` 不为空时，把它转告用户。

## 推荐的新任务流程

新任务优先使用“一次性创建群聊、添加角色、发布任务、等待回复”的流程。这样最适合外部 Agent 或 CLI 调用。

先创建一个 JSON 文件，例如 `task.json`：

```json
{
  "chat": {
    "name": "方案评审",
    "mode": "independent"
  },
  "roles": [
    {
      "source": "temporary",
      "name": "工程师",
      "systemPrompt": "从工程实现、复杂度、风险和测试角度评估。"
    },
    {
      "source": "temporary",
      "name": "产品经理",
      "systemPrompt": "从用户价值、范围控制和交付节奏角度评估。"
    }
  ],
  "task": {
    "target": "all",
    "content": "请评估这个方案，给出风险、建议和最终判断。"
  },
  "options": {
    "waitForReplies": true,
    "activateChat": true,
    "openTeamPage": true
  }
}
```

然后运行：

```bash
openteamcli run create-and-post --file task.json --wait
```

向用户汇报时，优先按角色保留观点差异，不要把所有回复压平成一段通用总结。

## 临时角色

如果人员库里没有现成模板，不要要求用户先手动创建模板。直接在任务 JSON 里使用临时角色：

```json
{
  "source": "temporary",
  "name": "研究员",
  "description": "负责查漏补缺和事实核对。",
  "chatSite": "deepseek",
  "systemPrompt": "你是研究员，负责核对事实、找出假设漏洞，并列出需要补充的信息。"
}
```

临时角色只属于当前群聊，不会写入人员库。`chatSite` 可用值：`deepseek`、`chatgpt`、`gemini`、`claude`、`grok`、`qwen`、`kimi`。

如果模拟真实公众人物、公司创始人或专家风格，必须在 `systemPrompt` 里明确：

- 这是公开思想风格的模拟角色。
- 不是真人本人。
- 不代表其公司或组织发言。
- 不声称拥有私人经历、实时信息或内部信息。

## 继续已有群聊

当用户给出 `chatId`，或希望继续之前的 OpenTeam 群聊时，使用已有群聊流程：

```bash
openteamcli task post --chat <chatId> --target all --content "继续追问的问题"
openteamcli task wait --chat <chatId> --message <messageId> --timeout 300000
openteamcli task read --chat <chatId> --message <messageId>
```

如果 `task post` 的 CLI 进程迟迟不返回，但 `chat get` 已经能看到用户消息和角色回复，说明群聊执行链路可能已经完成。此时用 `task read` 按消息 ID 读取结果，并检查 daemon 是否有悬挂请求：

```bash
openteamcli daemon status
```

如果 `pending` 长时间不为 `0`，重启 daemon 清理悬挂状态：

```bash
openteamcli daemon restart
```

## 常用命令

```bash
openteamcli daemon start
openteamcli doctor
openteamcli daemon status
openteamcli daemon restart
openteamcli daemon install
openteamcli daemon uninstall
openteamcli chat list
openteamcli chat get <chatId>
openteamcli chat create --name "群聊名" --mode independent
openteamcli chat activate --chat <chatId>
openteamcli chat initialize --chat <chatId>
openteamcli role list --chat <chatId>
openteamcli role batch-add --chat <chatId> --file roles.json
openteamcli task post --chat <chatId> --target all --content "任务"
openteamcli task wait --chat <chatId> --message <messageId> --timeout 300000
openteamcli task read --chat <chatId> --message <messageId>
openteamcli memory search --chat <chatId> --role name:<成员名> --query "问题"
openteamcli memory add --scope chat --chat <chatId> --kind decision --content "要记住的一句话"
```

## 记忆库

`memory search` 按某个群里某位成员能看到的范围查记忆库，结果和这位成员在提示词里会读到的一致：`pinned` 是每次都带的条目，`items` 是查询找到的条目（不给 `--query` 时列出它能看到的全部）。群聊关掉了记忆时结果为空，`memoryDisabled` 为 `true`。

`memory add` 以用户的身份保存，所以**只在用户明确要求记住某件事时使用**，不要自己决定把回复、结论或推测存进去。`--scope` 决定谁会读到：

- `global`：所有群聊的所有成员，包括 ChatGPT、Gemini 等第三方站点上的成员和本机智能体。用之前先向用户确认。
- `chat`：`--chat` 指定的群的成员。
- `role`：`--chat` 群里 `--role` 指定的那一位成员。

`--kind` 是 `fact`、`decision`、`preference` 或 `note`，默认 `fact`；`preference` 默认常驻。内容不超过 500 字，记忆库最多 500 条。

`roles.json` 可以是数组：

```json
[
  {
    "source": "temporary",
    "name": "研究员",
    "systemPrompt": "负责查漏补缺和事实核对。"
  }
]
```

## 网站自检

用户问某个 AI 网站还能不能用，或者 OpenTeam 收发消息出了问题、想知道是哪个网站坏了时，运行：

```bash
openteamcli site-check
```

它会新建一个「网站自检」群，给每个 AI 网站发一句「只回复 OK」，并打开 OpenTeam 页面；一般一分钟左右出结果，最长约六分半钟，期间不要再发别的任务。结果的 `results` 逐个列出网站：`ok` 正常；`login` 要用户去那个网站登录；`page-problem` 页面被验证页或弹窗挡住，请用户打开 AI 网页看看；`failed`、`not-sent`、`no-reply` 是发送或读取出了问题，`no-reply` 常常说明网站改版了。把需要处理的网站和原因（`detail`）告诉用户，不要自己去点浏览器。这会用用户的账号在每个网站发一条消息，用户没有要求时不要主动跑。

## 查日志

排查 OpenTeam 里出的问题（成员没回答、换了备用模型、资料库网页没更新、网页成员报错）时，先看扩展后台的日志，不要先让用户导出诊断信息：

```bash
openteamcli logs --level warn --since 1h
openteamcli logs --search fallback --limit 20
```

`entries` 按时间排列，最新的在最后；`event` 是事件名，`details` 是详情。日志已去掉消息内容、名字和 Key。`daemon logs` 是守护进程自己的日志，和这个不同。

## 错误恢复

优先看机器可读的 `error.code`。

| 错误码 | 处理方式 |
| --- | --- |
| `extension_not_connected` | 请用户打开 OpenTeam 插件页面，确认已开启本机智能体控制，然后重跑 `doctor`。 |
| `control_disabled` | 请用户在 OpenTeam 设置里开启 `本机智能体控制`。 |
| `role_not_ready` | 运行 `chat initialize --chat <chatId>`，或请用户等待角色 iframe 初始化完成。 |
| `task_timeout` | 运行 `task read`，汇报已收到的部分回复和仍在等待的角色。 |
| `permission_denied` | 不要盲目重试。本地 token 或 daemon 状态可能异常，先运行 `daemon restart`。 |
| `fetch failed` | 先运行 `doctor` 和 `daemon status`。如果 daemon 退出或插件断开，重启 daemon 并重新打开 OpenTeam 页面。 |

## 操作规则

- 新任务优先使用 `run create-and-post --file ... --wait`。
- 多角色、长提示词或复杂任务必须使用 JSON 文件承载输入。
- 不要把密钥、token、cookie 或用户隐私信息写进任务提示词。
- 本地 daemon 只能监听 `127.0.0.1`，不要暴露到公网或局域网。
- 除非用户明确希望浏览器会话里的 AI 角色行动，否则不要替用户向 OpenTeam 发布任务。
- 汇报结果时说明哪些角色已回复、哪些角色仍在等待、是否超时。
