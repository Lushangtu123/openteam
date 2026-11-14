# OpenTeam CLI

**Language:** English | [简体中文](README.zh-CN.md)

OpenTeam CLI lets local agents control an OpenTeam browser extension through a local daemon.

## Install

Install the CLI from npm:

```bash
npm install -g @afumu/openteamcli
openteamcli doctor
```

## Install the Agent Skill

The package also ships an `openteam-control` skill for local agents. The skill teaches an agent how to start the daemon, check the browser extension connection, create OpenTeam chats, add temporary roles, post tasks, wait for replies, and recover from common local-control errors.

Install from GitHub with the standard skills installer:

```bash
npx skills add afumu/openteam --skill openteam-control
```

For a local checkout or unzipped source package, install from the repository root:

```bash
npx skills add . --skill openteam-control
```

The skills installer will ask which agent, scope, and install method to use.

Restart the agent session after installing the skill, then verify the local bridge:

```bash
openteamcli daemon start
openteamcli doctor
```

If you want an agent to install everything for you, copy this prompt into Codex, Claude Code, or another local coding agent:

```text
Please install OpenTeam local agent control for me.

1. Install the CLI:
   npm install -g @afumu/openteamcli

2. Install the OpenTeam agent skill:
   npx skills add afumu/openteam --skill openteam-control

   If you are working from a local OpenTeam checkout or unzipped source package, run this from the repository root instead:
   npx skills add . --skill openteam-control

3. Start and verify the local bridge:
   openteamcli daemon start
   openteamcli doctor

If the skills installer asks which agent, scope, or install method to use, let me choose. If doctor says the extension is not connected, ask me to open the OpenTeam extension page and enable local agent control in settings.
```

## Development Install

Run from the repository root:

```bash
npm install -g ./packages/openteamcli
# or
npm link ./packages/openteamcli
```

For development, install the local skill from the repository root:

```bash
npx skills add . --skill openteam-control
```

The daemon only accepts requests whose `Host` is `127.0.0.1`/`localhost`, and only accepts the extension WebSocket from the OpenTeam extension origin (`chrome-extension://cnccbifloajlkjglmiojkpimjciamlpe`, fixed by the manifest `key`). If you load a build with a different extension ID, allow it explicitly:

```bash
OPENTEAM_EXTENSION_ORIGINS=chrome-extension://<your-extension-id> openteamcli daemon restart
```

The daemon runs in the background with no output. What happens to it is kept in `~/.openteam/daemon.log` (readable only by you; the previous file is kept as `daemon.log.1` once it reaches 1 MB): when it started and ended and why (a signal, a crash, `daemon stop`), the extension connecting and leaving, and local agent runs. Prompts and the token are never written there. A run that ended without writing its end (killed outright, or the computer lost power) is noted at the next start. `openteamcli daemon status` shows the file's path.

## Start at Login (macOS)

The daemon does not start by itself after the Mac restarts, so local agent members and CLI control stop working until someone runs `openteamcli daemon start`. On macOS, install it as a LaunchAgent instead:

```bash
openteamcli daemon install
```

This writes `~/Library/LaunchAgents/io.github.afumu.openteam.daemon.plist` and loads it with `launchctl bootstrap gui/$UID`. launchd then runs the daemon (`node openteam-daemon.mjs --port=<port>`, the port from `OPENTEAM_DAEMON_PORT` or 19305) when you log in (`RunAtLoad`), and again whenever it ends with a failure, such as a crash (`KeepAlive` with `SuccessfulExit` false). A daemon already running on the port is stopped first, so the two do not compete for it. Running `install` again changes nothing when nothing changed; run it again after you move or reinstall openteamcli.

- **Node**: the one that runs `openteamcli`, by its path on `PATH` when that leads to the same program, so `/opt/homebrew/bin/node` rather than the Cellar folder of one version, which `brew upgrade` removes.
- **Environment**: launchd gives programs only the system folders on `PATH`, so the daemon gets the `PATH` that `install` ran with (local agents start with `npx`), and `OPENTEAM_EXTENSION_ORIGINS` if it was set. Nothing else from your shell reaches it: give an agent the variables it needs with `agent add --env`, and set `OPENTEAM_EXTENSION_ORIGINS` when you run `install`, not on `daemon restart`.
- **Stop and start**: `daemon stop` ends the daemon with exit code 0, which launchd leaves alone, so it stays stopped until the next login or `daemon start`. With the LaunchAgent loaded, `daemon start` and `daemon restart` start it through launchd, so the running daemon is always the one that comes back after a crash.
- **Status**: `daemon status` and `doctor` include `launchAgent`: whether it is installed and loaded, launchd's state, pid and last exit code, whether the daemon on the port is the one launchd runs (`managed`), and a `hint` when something needs doing (for example the Node it runs is gone).
- **Login Items**: macOS may show a notice that a background item (`node`) was added. Leave it allowed under System Settings › General › Login Items; turned off, launchd does not run the daemon.
- Run `install` from a global install (`npm install -g @afumu/openteamcli`) or a checkout that stays where it is. A command run with `npx` lives in npm's cache, which npm clears.

```bash
openteamcli daemon uninstall
```

This unloads it (which stops the daemon it started) and removes the file. `daemon start` still starts a daemon the usual way. Both commands refuse on other systems.

## Publish Checklist

Before publishing a new CLI release, bump `packages/openteamcli/package.json`; npm does not allow republishing an existing version.

```bash
cd packages/openteamcli
npm version patch --no-git-tag-version
npm pack --dry-run
npm publish --dry-run --access public
npm login
npm whoami
npm publish --access public
```

For a beta release:

```bash
npm publish --tag beta --access public
```

## Local agents in OpenTeam groups

Add a local ACP agent, then pick it in OpenTeam under 添加大模型 → 本机智能体（ACP）:

```bash
openteamcli agent add --preset claude-code --cwd ~/projects/app
openteamcli agent list
openteamcli agent remove claude-code
```

Presets: `claude-code`, `codex`, `gemini`; or `--id <id> --name <name> --command "<command and arguments>"`. The agent can read and write only inside the `--cwd` folders, and OpenTeam asks you before each run and for each permission the agent requests. See `docs/ACP.md` in the OpenTeam repository.

