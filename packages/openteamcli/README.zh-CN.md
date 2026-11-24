# OpenTeam CLI

**语言:** [English](README.md) | 简体中文

OpenTeam CLI 让本机智能体可以通过本地 daemon 控制 OpenTeam 浏览器扩展。

## 安装

从最新发布安装 CLI（需要 Node.js 18 或更高版本）：

```bash
npm install -g https://github.com/Lushangtu123/openteam/releases/latest/download/openteamcli.tgz
openteamcli doctor
```

包名是 `@lushangtu123/openteamcli`，没有发布到 npm。在本仓库的 checkout 里，`npm install -g ./packages/openteamcli` 会装上同一个 CLI。

## 安装 Agent Skill

这个包也包含一个给本机智能体使用的 `openteam-control` skill。这个 skill 会告诉智能体如何启动 daemon、检查浏览器扩展连接、创建 OpenTeam 群聊、添加临时角色、发布任务、等待回复，以及处理常见的本机控制错误。

使用标准的 skills 安装器从 GitHub 安装：

```bash
npx skills add Lushangtu123/openteam --skill openteam-control
```

如果使用本地 checkout 或解压后的源码包，请在仓库根目录执行：

```bash
npx skills add . --skill openteam-control
```

skills 安装器会询问要安装到哪个 agent、使用什么范围和安装方式。

安装 skill 后，重新打开智能体会话，然后检查本地连接：

```bash
openteamcli daemon start
openteamcli doctor
```

如果希望让 Codex、Claude Code 或其他本机代码智能体帮你完成安装，可以把下面这段说明复制给它：

```text
请帮我安装 OpenTeam 本机智能体控制能力。

1. 安装 CLI：
   npm install -g https://github.com/Lushangtu123/openteam/releases/latest/download/openteamcli.tgz

2. 安装 OpenTeam agent skill：
   npx skills add Lushangtu123/openteam --skill openteam-control

   如果你正在使用本地 OpenTeam checkout 或解压后的源码包，请在仓库根目录改用：
   npx skills add . --skill openteam-control

3. 启动并检查本地连接：
   openteamcli daemon start
   openteamcli doctor

如果 skills 安装器询问要安装到哪个 agent、使用什么范围或安装方式，请让我选择。如果 doctor 提示 extension 没有连接，请提醒我打开 OpenTeam 扩展页面，并在设置里开启本机智能体控制。
```

## 开发安装

在仓库根目录执行：

```bash
npm install -g ./packages/openteamcli
# 或
npm link ./packages/openteamcli
```

开发时，在仓库根目录安装本地 skill：

```bash
npx skills add . --skill openteam-control
```

守护进程只接受 `Host` 为 `127.0.0.1`/`localhost` 的请求，并且只接受来自 OpenTeam 扩展来源（`chrome-extension://cnccbifloajlkjglmiojkpimjciamlpe`，由 manifest 的 `key` 固定）的扩展 WebSocket 连接。如果你加载的构建扩展 ID 不同，需要显式放行：

```bash
OPENTEAM_EXTENSION_ORIGINS=chrome-extension://<你的扩展ID> openteamcli daemon restart
```

守护进程在后台运行，没有输出。它的经过记在 `~/.openteam/daemon.log`（只有你能读；满 1 MB 后旧文件保留为 `daemon.log.1`）：何时启动、何时结束以及原因（收到信号、崩溃、`daemon stop`），扩展的连接和断开，本地智能体的运行。提示词和令牌不会写进去。如果上一次运行没有写下结束记录（被强制结束或电脑断电），下次启动时会补记一条。`openteamcli daemon status` 会显示这个文件的位置。

## 远程智能体（通过 SSH）

智能体也可以在另一台机器上运行，比如虚拟机里的 DeepSeek Harness（dsh）。只要它支持通过标准输入输出说 ACP，守护进程就可以用 `ssh` 启动它，SSH 会把输入输出双向转发。在 OpenTeam 里它和 Claude Code 一样：执行前先问你，它的权限请求以卡片出现，回复回到群里。

