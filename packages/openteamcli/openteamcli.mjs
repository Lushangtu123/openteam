#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_AGENT_CONFIG_PATH, DEFAULT_PORT, DEFAULT_TOKEN_PATH, readOrCreateToken } from './openteam-daemon.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DAEMON_SCRIPT = resolve(__dirname, 'openteam-daemon.mjs')
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000

export function buildCliRequest(argv) {
  const [group, subcommand, ...rest] = argv
  const options = parseOptions(rest)

  if (!group || group === 'help' || group === '--help' || group === '-h') return { kind: 'help' }
  if (group === 'doctor') return { kind: 'doctor' }

  if (group === 'daemon') {
    if (subcommand === 'start') return { kind: 'daemon-start' }
    if (subcommand === 'status') return { kind: 'daemon-status' }
    if (subcommand === 'stop') return { kind: 'daemon-stop' }
    if (subcommand === 'restart') return { kind: 'daemon-restart' }
    if (subcommand === 'logs') return { kind: 'daemon-logs' }
  }

  if (group === 'chat') {
    if (subcommand === 'list') return command('chat.list')
    if (subcommand === 'get') return command('chat.get', { chatId: positional(rest, 0) ?? requireOption(options, 'chat') })
    if (subcommand === 'create') return command('chat.create', {
      name: requireOption(options, 'name'),
      description: options.description,
      mode: options.mode,
      // How members answer a message to several of them (协作 groups): review (answer, then review
      // each other), turns or parallel; --reply-all makes a message without @ reach everyone.
      ...(typeof options.style === 'string' ? { collaboration: { style: options.style, replyAll: options['reply-all'] === true } } : {}),
    })
    if (subcommand === 'activate') return command('chat.activate', { chatId: positional(rest, 0) ?? requireOption(options, 'chat') })
    if (subcommand === 'initialize') return command('chat.initialize', {
      chatId: requireOption(options, 'chat'),
      waitForReady: true,
      timeoutMs: numberOption(options.timeout),
    })
  }

  if (group === 'role') {
    if (subcommand === 'list') return command('chat.get', { chatId: requireOption(options, 'chat') })
    if (subcommand === 'batch-add') {
      return {
        kind: 'file-command',
        action: 'roles.batchAdd',
        file: requireOption(options, 'file'),
        decoratePayload: payload => ({
          chatId: requireOption(options, 'chat'),
          ...(Array.isArray(payload) ? { items: payload } : payload),
        }),
      }
    }
  }

  if (group === 'task') {
    if (subcommand === 'post') return command('task.post', {
      chatId: requireOption(options, 'chat'),
      target: parseTarget(options.target ?? 'all'),
      content: requireOption(options, 'content'),
    })
    if (subcommand === 'read') return command('task.read', {
      chatId: requireOption(options, 'chat'),
      messageId: requireOption(options, 'message'),
    })
    if (subcommand === 'wait') return command('task.wait', {
      chatId: requireOption(options, 'chat'),
      messageId: requireOption(options, 'message'),
      timeoutMs: numberOption(options.timeout),
    })
  }

  if (group === 'run' && subcommand === 'create-and-post') {
    return {
      kind: 'file-command',
      action: 'run.createAndPost',
      file: requireOption(options, 'file'),
      wait: options.wait === true,
      decoratePayload: payload => ({
        ...payload,
        options: {
          ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.options : {}),
          ...(options.wait === true ? {
            waitForReplies: true,
            waitForReady: true,
            activateChat: true,
            openTeamPage: true,
          } : {}),
          ...(numberOption(options.timeout) ? { timeoutMs: numberOption(options.timeout) } : {}),
        },
      }),
    }
  }

  if (group === 'agent') {
    if (subcommand === 'add') return { kind: 'agent-add', agent: agentFromOptions(options) }
    if (subcommand === 'remove') return { kind: 'agent-remove', id: positional(rest, 0) ?? requireOption(options, 'id') }
    if (subcommand === 'list') return command('agent.list')
    if (subcommand === 'run') return command('agent.run', {
      agentId: requireOption(options, 'agent'),
      prompt: requireOption(options, 'content'),
      cwd: requireOption(options, 'cwd'),
      timeoutMs: numberOption(options.timeout),
    })
  }

  throw new Error(`未知命令：${argv.join(' ')}`)
}

async function main(argv) {
  try {
    const request = buildCliRequest(argv)
    const result = await runRequest(request)
    if (result !== undefined) writeJson(result)
  } catch (error) {
    writeJson({
      ok: false,
      error: {
        code: 'cli_error',
        message: error instanceof Error ? error.message : String(error),
      },
    })
    process.exitCode = 1
  }
}

