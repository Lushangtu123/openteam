import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import { createStoreSyncDecoder, createStoreSyncEncoder, type StoreSyncPayload } from './storeSync'
import type { GroupMessage, OpenTeamStore } from './types'

const TAB = 7

// Extension messaging copies messages as JSON.
function deliver(payload: StoreSyncPayload): StoreSyncPayload {
  return JSON.parse(JSON.stringify(payload))
}

function asStored(store: OpenTeamStore): unknown {
  return JSON.parse(JSON.stringify(store))
}

function makeStore(messageCount: number): OpenTeamStore {
  const store = createDefaultStore()
  for (const chatId of ['chat-1', 'chat-2']) {
    const messageIds = Array.from({ length: messageCount }, (_, index) => `${chatId}-msg-${index}`)
    store.chatOrder.push(chatId)
    store.chatsById[chatId] = { id: chatId, name: chatId, mode: 'independent', roleIds: [], messageIds, nextMessageSeq: messageCount + 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    messageIds.forEach((id, index) => {
      store.messagesById[id] = makeMessage(chatId, id, index + 1)
    })
  }
  return store
}

function makeMessage(chatId: string, id: string, seq: number, content = `message ${seq}`): GroupMessage {
  return { id, chatId, seq, type: 'user', content, createdAt: seq, status: 'sent' }
}

function addMessage(store: OpenTeamStore, chatId: string, id: string): void {
  const chat = store.chatsById[chatId]
  store.messagesById[id] = makeMessage(chatId, id, chat.nextMessageSeq)
  chat.messageIds = [...chat.messageIds, id]
  chat.nextMessageSeq += 1
}

describe('store sync', () => {
  it('sends the whole store first and then only the entries that changed', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const decoder = createStoreSyncDecoder()
    const store = makeStore(50)
    for (const message of Object.values(store.messagesById)) message.content = '模型回复内容 '.repeat(60)

    const first = encoder.encode(store, TAB)
    expect(first.baseSequence).toBeUndefined()
    expect(Object.keys(first.store.messagesById)).toHaveLength(100)
    expect(decoder.receive(deliver(first))).toMatchObject({ status: 'applied' })

    const next = structuredClone(store)
    next.messagesById['chat-2-msg-3'].content = 'edited'
    addMessage(next, 'chat-2', 'chat-2-new')
    delete next.messagesById['chat-1-msg-0']
    next.chatsById['chat-1'].messageIds = next.chatsById['chat-1'].messageIds.slice(1)
    next.settings.defaultChatSite = 'claude'
    const delta = encoder.encode(next, TAB)

    expect(delta.baseSequence).toBe(first.sequence)
    expect(Object.keys(delta.store.messagesById).sort()).toEqual(['chat-2-msg-3', 'chat-2-new'])
    expect(Object.keys(delta.store.chatsById).sort()).toEqual(['chat-1', 'chat-2'])
    expect(delta.removed).toEqual({ messagesById: ['chat-1-msg-0'] })
    expect(delta.store.rolesById).toEqual({})

    const result = decoder.receive(deliver(delta))
    expect(result.status).toBe('applied')
    if (result.status === 'gap') return
    expect(asStored(result.store)).toEqual(asStored(next))
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(first).length / 10)
  })

  it('sends nothing for collections whose entries did not change', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const store = makeStore(20)
    encoder.encode(store, TAB)

    const repeat = encoder.encode(structuredClone(store), TAB)

    expect(repeat.store.messagesById).toEqual({})
    expect(repeat.store.chatsById).toEqual({})
    expect(repeat.removed).toBeUndefined()
  })

  it('notices changes made in place to a store that was already encoded', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const store = makeStore(3)
    encoder.encode(store, TAB)

    store.messagesById['chat-1-msg-1'].content = 'changed after it was sent'
    const delta = encoder.encode(store, TAB)

    expect(delta.store.messagesById['chat-1-msg-1']?.content).toBe('changed after it was sent')
  })

  it('applies a delta that arrives early once the one before it arrives', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const decoder = createStoreSyncDecoder()
    const store = makeStore(5)
    decoder.receive(deliver(encoder.encode(store, TAB)))

    const second = structuredClone(store)
    addMessage(second, 'chat-1', 'a')
    const secondPayload = encoder.encode(second, TAB)
    const third = structuredClone(second)
    addMessage(third, 'chat-1', 'b')
    const thirdPayload = encoder.encode(third, TAB)

    expect(decoder.receive(deliver(thirdPayload))).toEqual({ status: 'gap' })
    expect(decoder.needsFullStore()).toBe(true)

    const result = decoder.receive(deliver(secondPayload))
    expect(result.status).toBe('applied')
    if (result.status === 'gap') return
    expect(asStored(result.store)).toEqual(asStored(third))
    expect(decoder.needsFullStore()).toBe(false)
  })

  it('ignores a payload older than one already applied and returns the newer store', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const decoder = createStoreSyncDecoder()
    const store = makeStore(2)
    const older = encoder.encode(store, TAB)
    const newerStore = structuredClone(store)
    newerStore.chatsById['chat-1'].name = 'renamed'
    encoder.reset(TAB)
    const newer = encoder.encode(newerStore, TAB)

    decoder.receive(deliver(newer))
    const result = decoder.receive(deliver(older))

    expect(result.status).toBe('stale')
    if (result.status === 'gap') return
    expect(result.store.chatsById['chat-1'].name).toBe('renamed')
  })

  it('accepts a fresh full store after the background restarts', () => {
    const decoder = createStoreSyncDecoder()
    const before = createStoreSyncEncoder('epoch-1')
    const store = makeStore(2)
    decoder.receive(deliver(before.encode(store, TAB)))
    addMessage(store, 'chat-1', 'x')
    decoder.receive(deliver(before.encode(store, TAB)))

    const restarted = createStoreSyncEncoder('epoch-2')
    const afterRestart = structuredClone(store)
    afterRestart.chatsById['chat-2'].name = 'after restart'
    const result = decoder.receive(deliver(restarted.encode(afterRestart, TAB)))

    expect(result.status).toBe('applied')
    if (result.status === 'gap') return
    expect(result.store.chatsById['chat-2'].name).toBe('after restart')
  })

  it('cannot apply a delta without a base and asks for a full store', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const store = makeStore(2)
    encoder.encode(store, TAB)
    const delta = encoder.encode(store, TAB)
    const reloadedPage = createStoreSyncDecoder()

    expect(reloadedPage.needsFullStore()).toBe(true)
    expect(reloadedPage.receive(deliver(delta))).toEqual({ status: 'gap' })

    encoder.reset(TAB)
    const full = encoder.encode(store, TAB)
    expect(full.baseSequence).toBeUndefined()
    expect(reloadedPage.receive(deliver(full)).status).toBe('applied')
    expect(reloadedPage.needsFullStore()).toBe(false)
  })

  it('keeps fields that become undefined undefined', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const decoder = createStoreSyncDecoder()
    const store = makeStore(1)
    store.chatNotesById = { 'chat-1': { type: 'doc', content: [] } as never }
    decoder.receive(deliver(encoder.encode(store, TAB)))

    const next = structuredClone(store)
    next.chatNotesById = undefined
    const result = decoder.receive(deliver(encoder.encode(next, TAB)))

    expect(result.status).toBe('applied')
    if (result.status === 'gap') return
    expect(result.store.chatNotesById).toBeUndefined()
  })

  it('tracks each team page separately', () => {
    const encoder = createStoreSyncEncoder('epoch-1')
    const store = makeStore(3)
    encoder.encode(store, 1)

    expect(encoder.isTracking(1)).toBe(true)
    expect(encoder.isTracking(2)).toBe(false)
    expect(encoder.encode(store, 2).baseSequence).toBeUndefined()
    expect(encoder.encode(store, 1).baseSequence).toBe(1)

    encoder.forget(1)
    expect(encoder.isTracking(1)).toBe(false)
  })

  it('reproduces every store across a long run of random changes', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const encoder = createStoreSyncEncoder('epoch-1')
    const decoder = createStoreSyncDecoder()
    let store = makeStore(10)
    decoder.receive(deliver(encoder.encode(store, TAB)))
    let nextId = 0

    for (let step = 0; step < 300; step += 1) {
      store = structuredClone(store)
      const chatId = random() < 0.5 ? 'chat-1' : 'chat-2'
      const chat = store.chatsById[chatId]
      const roll = random()
      if (roll < 0.4) {
        addMessage(store, chatId, `random-${nextId++}`)
      } else if (roll < 0.6 && chat.messageIds.length > 0) {
        const id = chat.messageIds[Math.floor(random() * chat.messageIds.length)]
        store.messagesById[id] = { ...store.messagesById[id], content: `edit ${step}` }
      } else if (roll < 0.75 && chat.messageIds.length > 0) {
        const id = chat.messageIds[Math.floor(random() * chat.messageIds.length)]
        delete store.messagesById[id]
        chat.messageIds = chat.messageIds.filter(messageId => messageId !== id)
      } else if (roll < 0.85) {
        store.rolesById[`role-${step}`] = { id: `role-${step}`, chatId, name: `role ${step}`, status: 'ready', contextCursor: 0, createdAt: step, updatedAt: step }
      } else {
        chat.status = chat.status === 'ready' ? 'running' : 'ready'
      }

      // Every few steps two payloads arrive in swapped order.
      if (step % 7 === 3) {
        const firstStore = store
        const firstPayload = encoder.encode(firstStore, TAB)
        store = structuredClone(store)
        addMessage(store, chatId, `random-${nextId++}`)
        const secondPayload = encoder.encode(store, TAB)
        expect(decoder.receive(deliver(secondPayload)).status).toBe('gap')
        const result = decoder.receive(deliver(firstPayload))
        if (result.status === 'gap') throw new Error('missing payload was not applied')
        expect(asStored(result.store)).toEqual(asStored(store))
        continue
      }

      const result = decoder.receive(deliver(encoder.encode(store, TAB)))
      if (result.status === 'gap') throw new Error(`gap at step ${step}`)
      expect(asStored(result.store)).toEqual(asStored(store))
    }
    expect(decoder.needsFullStore()).toBe(false)
  })
})
