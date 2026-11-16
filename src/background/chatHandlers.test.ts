import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

describe('background chat handlers', () => {
  it('exposes group chat routes and creates a chat through the injected runtime dependencies', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createDefaultStore()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { CHAT_ROUTE_TYPES, createChatHandlers } = await import('./chatHandlers')
    const broadcastStoreUpdated = vi.fn()
    const routes = createChatHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole: vi.fn() },
    })

    expect(CHAT_ROUTE_TYPES).toEqual([
      'GROUP_CHAT_CREATE',
      'GROUP_TEAM_CREATE',
      'GROUP_TEAM_HANDBOOK_SAVE',
      'GROUP_TEAM_TEMPLATE_SAVE',
      'GROUP_TEAM_TEMPLATE_DELETE',
      'GROUP_CHAT_DUPLICATE',
      'GROUP_CHAT_SWITCH',
      'GROUP_CHAT_UPDATE',
      'GROUP_CHAT_DELETE',
      'GROUP_CHAT_CLEAR_MESSAGES',
      'GROUP_CHAT_CLOSE',
      'GROUP_CHAT_MARK_READ',
    ])
    expect(routes.map(route => route.type)).toEqual(CHAT_ROUTE_TYPES)

    const createRoute = routes.find(route => route.type === 'GROUP_CHAT_CREATE')
    const response = await createRoute?.handler({ type: 'GROUP_CHAT_CREATE', name: '架构评审' }, {})

    expect(response).toMatchObject({
      ok: true,
      chat: { id: 'chat-1', name: '架构评审', status: 'draft', requireManualMention: true },
    })
    expect(draftStore?.currentChatId).toBe('chat-1')
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentChatId: 'chat-1' }))
  })

  it('creates a chat with the people supplied by a group template', async () => {
    vi.resetModules()
    const { BUILTIN_GROUP_TEMPLATES, buildBuiltinGroupTemplateWelcomeMessage } = await import('../group/builtinGroupTemplates')
    const template = BUILTIN_GROUP_TEMPLATES[0]
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createDefaultStore()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const idCounters: Record<string, number> = {}
    const { createChatHandlers } = await import('./chatHandlers')
    const routes = createChatHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => {
        idCounters[prefix] = (idCounters[prefix] ?? 0) + 1
        return `${prefix}-${idCounters[prefix]}`
      }),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole: vi.fn() },
    })

    const createRoute = routes.find(route => route.type === 'GROUP_CHAT_CREATE')
    const response = await createRoute?.handler({
      type: 'GROUP_CHAT_CREATE',
      name: template.defaultChatName,
      mode: template.defaultMode,
      roles: template.roles,
      welcomeMessage: buildBuiltinGroupTemplateWelcomeMessage(template),
    }, {})

    expect(response).toMatchObject({
      ok: true,
      chat: {
        id: 'chat-1',
        name: template.defaultChatName,
        mode: template.defaultMode,
        status: 'initializing',
      },
    })
    expect(draftStore?.chatsById['chat-1'].roleIds).toHaveLength(template.roles.length)
    expect(draftStore?.chatsById['chat-1'].messageIds).toEqual(['msg-1'])
    expect(draftStore?.chatsById['chat-1'].nextMessageSeq).toBe(2)
    expect(draftStore?.messagesById['msg-1']).toMatchObject({
      chatId: 'chat-1',
      seq: 1,
      type: 'assistant',
      contentFormat: 'markdown',
      roleName: template.roles[0].name,
      content: expect.stringContaining(`欢迎来到「${template.name}」`),
      status: 'received',
    })
    expect(Object.values(draftStore?.rolesById ?? {}).map(role => ({
      name: role.name,
      description: role.description,
      systemPrompt: role.systemPrompt,
      chatSite: role.chatSite,
    }))).toEqual(template.roles.map(role => ({
      name: role.name,
      description: role.description,
      systemPrompt: role.systemPrompt,
      chatSite: 'deepseek',
    })))
  })

  it('clearing a chat\'s messages starts its members\' site conversations over, memory items included', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    store.chatsById['chat-1'] = { id: 'chat-1', name: '架构评审', mode: 'independent', roleIds: ['role-1'], messageIds: ['m1'], nextMessageSeq: 2, status: 'ready', createdAt: 0, updatedAt: 0 }
    store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '工程师', systemPrompt: '', chatSite: 'chatgpt', status: 'ready', contextCursor: 1, geminiConversationUrl: 'https://chatgpt.com/c/1', memorySent: { item: 1 }, memoryPending: { messageId: 'm1', sent: { other: 1 } }, createdAt: 0, updatedAt: 10 }
    store.messagesById.m1 = { id: 'm1', chatId: 'chat-1', seq: 1, type: 'user', content: '问题', createdAt: 1, status: 'received' }
    // The memory items themselves are kept.
    store.memoryItemsById = { item: { id: 'item', scope: 'chat', scopeId: 'chat-1', kind: 'fact', content: '事实', source: { origin: 'user' }, createdAt: 1, updatedAt: 1 } }
    store.memoryOrder = ['item']
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createChatHandlers } = await import('./chatHandlers')
    const routes = createChatHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn(),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole: vi.fn() },
    })

    await routes.find(route => route.type === 'GROUP_CHAT_CLEAR_MESSAGES')!.handler({ type: 'GROUP_CHAT_CLEAR_MESSAGES', chatId: 'chat-1' }, {})

    expect(store.rolesById['role-1']).toMatchObject({ contextCursor: 0, status: 'loading' })
    expect(store.rolesById['role-1'].memorySent).toBeUndefined()
    expect(store.rolesById['role-1'].memoryPending).toBeUndefined()
    expect(store.memoryOrder).toEqual(['item'])
  })

  it('switches a chat\'s memory off and back on', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    store.chatsById['chat-1'] = { id: 'chat-1', name: '架构评审', mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createChatHandlers } = await import('./chatHandlers')
    const routes = createChatHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn(),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole: vi.fn() },
    })
    const update = (memoryDisabled: boolean) => routes.find(route => route.type === 'GROUP_CHAT_UPDATE')!.handler({ type: 'GROUP_CHAT_UPDATE', chatId: 'chat-1', patch: { memoryDisabled } }, {})

    await update(true)
    expect(store.chatsById['chat-1'].memoryDisabled).toBe(true)
    await update(false)
    // Left out when on, as in a chat that never had it switched off.
    expect('memoryDisabled' in store.chatsById['chat-1']).toBe(false)
  })

  it('deleting a chat removes its memory items and its members\', and duplicating one copies them', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    store.chatOrder = ['chat-1']
    store.chatsById['chat-1'] = { id: 'chat-1', name: '架构评审', mode: 'independent', roleIds: ['role-1'], messageIds: [], nextMessageSeq: 1, status: 'ready', memoryDisabled: true, createdAt: 0, updatedAt: 0 }
    store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '工程师', systemPrompt: '', chatSite: 'chatgpt', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
    const item = (id: string, scope: 'global' | 'chat' | 'role', scopeId?: string) => ({ id, scope, ...(scopeId ? { scopeId } : {}), kind: 'fact' as const, content: `内容 ${id}`, source: { origin: 'user' as const }, createdAt: 1, updatedAt: 1 })
    store.memoryItemsById = { everywhere: item('everywhere', 'global'), group: item('group', 'chat', 'chat-1'), own: item('own', 'role', 'role-1') }
    store.memoryOrder = ['everywhere', 'group', 'own']
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createChatHandlers } = await import('./chatHandlers')
    const counters: Record<string, number> = {}
    const routes = createChatHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-copy-${counters[prefix] = (counters[prefix] ?? 0) + 1}`),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole: vi.fn() },
    })
    const run = (type: string, chatId: string) => routes.find(route => route.type === type)!.handler({ type, chatId }, {})
    const items = () => (store.memoryOrder ?? []).map(id => store.memoryItemsById![id])

    await run('GROUP_CHAT_DUPLICATE', 'chat-1')
    expect(store.chatsById['chat-copy-1']).toMatchObject({ memoryDisabled: true, roleIds: ['role-copy-1'] })
    expect(items().map(entry => [entry.scope, entry.scopeId, entry.content])).toEqual([
      ['global', undefined, '内容 everywhere'],
      ['chat', 'chat-1', '内容 group'],
      ['role', 'role-1', '内容 own'],
      ['chat', 'chat-copy-1', '内容 group'],
      ['role', 'role-copy-1', '内容 own'],
    ])

    // Deleting the original leaves the copy's items and the one kept for every group.
    await run('GROUP_CHAT_DELETE', 'chat-1')
    expect(items().map(entry => [entry.scope, entry.scopeId])).toEqual([['global', undefined], ['chat', 'chat-copy-1'], ['role', 'role-copy-1']])
  })

  it('closing a chat leaves a member that is waiting for a reply as it is, time included', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    store.chatsById['chat-1'] = { id: 'chat-1', name: '架构评审', mode: 'independent', roleIds: ['role-1', 'role-2'], messageIds: [], nextMessageSeq: 1, status: 'running', createdAt: 0, updatedAt: 0 }
    store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '工程师', systemPrompt: '', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 10 }
    // Asked at 40; how long it has been waiting is counted from then.
    store.rolesById['role-2'] = { id: 'role-2', chatId: 'chat-1', name: '产品经理', systemPrompt: '', status: 'thinking', lastPromptMessageId: 'msg-1', contextCursor: 0, createdAt: 0, updatedAt: 40 }
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createChatHandlers } = await import('./chatHandlers')
    const removeRole = vi.fn()
    const routes = createChatHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'running',
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn(),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole },
    })

    const response = await routes.find(route => route.type === 'GROUP_CHAT_CLOSE')!.handler({ type: 'GROUP_CHAT_CLOSE', chatId: 'chat-1' }, {})

    expect(response).toMatchObject({ ok: true })
    expect(removeRole).toHaveBeenCalledTimes(2)
    expect(store.rolesById['role-1']).toMatchObject({ status: 'loading', updatedAt: 100 })
    expect(store.rolesById['role-2']).toMatchObject({ status: 'thinking', lastPromptMessageId: 'msg-1', updatedAt: 40 })
  })
})