async function runRequest(request) {
  if (request.kind === 'help') return help()
  if (request.kind === 'daemon-start') return startDaemon()
  if (request.kind === 'daemon-status') return getDaemonStatus()
  if (request.kind === 'daemon-stop') return stopDaemon()
  if (request.kind === 'daemon-restart') {
    await stopDaemon().catch(() => undefined)
    return startDaemon()
  }
  if (request.kind === 'daemon-logs') return daemonFetch('/logs')
  if (request.kind === 'doctor') return doctor()
  if (request.kind === 'agent-add') {
    const saved = saveAgent(agentConfigPath(), request.agent)
    // The values (API keys) are saved, but not printed: the output may be shared or logged.
    return { ok: true, ...saved, agent: withHiddenEnv(saved.agent) }
  }
  if (request.kind === 'agent-remove') return { ok: true, ...removeAgent(agentConfigPath(), request.id) }
  if (request.kind === 'command') {
    await ensureDaemon()
    return daemonFetch('/command', { method: 'POST', body: request.command })
  }
  if (request.kind === 'file-command') {
    const filePayload = JSON.parse(readFileSync(resolve(process.cwd(), request.file), 'utf8'))
    const payload = request.decoratePayload ? request.decoratePayload(filePayload) : filePayload
    await ensureDaemon()
    return daemonFetch('/command', {
      method: 'POST',
      body: {
        id: newCommandId(),
        action: request.action,
        payload,
        timeoutMs: payload?.options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      },
    })
  }
  throw new Error('未知请求类型')
}

async function doctor() {
  await ensureDaemon()
  const status = await getDaemonStatus()
  return {
    ok: Boolean(status.ok && status.extensionConnected),
    daemon: {
      reachable: Boolean(status.ok),
      port: status.port,
      pid: status.pid,
    },
    extension: {
      connected: Boolean(status.extensionConnected),
      version: status.extensionVersion,
      protocolVersion: status.protocolVersion,
      profiles: status.profiles ?? [],
    },
    hint: status.extensionConnected ? undefined : '请打开 OpenTeam 页面，在设置里开启“本机智能体控制”。',
  }
}

async function ensureDaemon() {
  try {
    await getDaemonStatus()
    return
  } catch {
    await startDaemon()
  }
}

async function startDaemon() {
  try {
    const status = await getDaemonStatus()
    return { ok: true, alreadyRunning: true, status }
  } catch {
    const child = spawn(process.execPath, [DAEMON_SCRIPT, `--port=${controlPort()}`], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    await waitForDaemon()
    return { ok: true, started: true, status: await getDaemonStatus() }
  }
}

async function stopDaemon() {
  return daemonFetch('/shutdown', { method: 'POST', body: {} })
}

async function waitForDaemon(timeoutMs = 2_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await getDaemonStatus()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }
  throw new Error('本地守护进程启动超时')
}

async function getDaemonStatus() {
  const response = await fetch(controlUrl('/status'))
  if (!response.ok) throw new Error(`本地守护进程不可用：HTTP ${response.status}`)
  return response.json()
}

