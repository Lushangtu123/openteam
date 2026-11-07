#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createServer } from 'node:http'
import { runStdioAcpAgent } from './acp-stdio.mjs'

export const DEFAULT_PORT = 19305
export const DEFAULT_TOKEN_PATH = resolve(homedir(), '.openteam/control-token')
export const DEFAULT_AGENT_CONFIG_PATH = resolve(homedir(), '.openteam/acp-agents.json')
// The extension ID is fixed by the `key` in public/manifest.json.
export const DEFAULT_EXTENSION_ORIGINS = ['chrome-extension://cnccbifloajlkjglmiojkpimjciamlpe']
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000
// A run in OpenTeam may wait for the user's permission answers, so it gets longer.
const DEFAULT_AGENT_RUN_TIMEOUT_MS = 30 * 60_000
const MAX_BODY_BYTES = 1024 * 1024
const AGENT_CAPABILITIES = ['agent.list', 'agent.run', 'agent.cancel', 'agent.read', 'agent.permission']
// What the extension may ask of the daemon over its WebSocket.
const EXTENSION_REQUEST_ACTIONS = new Set(['agent.list', 'agent.run', 'agent.cancel', 'agent.permission'])
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

export async function createControlDaemon(options = {}) {
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? readOrCreateToken(options.tokenPath ?? DEFAULT_TOKEN_PATH)
  const allowedExtensionOrigins = new Set(options.allowedExtensionOrigins ?? readAllowedExtensionOrigins())
  const logToConsole = options.logToConsole ?? true
  const startedAt = Date.now()
  const logs = []
  const pending = new Map()
  // Agents are read again on each use, so editing the config (or `openteamcli agent add`) needs
  // no restart; tests pass them in.
  const agentConfigPath = options.agentConfigPath ?? DEFAULT_AGENT_CONFIG_PATH
  const currentAgents = () => normalizeAcpAgents(options.acpAgents ?? safeReadAgentConfig(agentConfigPath, log))
  const agentRuns = new Map()
  let extension

  function log(event, details = {}) {
    const entry = { createdAt: Date.now(), event, details }
    logs.push(entry)
    if (logs.length > 300) logs.shift()
    if (logToConsole) console.error(`[openteam-daemon] ${event}`, details)
  }

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackHostHeader(request.headers.host)) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden_host', message: '只接受来自 127.0.0.1 的请求。' } })
        return
      }
      const url = new URL(request.url ?? '/', `http://${host}`)
      if (request.method === 'GET' && url.pathname === '/ping') {
        writeJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        writeJson(response, 200, status())
        return
      }
      if (url.pathname === '/logs') {
        if (!isAuthorized(request, token)) {
          writeJson(response, 401, permissionDenied())
          return
        }
        writeJson(response, 200, { ok: true, logs })
        return
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        if (!isAuthorized(request, token)) {
          writeJson(response, 401, permissionDenied())
          return
        }
        writeJson(response, 200, { ok: true })
        setTimeout(() => daemon.close(), 0)
        return
      }
      if (request.method === 'POST' && url.pathname === '/command') {
        if (!isAuthorized(request, token)) {
          writeJson(response, 401, permissionDenied())
          return
        }
        const command = normalizeCommand(await readJsonBody(request))
        const result = await executeDaemonCommand(command) ?? await forwardCommand(command)
        writeJson(response, result.ok ? 200 : statusForError(result.error?.code), result)
        return
      }
      writeJson(response, 404, { ok: false, error: { code: 'not_found', message: '接口不存在。' } })
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })

  server.on('upgrade', (request, socket) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`)
      if (url.pathname !== '/ext' || !isLoopbackHostHeader(request.headers.host)) {
        socket.destroy()
        return
      }
      // Browsers always send Origin on WebSocket handshakes and web pages cannot
      // forge it, so this keeps websites from impersonating the extension.
      const origin = request.headers.origin
      if (typeof origin !== 'string' || !allowedExtensionOrigins.has(origin)) {
        log('extension:rejected-origin', { origin: typeof origin === 'string' ? origin : null })
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') {
        socket.destroy()
        return
      }
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'))

      extension?.socket.destroy()
      extension = createExtensionConnection(socket, url.searchParams.get('profileId') || 'default')
      log('extension:connected', { profileId: extension.profileId })
    } catch {
      socket.destroy()
    }
  })

  const daemon = {
    get port() {
      const address = server.address()
      return typeof address === 'object' && address ? address.port : port
    },
    status,
    close,
  }

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen(undefined)
    })
  })

  function status() {
    return {
      ok: true,
      pid: process.pid,
      uptime: Date.now() - startedAt,
      daemonVersion: '0.1.0',
      extensionConnected: Boolean(extension?.open),
      extensionVersion: extension?.extensionVersion,
      protocolVersion: extension?.protocolVersion,
      profiles: extension?.open ? [{
        profileId: extension.profileId,
        connected: true,
        lastSeenAt: extension.lastSeenAt,
        capabilities: extension.capabilities,
      }] : [],
      agents: currentAgents().map(publicAgent),
      agentCapabilities: AGENT_CAPABILITIES,
      pending: pending.size,
      port: daemon.port,
    }
  }

  async function executeDaemonCommand(command) {
    switch (command.action) {
      case 'agent.list':
        return success(command.id, {
          agents: currentAgents().map(publicAgent),
          capabilities: AGENT_CAPABILITIES,
        })
      case 'agent.run':
        return runAgent(command)
      case 'agent.read':
        return readAgent(command)
      case 'agent.cancel':
        return cancelAgent(command)
      default:
        return undefined
    }
  }

  async function runAgent(command) {
    const input = requireRecord(command.payload, '缺少本地智能体运行参数。')
    const agentId = requireString(input.agentId ?? input.id, '缺少 agentId。')
    const prompt = requireString(input.prompt ?? input.content, '本地智能体任务内容不能为空。')
    const cwd = normalizeFsPath(readString(input.cwd) ?? process.cwd())
    const agent = currentAgents().find(item => item.id === agentId && item.enabled)
    if (!agent) return failure(command.id, 'agent_not_found', `找不到可用的本地智能体：${agentId}`)
    if (!isWorkspaceAllowed(cwd, agent.cwdAllowlist)) {
      return failure(command.id, 'workspace_not_allowed', '本地智能体工作目录不在允许范围内。', '请在 OpenTeam daemon 的 ACP agent 配置里加入该 workspace。')
    }

    const run = {
      id: newRunId(),
      agentId: agent.id,
      status: 'running',
      cwd,
      prompt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: undefined,
      output: undefined,
      error: undefined,
      cancel: undefined,
    }
    agentRuns.set(run.id, run)
    const controller = new AbortController()
    run.cancel = () => controller.abort()

    try {
      const timeoutMs = readPositiveNumber(input.timeoutMs) ?? command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      // From the command line nobody can answer a permission request, so the agent's requests are declined.
      const result = agent.type === 'stdio'
        ? await runStdioAcpAgent(agent, { prompt, cwd, timeoutMs, signal: controller.signal })
        : await runWebSocketAgent(agent, { prompt, cwd, timeoutMs, signal: controller.signal })
      run.status = 'completed'
      run.result = result
      run.output = extractAgentOutput(result)
      run.updatedAt = Date.now()
      run.cancel = undefined
      return success(command.id, { run: publicRun(run) })
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'
      run.error = error instanceof Error ? error.message : String(error)
      run.updatedAt = Date.now()
      run.cancel = undefined
      return failure(command.id, controller.signal.aborted ? 'agent_cancelled' : 'agent_failed', run.error)
    }
  }

  function readAgent(command) {
    const input = requireRecord(command.payload, '缺少本地智能体读取参数。')
    const runId = requireString(input.runId, '缺少 runId。')
    const run = agentRuns.get(runId)
    if (!run) return failure(command.id, 'agent_run_not_found', `找不到本地智能体运行记录：${runId}`)
    return success(command.id, { run: publicRun(run) })
  }

  function cancelAgent(command) {
    const input = requireRecord(command.payload, '缺少本地智能体取消参数。')
    const runId = requireString(input.runId, '缺少 runId。')
    const run = agentRuns.get(runId)
    if (!run) return failure(command.id, 'agent_run_not_found', `找不到本地智能体运行记录：${runId}`)
    if (run.status === 'running' && run.cancel) {
      run.cancel()
      run.status = 'cancelled'
      run.updatedAt = Date.now()
      run.cancel = undefined
      return success(command.id, { run: publicRun(run), cancelled: true })
    }
    return success(command.id, { run: publicRun(run), cancelled: false })
  }

  async function forwardCommand(command) {
    if (!extension?.open) {
      return failure(command.id, 'extension_not_connected', 'OpenTeam 扩展尚未连接到本地守护进程。', '请打开已启用 OpenTeam 扩展的 Chrome，并在 OpenTeam 设置里开启本机智能体控制。')
    }
    return new Promise(resolveCommand => {
      const timeout = setTimeout(() => {
        pending.delete(command.id)
        resolveCommand(failure(command.id, 'task_timeout', '等待 OpenTeam 扩展响应超时。'))
      }, command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
      pending.set(command.id, { resolve: resolveCommand, timeout })
      sendFrame(extension.socket, JSON.stringify({ type: 'command', command }))
    })
  }

  function createExtensionConnection(socket, profileId) {
    const connection = {
      socket,
      profileId,
      open: true,
      lastSeenAt: Date.now(),
      extensionVersion: undefined,
      protocolVersion: undefined,
      capabilities: [],
      buffer: Buffer.alloc(0),
      textFragments: [],
    }

    socket.on('data', chunk => {
      try {
        connection.buffer = Buffer.concat([connection.buffer, chunk])
        connection.buffer = readFrames(connection.buffer, frame => {
          if (frame.opcode === 8) {
            socket.end()
            return
          }
          if (frame.opcode === 9) {
            sendFrame(socket, frame.payload, 10)
            return
          }
          const text = readTextMessage(connection, frame)
          if (text === undefined) return
          handleExtensionMessage(connection, text)
        })
      } catch (error) {
        log('extension:message-error', { profileId: connection.profileId, error: error instanceof Error ? error.message : String(error) })
        socket.destroy()
      }
    })
    socket.on('close', () => {
      connection.open = false
      if (extension === connection) extension = undefined
      // Runs the extension started stop with it: nobody is left to see them or answer permissions.
      for (const run of agentRuns.values()) if (run.connection === connection && run.status === 'running') run.cancel?.()
      log('extension:closed', { profileId })
    })
    socket.on('error', error => {
      connection.open = false
      log('extension:error', { profileId, error: error.message })
    })
    return connection
  }

  function readTextMessage(connection, frame) {
    if (frame.opcode === 1) {
      if (frame.fin) return frame.payload.toString('utf8')
      connection.textFragments = [frame.payload]
      return undefined
    }
    if (frame.opcode !== 0) return undefined
    if (connection.textFragments.length === 0) return undefined
    connection.textFragments.push(frame.payload)
    if (!frame.fin) return undefined
    const payload = Buffer.concat(connection.textFragments)
    connection.textFragments = []
    return payload.toString('utf8')
  }

  function handleExtensionMessage(connection, raw) {
    connection.lastSeenAt = Date.now()
    const message = JSON.parse(raw)
    if (message.type === 'hello') {
      connection.extensionVersion = message.extensionVersion
      connection.protocolVersion = message.protocolVersion
      connection.profileId = message.profileId || connection.profileId
      connection.capabilities = Array.isArray(message.capabilities) ? message.capabilities : []
      log('extension:hello', { profileId: connection.profileId, capabilities: connection.capabilities })
      return
    }
    if (message.type === 'request' && message.request && typeof message.request.id === 'string') {
      void handleExtensionRequest(connection, message.request)
      return
    }
    if (message.type === 'result' && message.result?.id) {
      const entry = pending.get(message.result.id)
      if (!entry) return
      clearTimeout(entry.timeout)
      pending.delete(message.result.id)
      entry.resolve(message.result)
    }
  }

  // Requests from the extension itself (its WebSocket is checked for the extension's origin): list the
  // local agents, run one (its progress streams back as agent-event messages), answer one of its
  // permission requests, or cancel a run.
  async function handleExtensionRequest(connection, request) {
    const reply = response => {
      if (connection.open) sendFrame(connection.socket, JSON.stringify({ type: 'response', response }))
    }
    const id = request.id
    try {
      if (!EXTENSION_REQUEST_ACTIONS.has(request.action)) {
        reply(failure(id, 'unsupported_action', `不支持的请求：${request.action}`))
        return
      }
      const payload = request.payload && typeof request.payload === 'object' ? request.payload : {}
      if (request.action === 'agent.list') {
        reply(success(id, { agents: currentAgents().map(publicAgent) }))
        return
      }
      if (request.action === 'agent.cancel') {
        const run = agentRuns.get(readString(payload.runId))
        if (run?.status === 'running') run.cancel?.()
        reply(success(id, { cancelled: Boolean(run) }))
        return
      }
      if (request.action === 'agent.permission') {
        const run = agentRuns.get(readString(payload.runId))
        const waiting = run?.permissions?.get(readString(payload.permissionId))
        if (!waiting) {
          reply(failure(id, 'permission_not_found', '这个许可请求已经失效。'))
          return
        }
        run.permissions.delete(readString(payload.permissionId))
        waiting(readString(payload.optionId))
        reply(success(id, { answered: true }))
        return
      }
      reply(startExtensionRun(connection, id, payload))
    } catch (error) {
      reply(failure(id, 'internal_error', error instanceof Error ? error.message : String(error)))
    }
  }

  function startExtensionRun(connection, requestId, payload) {
    const agentId = readString(payload.agentId)
    const prompt = readString(payload.prompt)
    const cwdInput = readString(payload.cwd)
    if (!agentId || !prompt || !cwdInput) return failure(requestId, 'invalid_request', '缺少智能体、任务或工作目录。')
    const cwd = normalizeFsPath(cwdInput)
    const agent = currentAgents().find(item => item.id === agentId && item.enabled)
    if (!agent) return failure(requestId, 'agent_not_found', `找不到可用的本地智能体：${agentId}`)
    if (agent.type !== 'stdio') return failure(requestId, 'unsupported_agent_endpoint', '在 OpenTeam 里使用的本地智能体需要以 stdio 方式运行（ACP）。')
    if (!isWorkspaceAllowed(cwd, agent.cwdAllowlist)) {
      return failure(requestId, 'workspace_not_allowed', '工作目录不在这个智能体允许的范围内。', '用 openteamcli agent add 加入这个目录，或在 ~/.openteam/acp-agents.json 的 cwdAllowlist 里加上它。')
    }
    const controller = new AbortController()
    const run = {
      id: newRunId(),
      agentId: agent.id,
      status: 'running',
      cwd,
      prompt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancel: () => controller.abort(),
      permissions: new Map(),
      connection,
    }
    agentRuns.set(run.id, run)
    const emit = event => {
      if (run.connection.open) sendFrame(run.connection.socket, JSON.stringify({ type: 'agent-event', runId: run.id, event }))
    }
    log('agent:run-start', { runId: run.id, agentId: agent.id, cwd })
    runStdioAcpAgent(agent, {
      prompt,
      cwd,
      timeoutMs: readPositiveNumber(payload.timeoutMs) ?? DEFAULT_AGENT_RUN_TIMEOUT_MS,
      signal: controller.signal,
      onEvent: emit,
      // The user answers in OpenTeam; the run waits until then.
      requestPermission: ({ toolCall, options }) => new Promise(resolvePermission => {
        const permissionId = newRunId('permission')
        run.permissions.set(permissionId, resolvePermission)
        controller.signal.addEventListener('abort', () => resolvePermission(undefined), { once: true })
        emit({
          kind: 'permission',
          permissionId,
          title: typeof toolCall.title === 'string' ? toolCall.title : '',
          toolKind: typeof toolCall.kind === 'string' ? toolCall.kind : '',
          options,
        })
      }),
    })
      .then(result => {
        run.status = 'completed'
        run.output = result.output
        emit({ kind: 'done', output: result.output, stopReason: result.stopReason })
      })
      .catch(error => {
        run.status = controller.signal.aborted ? 'cancelled' : 'failed'
        run.error = error instanceof Error ? error.message : String(error)
        emit({ kind: controller.signal.aborted ? 'cancelled' : 'error', message: run.error })
      })
      .finally(() => {
        run.updatedAt = Date.now()
        run.cancel = undefined
        for (const waiting of run.permissions.values()) waiting(undefined)
        run.permissions.clear()
        log('agent:run-end', { runId: run.id, status: run.status })
      })
    return success(requestId, { runId: run.id })
  }

  async function close() {
    for (const run of agentRuns.values()) if (run.status === 'running') run.cancel?.()
    for (const entry of pending.values()) clearTimeout(entry.timeout)
    pending.clear()
    extension?.socket.destroy()
    await new Promise(resolveClose => server.close(() => resolveClose(undefined)))
  }

  return daemon
}

function success(id, data) {
  return {
    id,
    ok: true,
    ...(data === undefined ? {} : { data }),
  }
}

export function readOrCreateToken(tokenPath = DEFAULT_TOKEN_PATH) {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf8').trim()
    if (token) return token
  }
  mkdirSync(dirname(tokenPath), { recursive: true })
  const token = randomBytes(32).toString('base64url')
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return token
}

function normalizeCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('控制命令必须是 JSON 对象。')
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `cmd-${Date.now()}`
  const action = typeof raw.action === 'string' && raw.action.trim() ? raw.action.trim() : ''
  if (!action) throw new Error('缺少控制命令 action。')
  return {
    id,
    action,
    payload: raw.payload,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    profileId: typeof raw.profileId === 'string' ? raw.profileId : undefined,
  }
}

// Claude Code entries saved before `mode` existed start in `default` (it asks before each edit and
// command) rather than the adapter's own `auto`; `"mode": "auto"` in the entry keeps auto.
const CLAUDE_ADAPTER = '@agentclientprotocol/claude-agent-acp'

export function normalizeAcpAgents(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => {
      const id = readString(item.id) ?? `agent-${index + 1}`
      const type = item.type === 'websocket' || item.type === 'stdio' ? item.type : 'websocket'
      return {
        id,
        name: readString(item.name) ?? id,
        type,
        url: readString(item.url),
        command: readString(item.command),
        args: Array.isArray(item.args) ? item.args.filter(arg => typeof arg === 'string') : [],
        mode: readString(item.mode) ?? (Array.isArray(item.args) && item.args.some(arg => typeof arg === 'string' && arg.startsWith(CLAUDE_ADAPTER)) ? 'default' : undefined),
        env: item.env && typeof item.env === 'object' && !Array.isArray(item.env)
          ? Object.fromEntries(Object.entries(item.env).filter(([, value]) => typeof value === 'string'))
          : undefined,
        enabled: item.enabled !== false,
        cwdAllowlist: Array.isArray(item.cwdAllowlist) ? item.cwdAllowlist.map(readString).filter(Boolean).map(normalizeFsPath) : [],
        runMethod: readString(item.runMethod) ?? 'session/prompt',
      }
    })
}

function readAgentConfig(agentConfigPath) {
  const envConfig = process.env.OPENTEAM_ACP_AGENTS
  if (envConfig?.trim()) return readAgentConfigValue(JSON.parse(envConfig))
  if (!existsSync(agentConfigPath)) return []
  return readAgentConfigValue(JSON.parse(readFileSync(agentConfigPath, 'utf8')))
}

function safeReadAgentConfig(path, log) {
  try {
    return readAgentConfig(path)
  } catch (error) {
    log('agent:config-invalid', { path, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}

function readAgentConfigValue(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray(value.agents)) return value.agents
  return []
}

function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    type: agent.type,
    enabled: agent.enabled,
    cwdAllowlist: agent.cwdAllowlist,
  }
}

function publicRun(run) {
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    cwd: run.cwd,
    output: run.output,
    result: run.result,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

function requireRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value
}

function requireString(value, message) {
  const text = readString(value)
  if (!text) throw new Error(message)
  return text
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizeFsPath(value) {
  const resolved = resolve(value)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function isWorkspaceAllowed(cwd, allowlist) {
  if (allowlist.length === 0) return false
  return allowlist.some(root => cwd === root || cwd.startsWith(`${root}/`))
}

async function runWebSocketAgent(agent, input) {
  if (!agent.url) throw new Error('缺少 ACP WebSocket URL。')
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node.js 运行时不支持 WebSocket。')
  const requestId = newRunId('acp')
  const request = {
    jsonrpc: '2.0',
    id: requestId,
    method: agent.runMethod,
    params: {
      prompt: input.prompt,
      cwd: input.cwd,
    },
  }

  return new Promise((resolveRun, rejectRun) => {
    const socket = new WebSocket(agent.url)
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      callback(value)
    }
    const abort = () => finish(rejectRun, new Error('本地智能体运行已取消。'))
    const timeout = setTimeout(() => finish(rejectRun, new Error('本地智能体运行超时。')), input.timeoutMs)
    input.signal?.addEventListener('abort', abort, { once: true })
    socket.addEventListener('open', () => socket.send(JSON.stringify(request)))
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data))
        if (message.id !== requestId) return
        if (message.error) {
          finish(rejectRun, new Error(readString(message.error.message) ?? 'ACP agent returned an error.'))
          return
        }
        finish(resolveRun, message.result)
      } catch (error) {
        finish(rejectRun, error)
      }
    })
    socket.addEventListener('error', () => finish(rejectRun, new Error('无法连接 ACP agent。')))
    socket.addEventListener('close', () => {
      if (!settled) finish(rejectRun, new Error('ACP agent 连接已关闭。'))
    })
  })
}

function extractAgentOutput(result) {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return undefined
  if (typeof result.output === 'string') return result.output
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.content)) {
    return result.content
      .map(item => item && typeof item === 'object' && typeof item.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n') || undefined
  }
  return undefined
}

function newRunId(prefix = 'agent-run') {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`
}