```bash
openteamcli agent add --id deepseek-vm --name "DeepSeek（VM）" \
  --command "ssh -T -o BatchMode=yes harness-vm bin/dsh-acp" \
  --cwd ~/OpenTeam/vm --remote-cwd /home/purge/workspace
```

- `--command`：在 Mac 上执行的命令。`-T` 不分配终端，`BatchMode=yes` 让 SSH 在需要密码时直接失败而不是卡住（请用密钥登录）。命令按空格拆开，不支持引号；需要环境变量（node 路径、`DSH_HOME`、代理）时，在虚拟机里写一个小脚本（例如 `~/bin/dsh-acp`，内容是设好环境后执行 `dsh --profile acp`），在这里调用它。
- `--cwd`：Mac 上的一个文件夹，OpenTeam 用它做检查，并在这里启动 `ssh`。在 OpenTeam 里给这个成员选的工作目录必须在它下面。
- `--remote-cwd`：智能体在远程机器上实际工作的文件夹（绝对路径）。选了 `--cwd` 下的子文件夹时，远程也用同名的子文件夹，例如 `~/OpenTeam/vm/demo` 对应 `/home/purge/workspace/demo`。
- 远程智能体用它自己的工具读写文件；OpenTeam 不替它读写，因为那些路径不在这台 Mac 上。

## 登录时自动启动（macOS）

Mac 重启后守护进程不会自己启动，本机智能体成员和 CLI 控制都要等有人运行 `openteamcli daemon start` 才能用。在 macOS 上可以把它装成 LaunchAgent：

```bash
openteamcli daemon install
```

它会写入 `~/Library/LaunchAgents/io.github.afumu.openteam.daemon.plist`，并用 `launchctl bootstrap gui/$UID` 加载。之后 launchd 会在你登录时运行守护进程（`node openteam-daemon.mjs --port=<端口>`，端口取 `OPENTEAM_DAEMON_PORT`，默认 19305，即 `RunAtLoad`），并在它异常结束（比如崩溃）时再启动它（`KeepAlive` 里 `SuccessfulExit` 为 false）。端口上已经在运行的守护进程会先被停掉，免得两个抢同一个端口。没有变化时再运行一次 `install` 什么也不改；移动或重新安装 openteamcli 后请再运行一次。

- **Node**：就是运行 `openteamcli` 的那个 Node；如果 `PATH` 上有一条路径指向同一个程序，就用那条路径。比如用 `/opt/homebrew/bin/node`，而不是某个版本的 Cellar 文件夹（`brew upgrade` 会删掉它）。
- **环境变量**：launchd 给程序的 `PATH` 只有系统文件夹，所以守护进程会拿到运行 `install` 时的 `PATH`（本机智能体用 `npx` 启动），以及设置了的 `OPENTEAM_EXTENSION_ORIGINS`。shell 里的其他变量都不会带过去：智能体需要的变量请用 `agent add --env` 设置；`OPENTEAM_EXTENSION_ORIGINS` 请在运行 `install` 时设置，而不是在 `daemon restart` 时。
- **停止和启动**：`daemon stop` 让守护进程以退出码 0 结束，launchd 不会再启动它，所以它会一直停着，直到下次登录或运行 `daemon start`。LaunchAgent 已加载时，`daemon start` 和 `daemon restart` 都通过 launchd 启动，这样在运行的始终是崩溃后会被拉起来的那一个。
- **状态**：`daemon status` 和 `doctor` 的结果里有 `launchAgent`：是否已安装、是否已加载，launchd 看到的状态、pid 和上次退出码，端口上的守护进程是不是 launchd 运行的那个（`managed`），需要处理时还有 `hint`（比如它要运行的 Node 已经不在了）。
- **登录项**：macOS 可能会提示添加了一个后台项目（`node`）。请在“系统设置 › 通用 › 登录项”里保持允许；关掉后 launchd 不会运行守护进程。
- 请从全局安装（见上方「安装」）或一个不会移动的 checkout 运行 `install`。用 `npx` 运行的命令放在 npm 的缓存里，npm 清理缓存后就没了。