async function daemonFetch(path, options = {}) {
  const token = readOrCreateToken(DEFAULT_TOKEN_PATH)
  const response = await fetch(controlUrl(path), {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenTeam': '1',
      Authorization: `Bearer ${token}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const data = await response.json()
  if (!response.ok) {
    const message = data?.error?.message ?? `请求失败：HTTP ${response.status}`
    const error = new Error(message)
    error.data = data
    throw error
  }
  return data
}

function command(action, payload) {
  return {
    kind: 'command',
    command: {
      id: newCommandId(),
      action,
      ...(payload === undefined ? {} : { payload }),
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  }
}

function parseTarget(value) {
  if (!value || value === 'all') return 'all'
  if (String(value).startsWith('role:')) return { roleIds: [String(value).slice('role:'.length)] }
  if (String(value).startsWith('name:')) return { roleNames: [String(value).slice('name:'.length)] }
  return value
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    if (key === 'wait') {
      options.wait = true
      continue
    }
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    index += 1
  }
  return options
}

function positional(args, position) {
  return args.filter(item => !item.startsWith('--'))[position]
}

function requireOption(options, key) {
  const value = options[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少 --${key}`)
  return value.trim()
}

function numberOption(value) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function controlPort() {
  const parsed = Number(process.env.OPENTEAM_DAEMON_PORT)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT
}

function controlUrl(path) {
  return `http://127.0.0.1:${controlPort()}${path}`
}

function newCommandId() {
  return `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// Well-known ACP adapters. npx downloads the adapter the first time it runs.
export const AGENT_PRESETS = {
  // Formerly @zed-industries/claude-code-acp and @zed-industries/codex-acp, which are deprecated.
  // `default` mode: Claude Code asks before each edit and command (its adapter otherwise starts in
  // `auto`, where Claude Code approves what it judges safe by itself).
  'claude-code': { id: 'claude-code', name: 'Claude Code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], mode: 'default' },
  codex: { id: 'codex', name: 'Codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
  gemini: { id: 'gemini-cli', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'] },
}

// The full path of a program on PATH, if it is there.
export function findOnPath(name, path = process.env.PATH ?? '') {
  for (const folder of path.split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here.
    }
  }
  return undefined
}

// Extra environment for the agent, from `--env KEY=VALUE[,KEY=VALUE]`.
function envFromOption(value) {
  if (typeof value !== 'string') return {}
  const env = {}
  for (const pair of value.split(',').map(item => item.trim()).filter(Boolean)) {
    const equals = pair.indexOf('=')
    if (equals <= 0) throw new Error(`--env 的格式是 KEY=VALUE：${pair}`)
    env[pair.slice(0, equals)] = pair.slice(equals + 1)
  }
  return env
}

// A local agent to add, from `agent add` options. Folders are checked to exist; `~` is the home folder.
export function agentFromOptions(options) {
  const preset = typeof options.preset === 'string' ? AGENT_PRESETS[options.preset] : undefined
  if (options.preset !== undefined && !preset) throw new Error(`没有这个预设：${options.preset}（可选 ${Object.keys(AGENT_PRESETS).join('、')}）`)
  const commandLine = typeof options.command === 'string' ? options.command.trim().split(/\s+/) : undefined
  const command = commandLine?.[0] ?? preset?.command
  if (!command) throw new Error('请用 --preset 选一个智能体，或用 --command 写出启动命令')
  const id = typeof options.id === 'string' ? options.id.trim() : preset?.id
  if (!id || !/^[\w.-]{1,40}$/.test(id)) throw new Error('请用 --id 给智能体起一个 ID（字母、数字、- _ .）')
  const cwdAllowlist = String(requireOption(options, 'cwd')).split(',').map(item => item.trim()).filter(Boolean).map(folder => {
    const absolute = resolve(folder.replace(/^~(?=$|\/)/, homedir()))
    if (!existsSync(absolute)) throw new Error(`文件夹不存在：${absolute}`)
    return realpathSync(absolute)
  })
  // Claude Code's adapter starts its own bundled copy of Claude Code; pointing it at the installed
  // `claude` makes it use the same program, settings and login as the terminal.
  const installedClaude = options.preset === 'claude-code' ? findOnPath('claude') : undefined
  const env = { ...(installedClaude ? { CLAUDE_CODE_EXECUTABLE: installedClaude } : {}), ...envFromOption(options.env) }
  return {
    id,
    name: typeof options.name === 'string' ? options.name.trim() : preset?.name ?? id,
    type: 'stdio',
    command,
    args: commandLine ? commandLine.slice(1) : preset?.args ?? [],
    ...(Object.keys(env).length ? { env } : {}),
    ...((typeof options.mode === 'string' ? options.mode.trim() : preset?.mode) ? { mode: typeof options.mode === 'string' ? options.mode.trim() : preset.mode } : {}),
    enabled: true,
    cwdAllowlist,
  }
}

function agentConfigPath() {
  return process.env.OPENTEAM_ACP_AGENTS_FILE || DEFAULT_AGENT_CONFIG_PATH
}

function readAgentsFile(path) {
  if (!existsSync(path)) return []
  const value = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(value) ? value : Array.isArray(value?.agents) ? value.agents : []
}

// Adds the agent to the config file, or replaces the one with its ID. The daemon reads the file on
// each use, so it needs no restart.
export function saveAgent(path, agent) {
  const agents = readAgentsFile(path).filter(item => item?.id !== agent.id)
  agents.push(agent)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ agents }, null, 2)}\n`, { mode: 0o600 })
  return { agent, configPath: path }
}

// The agent as printed: its environment values hidden, all but the last four characters.
export function withHiddenEnv(agent) {
  if (!agent.env) return agent
  return { ...agent, env: Object.fromEntries(Object.entries(agent.env).map(([key, value]) => [key, key === 'CLAUDE_CODE_EXECUTABLE' ? value : hideValue(value)])) }
}

function hideValue(value) {
  const text = String(value)
  return text.length <= 8 ? '********' : `********${text.slice(-4)}`
}

export function removeAgent(path, id) {
  const agents = readAgentsFile(path)
  const kept = agents.filter(item => item?.id !== id)
  if (kept.length === agents.length) throw new Error(`没有这个智能体：${id}`)
  writeFileSync(path, `${JSON.stringify({ agents: kept }, null, 2)}\n`, { mode: 0o600 })
  return { removed: id, configPath: path }
}

export function help() {
  return {
    ok: true,
    commands: [
      'openteamcli doctor',
      'openteamcli daemon start|status|stop|restart|logs',
      'openteamcli chat list|get|create|activate|initialize',
      'openteamcli chat create --name <name> [--mode collaborative|independent] [--style review|turns|parallel] [--reply-all]',
      'openteamcli role batch-add --chat <chatId> --file roles.json',
      'openteamcli task post|wait|read',
      'openteamcli run create-and-post --file task.json --wait',
      'openteamcli agent list|run --agent <id> --content <prompt> --cwd <path>',
      'openteamcli agent add --preset claude-code|codex|gemini --cwd <folder>[,<folder>] [--id <id>] [--name <name>] [--env KEY=VALUE,...] [--mode <session mode>]',
      'openteamcli agent add --id <id> --name <name> --command "<command and arguments>" --cwd <folder>[,<folder>]',
      'openteamcli agent remove <id>',
    ],
  }
}

function isMainModule(importMetaUrl, argvPath) {
  if (!argvPath) return false
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argvPath)
  } catch {
    return fileURLToPath(importMetaUrl) === argvPath
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
}
