import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

async function setup() {
  vi.resetModules()
  const store = createDefaultStore()
  store.chatOrder = ['chat-1']
  store.chatsById['chat-1'] = { id: 'chat-1', name: '评审', mode: 'independent', roleIds: ['role-1'], messageIds: ['q', 'a'], nextMessageSeq: 3, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '工程师', chatSite: 'chatgpt', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
  store.messagesById.q = { id: 'q', chatId: 'chat-1', seq: 1, type: 'user', content: '后端用什么写？', createdAt: 1, status: 'received' }
  store.messagesById.a = { id: 'a', chatId: 'chat-1', seq: 2, type: 'assistant', content: '用 Go，数据库 PostgreSQL 15。', roleId: 'role-1', roleName: '工程师', sourceMessageId: 'q', createdAt: 2, status: 'received' }
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return {
      ...actual,
      mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
    }
  })
  const { MEMORY_ROUTE_TYPES, createMemoryHandlers } = await import('./memoryHandlers')
  const broadcastStoreUpdated = vi.fn()
  const routes = createMemoryHandlers({ broadcastStoreUpdated, log: { info: vi.fn() }, now: () => 500 })
  const run = (type: string, fields: Record<string, unknown>) => Promise.resolve(routes.find(route => route.type === type)!.handler({ type, ...fields }, {})) as Promise<{ ok: boolean; item?: { id: string }; store?: OpenTeamStore }>
  const items = () => (store.memoryOrder ?? []).map(id => store.memoryItemsById![id])
  return { store, routes, run, items, broadcastStoreUpdated, MEMORY_ROUTE_TYPES }
}

describe('background memory handlers', () => {
  it('saves what the user wrote as the user\'s, and a member\'s reply as that member\'s', async () => {
    const { run, items, routes, broadcastStoreUpdated, MEMORY_ROUTE_TYPES, store } = await setup()
    expect(routes.map(route => route.type)).toEqual(MEMORY_ROUTE_TYPES)

    const own = await run('GROUP_MEMORY_ADD', { item: { scope: 'global', kind: 'preference', content: ' 回答用中文，先给结论。 ' } })
    expect(own).toMatchObject({ ok: true, store })
    expect(items()[0]).toMatchObject({ scope: 'global', kind: 'preference', content: '回答用中文，先给结论。', pinned: true, source: { origin: 'user' }, createdAt: 500 })

    // From a member's reply, edited before saving: who wrote it comes from the message itself.
    await run('GROUP_MEMORY_ADD', { item: { scope: 'chat', scopeId: 'chat-1', kind: 'decision', content: '后端用 Go，数据库 PostgreSQL 15。', tags: ['后端'], messageId: 'a', source: { origin: 'user' } } })
    expect(items()[0]).toMatchObject({ scope: 'chat', scopeId: 'chat-1', tags: ['后端'], source: { origin: 'member', roleId: 'role-1', chatId: 'chat-1', messageId: 'a' } })
    expect(items()[0].pinned).toBeUndefined()

    await run('GROUP_MEMORY_ADD', { item: { scope: 'role', scopeId: 'role-1', kind: 'note', content: '后端用什么写？', messageId: 'q' } })
    expect(items()[0]).toMatchObject({ scope: 'role', scopeId: 'role-1', source: { origin: 'user', chatId: 'chat-1', messageId: 'q' } })
    expect(broadcastStoreUpdated).toHaveBeenCalledTimes(3)
  })

  it('says what is wrong with an item it does not save', async () => {
    const { run, items } = await setup()
    const add = (item: Record<string, unknown>) => run('GROUP_MEMORY_ADD', { item })

    await expect(add({ scope: 'global', kind: 'fact', content: '   ' })).rejects.toThrow('记忆内容不能为空')
    await expect(add({ scope: 'global', kind: 'fact', content: '长'.repeat(501) })).rejects.toThrow('记忆内容不能超过 500 字')
    await expect(add({ scope: 'chat', scopeId: 'gone', kind: 'fact', content: '内容' })).rejects.toThrow('找不到这条记忆所属的群聊或成员')
    await expect(add({ scope: 'global', kind: 'fact', content: '内容', messageId: 'gone' })).rejects.toThrow('找不到这条消息')
    await expect(add(undefined as never)).rejects.toThrow('缺少记忆内容')
    expect(items()).toEqual([])
  })

  it('edits, pins, switches off and deletes an item', async () => {
    const { run, items } = await setup()
    const { item } = await run('GROUP_MEMORY_ADD', { item: { scope: 'global', kind: 'fact', content: '后端用 Go。' } })
    const itemId = item!.id

    await run('GROUP_MEMORY_UPDATE', { itemId, patch: { content: '后端用 Rust。', pinned: true, disabled: true, scope: 'chat', scopeId: 'chat-1' } })
    expect(items()[0]).toMatchObject({ content: '后端用 Rust。', pinned: true, disabled: true, scope: 'chat', scopeId: 'chat-1', updatedAt: 500 })
    await run('GROUP_MEMORY_UPDATE', { itemId, patch: { disabled: false } })
    expect(items()[0].disabled).toBeUndefined()
    await expect(run('GROUP_MEMORY_UPDATE', { itemId: 'gone', patch: { pinned: true } })).rejects.toThrow('找不到这条记忆')

    await run('GROUP_MEMORY_DELETE', { itemId })
    expect(items()).toEqual([])
    await expect(run('GROUP_MEMORY_DELETE', { itemId })).rejects.toThrow('找不到这条记忆')
  })
})
