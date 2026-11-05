# OpenTeam CLI

**语言:** [English](README.md) | 简体中文

OpenTeam CLI 让本机智能体可以通过本地 daemon 控制 OpenTeam 浏览器扩展。

## 安装

从 npm 安装 CLI：

```bash
npm install -g @afumu/openteamcli
openteamcli doctor
```

## 安装 Agent Skill

这个包也包含一个给本机智能体使用的 `openteam-control` skill。这个 skill 会告诉智能体如何启动 daemon、检查浏览器扩展连接、创建 OpenTeam 群聊、添加临时角色、发布任务、等待回复，以及处理常见的本机控制错误。

使用标准的 skills 安装器从 GitHub 安装：

```bash
npx skills add afumu/openteam --skill openteam-control
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
   npm install -g @afumu/openteamcli

2. 安装 OpenTeam agent skill：
   npx skills add afumu/openteam --skill openteam-control

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
