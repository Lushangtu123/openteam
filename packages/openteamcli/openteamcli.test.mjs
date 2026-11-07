import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCliRequest, help } from './openteamcli.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('openteamcli command builder', () => {
  it('builds doctor and daemon commands', () => {
    expect(buildCliRequest(['doctor'])).toEqual({ kind: 'doctor' })
    expect(buildCliRequest(['daemon', 'status'])).toEqual({ kind: 'daemon-status' })
    expect(buildCliRequest(['daemon', 'stop'])).toEqual({ kind: 'daemon-stop' })
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
        'openteamcli chat list|get|create|activate|initialize',
        'openteamcli role batch-add --chat <chatId> --file roles.json',
        'openteamcli task post|wait|read',
        'openteamcli run create-and-post --file task.json --wait',
        'openteamcli agent list|run --agent <id> --content <prompt> --cwd <path>',
        'openteamcli agent add --preset claude-code|codex|gemini --cwd <folder>[,<folder>] [--id <id>] [--name <name>]',
        'openteamcli agent add --id <id> --name <name> --command "<command and arguments>" --cwd <folder>[,<folder>]',
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
      const preset = agentFromOptions({ preset: 'claude-code', cwd: folder })
      expect(preset).toEqual({ id: 'claude-code', name: 'Claude Code', type: 'stdio', command: 'npx', args: ['-y', '@zed-industries/claude-code-acp'], enabled: true, cwdAllowlist: [folder] })
      const custom = agentFromOptions({ id: 'mine', name: '我的智能体', command: 'node agent.mjs --acp', cwd: `${folder},${folder}` })
      expect(custom).toMatchObject({ id: 'mine', command: 'node', args: ['agent.mjs', '--acp'], cwdAllowlist: [folder, folder] })
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
