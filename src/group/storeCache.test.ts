import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupMessage, OpenTeamStore } from './types'

type StoreModule = typeof import('./store')
type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void

// chrome.storage.local with the parts of Chrome's behaviour the store cache relies on:
// values are copied as JSON, and onChanged reports only keys whose value changed, after the write.
function createFakeStorage() {
  let stored: Record<string, unknown> = {}
  const listeners: ChangeListener[] = []
  const pendingEvents: Array<Promise<void>> = []

  const emit = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (Object.keys(changes).length === 0) return
    pendingEvents.push(new Promise(resolve => setTimeout(() => {
      for (const listener of listeners) listener(changes, 'local')
      resolve()
    }, 0)))
  }
  const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

  const local = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return copy(stored)
      const list = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(list.filter(key => key in stored).map(key => [key, copy(stored[key])]))
    }),
    getKeys: vi.fn(async () => Object.keys(stored)),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, chrome.storage.StorageChange> = {}
      const next = { ...stored }
      for (const [key, value] of Object.entries(items)) {
        const newValue = copy(value)
        if (JSON.stringify(stored[key]) === JSON.stringify(newValue)) continue
        changes[key] = { oldValue: stored[key], newValue }
        next[key] = newValue
      }
      stored = next
      emit(changes)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const changes: Record<string, chrome.storage.StorageChange> = {}
      const next = { ...stored }
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!(key in next)) continue
        changes[key] = { oldValue: next[key] }
        delete next[key]
      }
      stored = next
      emit(changes)
    }),
  }

  return {
    local,
    onChanged: { addListener: vi.fn((listener: ChangeListener) => listeners.push(listener)) },
    read: (key: string) => stored[key],
    settle: async () => {
      while (pendingEvents.length > 0) await pendingEvents.shift()
    },
  }
}

