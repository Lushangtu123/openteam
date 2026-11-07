// Runs one prompt on a local agent that speaks ACP (Agent Client Protocol: JSON-RPC 2.0, one message
// per line, over the agent's stdin and stdout), as Claude Code, Codex and Gemini CLI do through their
// ACP adapters. The agent works in one folder: OpenTeam answers its file reads and writes only inside
// that folder, and asks the user (through `requestPermission`) whenever the agent asks permission
// for a tool call.
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const ACP_PROTOCOL_VERSION = 1
const STDERR_TAIL_CHARS = 2000
const CANCEL_GRACE_MS = 2000
const MAX_READ_BYTES = 2 * 1024 * 1024

export class AcpError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

// ACP's error for an agent that is not logged in.
const AUTH_REQUIRED_CODE = -32000

// What to tell the user when the agent needs a login: how the agent itself says to log in.
export function loginHint(authMethods) {
  const ways = (Array.isArray(authMethods) ? authMethods : [])
    .map(method => [method?.name, method?.description].filter(text => typeof text === 'string' && text.trim()).join('：'))
    .filter(Boolean)
  return ways.length
    ? `本机智能体还没有登录，请先登录后再试（${ways.join('；')}）。`
    : '本机智能体还没有登录，请先在终端里登录它后再试（例如 Claude Code：运行 claude，再输入 /login）。'
}

/**
 * @param {{ command: string, args?: string[], env?: Record<string, string> }} agent
 * @param {{
 *   prompt: string,
 *   cwd: string,
 *   timeoutMs: number,
 *   signal?: AbortSignal,
 *   onEvent?: (event: Record<string, unknown>) => void,
 *   requestPermission?: (request: { toolCall: Record<string, unknown>, options: Array<{ optionId: string, name: string, kind: string }> }) => Promise<string | undefined>,
 * }} input
 */
