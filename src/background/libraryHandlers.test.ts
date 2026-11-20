import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

async function setup() {
  vi.resetModules()
  const store: OpenTeamStore = createDefaultStore()
  store.chatsById.c = { id: 'c', name: '产品群', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['c']
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (current: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  vi.doMock('../group/store', async importOriginal => ({ ...(await importOriginal<typeof import('../group/store')>()), loadStore: async () => store }))
  const { createLibraryHandlers, LIBRARY_ROUTE_TYPES } = await import('./libraryHandlers')
  const broadcastStoreUpdated = vi.fn()
  let seq = 0
  const routes = createLibraryHandlers({ broadcastStoreUpdated, newId: prefix => `${prefix}-${++seq}`, now: () => 100 })
  const run = (type: string, payload: Record<string, unknown> = {}) => routes.find(route => route.type === type)!.handler({ type, ...payload }, {})
  return { store, routes, run, broadcastStoreUpdated, LIBRARY_ROUTE_TYPES }
}

describe('the page\'s library commands', () => {
  it('add a document, give its text back, export every text, and remove it', async () => {
    const { store, routes, run, broadcastStoreUpdated, LIBRARY_ROUTE_TYPES } = await setup()
    expect(routes.map(route => route.type)).toEqual([...LIBRARY_ROUTE_TYPES])
    const added = await run('LIBRARY_ADD', { chatId: 'c', doc: { title: '需求文档.md', kind: 'file', source: '需求文档.md', text: '预算提醒在八成时推送。' } }) as { docId: string }
    expect(added.docId).toBe('library-doc-1')
    expect(store.libraryByChatId?.c).toEqual([{ id: 'library-doc-1', title: '需求文档.md', kind: 'file', source: '需求文档.md', text: '预算提醒在八成时推送。', chars: 11, addedAt: 100 }])
    expect(broadcastStoreUpdated).toHaveBeenCalled()
    expect(await run('LIBRARY_TEXT_GET', { chatId: 'c', docId: 'library-doc-1' })).toEqual({ ok: true, title: '需求文档.md', text: '预算提醒在八成时推送。' })
    expect(await run('LIBRARY_EXPORT')).toEqual({ ok: true, libraryByChatId: store.libraryByChatId })
    await expect(run('LIBRARY_ADD', { chatId: 'c', doc: { title: 'x', kind: 'note', text: ' ' } })).rejects.toThrow('资料里没有文字')
    await expect(run('LIBRARY_TEXT_GET', { chatId: 'c', docId: 'gone' })).rejects.toThrow('找不到这份资料')
    await run('LIBRARY_REMOVE', { chatId: 'c', docId: 'library-doc-1' })
    expect(store.libraryByChatId?.c).toBeUndefined()
  })
})