describe('group store cache', () => {
  let storage: ReturnType<typeof createFakeStorage>
  let storeModule: StoreModule

  beforeEach(async () => {
    vi.resetModules()
    storage = createFakeStorage()
    vi.stubGlobal('chrome', { storage: { local: storage.local, onChanged: storage.onChanged } })
    storeModule = await import('./store')
  })

  function storeWithChats(messagesPerChat: number): OpenTeamStore {
    const store = storeModule.createDefaultStore()
    for (const chatId of ['chat-1', 'chat-2']) {
      const messageIds = Array.from({ length: messagesPerChat }, (_, index) => `${chatId}-msg-${index + 1}`)
      store.chatOrder.push(chatId)
      store.chatsById[chatId] = {
        id: chatId,
        name: chatId,
        mode: 'independent',
        roleIds: [],
        messageIds,
        nextMessageSeq: messagesPerChat + 1,
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      }
      messageIds.forEach((id, index) => {
        store.messagesById[id] = makeMessage(chatId, id, index + 1)
      })
    }
    return store
  }

  it('serves repeated loads from memory and writes only the chunk that changed', async () => {
    const { loadStore, saveStore, messageChunkStorageKey, STORE_WRITER_KEY } = storeModule
    await saveStore(storeWithChats(250))
    await storage.settle()
    storage.local.get.mockClear()
    storage.local.set.mockClear()

    const draft = await loadStore()
    draft.messagesById['chat-2-msg-250'].content = 'edited reply'
    await saveStore(draft)
    await storage.settle()

    expect(storage.local.get).not.toHaveBeenCalled()
    expect(storage.local.set).toHaveBeenCalledTimes(1)
    expect(Object.keys(storage.local.set.mock.calls[0][0]).sort()).toEqual([
      STORE_WRITER_KEY,
      messageChunkStorageKey('chat-2', '000003'),
    ].sort())

    const reloaded = await loadStore()
    expect(reloaded.messagesById['chat-2-msg-250'].content).toBe('edited reply')
    expect(storage.local.get).not.toHaveBeenCalled()
  })

  it('does not write anything when a save changes nothing', async () => {
    const { loadStore, saveStore } = storeModule
    await saveStore(storeWithChats(3))
    await storage.settle()
    storage.local.set.mockClear()

    await saveStore(await loadStore())

    expect(storage.local.set).not.toHaveBeenCalled()
  })

  it('hands out copies, so changing a loaded store does not change the cache', async () => {
    const { loadStore, saveStore } = storeModule
    await saveStore(storeWithChats(3))

    const first = await loadStore()
    first.messagesById['chat-1-msg-1'].content = 'not saved'
    first.chatOrder.reverse()

    const second = await loadStore()
    expect(second.messagesById['chat-1-msg-1'].content).toBe('message-1')
    expect(second.chatOrder).toEqual(['chat-1', 'chat-2'])
  })

  it('reloads from storage after another context writes the store', async () => {
    const { loadStore, saveStore, chatStorageKey, META_STORE_KEY, STORE_WRITER_KEY } = storeModule
    await saveStore(storeWithChats(3))
    await loadStore()
    await storage.settle()

    // Another extension context (for example the team page) deletes chat-1.
    const meta = structuredClone(storage.read(META_STORE_KEY)) as { chatOrder: string[] }
    meta.chatOrder = ['chat-2']
    await storage.local.set({ [META_STORE_KEY]: meta, [STORE_WRITER_KEY]: { id: 'team-page', revision: 1 } })
    await storage.local.remove([chatStorageKey('chat-1')])
    await storage.settle()
    storage.local.get.mockClear()

    const reloaded = await loadStore()
    expect(storage.local.get).toHaveBeenCalled()
    expect(reloaded.chatOrder).toEqual(['chat-2'])
    expect(reloaded.chatsById['chat-1']).toBeUndefined()
  })

  it('treats a write without a writer token as coming from another context', async () => {
    const { loadStore, saveStore, META_STORE_KEY } = storeModule
    await saveStore(storeWithChats(3))
    await storage.settle()

    const meta = structuredClone(storage.read(META_STORE_KEY)) as { currentChatId?: string }
    meta.currentChatId = 'chat-2'
    await storage.local.set({ [META_STORE_KEY]: meta })
    await storage.settle()

    expect((await loadStore()).currentChatId).toBe('chat-2')
  })

  it('removes stale keys without listing storage once the cache knows every key', async () => {
    const { loadStore, saveStore, chatStorageKey, messageChunkStorageKey } = storeModule
    await saveStore(storeWithChats(150))
    await storage.settle()
    storage.local.getKeys.mockClear()

    const draft = await loadStore()
    for (const messageId of draft.chatsById['chat-1'].messageIds) delete draft.messagesById[messageId]
    delete draft.chatsById['chat-1']
    draft.chatOrder = ['chat-2']
    await saveStore(draft)
    await storage.settle()

    expect(storage.local.getKeys).not.toHaveBeenCalled()
    expect(storage.local.remove).toHaveBeenCalledWith(expect.arrayContaining([
      chatStorageKey('chat-1'),
      messageChunkStorageKey('chat-1', '000001'),
      messageChunkStorageKey('chat-1', '000002'),
    ]))
    expect(storage.read(chatStorageKey('chat-1'))).toBeUndefined()
    expect(storage.read(messageChunkStorageKey('chat-1', '000002'))).toBeUndefined()
    expect((await loadStore()).chatOrder).toEqual(['chat-2'])
  })

  it('lists keys with getKeys instead of reading every stored value', async () => {
    const { saveStore, STORE_KEY } = storeModule
    await storage.local.set({ [STORE_KEY]: { version: 1 }, unrelated: 'kept' })

    await saveStore(storeWithChats(3))

    expect(storage.local.getKeys).toHaveBeenCalled()
    expect(storage.local.get).not.toHaveBeenCalledWith(null)
    expect(storage.read(STORE_KEY)).toBeUndefined()
    expect(storage.read('unrelated')).toBe('kept')
  })

  it('drops the cache when a write fails', async () => {
    const { loadStore, saveStore } = storeModule
    await saveStore(storeWithChats(3))
    await storage.settle()

    const draft = await loadStore()
    draft.messagesById['chat-1-msg-1'].content = 'lost'
    storage.local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'))
    await expect(saveStore(draft)).rejects.toThrow('QUOTA_BYTES')

    expect((await loadStore()).messagesById['chat-1-msg-1'].content).toBe('message-1')
  })

  it('keeps the cache warm through queued updates', async () => {
    const { loadStore, saveStore, updateStoreQueued } = storeModule
    await saveStore(storeWithChats(3))
    await storage.settle()
    storage.local.get.mockClear()

    await Promise.all(['a', 'b', 'c'].map(suffix => updateStoreQueued(draft => {
      draft.chatsById['chat-1'].name += suffix
    })))
    await storage.settle()

    expect(storage.local.get).not.toHaveBeenCalled()
    expect((await loadStore()).chatsById['chat-1'].name).toBe('chat-1abc')
  })
})

function makeMessage(chatId: string, id: string, seq: number): GroupMessage {
  return {
    id,
    chatId,
    seq,
    type: 'user',
    content: `message-${seq}`,
    createdAt: seq,
    status: 'sent',
  }
}