function readAllowedExtensionOrigins() {
  const envOrigins = process.env.OPENTEAM_EXTENSION_ORIGINS
  if (!envOrigins?.trim()) return DEFAULT_EXTENSION_ORIGINS
  return envOrigins.split(',').map(origin => origin.trim()).filter(Boolean)
}

export function isLoopbackHostHeader(value) {
  if (typeof value !== 'string' || !value) return false
  const hostname = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0]
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())
}

function isAuthorized(request, token) {
  if (request.headers['x-openteam'] !== '1') return false
  const authorization = request.headers.authorization
  return authorization === `Bearer ${token}`
}

function permissionDenied() {
  return {
    ok: false,
    error: {
      code: 'permission_denied',
      message: '没有权限访问 OpenTeam 本地控制接口。',
      recoverable: false,
    },
  }
}

function failure(id, code, message, hint) {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      ...(hint ? { hint } : {}),
      recoverable: code !== 'permission_denied',
    },
  }
}

function statusForError(code) {
  if (code === 'permission_denied') return 401
  if (code === 'workspace_not_allowed') return 403
  if (code === 'agent_not_found' || code === 'agent_run_not_found') return 404
  if (code === 'extension_not_connected') return 503
  if (code === 'task_timeout' || code === 'agent_failed') return 504
  return 400
}

async function readJsonBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体超过 1 MB。')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function readFrames(buffer, onFrame) {
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = Boolean(first & 0x80)
    const opcode = first & 0x0f
    const masked = Boolean(second & 0x80)
    let length = second & 0x7f
    let headerLength = 2
    if (length === 126) {
      if (buffer.length - offset < 4) break
      length = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (length === 127) {
      if (buffer.length - offset < 10) break
      const bigLength = buffer.readBigUInt64BE(offset + 2)
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large')
      length = Number(bigLength)
      headerLength = 10
    }
    const maskLength = masked ? 4 : 0
    const frameLength = headerLength + maskLength + length
    if (buffer.length - offset < frameLength) break
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : undefined
    const payloadStart = offset + headerLength + maskLength
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length))
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
    }
    onFrame({ fin, opcode, payload })
    offset += frameLength
  }
  return buffer.subarray(offset)
}

function sendFrame(socket, data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.find(arg => arg.startsWith('--port='))
  const port = portArg ? Number(portArg.slice('--port='.length)) : DEFAULT_PORT
  createControlDaemon({ port })
    .then(daemon => {
      console.error(`[openteam-daemon] listening on 127.0.0.1:${daemon.port}`)
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
