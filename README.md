# OpenTeam

**Language:** English | [简体中文](README.zh-CN.md)

> **Origin.** This project is based on **OpenTeam** by **[afumu](https://github.com/afumu)** (original repository: [afumu/openteam](https://github.com/afumu/openteam)). The original code, design and documentation belong to afumu and the OpenTeam contributors and remain under the [PolyForm Noncommercial License 1.0.0](LICENSE) (`Required Notice: Copyright (c) 2026 OpenTeam contributors.`).

> A local-first AI team workspace: put ChatGPT, Gemini, DeepSeek, Grok, Qwen, Kimi, API models and local coding agents in one group chat, and let them discuss, review each other and work through a project together.

OpenTeam is a Manifest V3 Chrome extension. Most members need no API key: OpenTeam reuses the AI websites you are already signed in to, sends each member its task inside that site, and gathers the replies in one shared chat. When you want them, API models and local agents such as Claude Code or Codex can join the same group.

Use it for learning, research and personal non-commercial work where one answer is not enough: comparing models, fact-checking, design and code reviews, content planning, decisions, and multi-step work that benefits from several roles.

![A group chat: three members answer one question, each reply starting with its key points](docs/assets/screenshots/group-chat.png)

## Highlights

**A team made of the AIs you already use**

- **No API tokens needed**: web members use your existing AI website sessions.
- **Six AI websites**: Gemini, ChatGPT, DeepSeek, Grok, Qwen and Kimi as group members, each in its own page; a member can be moved to another site or model at any time.
- **API members**: add any OpenAI- or Anthropic-compatible model (DeepSeek, Gemini, Zhipu, Ark, OpenRouter and others). Each reply shows the tokens it used, and a failed request shows the server's own reason.
- **Local agents as members**: Claude Code, Codex or another ACP agent works in a folder you allow, through the local daemon. Every run, file edit and command waits for your approval, and agents that share a folder take turns.
- **Team up for a task**: describe the task, pick the AIs, and each chooses its position; you confirm the roles before work starts.
- **Advisor library**: 38 expert and thinking-style templates, or people you create yourself.

**Ways to work together**

- **Mentions**: `@person` asks one member, `@everyone` asks the whole team.
- **Independent and collaborative modes**: compare separate answers first, then let members read, challenge and build on each other.
- **Turn-by-turn discussion**: members speak one at a time and can hand the turn to someone else; no single member can take over the discussion.
- **Project mode**: a coordinator breaks a goal into tasks with owners and "done" criteria. After you approve, members work in order or in parallel, the coordinator checks each result and asks for rework (with a limit, so tasks are not passed around forever), and finally writes the deliverable on a task board in the chat.
- **Key points and round summaries**: replies to a group start with their key points; once everyone has answered, one member summarises agreements, disagreements, open questions and next steps. You can adopt a summary as a decision with one click.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/turn-discussion-dark.png" alt="A turn-by-turn discussion in the Grok-like dark look, ending with a round summary"></td>
    <td width="50%"><img src="docs/assets/screenshots/project-board.png" alt="Project mode: the coordinator's plan with two tasks and their owners, waiting for approval"></td>
  </tr>
  <tr>
    <td>Turn-by-turn discussion with a round summary (Grok-like look, dark)</td>
    <td>Project mode: the plan waits for your approval</td>
  </tr>
</table>

**Memory that lasts across chats**

- **Memory store**: save a fact, decision, preference or note from any message, for every group, one group or one member. Each member gets the pinned items and the ones relevant to the current request, within its context budget; a web member is sent only what it has not seen yet.
- **Kept apart where it should be**: in independent mode a member does not read what other members wrote. Members can also propose items for you to accept or dismiss (off by default).

**Workspace**

- **Live replies**: a web member's reply appears while the site is still writing it; stopping keeps what was written. If a member's page reloads or the member moves to another model mid-reply, the reply is closed properly and the member is brought back up to date.
- **Images and files**: attach images, PDF, Word, PowerPoint, Excel and text files; images that ChatGPT, Gemini, Grok or Qwen draw are copied into the chat.
- **Compare replies**: put every answer to one question side by side, then ask a member to summarise where they agree and differ.
- **Clickable choices**: when a reply ends with options (A / B / C), answer with one click.
- **Tools**: search, edit and resend, voice input, pinned groups, notes, a notification when everyone has answered, a live health status for each AI page, and full backup and restore.
- **Two looks**: a ChatGPT-like and a Grok-like interface, each in light and dark.
- **Local-first**: chats, people, memory, notes and settings stay in your browser.
- **Agent control CLI**: `openteamcli` lets a local agent create groups, add members, post tasks, wait for replies and search or add memory.

![Comparing three replies side by side](docs/assets/screenshots/compare-replies.png)

## How It Works

```mermaid
flowchart TB
  user([You]) --> page["Team page<br/>team.html"]
  page <--> bg["Background service worker<br/>routing, prompts, memory, replies"]
  bg <--> store[("Browser storage<br/>chats, people, memory")]
  bg <-->|prompts and live replies| cs["Content script and site adapter<br/>in each AI page"]
  bg <-->|HTTPS| api["API models<br/>OpenAI or Anthropic format"]
  bg <-->|WebSocket, 127.0.0.1| daemon["Local daemon<br/>openteamcli"]
  cs <--> web["ChatGPT / Gemini / DeepSeek<br/>Grok / Qwen / Kimi"]
  daemon <-->|ACP| agents["Claude Code / Codex<br/>in a folder you allow"]
  cli["Your agent using openteamcli"] -->|HTTP, 127.0.0.1| daemon
```

Each web member is bound to an AI website page inside the OpenTeam workspace. When you send a message, OpenTeam builds a prompt from the chat mode, the member's persona, quoted messages, shared context and relevant memory, delivers it into the member's page, and follows the reply as it is written.

```mermaid
sequenceDiagram
  participant U as You
  participant P as Team page
  participant B as Background
  participant M as Member (website, API or local agent)
  U->>P: message, with @mentions
  P->>B: send
  B->>B: build the prompt: mode, persona, quoted messages,<br/>group messages it has not seen, relevant memory
  B->>M: deliver the prompt
  M-->>B: reply, piece by piece
  B-->>P: show the reply as it is written
  Note over B,M: if the page reloads or the member moves to another model,<br/>the reply is closed and the member is brought up to date
  B->>M: once everyone has answered, one member writes the round summary
```

API members are called directly from the extension; local agents run through the local daemon.

| Site | Common fit |
| --- | --- |
| Gemini | Long context, research, multimodal material |
| ChatGPT | General execution, fast iteration |
| DeepSeek | Code, reasoning, Chinese-language work |
| Grok | Current events, alternative phrasing |
| Qwen | Chinese and multilingual writing, code, long documents (chat.qwen.ai) |
| Kimi | Long documents, Chinese-language research and writing (www.kimi.com) |
| Claude | claude.ai refuses to run inside other pages, so add Claude as an API member (Anthropic format) |

These are practical defaults, not rankings. Quality depends on model versions, account plans, task type and input.

## Disclaimer

OpenTeam is an unofficial project for learning, research and personal non-commercial use only. It is not affiliated with, endorsed by or supported by OpenAI, Anthropic, Google, DeepSeek, xAI, Alibaba, Moonshot AI or any supported AI website.

OpenTeam works with AI websites through your own signed-in browser sessions and page automation. Website changes, account rules, rate limits, anti-abuse systems or terms of service may affect whether it works. You are responsible for following the rules, policies and laws that apply to your use.

Do not use OpenTeam for commercial products, hosted services, paid workflows, bulk automation, spam, scraping, bypassing access controls or paid access, or anything that violates third-party terms or rights.

Use it at your own risk. The maintainers are not responsible for account restrictions, service interruptions, data loss, legal issues or other consequences of your use. This notice is not legal advice.

## Install

### Download a release

1. Download `openteam-extension-v<version>.zip` from the [latest release](https://github.com/Lushangtu123/openteam/releases/latest) and unzip it into a folder you will keep (Chrome loads the extension from that folder).
2. Open `chrome://extensions/`, turn on Developer mode, click **Load unpacked** and choose the folder.
3. Sign in to the AI websites you want to use in normal tabs, then click the OpenTeam icon.

To update, empty that folder, unzip the new version into it and click the reload button on OpenTeam in `chrome://extensions/`. Your chats are kept in the browser, so an update keeps them; removing OpenTeam from Chrome deletes them (make a backup in settings first).

### Build from source

```bash
git clone https://github.com/Lushangtu123/openteam.git
cd openteam
npm install
npm run build
```

Then load the generated `dist/` folder as in step 2 above.

After pulling changes, run `npm run build` again and click the reload button on OpenTeam in `chrome://extensions/`.

### Local agents and the CLI (optional)

Needed only for local agent members or to let an agent such as Codex or Claude Code control OpenTeam. Install the CLI tarball from the release (`npm install -g ./afumu-openteamcli-<version>.tgz`, then `openteamcli daemon start`), or run it from the repository folder:

```bash
npm run openteamcli -- daemon start
npm run openteamcli -- doctor
```

Then enable local agent control in OpenTeam's settings. To give your agent the OpenTeam control skill, install it from the repository folder:

```bash
npx skills add . --skill openteam-control
```

The daemon does not start by itself after a restart. On macOS, `npm run openteamcli -- daemon install` adds it as a LaunchAgent that starts at login; `daemon uninstall` removes it. See [OpenTeam CLI](packages/openteamcli/README.md) for all commands.

## Development

```bash
npm install
npm run dev       # watch build into dist/
npm run verify    # type check, unit tests and production build
npm run package   # after a build: release/ gets the extension ZIP, the CLI tarball and checksums
```

To publish a release, set the same version in `package.json` and `public/manifest.json`, commit, and push a tag `v<version>`. The release workflow checks the versions, runs the checks and attaches the files to a GitHub release.

`npm run visual:snap -- <folder>` and `npm run visual:compare -- <before> <after>` take screenshots of every screen (both looks, both themes, three widths) and compare two sets, with an accessibility check on each screen.

## Permissions and Privacy

- `storage` / `unlimitedStorage`: chats, people, memory, notes, settings and large chats.
- `tabs`: find and talk to OpenTeam and AI-site tabs and frames.
- `alarms`: runtime maintenance.
- `declarativeNetRequest`: adjust response headers so supported AI websites can open inside the workspace.
- `clipboardRead` / `clipboardWrite`: copy and paste.
- `cookies`: Grok's session cookies, so its live connection works inside the workspace (OpenTeam's own tabs only).
- `notifications`: tell you when everyone has answered (can be turned off).
- Host permissions: only the supported AI websites, their image hosts and the local daemon. Each API model address is allowed separately, when you click **Allow access** on that model.
- Microphone (no manifest permission): voice input uses Chrome's online speech recognition; Chrome asks the first time.

Attached images are stored in the browser (IndexedDB) and uploaded only when you send them. API keys stay in browser storage and are left out of backups unless you include them. There is no cloud sync; your conversations are processed by the AI websites and model providers you use, under their own terms.

## Current Limits

- Chrome / Chromium only.
- AI-site adapters depend on each site's page structure, so a redesign can break sending or reading replies.
- Embedding sites needs response-header changes through `declarativeNetRequest`, a heavier permission than a normal extension.
- Some sites refuse to run inside other pages on purpose (claude.ai today). OpenTeam shows this on the member's status and does not work around it.
- Signed-out sessions have limits: signed-out Gemini does not send images, and signed-out Grok asks you to sign in before drawing.
- Voice input needs a network connection.
- Famous-person advisor templates are prompts inspired by public ideas, not real people.
- Medical, legal, financial and other high-stakes answers still need human judgment and qualified advice.

## Repository Layout

```text
public/                 extension manifest, team page, styles, DNR rules
src/background/         service worker, message and command handlers, model clients
src/content/            AI-site content scripts and adapters
src/group/              group data model, store, roles, prompts, memory, mentions
src/teamPage/           OpenTeam workspace UI
packages/openteamcli/   local CLI and daemon for agents
docs/                   design documents
```

## Documentation

- [Design document](docs/DESIGN.md)
- [Team formation](docs/TEAM_FORMATION.md)
- [Project mode](docs/PROJECT_MODE.md)
- [Memory store (Chinese)](docs/MEMORY_STORE.zh-CN.md)
- [AI page health status](docs/AI_PAGE_HEALTH.md)
- [Images and attachments](docs/MULTIMODAL_ATTACHMENTS.md)
- [Local agents (ACP)](docs/ACP.md)
- [OpenTeam CLI](packages/openteamcli/README.md)
- [Contributing](CONTRIBUTING.md)

Issues and pull requests are welcome at [Lushangtu123/openteam](https://github.com/Lushangtu123/openteam). Run `npm run verify` before opening a pull request.

## License

Released under the [PolyForm Noncommercial License 1.0.0](LICENSE) (SPDX `PolyForm-Noncommercial-1.0.0`). You may use, study, modify and redistribute it for non-commercial purposes only; commercial use, commercial redistribution, hosted commercial services and paid workflows are not permitted without separate written permission.

Reading PDFs uses Mozilla's [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`), under the Apache License 2.0; the build includes its license at `pdfjs/LICENSE`.
