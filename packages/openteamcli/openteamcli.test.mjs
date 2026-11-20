import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCliRequest, help, siteCheckExitCode } from './openteamcli.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('openteamcli command builder', () => {
  it('builds doctor and daemon commands', () => {
    expect(buildCliRequest(['doctor'])).toEqual({ kind: 'doctor' })
    expect(buildCliRequest(['daemon', 'status'])).toEqual({ kind: 'daemon-status' })
    expect(buildCliRequest(['daemon', 'stop'])).toEqual({ kind: 'daemon-stop' })
    expect(buildCliRequest(['daemon', 'install'])).toEqual({ kind: 'daemon-install' })
    expect(buildCliRequest(['daemon', 'uninstall'])).toEqual({ kind: 'daemon-uninstall' })
  })

  it('builds chat, role, task, and run control commands', () => {
    expect(buildCliRequest(['chat', 'list'])).toMatchObject({
      kind: 'command',
      command: { action: 'chat.list' },
    })
    expect(buildCliRequest(['chat', 'create', '--name', '评审群', '--mode', 'independent'])).toMatchObject({
      kind: 'command',
      command: { action: 'chat.create', payload: { name: '评审群', mode: 'independent' } },
    })
    expect(buildCliRequest(['chat', 'create', '--name', '评审群', '--mode', 'collaborative', '--style', 'review', '--reply-all'])).toMatchObject({
      kind: 'command',
      command: { action: 'chat.create', payload: { name: '评审群', mode: 'collaborative', collaboration: { style: 'review', replyAll: true } } },
    })
    expect(buildCliRequest(['role', 'batch-add', '--chat', 'chat-1', '--file', 'roles.json'])).toMatchObject({
      kind: 'file-command',
      action: 'roles.batchAdd',
      file: 'roles.json',
      decoratePayload: expect.any(Function),
    })
    expect(buildCliRequest(['task', 'post', '--chat', 'chat-1', '--target', 'all', '--content', '请评估'])).toMatchObject({
      kind: 'command',
      command: { action: 'task.post', payload: { chatId: 'chat-1', target: 'all', content: '请评估' } },
    })
    expect(buildCliRequest(['memory', 'search', '--chat', 'chat-1', '--role', 'name:后端', '--query', '数据库'])).toMatchObject({
      kind: 'command',
      command: { action: 'memory.search', payload: { chatId: 'chat-1', roleName: '后端', query: '数据库' } },
    })
    expect(buildCliRequest(['memory', 'search', '--chat', 'chat-1', '--role', 'role:role-be', '--limit', '3'])).toMatchObject({
      command: { action: 'memory.search', payload: { chatId: 'chat-1', roleId: 'role-be', limit: 3 } },
    })
    // Without --query nothing else is taken for one, not the chat id either.
    expect(buildCliRequest(['memory', 'search', '--chat', 'chat-1', '--role', 'name:后端']).command.payload).toEqual({ chatId: 'chat-1', roleName: '后端' })
    expect(buildCliRequest(['memory', 'add', '--scope', 'chat', '--chat', 'chat-1', '--kind', 'decision', '--content', '数据库用 PostgreSQL', '--tags', '数据库，后端', '--pinned'])).toMatchObject({
      command: { action: 'memory.add', payload: { scope: 'chat', chatId: 'chat-1', kind: 'decision', content: '数据库用 PostgreSQL', tags: ['数据库', '后端'], pinned: true } },
    })
    expect(buildCliRequest(['memory', 'add', '--scope', 'global', '--content', '回答简短'])).toMatchObject({
      command: { action: 'memory.add', payload: { scope: 'global', kind: 'fact', content: '回答简短' } },
    })
    expect(() => buildCliRequest(['memory', 'add', '--content', '回答简短'])).toThrow('缺少 --scope')
    // 群资料库: a text file, or text given on the command line.
    expect(buildCliRequest(['library', 'add', '--chat', 'chat-1', '--file', 'docs/需求.md'])).toEqual({ kind: 'text-file-command', action: 'library.add', file: 'docs/需求.md', payload: { chatId: 'chat-1', kind: 'file', title: '需求.md', source: '需求.md' } })
    expect(buildCliRequest(['library', 'add', '--chat', 'chat-1', '--title', '纪要', '--text', '预算提醒在八成时推送'])).toMatchObject({ kind: 'command', command: { action: 'library.add', payload: { chatId: 'chat-1', kind: 'note', title: '纪要', text: '预算提醒在八成时推送' } } })
    expect(buildCliRequest(['library', 'list', '--chat', 'chat-1'])).toMatchObject({ command: { action: 'library.list', payload: { chatId: 'chat-1' } } })
    expect(() => buildCliRequest(['library', 'add', '--chat', 'chat-1'])).toThrow('缺少 --text')
    expect(() => buildCliRequest(['memory', 'search', '--chat', 'chat-1'])).toThrow('缺少 --role')
    expect(buildCliRequest(['run', 'create-and-post', '--file', 'task.json', '--wait'])).toMatchObject({
      kind: 'file-command',
      action: 'run.createAndPost',
      file: 'task.json',
      wait: true,
    })
    expect(buildCliRequest(['agent', 'list'])).toMatchObject({
      kind: 'command',
      command: { action: 'agent.list' },
    })
    expect(buildCliRequest(['agent', 'run', '--agent', 'opencode', '--content', '请修复 issue', '--cwd', process.cwd()])).toMatchObject({
      kind: 'command',
      command: {
        action: 'agent.run',
        payload: {
          agentId: 'opencode',
          prompt: '请修复 issue',
          cwd: process.cwd(),
        },
      },
    })
  })

  it('uses the openteamcli name in help output', () => {
    expect(help()).toEqual({
      ok: true,
      commands: [
        'openteamcli doctor',
        'openteamcli daemon start|status|stop|restart|logs',
        'openteamcli daemon install|uninstall',
        'openteamcli chat list|get|create|activate|initialize',
        'openteamcli chat create --name <name> [--mode collaborative|independent] [--style review|turns|parallel] [--reply-all]',
        'openteamcli role batch-add --chat <chatId> --file roles.json',
        'openteamcli task post|wait|read',
        'openteamcli run create-and-post --file task.json --wait',
        'openteamcli memory search --chat <chatId> --role name:<name>|role:<id> [--query <text>] [--limit <n>]',
        'openteamcli site-check [--no-wait] [--timeout <ms>]',
        'openteamcli memory add --scope global|chat|role [--chat <chatId>] [--role name:<name>|role:<id>] [--kind fact|decision|preference|note] --content <text> [--tags a,b] [--pinned]',
        'openteamcli library add --chat <chatId> (--file <path> | --text <text>) [--title <title>]',
        'openteamcli library list --chat <chatId>',
        'openteamcli agent list|run --agent <id> --content <prompt> --cwd <path>',
        'openteamcli agent add --preset claude-code|codex|gemini --cwd <folder>[,<folder>] [--id <id>] [--name <name>] [--env KEY=VALUE,...] [--mode <session mode>]',
        'openteamcli agent add --id <id> --name <name> --command "<command and arguments>" --cwd <folder>[,<folder>] [--remote-cwd <folder on the remote machine>]',
        'openteamcli agent remove <id>',
      ],
    })
  })

  it('runs when invoked through an npm-style bin symlink', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openteamcli-bin-'))
    const binPath = join(tempDir, 'openteamcli')
    symlinkSync(resolve(__dirname, 'openteamcli.mjs'), binPath)

    try {
      const result = spawnSync(binPath, ['help'], { encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('openteamcli doctor')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('adds and removes local agents in the config file', async () => {
    const { mkdtempSync, readFileSync, rmSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { agentFromOptions, saveAgent, removeAgent, buildCliRequest } = await import('./openteamcli.mjs')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ot-cli-')))
    const configPath = join(folder, 'acp-agents.json')
    try {
      const savedPath = process.env.PATH
      process.env.PATH = join(folder, 'no-bin')
      const preset = agentFromOptions({ preset: 'claude-code', cwd: folder })
      expect(preset).toEqual({ id: 'claude-code', name: 'Claude Code', type: 'stdio', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], mode: 'default', enabled: true, cwdAllowlist: [folder] })
      expect(agentFromOptions({ preset: 'claude-code', cwd: folder, mode: 'plan' }).mode).toBe('plan')
      expect(agentFromOptions({ preset: 'codex', cwd: folder }).mode).toBeUndefined()
      // With Claude Code installed, the adapter is pointed at it, so it uses that login.
      const { mkdirSync, writeFileSync, chmodSync } = await import('node:fs')
      mkdirSync(join(folder, 'bin'))
      writeFileSync(join(folder, 'bin', 'claude'), '#!/bin/sh\n')
      chmodSync(join(folder, 'bin', 'claude'), 0o755)
      process.env.PATH = join(folder, 'bin')
      expect(agentFromOptions({ preset: 'claude-code', cwd: folder, env: 'FOO=1,BAR=a=b' }).env).toEqual({ CLAUDE_CODE_EXECUTABLE: join(folder, 'bin', 'claude'), FOO: '1', BAR: 'a=b' })
      expect(agentFromOptions({ preset: 'codex', cwd: folder }).env).toBeUndefined()
      expect(() => agentFromOptions({ preset: 'codex', cwd: folder, env: 'NOEQUALS' })).toThrow('--env 的格式是 KEY=VALUE')
      // Printed back with the values hidden, so a key does not end up in logs or shared output.
      const { withHiddenEnv } = await import('./openteamcli.mjs')
      expect(withHiddenEnv({ id: 'x', env: { CLAUDE_CODE_EXECUTABLE: '/bin/claude', ANTHROPIC_API_KEY: 'sk-ant-1234567890abcd', SHORT: 'abc' } }).env)
        .toEqual({ CLAUDE_CODE_EXECUTABLE: '/bin/claude', ANTHROPIC_API_KEY: '********abcd', SHORT: '********' })
      process.env.PATH = savedPath
      const custom = agentFromOptions({ id: 'mine', name: '我的智能体', command: 'node agent.mjs --acp', cwd: `${folder},${folder}` })
      expect(custom).toMatchObject({ id: 'mine', command: 'node', args: ['agent.mjs', '--acp'], cwdAllowlist: [folder, folder] })
      // An agent in a VM, started over SSH: the folder it works in there.
      expect(agentFromOptions({ id: 'deepseek-vm', name: 'DeepSeek（VM）', command: 'ssh -T -o BatchMode=yes harness-vm bin/dsh-acp', cwd: folder, 'remote-cwd': '/home/purge/workspace/' }))
        .toMatchObject({ command: 'ssh', args: ['-T', '-o', 'BatchMode=yes', 'harness-vm', 'bin/dsh-acp'], cwdAllowlist: [folder], remoteCwd: '/home/purge/workspace' })
      expect(() => agentFromOptions({ id: 'x', command: 'ssh vm', cwd: folder, 'remote-cwd': 'workspace' })).toThrow('--remote-cwd 要写远程机器上的绝对路径')
      expect(agentFromOptions({ id: 'x', command: 'ssh vm', cwd: folder }).remoteCwd).toBeUndefined()
      expect(() => agentFromOptions({ preset: 'nope', cwd: folder })).toThrow('没有这个预设')
      expect(() => agentFromOptions({ preset: 'codex', cwd: join(folder, 'missing') })).toThrow('文件夹不存在')
      expect(buildCliRequest(['agent', 'remove', 'mine'])).toEqual({ kind: 'agent-remove', id: 'mine' })

      saveAgent(configPath, preset)
      saveAgent(configPath, custom)
      saveAgent(configPath, { ...custom, name: '改名了' })
      expect(JSON.parse(readFileSync(configPath, 'utf8')).agents.map(agent => [agent.id, agent.name])).toEqual([['claude-code', 'Claude Code'], ['mine', '改名了']])
      removeAgent(configPath, 'claude-code')
      expect(JSON.parse(readFileSync(configPath, 'utf8')).agents.map(agent => agent.id)).toEqual(['mine'])
      expect(() => removeAgent(configPath, 'claude-code')).toThrow('没有这个智能体')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('openteamcli site-check', () => {
  it('asks the extension to run the check, waiting long enough for every site', () => {
    const request = buildCliRequest(['site-check'])
    expect(request).toMatchObject({ kind: 'command', command: { action: 'site.check', payload: {} } })
    // The check may take over six minutes: the daemon must not give up before it does.
    expect(request.command.timeoutMs).toBeGreaterThanOrEqual(420_000)
  })

  it('can return as soon as the check starts, and take a time limit', () => {
    expect(buildCliRequest(['site-check', '--no-wait']).command.payload).toEqual({ wait: false })
    const limited = buildCliRequest(['site-check', '--timeout', '60000'])
    expect(limited.command.payload).toEqual({ timeoutMs: 60000 })
    expect(limited.command.timeoutMs).toBeGreaterThan(60000)
  })

  it('exits with 2 when a site needs attention or the check ran out of time, so a scheduled job notices', () => {
    expect(siteCheckExitCode({ ok: true, data: { finished: true, needsAttention: 0, waiting: 0 } })).toBe(0)
    expect(siteCheckExitCode({ ok: true, data: { finished: true, needsAttention: 1, waiting: 0 } })).toBe(2)
    expect(siteCheckExitCode({ ok: true, data: { finished: false, needsAttention: 0, waiting: 2 } })).toBe(2)
    expect(siteCheckExitCode({ ok: true, data: { finished: true, needsAttention: 0, waiting: 0, error: '没有一个网站的页面打开了。' } })).toBe(2)
    // Started without waiting: nothing to judge yet.
    expect(siteCheckExitCode({ ok: true, data: { chatId: 'c', finished: false } })).toBe(0)
    expect(siteCheckExitCode({ ok: false, error: { message: 'x' } })).toBe(1)
  })

  it('is in the help', () => {
    expect(JSON.stringify(help())).toContain('openteamcli site-check')
  })
})
