#!/usr/bin/env node
// A stand-in ACP agent for tests: it answers initialize and session/new, and for each prompt it
// writes text, announces a tool call, asks permission, and writes hello.txt through the client.
// "ESCAPE" in the prompt makes it try to write outside its folder; "SLOW" makes it wait until
// cancelled; "READ" makes it read hello.txt back.
import { join } from 'node:path'

let buffer = ''
let nextId = 1000
const waiting = new Map()
let cwd = process.cwd()
let cancelled = false
let mode = 'auto'
let releaseSlow

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function call(method, params) {
  const id = nextId++
  send({ id, method, params })
  return new Promise(resolve => waiting.set(id, resolve))
}

function update(sessionId, value) {
  send({ method: 'session/update', params: { sessionId, update: value } })
}

function say(sessionId, text) {
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

async function prompt(id, params) {
  const sessionId = params.sessionId
  const text = params.prompt?.map(part => part.text ?? '').join('') ?? ''
  cancelled = false
  say(sessionId, `好的，我来写文件（${mode}）。\n`)
  if (text.includes('SLOW')) {
    await new Promise(resolve => { releaseSlow = resolve })
    send({ id, result: { stopReason: 'cancelled' } })
    return
  }
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: '写入 hello.txt', kind: 'edit', status: 'pending' })
  const permission = await call('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'c1', title: '写入 hello.txt', kind: 'edit' },
    options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }],
  })
  const allowed = permission.result?.outcome?.outcome === 'selected' && permission.result.outcome.optionId === 'allow'
  if (allowed) {
    const written = await call('fs/write_text_file', { sessionId, path: join(cwd, 'hello.txt'), content: `你好，来自 OpenTeam：${text.slice(0, 40)}\n` })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: written.error ? 'failed' : 'completed' })
    say(sessionId, written.error ? `写入失败：${written.error.message}\n` : '已写入 hello.txt。\n')
  } else {
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' })
    say(sessionId, '没有获得许可，未写入。\n')
  }
  if (text.includes('READ')) {
    const read = await call('fs/read_text_file', { sessionId, path: join(cwd, 'hello.txt') })
    say(sessionId, `读到：${read.result?.content ?? read.error?.message}`)
  }
  if (text.includes('ESCAPE')) {
    const escaped = await call('fs/write_text_file', { sessionId, path: '/tmp/openteam-escape-test.txt', content: 'x' })
    say(sessionId, escaped.error ? `越界写入被拒绝：${escaped.error.message}\n` : '越界写入成功了！\n')
  }
  send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
}

function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = waiting.get(message.id)
    waiting.delete(message.id)
    resolve?.(message)
    return
  }
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: process.env.MOCK_ACP_AUTH ? [{ id: 'claude-login', name: 'Log in with Claude Code', description: 'Run `claude /login` in the terminal' }] : [] } })
      return
    case 'session/new':
      // MOCK_ACP_AUTH: an agent that is not logged in, as Claude Code's adapter answers then.
      if (process.env.MOCK_ACP_AUTH) {
        send({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
        return
      }
      cwd = message.params.cwd
      send({ id: message.id, result: { sessionId: 'session-1', modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'default', name: 'Default' }] } } })
      return
    case 'session/set_mode':
      if (message.params.modeId === 'default' || message.params.modeId === 'auto') {
        mode = message.params.modeId
        send({ id: message.id, result: {} })
      } else {
        send({ id: message.id, error: { code: -32602, message: `unknown mode ${message.params.modeId}` } })
      }
      return
    case 'session/prompt':
      void prompt(message.id, message.params)
      return
    case 'session/cancel':
      cancelled = true
      releaseSlow?.()
      return
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'unknown method' } })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line) handle(JSON.parse(line))
    newline = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
