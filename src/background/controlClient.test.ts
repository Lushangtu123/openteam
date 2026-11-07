import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENTEAM_CONTROL_DEFAULT_PORT, OPENTEAM_CONTROL_PROTOCOL_VERSION } from '../shared/localControlProtocol'
import type { OpenTeamControlConnectionStatus } from '../shared/localControlProtocol'
import { createDefaultStore } from '../group/store'
import { createControlClient } from './controlClient'

describe('background control client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not connect while local agent control is disabled', async () => {
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = false

    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    await client.sync()

    expect(sockets).toHaveLength(0)
  })

  it('connects to the configured daemon port and answers commands', async () => {
    const sockets: FakeWebSocket[] = []
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    vi.stubGlobal('fetch', fetchMock)
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    store.settings.agentControlPort = 19999
    const executeCommand = vi.fn(async () => ({ id: 'cmd-1', ok: true, data: { pong: true } }))
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand,
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    await client.sync()
    sockets[0].open()
    sockets[0].receive(JSON.stringify({ type: 'command', command: { id: 'cmd-1', action: 'store.get' } }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19999/ping', expect.objectContaining({ method: 'GET' }))
    expect(sockets[0].url).toBe('ws://127.0.0.1:19999/ext?profileId=profile-test')
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: 'hello',
      extensionVersion: '1.0.0',
      protocolVersion: OPENTEAM_CONTROL_PROTOCOL_VERSION,
      profileId: 'profile-test',
    })
    expect(JSON.parse(sockets[0].sent[1])).toEqual({
      type: 'result',
      result: { id: 'cmd-1', ok: true, data: { pong: true } },
    })
  })

  it('asks the daemon for local agent work and follows a run’s events', async () => {
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: (handler, ms) => setTimeout(handler, ms),
      clearTimer: timer => clearTimeout(timer),
    })

    // Not connected yet: the request fails at once, with how to fix it.
    expect(await client.request('agent.list')).toMatchObject({ ok: false, error: { code: 'daemon_not_connected', message: expect.stringContaining('openteamcli daemon start') } })

    await client.sync()
    sockets[0].open()
    const listed = client.request('agent.list')
    const sent = JSON.parse(sockets[0].sent[1])
    expect(sent).toMatchObject({ type: 'request', request: { action: 'agent.list', payload: {} } })
    sockets[0].receive(JSON.stringify({ type: 'response', response: { id: sent.request.id, ok: true, data: { agents: [{ id: 'claude-code' }] } } }))
    expect(await listed).toEqual({ id: sent.request.id, ok: true, data: { agents: [{ id: 'claude-code' }] } })

    const events: unknown[] = []
    const stop = client.onAgentEvents('run-1', event => events.push(event))
    sockets[0].receive(JSON.stringify({ type: 'agent-event', runId: 'run-1', event: { kind: 'text', text: '你好' } }))
    sockets[0].receive(JSON.stringify({ type: 'agent-event', runId: 'run-2', event: { kind: 'text', text: '别人的' } }))
    stop()
    sockets[0].receive(JSON.stringify({ type: 'agent-event', runId: 'run-1', event: { kind: 'text', text: '停止跟随后' } }))
    expect(events).toEqual([{ kind: 'text', text: '你好' }])

    // The connection dropping ends what was waiting.
    const pending = client.request('agent.run', { agentId: 'x' })
    const following: unknown[] = []
    client.onAgentEvents('run-3', event => following.push(event))
    sockets[0].close()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'daemon_disconnected' } })
    expect(following).toEqual([{ kind: 'error', message: '和 OpenTeam 本地守护进程的连接断开了。' }])
  })

  it('uses the default port when settings do not override it', async () => {
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    await client.sync()

    expect(sockets[0].url).toBe(`ws://127.0.0.1:${OPENTEAM_CONTROL_DEFAULT_PORT}/ext?profileId=profile-test`)
  })

  it('does not create a WebSocket when the daemon ping is unavailable', async () => {
    const sockets: FakeWebSocket[] = []
    const reconnectTimers: Array<{ handler: () => void; ms: number }> = []
    const fetchMock = vi.fn(async () => {
      throw new TypeError('daemon unavailable')
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    store.settings.agentControlPort = 19999
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn((handler, ms) => {
        reconnectTimers.push({ handler, ms })
        return reconnectTimers.length as unknown as ReturnType<typeof setTimeout>
      }),
      clearTimer: vi.fn(),
    })

    await client.sync()

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:19999/ping', expect.objectContaining({ method: 'GET' }))
    expect(sockets).toHaveLength(0)
    expect(reconnectTimers.map(timer => timer.ms)).toEqual([2_000])
  })

  it('reports local control connection status transitions', async () => {
    const sockets: FakeWebSocket[] = []
    const fetchMock = vi.fn(async () => ({ ok: true }))
    const statusUpdates: OpenTeamControlConnectionStatus[] = []
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
      onStatusChange: status => {
        statusUpdates.push(status)
      },
    })

    await client.sync()

    expect(client.status()).toMatchObject({
      state: 'connecting',
      port: OPENTEAM_CONTROL_DEFAULT_PORT,
      url: `ws://127.0.0.1:${OPENTEAM_CONTROL_DEFAULT_PORT}/ext?profileId=profile-test`,
    })

    sockets[0].open()

    expect(client.status()).toMatchObject({
      state: 'connected',
      port: OPENTEAM_CONTROL_DEFAULT_PORT,
    })
    expect(statusUpdates.map(status => (status as { state?: string }).state)).toEqual(['connecting', 'connected'])
  })

  it('reports a disconnected status when the daemon is unavailable', async () => {
    const reconnectTimers: Array<{ handler: () => void; ms: number }> = []
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('daemon unavailable')
    }))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn((handler, ms) => {
        reconnectTimers.push({ handler, ms })
        return reconnectTimers.length as unknown as ReturnType<typeof setTimeout>
      }),
      clearTimer: vi.fn(),
    })

    await client.sync()

    expect(client.status()).toMatchObject({
      state: 'disconnected',
      port: OPENTEAM_CONTROL_DEFAULT_PORT,
      lastError: 'OpenTeam CLI daemon is not reachable.',
    })
  })

  it('does not let an older daemon ping race override a newer port sync', async () => {
    const sockets: FakeWebSocket[] = []
    const firstPing = deferred<{ ok: boolean }>()
    const fetchMock = vi.fn((url: string) => {
      if (url === 'http://127.0.0.1:19999/ping') return firstPing.promise
      return Promise.resolve({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', fakeWebSocketClass(sockets))
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    store.settings.agentControlPort = 19999
    const client = createControlClient({
      loadStore: async () => store,
      executeCommand: vi.fn(),
      getExtensionVersion: () => '1.0.0',
      getProfileId: () => 'profile-test',
      log: testLog(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    })

    const firstSync = client.sync()
    await waitFor(() => fetchMock.mock.calls.length === 1)
    store.settings.agentControlPort = 20000
    const secondSync = client.sync()
    firstPing.resolve({ ok: true })
    await Promise.all([firstSync, secondSync])

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:20000/ping', expect.objectContaining({ method: 'GET' }))
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('ws://127.0.0.1:20000/ext?profileId=profile-test')
  })
})

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  readonly url: string
  sent: string[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(data: string): void {
    this.onmessage?.({ data })
  }
}

function fakeWebSocketClass(sockets: FakeWebSocket[]): typeof FakeWebSocket {
  return class extends FakeWebSocket {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
}

function testLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('waitFor timed out')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
