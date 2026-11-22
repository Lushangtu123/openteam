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
      'GROUP_TEAM_JOIN',
      'GROUP_TEAM_HANDBOOK_SAVE',
      'GROUP_TEAM_TEMPLATE_SAVE',
      'GROUP_TEAM_TEMPLATE_DELETE',
      'GROUP_CHAT_DUPLICATE',
      'GROUP_CHAT_SWITCH',
      'GROUP_CHAT_UPDATE',
      'GROUP_CHAT_DELETE',
      'GROUP_CHATS_DELETE',
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

  it('lets new AIs join a group with members and claim positions, the members there counted as taken', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    store.chatsById['chat-1'] = { id: 'chat-1', name: '记账', mode: 'collaborative', roleIds: ['role-1'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
    store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: 'Kimi', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
    })
    const { createChatHandlers } = await import('./chatHandlers')
    let id = 0
    const routes = createChatHandlers({ broadcastStoreUpdated: vi.fn(), getChatStatusFromRoles: () => 'ready', log: { info: vi.fn(), warn: vi.fn() }, newId: vi.fn((prefix: string) => `${prefix}-n${++id}`), now: vi.fn(() => 100), runtimeFrames: { removeRole: vi.fn() } })
    const join = (fields: Record<string, unknown>) => Promise.resolve(routes.find(route => route.type === 'GROUP_TEAM_JOIN')!.handler({ type: 'GROUP_TEAM_JOIN', chatId: 'chat-1', task: '加上预算提醒', ...fields }, {}))

    await expect(join({ members: [] })).rejects.toThrow('请选择 1–6 位新成员')
    await join({ members: [{ modelSource: 'site', chatSite: 'kimi' }, { modelSource: 'site', chatSite: 'deepseek' }] })
    const chat = store.chatsById['chat-1']
    const added = chat.roleIds.slice(1).map(roleId => store.rolesById[roleId])
    // Named after their model, apart from the Kimi already there.
    expect(added.map(role => role.name)).toEqual(['Kimi2', 'DeepSeek'])
    expect(chat.teamFormation).toMatchObject({ task: '加上预算提醒', status: 'checking', joiningRoleIds: added.map(role => role.id), invitationIds: [] })
    expect(chat.teamFormation!.rounds.flat().sort()).toEqual(added.map(role => role.id).sort())
    await expect(join({ members: [{ modelSource: 'site', chatSite: 'kimi' }] })).rejects.toThrow('这个群还在分工，等确认后再加人')
  })

  it('changes a group\'s mode, and says why not while a member answers', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    store.chatsById['chat-1'] = { id: 'chat-1', name: '网站自检 11-17 13:56', mode: 'independent', roleIds: ['role-1'], messageIds: [], nextMessageSeq: 4, status: 'ready', siteCheck: { startedAt: 0, scheduled: true }, createdAt: 0, updatedAt: 0 }
    store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '工程师', chatSite: 'chatgpt', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
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
    const update = (mode: unknown) => Promise.resolve(routes.find(route => route.type === 'GROUP_CHAT_UPDATE')!.handler({ type: 'GROUP_CHAT_UPDATE', chatId: 'chat-1', mode }, {}))

    await update('collaborative')
    expect(store.chatsById['chat-1']).toMatchObject({ mode: 'collaborative', sharedFromSeq: 3, updatedAt: 100 })
    // A 网站自检 group the user changed stays when 定时自检 runs again.
    expect(store.chatsById['chat-1'].siteCheck).toEqual({ startedAt: 0, scheduled: true, kept: true })
    await expect(update('team')).rejects.toThrow('群聊模式无效')
    store.rolesById['role-1'].status = 'thinking'
    await expect(update('independent')).rejects.toThrow('成员还在回答，等这一轮结束再切换模式')
    expect(store.chatsById['chat-1'].mode).toBe('collaborative')
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

  it('deletes several groups at once, with their members, messages, memory and images, in one update', async () => {
    vi.resetModules()
    const store = createDefaultStore()
    for (const [chatId, roleId, messageId] of [['chat-1', 'role-1', 'msg-1'], ['chat-2', 'role-2', 'msg-2'], ['chat-3', 'role-3', 'msg-3']]) {
      store.chatsById[chatId] = { id: chatId, name: chatId, mode: 'independent', roleIds: [roleId], messageIds: [messageId], nextMessageSeq: 2, status: 'ready', createdAt: 0, updatedAt: 0 }
      store.rolesById[roleId] = { id: roleId, chatId, name: roleId, systemPrompt: '', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
      store.messagesById[messageId] = { id: messageId, chatId, seq: 1, type: 'user', content: 'x', createdAt: 0, status: 'received' }
    }
    store.chatOrder = ['chat-1', 'chat-2', 'chat-3']
    store.currentChatId = 'chat-2'
    store.memoryItemsById = { kept: { id: 'kept', scope: 'chat', scopeId: 'chat-3', kind: 'fact', content: 'k', source: { origin: 'user' }, createdAt: 1, updatedAt: 1 }, gone: { id: 'gone', scope: 'role', scopeId: 'role-1', kind: 'fact', content: 'g', source: { origin: 'user' }, createdAt: 1, updatedAt: 1 } }
    store.memoryOrder = ['kept', 'gone']
    let updates = 0
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => {
          updates += 1
          return { store, result: await mutator(store) }
        },
      }
    })
    const { createChatHandlers } = await import('./chatHandlers')
    const broadcastStoreUpdated = vi.fn()
    const deleteByChatId = vi.fn(async () => undefined)
    const removeRole = vi.fn()
    const routes = createChatHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      imageAttachments: { deleteByChatId } as never,
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn(),
      now: vi.fn(() => 100),
      runtimeFrames: { removeRole },
    })
    const run = (chatIds: unknown) => Promise.resolve(routes.find(route => route.type === 'GROUP_CHATS_DELETE')!.handler({ type: 'GROUP_CHATS_DELETE', chatIds }, {})) as Promise<{ ok: boolean; deleted: number; memoryItemCount: number }>

    // A group that no longer exists is skipped, not an error.
    const response = await run(['chat-1', 'chat-2', 'chat-gone'])

    expect(response).toMatchObject({ ok: true, deleted: 2, memoryItemCount: 1 })
    expect(store.chatOrder).toEqual(['chat-3'])
    expect(Object.keys(store.rolesById)).toEqual(['role-3'])
    expect(Object.keys(store.messagesById)).toEqual(['msg-3'])
    expect(store.memoryOrder).toEqual(['kept'])
    expect(store.currentChatId).toBe('chat-3')
    expect(removeRole).toHaveBeenCalledWith('chat-1', 'role-1')
    expect(deleteByChatId.mock.calls.map(call => (call as unknown[])[0])).toEqual(['chat-1', 'chat-2'])
    expect(updates).toBe(1)
    expect(broadcastStoreUpdated).toHaveBeenCalledTimes(1)

    await expect(run([])).rejects.toThrow()
    await expect(run('chat-3')).rejects.toThrow()
  })
})
