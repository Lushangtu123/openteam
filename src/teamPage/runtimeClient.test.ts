import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { createStoreSyncEncoder, type StoreSyncPayload } from '../group/storeSync'
import type { OpenTeamStore } from '../group/types'

function storeWithChat(name: string): OpenTeamStore {
  const store = createDefaultStore()
  store.chatOrder = ['chat-1']
  store.chatsById['chat-1'] = { id: 'chat-1', name, mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  return store
}

async function createClient(respond: (message: Record<string, unknown>) => unknown) {
  vi.resetModules()
  const runtimeSendMessage = vi.fn((message: Record<string, unknown>, callback: (response: unknown) => void) => {
    callback(JSON.parse(JSON.stringify(respond(message))))
  })
  vi.stubGlobal('chrome', { runtime: { lastError: undefined, sendMessage: runtimeSendMessage } })
  const { createTeamPageRuntimeClient } = await import('./runtimeClient')
  const applyStore = vi.fn()
  const refreshStore = vi.fn(async () => undefined)
  const client = createTeamPageRuntimeClient({
    getHostTabId: () => 321,
    applyStore,
    refreshStore,
    log: { debug: vi.fn(), warn: vi.fn() },
  })
  return { client, runtimeSendMessage, applyStore, refreshStore }
}

describe('team page runtime client', () => {
  it('adds hostTabId to outgoing messages and applies command stores', async () => {
    vi.resetModules()
    const runtimeSendMessage = vi.fn((_message, callback) => callback({ ok: true, store: createDefaultStore() }))
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: undefined,
        sendMessage: runtimeSendMessage,
      },
    })

    const { createTeamPageRuntimeClient } = await import('./runtimeClient')
    const applyStore = vi.fn()
    const refreshStore = vi.fn()
    const client = createTeamPageRuntimeClient({
      getHostTabId: () => 321,
      applyStore,
      refreshStore,
      log: { debug: vi.fn(), warn: vi.fn() },
    })

    await client.runCommand('GROUP_CHAT_SWITCH', { chatId: 'chat-1' })

    expect(runtimeSendMessage).toHaveBeenCalledWith(
      // The first message asks for a full store; the page has none to apply deltas to yet.
      { type: 'GROUP_CHAT_SWITCH', chatId: 'chat-1', hostTabId: 321, storeSync: true, storeSyncReset: true },
      expect.any(Function),
    )
    expect(applyStore).toHaveBeenCalledWith(expect.objectContaining({ version: expect.any(Number) }))
    expect(refreshStore).not.toHaveBeenCalled()
  })

  it('rebuilds the store from deltas and only asks for a full store when it has none', async () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    let current = storeWithChat('first')
    const { client, runtimeSendMessage } = await createClient(message => {
      if (message.storeSyncReset === true) encoder.reset(321)
      return { ok: true, storeSync: encoder.encode(current, 321) }
    })

    expect((await client.sendRuntimeMessage('GROUP_STORE_GET')).store?.chatsById['chat-1'].name).toBe('first')
    current = storeWithChat('second')
    const response = await client.sendRuntimeMessage('GROUP_CHAT_RENAME')

    expect(response.store?.chatsById['chat-1'].name).toBe('second')
    expect(response).not.toHaveProperty('storeSync')
    expect(runtimeSendMessage.mock.calls[0][0]).toMatchObject({ storeSync: true, storeSyncReset: true })
    expect(runtimeSendMessage.mock.calls[1][0]).toMatchObject({ storeSync: true })
    expect(runtimeSendMessage.mock.calls[1][0]).not.toHaveProperty('storeSyncReset')
  })

  it('fetches a full store when a response delta builds on one it never received', async () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    let current = storeWithChat('first')
    let skipNext = false
    const { client, runtimeSendMessage } = await createClient(message => {
      if (message.storeSyncReset === true) encoder.reset(321)
      const payload = encoder.encode(current, 321)
      if (skipNext) {
        skipNext = false
        // This payload is lost; the next one builds on it.
        current = storeWithChat('third')
        return { ok: true, storeSync: encoder.encode(current, 321) }
      }
      return { ok: true, storeSync: payload }
    })

    await client.sendRuntimeMessage('GROUP_STORE_GET')
    current = storeWithChat('second')
    skipNext = true
    const response = await client.sendRuntimeMessage('GROUP_CHAT_RENAME')

    expect(response.ok).toBe(true)
    expect(response.store?.chatsById['chat-1'].name).toBe('third')
    expect(runtimeSendMessage.mock.calls[runtimeSendMessage.mock.calls.length - 1][0]).toMatchObject({ type: 'GROUP_STORE_GET', storeSyncReset: true })
  })

  it('applies pushed deltas and reloads the store once when pushes have a gap', async () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const store = storeWithChat('first')
    const { client, refreshStore } = await createClient(() => ({ ok: true, storeSync: encoder.encode(store, 321) }))
    await client.sendRuntimeMessage('GROUP_STORE_GET')
    const deliver = (payload: StoreSyncPayload) => JSON.parse(JSON.stringify(payload)) as StoreSyncPayload

    const applied = client.receiveStorePush(deliver(encoder.encode(storeWithChat('pushed'), 321)))
    expect(applied?.chatsById['chat-1'].name).toBe('pushed')

    encoder.encode(storeWithChat('lost'), 321)
    expect(client.receiveStorePush(deliver(encoder.encode(storeWithChat('after gap'), 321)))).toBeUndefined()
    expect(client.receiveStorePush(deliver(encoder.encode(storeWithChat('after gap 2'), 321)))).toBeUndefined()
    expect(refreshStore).toHaveBeenCalledTimes(1)
  })
})