export async function runStdioAcpAgent(agent, input) {
  if (!agent.command) throw new AcpError('缺少启动本地智能体的命令。')
  const workspace = await realpath(input.cwd)
  const child = spawn(agent.command, agent.args ?? [], {
    cwd: workspace,
    env: { ...process.env, ...(agent.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const onEvent = input.onEvent ?? (() => {})
  const pending = new Map()
  const tools = new Map()
  let nextId = 1
  let sessionId
  let output = ''
  let stderrTail = ''
  let stdoutBuffer = ''
  let exited = false
  let exitError

  const exitedPromise = new Promise(resolveExit => {
    child.on('exit', (code, signal) => {
      exited = true
      exitError = new AcpError(`本地智能体已退出（${signal ?? code}）${stderrTail.trim() ? `：${stderrTail.trim().slice(-400)}` : ''}`)
      for (const entry of pending.values()) entry.reject(exitError)
      pending.clear()
      resolveExit(undefined)
    })
  })
  child.on('error', error => {
    exitError = new AcpError(`无法启动本地智能体：${error.message}`)
    for (const entry of pending.values()) entry.reject(exitError)
    pending.clear()
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line) handleLine(line)
      newline = stdoutBuffer.indexOf('\n')
    }
  })

  function send(message) {
    if (exited || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  function request(method, params) {
    if (exitError) return Promise.reject(exitError)
    const id = nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
      send({ id, method, params })
    })
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // Agents sometimes print a stray line; it is not part of the protocol.
      return
    }
    if (!message || typeof message !== 'object') return
    if (message.method && message.id !== undefined) {
      void answerAgentRequest(message)
      return
    }
    if (message.method) {
      handleNotification(message)
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new AcpError(readMessage(message.error) ?? '本地智能体返回了错误。', message.error?.code))
    else entry.resolve(message.result)
  }

  function handleNotification(message) {
    if (message.method !== 'session/update') return
    const update = message.params?.update
    if (!update || typeof update !== 'object') return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content)
        if (text) {
          output += text
          onEvent({ kind: 'text', text })
        }
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(update.toolCallId ?? '')
        const known = tools.get(id) ?? {}
        const tool = {
          id,
          title: typeof update.title === 'string' && update.title ? update.title : known.title ?? '',
          toolKind: typeof update.kind === 'string' ? update.kind : known.toolKind,
          status: typeof update.status === 'string' ? update.status : known.status ?? 'pending',
        }
        tools.set(id, tool)
        onEvent({ kind: 'tool', ...tool })
        return
      }
      case 'plan':
        onEvent({ kind: 'plan', entries: Array.isArray(update.entries) ? update.entries.map(entry => ({ content: String(entry?.content ?? ''), status: String(entry?.status ?? '') })) : [] })
        return
      default:
    }
  }

  async function answerAgentRequest(message) {
    try {
      switch (message.method) {
        case 'session/request_permission': {
          const options = Array.isArray(message.params?.options) ? message.params.options.map(option => ({
            optionId: String(option?.optionId ?? ''),
            name: String(option?.name ?? option?.optionId ?? ''),
            kind: String(option?.kind ?? ''),
          })).filter(option => option.optionId) : []
          const toolCall = message.params?.toolCall && typeof message.params.toolCall === 'object' ? message.params.toolCall : {}
          const chosen = input.requestPermission ? await input.requestPermission({ toolCall, options }) : undefined
          const valid = chosen && options.some(option => option.optionId === chosen)
          send({ id: message.id, result: { outcome: valid ? { outcome: 'selected', optionId: chosen } : { outcome: 'cancelled' } } })
          return
        }
        case 'fs/read_text_file': {
          const path = await pathInside(workspace, message.params?.path)
          const bytes = await readFile(path)
          if (bytes.length > MAX_READ_BYTES) throw new AcpError('文件太大，无法读取。')
          let content = bytes.toString('utf8')
          const line = Number(message.params?.line)
          const limit = Number(message.params?.limit)
          if (Number.isInteger(line) && line > 0) {
            const lines = content.split('\n')
            content = lines.slice(line - 1, Number.isInteger(limit) && limit > 0 ? line - 1 + limit : undefined).join('\n')
          }
          onEvent({ kind: 'file', action: 'read', path: relative(workspace, path) })
          send({ id: message.id, result: { content } })
          return
        }
        case 'fs/write_text_file': {
          const path = await pathInside(workspace, message.params?.path)
          if (typeof message.params?.content !== 'string') throw new AcpError('缺少要写入的内容。')
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, message.params.content, 'utf8')
          onEvent({ kind: 'file', action: 'write', path: relative(workspace, path) })
          send({ id: message.id, result: null })
          return
        }
        default:
          send({ id: message.id, error: { code: -32601, message: `OpenTeam does not support ${message.method}` } })
      }
    } catch (error) {
      send({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    void stop()
  }, input.timeoutMs)
  const abort = () => void stop()
  input.signal?.addEventListener('abort', abort, { once: true })

  // Asks the agent to stop, then ends its process.
  async function stop() {
    if (sessionId) send({ method: 'session/cancel', params: { sessionId } })
    await Promise.race([exitedPromise, new Promise(resolveWait => setTimeout(resolveWait, CANCEL_GRACE_MS))])
    if (!exited) child.kill()
  }

  let authMethods = []
  try {
    const initialized = await request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'OpenTeam', version: '0.1.0' },
    })
    authMethods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : []
    const session = await request('session/new', { cwd: workspace, mcpServers: [] })
    sessionId = typeof session?.sessionId === 'string' ? session.sessionId : undefined
    if (!sessionId) throw new AcpError('本地智能体没有开始会话。')
    onEvent({ kind: 'started' })
    const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] })
    if (input.signal?.aborted) throw new AcpError('本地智能体运行已取消。')
    return { output, stopReason: typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn', tools: [...tools.values()] }
  } catch (error) {
    if (timedOut) throw new AcpError('本地智能体运行超时。')
    if (input.signal?.aborted) throw new AcpError('本地智能体运行已取消。')
    if (error instanceof AcpError && ((error.code === AUTH_REQUIRED_CODE && /auth/i.test(error.message)) || /authentication required|not logged in|please run \/login/i.test(error.message))) {
      throw new AcpError(loginHint(authMethods), AUTH_REQUIRED_CODE)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
    if (!exited) {
      child.stdin.end()
      await Promise.race([exitedPromise, new Promise(resolveWait => setTimeout(resolveWait, 500))])
      if (!exited) child.kill()
    }
  }
}

// An absolute path the agent named, if it lies inside the workspace (symbolic links included).
export async function pathInside(workspace, value) {
  if (typeof value !== 'string' || !value.trim()) throw new AcpError('缺少文件路径。')
  if (!isAbsolute(value)) throw new AcpError('文件路径必须是绝对路径。')
  const target = resolve(value)
  if (!isWithin(workspace, target)) throw new AcpError('不能访问工作目录以外的文件。')
  // The nearest folder that exists must also resolve inside, so a link cannot lead outside.
  let existing = target
  for (;;) {
    try {
      const real = await realpath(existing)
      if (!isWithin(workspace, real)) throw new AcpError('不能访问工作目录以外的文件。')
      break
    } catch (error) {
      if (error instanceof AcpError) throw error
      const parent = dirname(existing)
      if (parent === existing) throw new AcpError('不能访问工作目录以外的文件。')
      existing = parent
    }
  }
  return target
}

function isWithin(root, path) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function textOf(content) {
  if (!content || typeof content !== 'object') return ''
  return content.type === 'text' && typeof content.text === 'string' ? content.text : ''
}

function readMessage(error) {
  return error && typeof error === 'object' && typeof error.message === 'string' ? error.message : undefined
}
