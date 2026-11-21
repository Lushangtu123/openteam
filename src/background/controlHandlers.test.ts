import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, GroupRole, MemoryItem, OpenTeamStore } from '../group/types'
import { createControlActionExecutor, readTaskResult } from './controlHandlers'
import type { RuntimeMessage } from './runtimeClient'
import { OPENTEAM_CONTROL_CAPABILITIES } from '../shared/localControlProtocol'

describe('background control handlers', () => {
  it('routes create-and-post through existing chat, role, and message runtime commands', async () => {
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const routeRuntimeMessage = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === 'GROUP_CHAT_CREATE') {
        const chat = {
          id: 'chat-1',
          name: String(message.name),
          mode: 'independent',
          roleIds: [],
          messageIds: [],
          nextMessageSeq: 1,
          status: 'draft',
          createdAt: 1,
          updatedAt: 1,
        } satisfies OpenTeamStore['chatsById'][string]
        store.chatsById[chat.id] = chat
        store.chatOrder = [chat.id]
        store.currentChatId = chat.id
        return { ok: true, chat, store }
      }
      if (message.type === 'GROUP_ROLES_CREATE_BATCH') {
        const roles: GroupRole[] = [
          makeRole('chat-1', 'role-eng', '工程师'),
          makeRole('chat-1', 'role-pm', '产品经理'),
        ]
        store.chatsById['chat-1'].roleIds = roles.map(role => role.id)
        store.rolesById = Object.fromEntries(roles.map(role => [role.id, role]))
        return { ok: true, roles, store }
      }
      if (message.type === 'GROUP_CHAT_SWITCH') {
        store.currentChatId = String(message.chatId)
        return { ok: true, store }
      }
      if (message.type === 'GROUP_MESSAGE_SEND') {
        const userMessage: GroupMessage = {
          id: 'msg-task',
          chatId: 'chat-1',
          seq: 1,
          type: 'user',
          content: '请评估这个方案',
          targetRoleIds: ['role-eng', 'role-pm'],
          mentionsAll: true,
          createdAt: 2,
          status: 'pending',
          deliveryStatus: { 'role-eng': 'pending', 'role-pm': 'pending' },
        }
        store.messagesById[userMessage.id] = userMessage
        store.chatsById['chat-1'].messageIds = [userMessage.id]
        return { ok: true, message: userMessage, store }
      }
      throw new Error(`unexpected route ${message.type}`)
    })
    const executor = createControlActionExecutor({
      loadStore: async () => store,
      routeRuntimeMessage,
      runtimeFrames: { list: () => [] },
      openTeamPage: vi.fn(),
      waitFor: async () => undefined,
      now: () => 10,
    })

    const result = await executor({
      id: 'cmd-1',
      action: 'run.createAndPost',
      payload: {
        chat: { name: '方案评审', mode: 'independent' },
        roles: [
          { source: 'temporary', name: '工程师', systemPrompt: '从工程角度评估' },
          { source: 'temporary', name: '产品经理', systemPrompt: '从产品角度评估' },
        ],
        task: { target: 'all', content: '请评估这个方案' },
        options: { waitForReplies: false },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({
      chat: { id: 'chat-1', name: '方案评审' },
      roles: [{ id: 'role-eng' }, { id: 'role-pm' }],
      taskMessage: { id: 'msg-task', status: 'pending' },
    })
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'GROUP_CHAT_CREATE',
      name: '方案评审',
      mode: 'independent',
    }))
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'GROUP_ROLES_CREATE_BATCH',
      chatId: 'chat-1',
      items: expect.arrayContaining([
        expect.objectContaining({ source: 'temporary', name: '工程师', systemPrompt: '从工程角度评估' }),
      ]),
    }))
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(3, expect.objectContaining({
      type: 'GROUP_CHAT_SWITCH',
      chatId: 'chat-1',
    }))
    expect(routeRuntimeMessage).toHaveBeenNthCalledWith(4, expect.objectContaining({
      type: 'GROUP_MESSAGE_SEND',
      chatId: 'chat-1',
      raw: '@所有人 请评估这个方案',
    }))
  })

  it('redacts external model API keys from store snapshots returned to local agents', async () => {
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    store.settings.externalModelOrder = ['model-1']
    store.settings.externalModelsById = {
      'model-1': { id: 'model-1', name: '本地模型', format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', modelName: 'gpt', createdAt: 1, updatedAt: 1 },
    }
    const executor = createControlActionExecutor({
      loadStore: async () => store,
      routeRuntimeMessage: vi.fn(async () => ({ ok: true, store })),
      runtimeFrames: { list: () => [] },
      openTeamPage: vi.fn(),
      waitFor: async () => undefined,
      now: () => 10,
    })

    const snapshot = await executor({ id: 'cmd-1', action: 'store.get' })
    const created = await executor({ id: 'cmd-2', action: 'chat.create', payload: { name: '评审' } })

    for (const result of [snapshot, created]) {
      expect(result.ok).toBe(true)
      expect(JSON.stringify(result.data)).not.toContain('sk-secret')
      expect((result.data as { store: OpenTeamStore }).store.settings.externalModelsById['model-1']).toMatchObject({ apiKey: '[redacted]', baseUrl: 'https://api.example.com/v1' })
    }
    expect(store.settings.externalModelsById['model-1'].apiKey).toBe('sk-secret')
  })

  it('reads replies belonging to a task message without leaking later turns', () => {
    const store = createDefaultStore()
    store.chatsById['chat-1'] = {
      id: 'chat-1',
      name: '评审群',
      mode: 'independent',
      roleIds: ['role-eng', 'role-pm'],
      messageIds: ['msg-task', 'msg-eng', 'msg-pm', 'msg-next', 'msg-later'],
      nextMessageSeq: 6,
      status: 'ready',
      createdAt: 1,
      updatedAt: 5,
    }
    store.rolesById['role-eng'] = makeRole('chat-1', 'role-eng', '工程师')
    store.rolesById['role-pm'] = makeRole('chat-1', 'role-pm', '产品经理')
    store.messagesById['msg-task'] = {
      id: 'msg-task',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请评估这个方案',
      targetRoleIds: ['role-eng', 'role-pm'],
      createdAt: 1,
      status: 'received',
      deliveryStatus: { 'role-eng': 'received', 'role-pm': 'received' },
    }
    store.messagesById['msg-eng'] = makeReply('msg-eng', 'role-eng', '工程师', '工程可行', 2, 'msg-task')
    store.messagesById['msg-pm'] = makeReply('msg-pm', 'role-pm', '产品经理', '产品可行', 3, 'msg-task')
    store.messagesById['msg-next'] = {
      id: 'msg-next',
      chatId: 'chat-1',
      seq: 4,
      type: 'user',
      content: '继续追问',
      targetRoleIds: ['role-eng'],
      createdAt: 4,
      status: 'pending',
    }
    store.messagesById['msg-later'] = makeReply('msg-later', 'role-eng', '工程师', '后续回复', 5, 'msg-next')

    expect(readTaskResult(store, 'chat-1', 'msg-task')).toMatchObject({
      messageId: 'msg-task',
      status: 'received',
      replies: [
        { messageId: 'msg-eng', roleId: 'role-eng', content: '工程可行' },
        { messageId: 'msg-pm', roleId: 'role-pm', content: '产品可行' },
      ],
    })
  })
})