```bash
openteamcli daemon uninstall
```

它会卸载 LaunchAgent（同时停掉它启动的守护进程）并删除这个文件。之后 `daemon start` 仍然可以照旧启动守护进程。这两个命令在其他系统上会拒绝运行。

## 记忆库

```bash
openteamcli memory search --chat <chatId> --role name:<成员名> [--query "问题"] [--limit 5]
openteamcli memory add --scope global|chat|role [--chat <chatId>] [--role name:<成员名>|role:<成员ID>] [--kind fact|decision|preference|note] --content "内容" [--tags 标签1,标签2] [--pinned]
```

`memory search` 返回某个群里某位成员能看到的记忆：常驻的条目（`pinned`），以及 `--query` 找到的条目（不给时列出全部）。可见范围和成员在提示词里读到的一致，比如独立模式的群里，成员读不到其他成员的回复里存下的内容。这只是为了和成员看到的一致：持有令牌的程序本来就能用 `store.get` 读到全部数据。

`memory add` 以你的身份保存一条记忆，和在 OpenTeam 页面里保存一样。`--scope global` 的条目会发给所有群聊的所有成员，包括第三方站点上的成员和本机智能体。

## 网站自检

```bash
openteamcli site-check [--no-wait] [--timeout <毫秒>]
```

和「设置 → AI 网页 → 网站自检」一样：一个群里每个 AI 网站一位成员，各发一句「只回复 OK」。它会打开 OpenTeam 页面（成员的网页在那里加载），等到每个网站都有结果。某个网站失败时，会重新打开它的页面再问一次，第二次还失败才报告。一切正常时约一分钟，最长约十三分钟。结果逐个列出网站：`ok`、`login`（需要登录）、`page-problem`（页面被挡住或出错）、`failed`（发送或读取回复失败）、`not-sent`（没发出去）、`no-reply`（提问送到了但没读到回复，网站改版后最常见）。`--no-wait` 在检查开始后立即返回。

退出码：所有网站正常为 0；有网站需要处理或没在时限内回复为 2；命令本身失败为 1，方便定时任务判断。运行时 Chrome 要开着，装着 OpenTeam，并开启了本机智能体控制。比如用 cron 每天 9 点检查一次：

```text
0 9 * * * openteamcli site-check > ~/openteam-site-check.json || osascript -e 'display notification "有 AI 网站需要处理" with title "OpenTeam"'
```

每次运行都会再问同一个「网站自检」群，所以每个 AI 网站一直用同一个对话，不会每次在你的账号里多出一个新聊天；群里保留上一次检查的记录。你接着用过的「网站自检」群（改过名，或发过自己的消息）不会被动，会另建一个新的。

## 扩展的日志

```bash
openteamcli logs [--search <文字>] [--level warn|error] [--since 30m|2h|1d] [--limit <条数>]
```

读出 OpenTeam 后台最近记下的日志（最近 400 条，浏览器开着时一直保留：后台重启不丢，刷新扩展或关闭浏览器后清空）：比如 API 模型为什么换成了备用模型（`external-model:fallback`）、资料库网页为什么没更新成功（`library-refresh:failed`）、成员网页报的错等。`--search` 只留事件名或详情里含这段文字的，`--level warn` 只留警告和错误，`--since` 只留最近一段时间的，`--limit` 只留最后几条（默认 100）。日志在记下时就已清理过，和「导出诊断信息」一样：不含消息内容、提示词和名字，链接只留网站，不含任何 Key。这是扩展的日志；`daemon logs` 是本机守护进程自己的日志。

## 发布检查

发布新的 CLI 版本前，先更新 `packages/openteamcli/package.json` 里的版本号；npm 不允许重复发布已经存在的版本。

```bash
cd packages/openteamcli
npm version patch --no-git-tag-version
npm pack --dry-run
npm publish --dry-run --access public
npm login
npm whoami
npm publish --access public
```

发布 beta 版本：

```bash
npm publish --tag beta --access public
```