describe('memory through the control interface', () => {
  // An independent group with two members, and a second group.
  function setup(enabled = true) {
    const store = createDefaultStore()
    store.settings.agentControlEnabled = enabled
    store.chatsById['chat-1'] = { id: 'chat-1', name: '选型', mode: 'independent', roleIds: ['role-be', 'role-fe'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    store.chatsById['chat-2'] = { id: 'chat-2', name: '别的群', mode: 'collaborative', roleIds: ['role-x'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    store.rolesById = { 'role-be': makeRole('chat-1', 'role-be', '后端'), 'role-fe': makeRole('chat-1', 'role-fe', '前端'), 'role-x': makeRole('chat-2', 'role-x', '后端') }
    const item = (id: string, patch: Partial<MemoryItem>): MemoryItem => ({ id, scope: 'global', kind: 'fact', content: id, source: { origin: 'user' }, createdAt: 1, updatedAt: 1, ...patch })
    const items = [
      item('lang', { kind: 'preference', content: '回答用中文，先给结论。', pinned: true }),
      item('db', { scope: 'chat', scopeId: 'chat-1', kind: 'decision', content: '数据库用 PostgreSQL 15。', tags: ['数据库'] }),
      // The front-end member's own words, saved for the group: in an independent group, others do not read it.
      item('fe-said', { scope: 'chat', scopeId: 'chat-1', content: '数据库连接池开到 50。', source: { origin: 'member', roleId: 'role-fe', chatId: 'chat-1' } }),
      item('be-only', { scope: 'role', scopeId: 'role-be', content: '后端只用 Go 1.22。' }),
      item('other', { scope: 'chat', scopeId: 'chat-2', content: '另一个群的数据库。' }),
      item('off', { content: '停用的数据库条目', disabled: true }),
    ]
    store.memoryItemsById = Object.fromEntries(items.map(entry => [entry.id, entry]))
    store.memoryOrder = items.map(entry => entry.id)
    const routeRuntimeMessage = vi.fn(async (message: RuntimeMessage): Promise<unknown> => {
      if (message.type !== 'GROUP_MEMORY_ADD') throw new Error(`unexpected route ${message.type}`)
      const input = message.item as Record<string, unknown>
      return { ok: true, item: { id: 'memory-new', ...input, source: { origin: 'user' }, createdAt: 5, updatedAt: 5 }, store }
    })
    const executor = createControlActionExecutor({ loadStore: async () => store, routeRuntimeMessage, runtimeFrames: { list: () => [] }, openTeamPage: vi.fn(), waitFor: async () => undefined, now: () => 10 })
    const run = async (action: string, payload: Record<string, unknown>) => executor({ id: 'cmd', action, payload } as never) as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { message: string } }>
    return { store, run, routeRuntimeMessage }
  }

  it('lists what one member may read: its own and the user\'s items, not another member\'s words or another group\'s', async () => {
    const { run } = setup()
    const result = await run('memory.search', { chatId: 'chat-1', roleName: '后端' })
    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ chatId: 'chat-1', roleId: 'role-be', roleName: '后端', memoryDisabled: false, visibleCount: 3 })
    expect((result.data!.items as Array<{ id: string }>).map(entry => entry.id)).toEqual(['lang', 'db', 'be-only'])
    expect(result.data!.pinned).toEqual([{ id: 'lang', scope: 'global', kind: 'preference', content: '回答用中文，先给结论。', pinned: true, source: 'user' }])

    const front = await run('memory.search', { chatId: 'chat-1', roleId: 'role-fe' })
    expect((front.data!.items as Array<{ id: string }>).map(entry => entry.id)).toEqual(['lang', 'db', 'fe-said'])
  })

  it('finds what a query brings up, best first, with its score', async () => {
    const { run } = setup()
    const result = await run('memory.search', { chatId: 'chat-1', roleName: '后端', query: '数据库怎么选' })
    const items = result.data!.items as Array<{ id: string; score: number; tags?: string[] }>
    expect(items.map(entry => entry.id)).toEqual(['db'])
    expect(items[0].score).toBeGreaterThan(0)
    expect(items[0].tags).toEqual(['数据库'])
  })

  it('finds nothing in a group with memory switched off', async () => {
    const { store, run } = setup()
    store.chatsById['chat-1'].memoryDisabled = true
    const result = await run('memory.search', { chatId: 'chat-1', roleName: '后端' })
    expect(result.data).toMatchObject({ memoryDisabled: true, visibleCount: 0, items: [], pinned: [] })
  })

  it('says which group or member it could not find', async () => {
    const { store, run } = setup()
    expect((await run('memory.search', { chatId: 'gone', roleName: '后端' })).error?.message).toBe('找不到群聊：gone')
    expect((await run('memory.search', { chatId: 'chat-1', roleName: '设计' })).error?.message).toBe('群聊里没有叫「设计」的成员')
    // A member of another group is not this group's, even by id.
    expect((await run('memory.search', { chatId: 'chat-1', roleId: 'role-x' })).error?.message).toBe('群聊里没有这位成员：role-x')
    expect((await run('memory.search', { chatId: 'chat-1' })).error?.message).toBe('缺少成员：用 roleId 或 roleName 指定')
    store.rolesById['role-fe'].name = '后端'
    expect((await run('memory.search', { chatId: 'chat-1', roleName: '后端' })).error?.message).toBe('群聊里有 2 位叫「后端」的成员，请改用 roleId')
  })

  it('saves as the user for every group, a group, or one member, resolving the member in that group', async () => {
    const { run, routeRuntimeMessage } = setup()
    await run('memory.add', { scope: 'global', kind: 'preference', content: '回答简短。', pinned: true })
    await run('memory.add', { scope: 'chat', chatId: 'chat-1', content: '上线日期是 11 月 20 日。', tags: ['上线'] })
    const forMember = await run('memory.add', { scope: 'role', chatId: 'chat-1', roleName: '前端', kind: 'note', content: '前端用 Vue 3。' })
    expect(routeRuntimeMessage.mock.calls.map(([message]) => message.item)).toEqual([
      { scope: 'global', kind: 'preference', content: '回答简短。', pinned: true },
      { scope: 'chat', scopeId: 'chat-1', kind: 'fact', content: '上线日期是 11 月 20 日。', tags: ['上线'] },
      { scope: 'role', scopeId: 'role-fe', kind: 'note', content: '前端用 Vue 3。' },
    ])
    // The answer is the item alone, not the whole store.
    expect(forMember.data).toEqual({ item: { id: 'memory-new', scope: 'role', scopeId: 'role-fe', kind: 'note', content: '前端用 Vue 3。', source: 'user' } })
  })

  it('adds a document to a group\'s library as the user, and lists the library without its text', async () => {
    const { store, run, routeRuntimeMessage } = setup()
    routeRuntimeMessage.mockImplementationOnce(async () => ({ ok: true, docId: 'library-doc-9' }))
    const added = await run('library.add', { chatId: 'chat-1', kind: 'file', title: '需求.md', source: '需求.md', text: '预算提醒在八成时推送。' })
    expect(routeRuntimeMessage.mock.calls[routeRuntimeMessage.mock.calls.length - 1][0]).toEqual({ type: 'LIBRARY_ADD', chatId: 'chat-1', doc: { title: '需求.md', kind: 'file', source: '需求.md', text: '预算提醒在八成时推送。' } })
    expect(added.data).toEqual({ docId: 'library-doc-9' })
    store.libraryByChatId = { 'chat-1': [{ id: 'd', title: '需求.md', kind: 'file', text: '秘密正文', chars: 4, addedAt: 1 }] }
    const listed = await run('library.list', { chatId: 'chat-1' })
    expect(listed.data).toEqual({ docs: [{ id: 'd', title: '需求.md', kind: 'file', chars: 4, addedAt: 1 }] })
    expect((await run('library.add', { chatId: 'gone', text: 'x' })).error?.message).toBe('找不到群聊：gone')
  })

  it('needs a scope, and the group for a group or member item', async () => {
    const { run, routeRuntimeMessage } = setup()
    expect((await run('memory.add', { content: '内容' })).error?.message).toBe('缺少记忆范围：global（全部群聊）、chat（本群）或 role（本群的一位成员）')
    expect((await run('memory.add', { scope: 'chat', content: '内容' })).error?.message).toBe('缺少群聊 ID')
    expect((await run('memory.add', { scope: 'role', chatId: 'chat-1', content: '内容' })).error?.message).toBe('缺少成员：用 roleId 或 roleName 指定')
    expect((await run('memory.add', { scope: 'global', kind: '想法', content: '内容' })).error?.message).toBe('记忆类型只能是 fact、decision、preference、note，不是「想法」')
    expect(routeRuntimeMessage).not.toHaveBeenCalled()
  })

  it('does nothing while local control is switched off', async () => {
    const { run } = setup(false)
    expect((await run('memory.search', { chatId: 'chat-1', roleName: '后端' })).ok).toBe(false)
  })
})

function makeRole(chatId: string, id: string, name: string): GroupRole {
  return {
    id,
    chatId,
    name,
    systemPrompt: `${name}人设`,
    status: 'ready',
    contextCursor: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeReply(id: string, roleId: string, roleName: string, content: string, seq: number, sourceMessageId: string): GroupMessage {
  return {
    id,
    chatId: 'chat-1',
    seq,
    type: 'assistant',
    content,
    roleId,
    roleName,
    sourceMessageId,
    createdAt: seq,
    status: 'received',
  }
}

describe('the site check through the control interface', () => {
  // A check group whose members reply over time: a site has replied once its time comes.
  function checkStore(replyAt: Record<string, number>, options: { error?: string } = {}) {
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const sites = Object.keys(replyAt)
    store.chatsById['chat-check'] = { id: 'chat-check', name: '网站自检', mode: 'independent', roleIds: sites.map(site => `role-${site}`), messageIds: ['q'], nextMessageSeq: 2, status: 'ready', createdAt: 0, updatedAt: 0, siteCheck: { startedAt: 0, ...(options.error ? { error: options.error } : {}) } }
    store.chatOrder = ['chat-check']
    for (const site of sites) store.rolesById[`role-${site}`] = { id: `role-${site}`, chatId: 'chat-check', name: site, chatSite: site as never, modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
    store.messagesById.q = { id: 'q', chatId: 'chat-check', seq: 1, type: 'user', content: '@all OK', createdAt: 0, status: 'sent', deliveryStatus: Object.fromEntries(sites.map(site => [`role-${site}`, 'sent'])) }
    return store
  }

  function executorFor(store: OpenTeamStore, replyAt: Record<string, number>) {
    let clock = 0
    const routeRuntimeMessage = vi.fn(async (message: { type: string }) => message.type === 'GROUP_SITE_CHECK_START' ? { ok: true, chatId: 'chat-check', store } : { ok: true, store })
    const openTeamPage = vi.fn(async () => undefined)
    const executor = createControlActionExecutor({
      loadStore: async () => {
        for (const [site, at] of Object.entries(replyAt)) {
          const id = `a-${site}`
          if (clock >= at && !store.messagesById[id]) {
            store.messagesById[id] = { id, chatId: 'chat-check', seq: store.chatsById['chat-check'].messageIds.length + 1, type: 'assistant', content: site === 'grok' ? '回复失败：发送失败' : 'OK', roleId: `role-${site}`, sourceMessageId: 'q', createdAt: at, status: site === 'grok' ? 'error' : 'received' }
            store.chatsById['chat-check'].messageIds.push(id)
          }
        }
        return store
      },
      routeRuntimeMessage: routeRuntimeMessage as never,
      runtimeFrames: { list: () => [] },
      openTeamPage,
      waitFor: async (ms: number) => { clock += ms },
      now: () => clock,
    })
    return { executor, routeRuntimeMessage, openTeamPage }
  }

  it('starts the check, opens the page, waits for every site, and reports them', async () => {
    const replyAt = { gemini: 2000, deepseek: 6000, grok: 4000 }
    const { executor, routeRuntimeMessage, openTeamPage } = executorFor(checkStore(replyAt), replyAt)

    const result = await executor({ id: 'cmd-1', action: 'site.check' })

    expect(routeRuntimeMessage).toHaveBeenCalledWith({ type: 'GROUP_SITE_CHECK_START' })
    expect(openTeamPage).toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      chatId: 'chat-check',
      finished: true,
      ok: 2,
      needsAttention: 1,
      waiting: 0,
      results: [
        { site: 'gemini', outcome: 'ok' },
        { site: 'deepseek', outcome: 'ok' },
        { site: 'grok', outcome: 'failed', detail: '发送失败' },
      ],
    })
  })

  it('returns at once without waiting, and when its time is up', async () => {
    const replyAt = { gemini: 999_999 }
    const now = executorFor(checkStore(replyAt), replyAt)
    expect((await now.executor({ id: 'cmd-1', action: 'site.check', payload: { wait: false } })).data).toEqual({ chatId: 'chat-check', finished: false })

    const late = executorFor(checkStore(replyAt), replyAt)
    const result = await late.executor({ id: 'cmd-2', action: 'site.check', payload: { timeoutMs: 10_000 } })
    expect(result.data).toMatchObject({ finished: false, waiting: 1 })
  })

  it('says why when the question could not be sent', async () => {
    const replyAt = { gemini: 999_999 }
    const { executor } = executorFor(checkStore(replyAt, { error: '没有一个网站的页面打开了。' }), replyAt)
    expect((await executor({ id: 'cmd-1', action: 'site.check' })).data).toMatchObject({ finished: true, error: '没有一个网站的页面打开了。' })
  })
})

describe('logs.read: the background log, from the command line', () => {
  it('gives the kept entries that match, newest last', async () => {
    const store = createDefaultStore()
    store.settings.agentControlEnabled = true
    const at = 1_800_000_000_000
    const readLogs = vi.fn(() => [
      { at: at - 3_600_000, level: 'info' as const, scope: 'background', event: 'external-model:send:start', details: {} },
      { at: at - 60_000, level: 'warn' as const, scope: 'background', event: 'external-model:fallback', details: { reason: 'HTTP 503：busy' } },
    ])
    const executor = createControlActionExecutor({ loadStore: async () => store, routeRuntimeMessage: vi.fn(), runtimeFrames: { list: () => [] }, openTeamPage: vi.fn(), waitFor: async () => undefined, now: () => at, readLogs })
    const run = async (payload: Record<string, unknown>) => executor({ id: 'cmd', action: 'logs.read', payload } as never) as Promise<{ ok: boolean; data?: { total: number; entries: Array<{ event: string; time: string }> } }>
    const all = await run({})
    expect(all.ok).toBe(true)
    expect(all.data!.total).toBe(2)
    expect(all.data!.entries.map(entry => entry.event)).toEqual(['external-model:send:start', 'external-model:fallback'])
    expect((await run({ level: 'warn', withinMs: 600_000, search: 'fallback' })).data!.entries.map(entry => entry.event)).toEqual(['external-model:fallback'])
    expect(OPENTEAM_CONTROL_CAPABILITIES).toContain('logs.read')
  })
})

