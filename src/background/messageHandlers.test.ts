import { describe, expect, it, vi } from 'vitest'
import { REPLY_STUCK_AFTER_MS } from '../group/replyTiming'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, OrchestrationFlow, RuntimeFrameBinding } from '../group/types'

function createStoreWithReadyRole(): OpenTeamStore {
  const store = createDefaultStore()
  const chat: GroupChat = {
    id: 'chat-1',
    name: '架构评审',
    mode: 'independent',
    roleIds: ['role-1'],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 0,
    updatedAt: 0,
  }
  const role: GroupRole = {
    id: 'role-1',
    chatId: chat.id,
    name: '工程师',
    systemPrompt: '从工程角度分析问题',
    status: 'ready',
    contextCursor: 0,
    createdAt: 0,
    updatedAt: 0,
  }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[role.id] = role
  return store
}

// A chat with two API members, 工程师 and 设计师, on the same model.
function createStoreWithTwoApiRoles(): OpenTeamStore {
  const store = createStoreWithReadyRole()
  store.settings.language = 'zh-CN'
  store.settings.externalModelOrder = ['model-1']
  store.settings.externalModelsById = {
    'model-1': { id: 'model-1', name: '本地模型', format: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test', modelName: 'local-chat-model', createdAt: 1, updatedAt: 1 },
  }
  const engineer = store.rolesById['role-1']
  engineer.modelSource = 'external'
  engineer.externalModelId = 'model-1'
  delete engineer.chatSite
  store.rolesById['role-2'] = { ...structuredClone(engineer), id: 'role-2', name: '设计师', systemPrompt: '从设计角度分析问题' }
  store.chatsById['chat-1'].roleIds = ['role-1', 'role-2']
  return store
}

function addFlow(store: OpenTeamStore, flow: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
  const resolved: OrchestrationFlow = {
    id: flow.id ?? 'flow-1',
    chatId: flow.chatId ?? 'chat-1',
    name: flow.name ?? '默认编排',
    description: flow.description,
    maxRounds: flow.maxRounds ?? 1,
    maxNodeExecutions: flow.maxNodeExecutions,
    stages: flow.stages ?? [{
      id: 'stage-1',
      kind: 'roles',
      name: '执行',
      roleIds: ['role-1'],
    }],
    graph: flow.graph,
    createdAt: flow.createdAt ?? 1,
    updatedAt: flow.updatedAt ?? 1,
  }
  store.orchestrationFlowsById[resolved.id] = resolved
  store.orchestrationFlowOrderByChatId[resolved.chatId] ??= []
  store.orchestrationFlowOrderByChatId[resolved.chatId].push(resolved.id)
  return resolved
}

describe('background message handlers', () => {
  it('keeps a member waiting for its reply when the frame reports ready again', async () => {
    vi.resetModules()
    const store = createStoreWithReadyRole()
    const role = store.rolesById['role-1']
    Object.assign(role, { status: 'thinking', lastPromptMessageId: 'msg-1', replyAttemptId: 'attempt-1' })
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn(),
      now: () => 100,
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn() },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const route = routes.find(route => route.type === 'TEAM_FRAME_ROLE_READY')!
    await route.handler({ type: route.type, chatId: 'chat-1', roleId: 'role-1' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 7 })

    expect(role).toMatchObject({ status: 'thinking', lastPromptMessageId: 'msg-1', replyAttemptId: 'attempt-1' })
  })

  it('counts a wait for a reply as stuck from when the reply last moved, whatever else the page reports', async () => {
    vi.resetModules()
    const store = createStoreWithReadyRole()
    const role = store.rolesById['role-1']
    const saved = 'https://chatgpt.com/c/6aec2ed9-a14c-83e8-98bb-cff4d37e0c07'
    // Asked hours ago; the reply never came.
    Object.assign(role, { chatSite: 'chatgpt', geminiConversationUrl: saved, status: 'thinking', lastPromptMessageId: 'msg-old', replyAttemptId: 'attempt-old', updatedAt: 1_000 })
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let time = 10 * 3_600_000
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-new`),
      now: () => time,
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(() => binding), getByRole: vi.fn(() => binding) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })
    const sender = { tab: { id: 101 } as chrome.tabs.Tab, frameId: 7, url: saved }
    const report = (type: string, fields: Record<string, unknown> = {}) => routes.find(route => route.type === type)!.handler({ type, chatId: 'chat-1', roleId: 'role-1', ...fields }, sender)

    // The group is opened again: the member's page loads and reports itself.
    await report('TEAM_FRAME_ROLE_READY', { conversationUrl: saved })
    await report('TEAM_SITE_STATUS_UPDATE', { siteId: 'chatgpt', status: 'ready' })
    await report('TEAM_ROLE_CONVERSATION_UPDATED', { conversationUrl: saved })
    expect(role).toMatchObject({ status: 'thinking', updatedAt: 1_000, siteHealth: { status: 'ready', updatedAt: time } })

    // So a message sent half a minute later reaches it, instead of finding it busy.
    time += 30_000
    const response = await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')!.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 还在吗' }, {})
    expect(response).toMatchObject({ ok: true, message: { deliveryStatus: { 'role-1': 'pending' } } })
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(role).toMatchObject({ status: 'thinking', lastPromptMessageId: 'msg-new', updatedAt: time })

    // A page that says it is still generating is a sign of life, and does count.
    time += 100_000
    await report('TEAM_SITE_STATUS_UPDATE', { siteId: 'chatgpt', status: 'generating' })
    expect(role.updatedAt).toBe(time)
  })

  it('does not start a member’s wait over when a message has to skip it', async () => {
    vi.resetModules()
    const store = createStoreWithReadyRole()
    store.chatsById['chat-1'].roleIds = ['role-1', 'role-2']
    const start = 10 * 3_600_000
    // 产品经理 was asked a while ago, 20 seconds short of counting as stuck, and has not answered.
    const askedAt = start - (REPLY_STUCK_AFTER_MS - 20_000)
    store.rolesById['role-2'] = { ...store.rolesById['role-1'], id: 'role-2', name: '产品经理', status: 'thinking', lastPromptMessageId: 'msg-old', replyAttemptId: 'attempt-old', updatedAt: askedAt }
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let time = start
    let ids = 0
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-${ids += 1}`),
      now: () => time,
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn((chatId: string, roleId: string): RuntimeFrameBinding => ({ chatId, roleId, tabId: 101, frameId: roleId === 'role-1' ? 7 : 8, ready: true, lastSeenAt: 0 })),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })
    const send = (raw: string) => routes.find(route => route.type === 'GROUP_MESSAGE_SEND')!.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw }, {})

    // A message for everyone goes to 工程师 alone; 产品经理 is still waiting, and stays so.
    expect(await send('@all 第一条')).toMatchObject({ ok: true, message: { deliveryStatus: { 'role-1': 'pending', 'role-2': 'error' } } })
    expect(sendPrompt.mock.calls.map(call => call[0].roleId)).toEqual(['role-1'])
    expect(store.rolesById['role-2']).toMatchObject({ status: 'thinking', lastPromptMessageId: 'msg-old', updatedAt: askedAt })

    // Half a minute later 产品经理 counts as stuck: the next message reaches it.
    time += 30_000
    expect(await send('@all 第二条')).toMatchObject({ ok: true, message: { deliveryStatus: { 'role-2': 'pending' } } })
    expect(sendPrompt.mock.calls.map(call => call[0].roleId)).toEqual(['role-1', 'role-2'])
  })

  it('ends a web member\'s reply nobody can read any more, lets what waits for it go on, and takes it back once read again', async () => {
    vi.resetModules()
    const store = createStoreWithReadyRole()
    const role = store.rolesById['role-1']
    Object.assign(role, { chatSite: 'chatgpt', status: 'thinking', lastPromptMessageId: 'msg-q', replyAttemptId: 'attempt-1', liveReply: { promptMessageId: 'msg-q', content: '写到一半', updatedAt: 50 }, updatedAt: 50 })
    store.messagesById['msg-q'] = { id: 'msg-q', chatId: 'chat-1', seq: 1, type: 'user', content: '选哪个', targetRoleIds: ['role-1'], createdAt: 40, status: 'sent', deliveryStatus: { 'role-1': 'sent' } }
    Object.assign(store.chatsById['chat-1'], { messageIds: ['msg-q'], nextMessageSeq: 2, status: 'running' })
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const onPromptSettled = vi.fn()
    const sendRoleMessage = vi.fn()
    const complete = vi.fn(async () => undefined)
    const broadcastStoreUpdated = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'loading' as GroupChat['status'],
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-new`),
      now: () => 1_000,
      onPromptSettled,
      promptDeliveryLimiter: { complete } as never,
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(() => binding), getByRole: vi.fn(() => binding) },
      sendRoleMessage,
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })
    const route = (type: string) => routes.find(candidate => candidate.type === type)!

    // The last OpenTeam page was closed while the member was replying.
    const response = await route('GROUP_REPLIES_INTERRUPTED').handler({ type: 'GROUP_REPLIES_INTERRUPTED', siteMembers: true, apiMembers: false }, {})

    expect(response).toMatchObject({ ok: true, settled: [{ chatId: 'chat-1', roleId: 'role-1', promptMessageId: 'msg-q' }] })
    expect(role).toMatchObject({ status: 'loading', updatedAt: 1_000 })
    const reply = store.messagesById['msg-new']
    expect(reply).toMatchObject({ type: 'assistant', roleId: 'role-1', sourceMessageId: 'msg-q', status: 'received' })
    expect(reply.content).toMatch(/^写到一半\n\n.*重新同步完整回复/s)
    expect(store.messagesById['msg-q']).toMatchObject({ status: 'error', deliveryStatus: { 'role-1': 'error' } })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(store)
    // What waits for the reply (a round, a discussion, a project) hears that it is over.
    expect(onPromptSettled).toHaveBeenCalledWith(store, 'chat-1', 'msg-q')
    expect(complete).toHaveBeenCalledWith('chat-1', 'msg-q', 'role-1')

    // Nothing more to end the next time.
    expect(await route('GROUP_REPLIES_INTERRUPTED').handler({ type: 'GROUP_REPLIES_INTERRUPTED', siteMembers: true, apiMembers: true }, {})).toEqual({ ok: true, settled: [] })

    // The group is opened again and the reply is read from the site in full: the page looks for
    // the reply that goes on from what had been read, not for the note.
    await route('GROUP_MESSAGE_RESYNC_REPLY').handler({ type: 'GROUP_MESSAGE_RESYNC_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-new' }, {})
    expect(sendRoleMessage).toHaveBeenCalledWith(101, 7, expect.objectContaining({ type: 'TEAM_RESYNC_REPLY', messageId: 'msg-new', currentContent: '写到一半' }))
    await route('TEAM_ROLE_REPLY_RESYNC').handler({ type: 'TEAM_ROLE_REPLY_RESYNC', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-new', content: '写到一半，后面也写完了。' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 7 })
    expect(store.messagesById['msg-new']).toMatchObject({ status: 'received', content: '写到一半，后面也写完了。' })
    expect(store.messagesById['msg-q']).toMatchObject({ status: 'received', deliveryStatus: { 'role-1': 'received' } })
  })

  it('forgets a conversation its site sent the member away from, and gives it the chat again', async () => {
    vi.resetModules()
    const store = createStoreWithReadyRole()
    const role = store.rolesById['role-1']
    const saved = 'https://chatgpt.com/c/6aec2ed9-a14c-83e8-98bb-cff4d37e0c07'
    Object.assign(role, { chatSite: 'chatgpt', geminiConversationUrl: saved, geminiConversationId: '6aec2ed9-a14c-83e8-98bb-cff4d37e0c07', contextCursor: 12 })
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const warn = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn },
      newId: vi.fn(),
      now: () => 100,
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn() },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })
    const route = routes.find(route => route.type === 'TEAM_ROLE_CONVERSATION_UPDATED')!
    const report = (conversationUrl: string) => route.handler({ type: route.type, chatId: 'chat-1', roleId: 'role-1', conversationUrl }, {})

    // Just after a prompt the site is still on its start page: the conversation is not lost.
    role.status = 'thinking'
    await report('https://chatgpt.com/')
    expect(role).toMatchObject({ geminiConversationUrl: saved, contextCursor: 12 })

    // A login page is not a new chat either.
    role.status = 'ready'
    await report('https://chatgpt.com/auth/login')
    expect(role).toMatchObject({ geminiConversationUrl: saved, contextCursor: 12 })

    // The site opened its start page instead of the conversation.
    await report('https://chatgpt.com/')
    expect(role.geminiConversationUrl).toBeUndefined()
    expect(role.geminiConversationId).toBeUndefined()
    expect(role.contextCursor).toBe(0)
    expect(warn).toHaveBeenCalledWith('conversation:lost', expect.objectContaining({ lostConversationUrl: saved }))

    // The new chat's address is kept as soon as the site gives it one.
    await report('https://chatgpt.com/c/6aee516c-ed04-83e8-9f3f-3838e219d32f')
    expect(role.geminiConversationUrl).toBe('https://chatgpt.com/c/6aee516c-ed04-83e8-9f3f-3838e219d32f')
  })

  it('exposes group message route and sends prompts through injected delivery', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { MESSAGE_ROUTE_TYPES, createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const broadcastStoreUpdated = vi.fn()
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    expect(MESSAGE_ROUTE_TYPES).toEqual([
      'GROUP_ROLE_RETRY_REPLY',
      'GROUP_ROLE_STOP_REPLY',
      'GROUP_NOTE_SAVE',
      'GROUP_MESSAGE_HIGHLIGHT_CREATE',
      'GROUP_MESSAGE_RESYNC_REPLY',
      'GROUP_MESSAGE_SEND',
      'GROUP_ROUND_SUMMARY_REQUEST',
      'GROUP_DISCUSSION_STOP',
      'GROUP_DISCUSSION_CONTINUE',
      'GROUP_PROJECT_START',
      'GROUP_PROJECT_APPROVE',
      'GROUP_PROJECT_REPLAN',
      'GROUP_PROJECT_SET_OWNER',
      'GROUP_PROJECT_STOP',
      'GROUP_PROJECT_CONTINUE',
      'TEAM_FRAME_ROLE_READY',
      'TEAM_ROLE_CONVERSATION_UPDATED',
      'TEAM_SEND_ACK',
      'TEAM_ROLE_STATUS',
      'TEAM_SITE_STATUS_UPDATE',
      'TEAM_ROLE_REPLY',
      'TEAM_ROLE_REPLY_PROGRESS',
      'TEAM_ROLE_REPLY_RESYNC',
      'TEAM_ROLE_ERROR',
      'GROUP_REPLIES_INTERRUPTED',
    ])
    expect(routes.map(route => route.type)).toEqual(MESSAGE_ROUTE_TYPES)

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 帮我评审一下' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        chatId: 'chat-1',
        content: '帮我评审一下',
        targetRoleIds: ['role-1'],
        mentionsAll: true,
        deliveryStatus: { 'role-1': 'pending' },
      },
      deliveries: [{ roleId: 'role-1' }],
    })
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      roleId: 'role-1',
      tabId: 101,
      frameId: 7,
      message: expect.objectContaining({
        type: 'TEAM_SEND_PROMPT',
        chatId: 'chat-1',
        roleId: 'role-1',
        messageId: 'msg-1',
        replyAttemptId: 'attempt-1',
        includesPersona: true,
        content: expect.stringContaining('帮我评审一下'),
      }),
    }))
    expect(draftStore?.rolesById['role-1']).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: 'msg-1',
      replyAttemptId: 'attempt-1',
    })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({ 'msg-1': expect.any(Object) }),
    }))
  })

  it('stores attachments with the message, writes text files into the prompt and hands images to delivery', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn()
    const saveUploads = vi.fn(async () => undefined)
    let nextId = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-${++nextId}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => binding) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
      imageAttachments: { captureReplyImages: vi.fn(), deleteByIds: vi.fn(), saveUploads },
    })
    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const uploads = [
      { kind: 'text', fileName: 'notes.md', mimeType: 'text/markdown', size: 9, text: '季度目标：增长' },
      { kind: 'image', fileName: 'chart.png', mimeType: 'image/png', size: 3, data: btoa('png') },
    ]

    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 看看附件', uploads }, {}) as { ok: boolean; message: GroupMessage }

    expect(response.ok).toBe(true)
    const attachments = draftStore?.messagesById[response.message.id].attachments ?? []
    expect(attachments).toEqual([
      { id: expect.stringMatching(/^attachment-/), type: 'file', status: 'ready', fileName: 'notes.md', mimeType: 'text/markdown', size: 21, text: '季度目标：增长' },
      { id: expect.stringMatching(/^attachment-/), type: 'image', status: 'ready', source: 'user-upload', mimeType: 'image/png', size: 3, fileName: 'chart.png' },
    ])
    expect(saveUploads).toHaveBeenCalledWith({ chatId: 'chat-1', messageId: response.message.id, images: [{ id: attachments[1].id, fileName: 'chart.png', mimeType: 'image/png', data: btoa('png') }] })
    expect(saveUploads.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0])
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      imageAttachmentIds: [attachments[1].id],
      message: expect.objectContaining({ content: expect.stringContaining('看看附件\n\nAttached file notes.md:\n```\n季度目标：增长\n```\n\nAttached images (uploaded with this message): chart.png') }),
    }))
  })

  it('refuses attachments that break the upload rules before storing anything', async () => {
    vi.resetModules()
    const mutateStore = vi.fn()
    vi.doMock('./storeAccess', async importOriginal => ({ ...(await importOriginal<typeof import('./storeAccess')>()), mutateStore }))
    const { createMessageHandlers } = await import('./messageHandlers')
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn() },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })
    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')

    await expect(sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all x', uploads: [{ kind: 'image', fileName: 'a.mp3', mimeType: 'audio/mpeg', data: 'AAAA' }] }, {}))
      .rejects.toThrow('不支持这种文件：a.mp3')
    // A PDF travels as its text, never as image data.
    await expect(sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all x', uploads: [{ kind: 'image', fileName: 'a.pdf', mimeType: 'application/pdf', data: 'AAAA' }] }, {}))
      .rejects.toThrow('附件格式不正确')
    expect(mutateStore).not.toHaveBeenCalled()
  })

  it('allows @all delivery when manual mention routing is required', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          store.chatsById['chat-1'].requireManualMention = true
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 帮我评审一下' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        content: '帮我评审一下',
        targetRoleIds: ['role-1'],
        mentionsAll: true,
        deliveryStatus: { 'role-1': 'pending' },
      },
      deliveries: [{ roleId: 'role-1' }],
    })
    expect(sendPrompt).toHaveBeenCalled()
    expect(draftStore?.messagesById['msg-1']).toMatchObject({
      targetRoleIds: ['role-1'],
      status: 'pending',
    })
  })

  it('sends no-mention collaborative messages to all roles when manual mention routing is off', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          store.chatsById['chat-1'].mode = 'collaborative'
          store.chatsById['chat-1'].requireManualMention = false
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '帮我评审一下' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        content: '帮我评审一下',
        targetRoleIds: ['role-1'],
        deliveryStatus: { 'role-1': 'pending' },
      },
      deliveries: [{ roleId: 'role-1' }],
    })
    expect(sendPrompt).toHaveBeenCalled()
    expect(draftStore?.rolesById['role-1']).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: 'msg-1',
      replyAttemptId: 'attempt-1',
    })
  })

  it('stores no-mention collaborative messages by default without triggering roles', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          store.chatsById['chat-1'].mode = 'collaborative'
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '先记录这个背景' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        content: '先记录这个背景',
        targetRoleIds: [],
        status: 'received',
      },
      deliveries: [],
    })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(draftStore?.rolesById['role-1'].status).toBe('ready')
  })

  it('starts the default orchestration flow from an @编排 chat message', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    addFlow(startingStore)
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const sendPrompt = vi.fn()
    const counters = new Map<string, number>()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1
        counters.set(prefix, next)
        return `${prefix}-${next}`
      }),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => ({ chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 100 })),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@编排 请做方案' }, {}) as { ok: boolean; run: { id: string; flowId: string }; store: OpenTeamStore }

    expect(response.ok).toBe(true)
    expect(response.run.flowId).toBe('flow-1')
    expect(response.store.messagesById['msg-1']).toMatchObject({
      content: '请做方案',
      orchestrationKind: 'task',
      orchestrationRunId: response.run.id,
    })
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      roleId: 'role-1',
      tabId: 101,
      frameId: 7,
      message: expect.objectContaining({
        type: 'TEAM_SEND_PROMPT',
        chatId: 'chat-1',
        roleId: 'role-1',
      }),
    }))
  })

  it('starts a named orchestration flow from an @编排:name chat message', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    addFlow(startingStore, { id: 'flow-default', name: '默认编排' })
    addFlow(startingStore, { id: 'flow-review', name: '代码评审' })
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const counters = new Map<string, number>()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1
        counters.set(prefix, next)
        return `${prefix}-${next}`
      }),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => ({ chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 100 })),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@编排:代码评审 请评审' }, {}) as { ok: boolean; run: { flowId: string } }

    expect(response.run.flowId).toBe('flow-review')
  })

  it('fails clearly when an @编排:name chat message has no matching flow', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    addFlow(startingStore, { id: 'flow-default', name: '默认编排' })
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')

    await expect(sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@编排:不存在 请评审' }, {}))
      .rejects.toThrow('找不到名为“不存在”的编排流程')
  })

  it('ignores role status messages without identity instead of surfacing a delivery error', async () => {
    vi.resetModules()
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log,
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(() => undefined),
        getByRole: vi.fn(),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const statusRoute = routes.find(route => route.type === 'TEAM_ROLE_STATUS')
    const response = await statusRoute?.handler({ type: 'TEAM_ROLE_STATUS', status: 'idle' }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 7 }) as { ok: boolean; error: string }

    expect(response).toMatchObject({ ok: false, error: '缺少 chatId/roleId，已忽略状态更新' })
    expect(log.warn).toHaveBeenCalledWith('role-status:missing-identity', expect.objectContaining({ runtimeStatus: 'idle' }))
  })

  it('stores site health updates from a bound role frame', async () => {
    vi.resetModules()
    let currentStore = createStoreWithReadyRole()
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 1 }
    const broadcastStoreUpdated = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(() => binding),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const healthRoute = routes.find(route => route.type === 'TEAM_SITE_STATUS_UPDATE')
    const response = await healthRoute?.handler({
      type: 'TEAM_SITE_STATUS_UPDATE',
      siteId: 'chatgpt',
      status: 'blocked',
      reason: 'http-error',
      detail: 'Access Denied',
    }, {
      tab: { id: 101 } as chrome.tabs.Tab,
      frameId: 7,
      url: 'https://chatgpt.com/c/test',
    }) as { ok: boolean; store: OpenTeamStore }

    expect(response.ok).toBe(true)
    expect((response.store.rolesById['role-1'] as { siteHealth?: unknown }).siteHealth).toEqual({
      siteId: 'chatgpt',
      status: 'blocked',
      reason: 'http-error',
      detail: 'Access Denied',
      updatedAt: 100,
    })

    const loading = await healthRoute?.handler({
      type: 'TEAM_SITE_STATUS_UPDATE',
      chatId: 'chat-1',
      roleId: 'role-1',
      siteId: 'chatgpt',
      status: 'loading',
      reason: 'not-a-reason',
    }, { tab: { id: 101 } as chrome.tabs.Tab, frameId: 7, url: 'https://chatgpt.com/c/test' }) as { ok: boolean; store: OpenTeamStore }
    expect(loading.ok).toBe(true)
    expect(loading.store.rolesById['role-1'].siteHealth).toEqual({ siteId: 'chatgpt', status: 'loading', updatedAt: 100 })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(response.store)
  })

  it('requests role recovery during ordinary message delivery retries', async () => {
    vi.resetModules()
    const testStore = createStoreWithReadyRole()
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(testStore)
          return { store: testStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error('成员 iframe 尚未就绪，请先恢复成员'))
      .mockResolvedValueOnce(undefined)
    const requestRoleRecovery = vi.fn(async () => true)
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
      requestRoleRecovery,
      waitForRetry: vi.fn(async () => undefined),
      deliveryRetryDelaysMs: [1],
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 继续发送' }, {}) as { ok: boolean }

    expect(response.ok).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(requestRoleRecovery).toHaveBeenCalledWith('chat-1', 'role-1', '成员 iframe 尚未就绪，请先恢复成员')
  })

  it('skips the OpenTeam persona when sending a first prompt to a ChatGPT GPTs role', async () => {
    vi.resetModules()
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          store.rolesById['role-1'].chatSite = 'chatgpt'
          store.rolesById['role-1'].chatGptGptsUrl = 'https://chatgpt.com/g/g-coach'
          const result = await mutator(store)
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 帮我评审一下' }, {})

    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({
        includesPersona: false,
        content: expect.not.stringContaining('从工程角度分析问题'),
      }),
    }))
  })

  it('stores no-mention messages without delivering prompts to group roles', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createStoreWithReadyRole()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const broadcastStoreUpdated = vi.fn()
    const sendPrompt = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '先记一下这个背景' }, {})

    expect(response).toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        chatId: 'chat-1',
        content: '先记一下这个背景',
        targetRoleIds: [],
        status: 'received',
        deliveryStatus: {},
      },
      deliveries: [],
    })
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(draftStore?.rolesById['role-1']?.status).toBe('ready')
    expect(draftStore?.rolesById['role-1']?.lastPromptMessageId).toBeUndefined()
    expect(draftStore?.rolesById['role-1']?.replyAttemptId).toBeUndefined()
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({ 'msg-1': expect.any(Object) }),
    }))
  })

  it('retries transient site prompt delivery failures before marking the role failed', async () => {
    vi.resetModules()
    let currentStore = createStoreWithReadyRole()
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn(async () => {
      if (sendPrompt.mock.calls.length < 3) throw new Error('编辑框暂不可用')
    })
    const sendError = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      deliveryRetryDelaysMs: [0, 0],
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError,
      sendPrompt,
      waitForRetry: vi.fn(async () => undefined),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 继续发送' }, {}) as { ok: boolean }

    expect(response.ok).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(3)
    expect(sendError).not.toHaveBeenCalled()
    expect(currentStore.rolesById['role-1']).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: 'msg-1',
      replyAttemptId: 'attempt-1',
    })
    expect(currentStore.messagesById['msg-1']).toMatchObject({
      status: 'pending',
      deliveryStatus: { 'role-1': 'pending' },
    })
  })

  it('marks a site delivery failed only after retry attempts are exhausted', async () => {
    vi.resetModules()
    let currentStore = createStoreWithReadyRole()
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn(async () => {
      throw new Error('发送按钮不可用')
    })
    const sendError = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      deliveryRetryDelaysMs: [0, 0],
      getChatStatusFromRoles: () => 'error',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError,
      sendPrompt,
      waitForRetry: vi.fn(async () => undefined),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 继续发送' }, {})

    expect(sendPrompt).toHaveBeenCalledTimes(3)
    expect(sendError).toHaveBeenCalledWith('发送按钮不可用')
    expect(currentStore.rolesById['role-1'].status).toBe('error')
    expect(currentStore.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(currentStore.messagesById['msg-1']).toMatchObject({
      status: 'error',
      deliveryStatus: { 'role-1': 'error' },
    })
  })

  it('does not block other site roles while one role delivery is still pending', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.chatsById['chat-1'].roleIds = ['role-1', 'role-2']
    startingStore.rolesById['role-2'] = {
      ...startingStore.rolesById['role-1'],
      id: 'role-2',
      name: '产品经理',
    }
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const bindingsByRole: Record<string, RuntimeFrameBinding> = {
      'role-1': { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 },
      'role-2': { chatId: 'chat-1', roleId: 'role-2', tabId: 102, frameId: 8, ready: true, lastSeenAt: 0 },
    }
    let releaseRoleOneDelivery!: () => void
    const roleOneDeliveryPending = new Promise<void>(resolve => {
      releaseRoleOneDelivery = resolve
    })
    const sendPrompt = vi.fn(async delivery => {
      if (delivery.roleId === 'role-1') await roleOneDeliveryPending
    })
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      deliveryRetryDelaysMs: [100],
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-${prefix === 'attempt' ? sendPrompt.mock.calls.length + 1 : 1}`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn((_chatId: string, roleId: string) => bindingsByRole[roleId]),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt,
      waitForRetry: vi.fn(async () => undefined),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const responsePromise = sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 继续发送' }, {}) as Promise<{ ok: boolean }>
    for (let index = 0; index < 10; index += 1) {
      if (sendPrompt.mock.calls.some(call => call[0].roleId === 'role-2')) break
      await Promise.resolve()
    }

    expect(sendPrompt.mock.calls.some(call => call[0].roleId === 'role-2')).toBe(true)
    releaseRoleOneDelivery()
    const response = await responsePromise

    expect(response.ok).toBe(true)
    expect(sendPrompt.mock.calls.map(call => call[0].roleId)).toEqual(['role-1', 'role-2'])
  })

  it('retries an active site prompt after a runtime timeout before marking the role failed', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.chatsById['chat-1'].messageIds = ['msg-1']
    startingStore.chatsById['chat-1'].nextMessageSeq = 2
    startingStore.chatsById['chat-1'].status = 'running'
    startingStore.messagesById['msg-1'] = {
      id: 'msg-1',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请分析',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'sent',
      deliveryStatus: { 'role-1': 'sent' },
    }
    startingStore.rolesById['role-1'].status = 'thinking'
    startingStore.rolesById['role-1'].lastPromptMessageId = 'msg-1'
    startingStore.rolesById['role-1'].replyAttemptId = 'attempt-old'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const binding: RuntimeFrameBinding = { chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 0 }
    const sendPrompt = vi.fn()
    const sendError = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      deliveryRetryDelaysMs: [],
      getChatStatusFromRoles: () => 'running',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'attempt' ? 'attempt-retry' : `${prefix}-1`),
      now: vi.fn(() => 200),
      roleErrorRetryDelaysMs: [0],
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => binding),
      },
      sendRoleMessage: vi.fn(),
      sendError,
      sendPrompt,
      waitForRetry: vi.fn(async () => undefined),
    })

    const errorRoute = routes.find(route => route.type === 'TEAM_ROLE_ERROR')
    const response = await errorRoute?.handler({
      type: 'TEAM_ROLE_ERROR',
      chatId: 'chat-1',
      roleId: 'role-1',
      messageId: 'msg-1',
      replyAttemptId: 'attempt-old',
      reason: '等待 chatgpt 回复超时（120 秒）',
    }, {}) as { ok: boolean; store: OpenTeamStore }

    expect(response.ok).toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      roleId: 'role-1',
      message: expect.objectContaining({
        messageId: 'msg-1',
        replyAttemptId: 'attempt-retry',
        content: expect.stringContaining('请分析'),
      }),
    }))
    expect(sendError).not.toHaveBeenCalled()
    expect(currentStore.rolesById['role-1']).toMatchObject({
      status: 'thinking',
      lastPromptMessageId: 'msg-1',
      replyAttemptId: 'attempt-retry',
    })
    expect(currentStore.messagesById['msg-1']).toMatchObject({
      status: 'pending',
      deliveryStatus: { 'role-1': 'pending' },
    })
  })

  it('asks for key points in a round and has an API member summarize it once everyone has answered', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let answered = 0
    const complete = vi.fn(async (input: { prompt: string }): Promise<{ content: string }> => ({
      content: input.prompt.includes('汇总人') ? '**共识**\n- 都支持方案 A' : `**要点**\n- 回复 ${++answered}`,
    }))
    const onPromptSettled = vi.fn()
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      onPromptSettled,
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })

    await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 选哪个方案？' }, {})
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3))

    const prompts = complete.mock.calls.map(([input]: [{ prompt: string }]) => input.prompt)
    expect(prompts[0]).toContain('**要点**')
    expect(prompts[1]).toContain('**要点**')
    expect(prompts[2]).toContain('你是「工程师」，这次请你担任本轮讨论的汇总人。')
    expect(prompts[2]).toContain('【工程师】\n**要点**\n- 回复 1')
    expect(prompts[2]).toContain('【设计师】\n**要点**\n- 回复 2')
    expect(prompts[2]).not.toContain('**要点**」')
    await vi.waitFor(() => expect(Object.values(currentStore.messagesById).some(message => message.content === '**共识**\n- 都支持方案 A')).toBe(true))
    const request = Object.values(currentStore.messagesById).find(message => message.roundSummaryOf)
    expect(request).toMatchObject({ type: 'user', roundSummaryOf: 'msg-1', targetRoleIds: ['role-1'], content: '汇总本轮回复' })
    expect(onPromptSettled).toHaveBeenCalledWith(expect.anything(), 'chat-1', 'msg-1')
    // The summary is not summarized again, and a single member's reply is never summarized.
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('has members review each other once all have answered (互相审), then summarizes the reviews', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    Object.assign(startingStore.chatsById['chat-1'], { mode: 'collaborative', crossReview: true })
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const prompts: string[] = []
    const complete = vi.fn(async (input: { prompt: string }) => {
      prompts.push(input.prompt)
      const who = input.prompt.includes('你是「设计师」') ? '设计师' : '工程师'
      if (input.prompt.includes('担任本轮讨论的汇总人')) return { content: '**共识**\n- 用 Go' }
      if (input.prompt.includes('互相审一审')) return { content: `${who}的审阅：同意对方，修正后用 Go` }
      return { content: `${who}的回答：用 Python` }
    })
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-${++messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })

    await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 用 Python 还是 Go？' }, {})
    const messages = () => currentStore.chatsById['chat-1'].messageIds.map(id => currentStore.messagesById[id])
    await vi.waitFor(() => expect(messages().some(message => message.roundSummaryOf)).toBe(true))
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(5))

    const question = messages().find(message => message.type === 'user' && message.content.includes('Python 还是 Go'))!
    const review = messages().find(message => message.crossReviewOf)!
    expect(review).toMatchObject({ crossReviewOf: question.id, targetRoleIds: ['role-1', 'role-2'], content: '互相审阅上一轮的回答' })
    // Each reviewer sees its own answer and the other's.
    const reviewPrompts = prompts.filter(prompt => prompt.includes('互相审一审'))
    expect(reviewPrompts).toHaveLength(2)
    for (const prompt of reviewPrompts) {
      expect(prompt).toContain('用 Python 还是 Go？')
      expect(prompt).toContain('你刚才的回答：')
      expect(prompt).toContain('其他成员的回答：')
      expect(prompt).toContain('**修正后的方案**')
    }
    expect(reviewPrompts.some(prompt => prompt.includes('你是「工程师」') && prompt.includes('【设计师】'))).toBe(true)
    expect(reviewPrompts.some(prompt => prompt.includes('你是「设计师」') && prompt.includes('【工程师】'))).toBe(true)
    // The summary is of the reviews, against the user's question, and only once.
    const summaryRequests = messages().filter(message => message.roundSummaryOf)
    expect(summaryRequests.map(message => message.roundSummaryOf)).toEqual([review.id])
    const summaryPrompt = prompts.find(prompt => prompt.includes('担任本轮讨论的汇总人'))!
    expect(summaryPrompt).toContain('各成员看过彼此的回答后的意见，以及修正后的方案')
    expect(summaryPrompt).toContain('用 Python 还是 Go？')
  })

  it('summarizes the round right away, with no review, when the group is not 互相审', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    Object.assign(startingStore.chatsById['chat-1'], { mode: 'collaborative' })
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })
    const { createMessageHandlers } = await import('./messageHandlers')
    const complete = vi.fn(async (input: { prompt: string }) => ({ content: input.prompt.includes('汇总人') ? '汇总' : '回答' }))
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-${++messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })
    await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 用 Python 还是 Go？' }, {})
    const messages = () => currentStore.chatsById['chat-1'].messageIds.map(id => currentStore.messagesById[id])
    await vi.waitFor(() => expect(messages().some(message => message.roundSummaryOf)).toBe(true))
    expect(messages().some(message => message.crossReviewOf)).toBe(false)
  })

  it('lets API members reply at the same time, at most two at once on one model', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    startingStore.settings.roundSummary = false
    startingStore.settings.externalModelOrder = ['model-1', 'model-2']
    startingStore.settings.externalModelsById['model-2'] = { ...startingStore.settings.externalModelsById['model-1'], id: 'model-2', name: '另一个模型' }
    const base = startingStore.rolesById['role-1']
    startingStore.rolesById['role-3'] = { ...structuredClone(base), id: 'role-3', name: '测试', systemPrompt: '从测试角度分析问题' }
    startingStore.rolesById['role-4'] = { ...structuredClone(base), id: 'role-4', name: '运维', systemPrompt: '从运维角度分析问题', externalModelId: 'model-2' }
    startingStore.chatsById['chat-1'].roleIds = ['role-1', 'role-2', 'role-3', 'role-4']
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    // Each reply waits until the test lets it finish; the test watches how many run at once.
    const running = new Map<string, number>()
    const most = new Map<string, number>()
    const releases: Array<() => void> = []
    const complete = vi.fn(async (input: { model: { id: string } }) => {
      const model = input.model.id
      running.set(model, (running.get(model) ?? 0) + 1)
      most.set(model, Math.max(most.get(model) ?? 0, running.get(model)!))
      await new Promise<void>(resolve => releases.push(resolve))
      running.set(model, running.get(model)! - 1)
      return { content: '回复' }
    })
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })

    const sent = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 选哪个方案？' }, {}) as Promise<{ store: OpenTeamStore }>
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3))
    // Two of the three on model-1 and the one on model-2 started together; the third waits its turn.
    expect([running.get('model-1'), running.get('model-2')]).toEqual([2, 1])
    const user = Object.values(currentStore.messagesById).find(message => message.type === 'user')!
    expect(Object.values(user.deliveryStatus ?? {}).filter(status => status === 'pending')).toHaveLength(1)

    while (complete.mock.calls.length < 4 || releases.length > 0) {
      releases.shift()?.()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const response = await sent
    expect([most.get('model-1'), most.get('model-2')]).toEqual([2, 1])
    expect(Object.values(response.store.messagesById).filter(message => message.type === 'assistant' && message.status === 'received')).toHaveLength(4)
  })

  it('leaves rounds alone when summaries are turned off, and explains a round that cannot be summarized yet', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    startingStore.settings.roundSummary = false
    startingStore.settings.replyKeyPoints = false
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const complete = vi.fn(async (_input: { prompt: string }) => ({ content: '回复' }))
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })

    await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 选哪个方案？' }, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls.map(([input]) => input.prompt).join('\n')).not.toContain('**要点**')

    await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@工程师 你呢？' }, {})
    const single = Object.values(currentStore.messagesById).find(message => message.type === 'user' && message.content === '你呢？')
    const summarize = routes.find(route => route.type === 'GROUP_ROUND_SUMMARY_REQUEST')
    await expect(summarize?.handler({ type: 'GROUP_ROUND_SUMMARY_REQUEST', chatId: 'chat-1', messageId: single?.id }, {})).rejects.toThrow('这一轮还不能汇总：需要至少两位成员回复完成')

    // Asked by hand, the first round is summarized even with automatic summaries off.
    const response = await summarize?.handler({ type: 'GROUP_ROUND_SUMMARY_REQUEST', chatId: 'chat-1', messageId: 'msg-1' }, {})
    expect(response).toMatchObject({ ok: true, message: { roundSummaryOf: 'msg-1', targetRoleIds: ['role-1'] } })
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it('runs a discussion turn by turn, hands the turn over on @, passes the user’s notes on, and summarizes it', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    startingStore.chatsById['chat-1'].mode = 'collaborative'
    startingStore.chatsById['chat-1'].discussionMode = true
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let releaseTurn2: () => void = () => {}
    const turn2 = new Promise<void>(resolve => { releaseTurn2 = resolve })
    let turns = 0
    const complete = vi.fn(async (input: { prompt: string }): Promise<{ content: string }> => {
      if (input.prompt.includes('汇总人')) return { content: '**共识**\n- 先修再说' }
      turns += 1
      if (turns === 1) return { content: '应该重写。@设计师 你怎么看？' }
      if (turns === 2) {
        await turn2
        return { content: '先别重写，先修。' }
      }
      return { content: `第 ${turns} 次发言` }
    })
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })
    const send = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')!

    const response = await send.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 要不要重写登录模块？' }, {})
    expect(response).toMatchObject({ ok: true, message: { discussionTopic: true, content: '要不要重写登录模块？', targetRoleIds: ['role-1', 'role-2'] }, deliveries: [{ roleId: 'role-1' }] })

    // Turn 2 goes to the member turn 1 @-mentioned; the user adds a note while it is written.
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    await send.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 预算只有两周' }, {})
    releaseTurn2()
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(5))
    await vi.waitFor(() => expect(Object.values(currentStore.messagesById).some(message => message.content === '**共识**\n- 先修再说')).toBe(true))

    const prompts = complete.mock.calls.map(([input]) => input.prompt)
    expect(prompts[0]).toContain('还没有人发言，由你开场。')
    expect(prompts[1]).toContain('你的身份是「设计师」。')
    expect(prompts[1]).toContain('【工程师】\n应该重写。@设计师 你怎么看？')
    expect(prompts[2]).toContain('你的身份是「工程师」。')
    expect(prompts[2]).toContain('【用户补充】\n@all 预算只有两周')
    expect(prompts[3]).toContain('你的身份是「设计师」。')
    expect(prompts[4]).toContain('讨论中的发言（按顺序）：')
    expect(prompts[4]).toContain('【设计师 · 第 2 轮】\n先别重写，先修。')

    const requests = Object.values(currentStore.messagesById).filter(message => message.discussionTurnOf).sort((a, b) => a.seq - b.seq)
    expect(requests.map(request => [request.discussionTurn, request.targetRoleIds?.[0], request.discussionHandoffFrom])).toEqual([
      [1, 'role-1', undefined], [2, 'role-2', 'role-1'], [3, 'role-1', undefined], [4, 'role-2', undefined],
    ])
    expect(requests[1].content).toBe('第 2/4 轮 · 「工程师」请「设计师」接着说')
    expect(Object.values(currentStore.messagesById).find(message => message.discussionNoteOf)).toMatchObject({ content: '@all 预算只有两周', targetRoleIds: [] })
    expect(currentStore.chatsById['chat-1'].discussion).toMatchObject({ status: 'done', turn: 4, maxTurns: 4 })
  })

  it('stops a discussion after the current turn and continues it for one more round', async () => {
    vi.resetModules()
    const startingStore = createStoreWithTwoApiRoles()
    startingStore.chatsById['chat-1'].mode = 'collaborative'
    startingStore.chatsById['chat-1'].discussionMode = true
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let releaseTurn2: () => void = () => {}
    const turn2 = new Promise<void>(resolve => { releaseTurn2 = resolve })
    let turns = 0
    const complete = vi.fn(async (_input: { prompt: string }): Promise<{ content: string }> => {
      turns += 1
      if (turns === 2) await turn2
      return { content: `发言 ${turns}` }
    })
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })
    const route = (type: string) => routes.find(candidate => candidate.type === type)!

    await route('GROUP_MESSAGE_SEND').handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 讨论一下' }, {})
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    await route('GROUP_DISCUSSION_STOP').handler({ type: 'GROUP_DISCUSSION_STOP', chatId: 'chat-1' }, {})
    releaseTurn2()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(complete).toHaveBeenCalledTimes(2)
    expect(currentStore.chatsById['chat-1'].discussion).toMatchObject({ status: 'stopped', stopReason: 'user', turn: 2 })

    const continued = await route('GROUP_DISCUSSION_CONTINUE').handler({ type: 'GROUP_DISCUSSION_CONTINUE', chatId: 'chat-1' }, {})
    expect(continued).toMatchObject({ ok: true, message: { discussionTurn: 3, targetRoleIds: ['role-1'] } })
    await vi.waitFor(() => expect(currentStore.chatsById['chat-1'].discussion).toMatchObject({ status: 'done', turn: 4, maxTurns: 4 }))
    await expect(route('GROUP_DISCUSSION_CONTINUE').handler({ type: 'GROUP_DISCUSSION_CONTINUE', chatId: 'chat-2' }, {})).rejects.toThrow()
  })

  it('runs a project: plan, approval, tasks in parallel and in order, a redo, the checks and the final deliverable', async () => {
    vi.resetModules()
    let currentStore = structuredClone(createStoreWithTwoApiRoles())
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let reviews = 0
    let t3Checks = 0
    const complete = vi.fn(async (input: { prompt: string }): Promise<{ content: string }> => {
      const prompt = input.prompt
      if (prompt.includes('请用完成目标所需的最少任务')) {
        return { content: '```json\n' + JSON.stringify({ tasks: [
          { id: 't1', title: '技术方案', owner: '工程师', dependsOn: [], detail: '写技术方案', doneWhen: '有架构说明' },
          { id: 't2', title: '界面草图', owner: '设计师', dependsOn: [], detail: '画界面', doneWhen: '有三个页面' },
          { id: 't3', title: '上线清单', owner: '设计师', dependsOn: ['t1', 't2'], detail: '列上线清单', doneWhen: '包含风险' },
        ] }) + '\n```' }
      }
      for (const id of ['t1', 't2', 't3']) {
        if (prompt.includes(`你的任务（${id}`)) {
          const redone = prompt.includes('上一次结果的检查意见：\n加上风险')
          return { content: `${id} ${redone ? '改好的' : ''}成果\n【状态】完成\n【摘要】${id} 摘要${redone ? '（含风险）' : ''}` }
        }
      }
      if (prompt.includes('任务和结果：')) {
        // Passes what the check lists; t3 is sent back once, then passes.
        reviews += 1
        const listed = prompt.match(/这些新结果：([^。]+)。/)?.[1].split('、') ?? []
        if (listed.includes('t3')) t3Checks += 1
        const decisions = listed.map(task => task === 't3' && t3Checks === 1 ? { task, verdict: 'redo', note: '加上风险' } : { task, verdict: 'pass', note: '对照完成标准检查过' })
        return { content: '```json\n' + JSON.stringify({ decisions, newTasks: [], finish: listed.includes('t3') && t3Checks > 1 }) + '\n```' }
      }
      if (prompt.includes('整合成一份完整的最终交付')) return { content: '# 最终方案\n全部内容' }
      return { content: '?' }
    })
    const onPromptSettled = vi.fn()
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      onPromptSettled,
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })
    const route = (type: string) => routes.find(candidate => candidate.type === type)!
    const project = () => currentStore.chatsById['chat-1'].project!

    const started = await route('GROUP_PROJECT_START').handler({ type: 'GROUP_PROJECT_START', chatId: 'chat-1', goal: '做一个记账 App 的上线方案', uploads: [{ kind: 'text', fileName: '需求.md', mimeType: 'text/markdown', text: '必须支持导出' }] }, {})
    expect(started).toMatchObject({ ok: true, message: { projectGoal: true, content: '做一个记账 App 的上线方案' } })
    await vi.waitFor(() => expect(project().status).toBe('awaiting-approval'))
    expect(complete.mock.calls[0][0].prompt).toContain('附件 需求.md：')
    expect(project()).toMatchObject({ coordinatorRoleId: 'role-1', steps: 1 })
    expect(project().tasks.map(task => [task.id, task.ownerRoleId, task.dependsOn])).toEqual([['t1', 'role-1', []], ['t2', 'role-2', []], ['t3', 'role-2', ['t1', 't2']]])
    await vi.waitFor(() => expect(onPromptSettled).toHaveBeenCalledWith(expect.anything(), 'chat-1', (started as { message: { id: string } }).message.id))

    // The owner of t3 can be changed while the plan waits.
    await route('GROUP_PROJECT_SET_OWNER').handler({ type: 'GROUP_PROJECT_SET_OWNER', chatId: 'chat-1', taskId: 't3', roleId: 'role-1' }, {})
    await route('GROUP_PROJECT_SET_OWNER').handler({ type: 'GROUP_PROJECT_SET_OWNER', chatId: 'chat-1', taskId: 't3', roleId: 'role-2' }, {})
    await route('GROUP_PROJECT_APPROVE').handler({ type: 'GROUP_PROJECT_APPROVE', chatId: 'chat-1' }, {})
    await vi.waitFor(() => expect(project().status).toBe('done'))

    const prompts = complete.mock.calls.map(([input]) => input.prompt)
    const order = prompts.map(prompt => prompt.match(/你的任务（(t\d)/)?.[1] ?? (prompt.includes('任务和结果：') ? 'review' : prompt.includes('请用完成目标所需的最少任务') ? 'plan' : prompt.includes('最终交付') ? 'final' : '?'))
    expect(order.slice(0, 3)).toEqual(['plan', 't1', 't2'])
    // t3 builds on t1 and t2, so it starts only once both are checked: the coordinator (工程师) checks
    // 设计师's t2, and 设计师 checks the coordinator's own t1.
    expect(order.slice(3)).toEqual(['review', 'review', 't3', 'review', 't3', 'review', 'final'])
    expect(prompts[3]).toContain('你是「工程师」，这个项目的协调员。')
    expect(prompts[3]).toContain('这些新结果：t2。')
    expect(prompts[3]).toContain('至少指出一个具体问题或可以改进的地方')
    expect(prompts[4]).toContain('你是「设计师」。下面这些任务是协调员「工程师」自己做的，由你来检查')
    expect(prompts[4]).toContain('这些新结果：t1。')
    expect(prompts[4]).not.toContain('newTasks')
    const firstT3 = prompts[5]
    expect(firstT3).toContain('【t1 · 技术方案 · 工程师】\nt1 成果')
    expect(firstT3).toContain('【t2 · 界面草图 · 设计师】\nt2 成果')
    expect(prompts[7]).toContain('上一次结果的检查意见：\n加上风险')
    expect(prompts[8]).toContain('结果：\nt1 摘要')
    expect(prompts[8]).toContain('t3 改好的成果')

    expect(project().tasks.map(task => [task.id, task.status, task.attempts, task.summary])).toEqual([
      ['t1', 'done', 1, 't1 摘要'], ['t2', 'done', 1, 't2 摘要'], ['t3', 'done', 2, 't3 摘要（含风险）'],
    ])
    expect(project().steps).toBe(10)
    expect(currentStore.messagesById[project().finalMessageId!]).toMatchObject({ type: 'assistant', content: '# 最终方案\n全部内容' })
    const notices = Object.values(currentStore.messagesById).filter(message => message.projectRequest).sort((a, b) => a.seq - b.seq).map(message => message.content)
    expect(notices).toContain('项目 · 任务 t3「上线清单」交给「设计师」（第 2 次）')
    expect(notices[notices.length - 1]).toBe('项目 · 请「工程师」整理最终交付')
  })

  // A project between 工程师 (the coordinator, role-1) and 设计师 (role-2), answered by `answer`.
  async function runProjectWith(answer: (prompt: string) => { content: string }) {
    vi.resetModules()
    let currentStore = structuredClone(createStoreWithTwoApiRoles())
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })
    const { createMessageHandlers } = await import('./messageHandlers')
    const prompts: string[] = []
    const complete = vi.fn(async (input: { prompt: string }) => {
      prompts.push(input.prompt)
      return answer(input.prompt)
    })
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })
    const route = (type: string) => routes.find(candidate => candidate.type === type)!
    await route('GROUP_PROJECT_START').handler({ type: 'GROUP_PROJECT_START', chatId: 'chat-1', goal: '记账 App 的上线方案' }, {})
    await vi.waitFor(() => expect(currentStore.chatsById['chat-1'].project?.status).toBe('awaiting-approval'))
    await route('GROUP_PROJECT_APPROVE').handler({ type: 'GROUP_PROJECT_APPROVE', chatId: 'chat-1' }, {})
    await vi.waitFor(() => expect(['done', 'stopped']).toContain(currentStore.chatsById['chat-1'].project?.status))
    return { project: currentStore.chatsById['chat-1'].project!, prompts, store: currentStore }
  }

  const twoTaskPlan = '```json\n' + JSON.stringify({ tasks: [
    { id: 't1', title: '技术方案', owner: '工程师', dependsOn: [], detail: '写技术方案', doneWhen: '有架构说明' },
    { id: 't2', title: '界面草图', owner: '设计师', dependsOn: [], detail: '画界面', doneWhen: '有三个页面' },
  ] }) + '\n```'
  const reviewOf = (prompt: string) => prompt.match(/这些新结果：([^。]+)。/)?.[1].split('、') ?? []
  const verdicts = (tasks: string[], verdict: string, extra: Record<string, unknown> = {}) => ({ content: '```json\n' + JSON.stringify({ decisions: tasks.map(task => ({ task, verdict, note: '对照完成标准检查过' })), newTasks: [], finish: false, ...extra }) + '\n```' })

  it("hands back to the coordinator when a member's check leaves a task failed", async () => {
    const { project, prompts } = await runProjectWith(prompt => {
      if (prompt.includes('请用完成目标所需的最少任务')) return { content: twoTaskPlan }
      const task = prompt.match(/你的任务（(t\d)/)?.[1]
      if (task) return { content: `${task} 成果\n【状态】完成\n【摘要】${task} 摘要` }
      if (prompt.includes('由你来检查')) return verdicts(reviewOf(prompt), 'pass')
      // The coordinator keeps sending t2 back until it fails, then finishes with what passed.
      if (prompt.includes('任务和结果：')) return reviewOf(prompt).includes('t2') ? verdicts(['t2'], 'redo') : verdicts([], 'pass', { finish: true })
      return { content: '# 最终方案' }
    })

    expect(project.status).toBe('done')
    expect(project.tasks.map(task => [task.id, task.status])).toEqual([['t1', 'done'], ['t2', 'failed']])
    const reviewers = prompts.filter(prompt => prompt.includes('任务和结果：')).map(prompt => prompt.includes('由你来检查') ? 'member' : 'coordinator')
    // Three checks of t2 by the coordinator, the member's check of the coordinator's t1, then the
    // coordinator decides about the failed t2.
    expect(reviewers).toEqual(['coordinator', 'coordinator', 'coordinator', 'member', 'coordinator'])
  })

  it('makes a task blocked, not sent again at once, when the member could not do it', async () => {
    let designerTries = 0
    const { project, prompts } = await runProjectWith(prompt => {
      if (prompt.includes('请用完成目标所需的最少任务')) return { content: twoTaskPlan }
      const task = prompt.match(/你的任务（(t\d)/)?.[1]
      if (task === 't2' && prompt.includes('你是「设计师」')) {
        designerTries += 1
        throw Object.assign(new Error('页面上有弹窗挡住了发送'), { status: 403 })
      }
      if (task) return { content: `${task} 成果\n【状态】完成\n【摘要】${task} 摘要` }
      if (prompt.includes('由你来检查')) return verdicts(reviewOf(prompt), 'pass')
      // The coordinator gives the blocked task to 工程师.
      if (prompt.includes('受阻原因：')) return { content: '```json\n' + JSON.stringify({ decisions: [{ task: 't2', verdict: 'reassign', owner: '工程师', note: '设计师的页面用不了' }], newTasks: [], finish: false }) + '\n```' }
      if (prompt.includes('任务和结果：')) return verdicts(reviewOf(prompt), 'pass')
      return { content: '# 最终方案' }
    })

    expect(designerTries).toBe(1)
    expect(prompts.find(prompt => prompt.includes('受阻原因：'))).toContain('弹窗')
    expect(project.status).toBe('done')
    expect(project.tasks.map(task => [task.id, task.status, task.ownerRoleId])).toEqual([['t1', 'done', 'role-1'], ['t2', 'done', 'role-1']])
    // Both are the coordinator's work now: 设计师 checks them.
    expect(prompts.some(prompt => prompt.includes('你是「设计师」。下面这些任务是协调员「工程师」自己做的') && prompt.includes('这些新结果：t1、t2。'))).toBe(true)
  })

  it('waits for the user when the coordinator asks, goes on with the answer, and can be stopped and continued', async () => {
    vi.resetModules()
    let currentStore = structuredClone(createStoreWithTwoApiRoles())
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const complete = vi.fn(async (input: { prompt: string }): Promise<{ content: string }> => {
      const prompt = input.prompt
      if (prompt.includes('请用完成目标所需的最少任务')) {
        return { content: '{"tasks":[{"id":"t1","title":"预算表","owner":"设计师","detail":"列预算","doneWhen":"有总数"},{"id":"t2","title":"排期","owner":"工程师","detail":"排期","doneWhen":"有日期"}]}' }
      }
      if (prompt.includes('你的任务（')) return { content: '成果\n【状态】完成\n【摘要】做好了' }
      if (prompt.includes('任务和结果：')) {
        return { content: prompt.includes('预算 5 万')
          ? '{"decisions":[{"task":"t1","verdict":"pass"},{"task":"t2","verdict":"pass"}],"finish":true}'
          : '{"decisions":[],"question":"预算上限是多少？","finish":false}' }
      }
      return { content: '最终交付' }
    })
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-${messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => {}),
    })
    const route = (type: string) => routes.find(candidate => candidate.type === type)!
    const project = () => currentStore.chatsById['chat-1'].project!

    await route('GROUP_PROJECT_START').handler({ type: 'GROUP_PROJECT_START', chatId: 'chat-1', goal: '办一场发布会' }, {})
    await vi.waitFor(() => expect(project().status).toBe('awaiting-approval'))
    await expect(route('GROUP_PROJECT_START').handler({ type: 'GROUP_PROJECT_START', chatId: 'chat-1', goal: '另一个' }, {})).rejects.toThrow('这个群聊已经有进行中的项目，请先停止它')
    await route('GROUP_PROJECT_APPROVE').handler({ type: 'GROUP_PROJECT_APPROVE', chatId: 'chat-1' }, {})
    await vi.waitFor(() => expect(project().status).toBe('waiting-user'))
    expect(project().question).toBe('预算上限是多少？')

    // The answer goes in through the message box, as a note for the coordinator.
    await route('GROUP_MESSAGE_SEND').handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 预算 5 万' }, {})
    expect(Object.values(currentStore.messagesById).find(message => message.projectNoteOf)).toMatchObject({ content: '@all 预算 5 万', targetRoleIds: [] })
    await vi.waitFor(() => expect(project().status).toBe('done'))

    // A new project can start once this one is done; stopping and continuing work on it.
    await route('GROUP_PROJECT_START').handler({ type: 'GROUP_PROJECT_START', chatId: 'chat-1', goal: '第二个项目' }, {})
    await route('GROUP_PROJECT_STOP').handler({ type: 'GROUP_PROJECT_STOP', chatId: 'chat-1' }, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(project()).toMatchObject({ status: 'stopped', stopReason: 'user' })
    await route('GROUP_PROJECT_CONTINUE').handler({ type: 'GROUP_PROJECT_CONTINUE', chatId: 'chat-1' }, {})
    await vi.waitFor(() => expect(project().status).toBe('awaiting-approval'))
  })

  it('delivers external model roles through the API runtime without requiring an iframe', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: '本地模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'local-chat-model',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    delete startingStore.rolesById['role-1'].chatSite

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const getByRole = vi.fn(() => undefined)
    const externalModelClient = {
      complete: vi.fn(async () => ({ content: 'API 回复内容' })),
    }
    const broadcastStoreUpdated = vi.fn()
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      externalModelClient,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole,
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 用 API 回答' }, {})

    expect(response).toMatchObject({
      ok: true,
      deliveries: [{ roleId: 'role-1', modelSource: 'external' }],
    })
    expect(getByRole).not.toHaveBeenCalledWith('chat-1', 'role-1')
    expect(externalModelClient.complete).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'model-1', modelName: 'local-chat-model' }),
      prompt: expect.stringContaining('用 API 回答'),
    }))
    expect(broadcastStoreUpdated).toHaveBeenLastCalledWith(expect.objectContaining({
      messagesById: expect.objectContaining({
        'msg-1': expect.objectContaining({ status: 'received' }),
        'msg-2': expect.objectContaining({
          type: 'assistant',
          content: 'API 回复内容',
          roleId: 'role-1',
        }),
      }),
    }))
  })

  it("copies an earlier message's files onto a new one, as each team invitation does", async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.chatsById['chat-1'].requireManualMention = true
    startingStore.messagesById['msg-files'] = {
      id: 'msg-files', chatId: 'chat-1', seq: 1, type: 'user', content: '项目资料', createdAt: 1, status: 'received',
      attachments: [
        { id: 'img-1', type: 'image', status: 'ready', source: 'user-upload', mimeType: 'image/png', size: 3, fileName: 'chart.png' },
        { id: 'file-1', type: 'file', status: 'ready', fileName: 'spec.md', mimeType: 'text/markdown', size: 6, text: '# spec' },
      ],
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-files']
    startingStore.chatsById['chat-1'].nextMessageSeq = 2
    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })
    const { createMessageHandlers } = await import('./messageHandlers')
    const saveUploads = vi.fn(async () => undefined)
    const loadUploads = vi.fn(async (ids: string[]) => ids.map(() => ({ fileName: 'chart.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78]), data: btoa(String.fromCharCode(137, 80, 78)) })))
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      getChatStatusFromRoles: () => 'ready',
      imageAttachments: { captureReplyImages: vi.fn(), deleteByIds: vi.fn(async () => undefined), saveUploads, loadUploads },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-${++messageIdSeq}`),
      now: vi.fn(() => 100),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    } as never)
    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')!

    const response = await sendRoute.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '请看资料', attachmentsFrom: 'msg-files' }, {}) as { message: GroupMessage }

    expect(loadUploads).toHaveBeenCalledWith(['img-1'])
    expect(response.message.attachments).toEqual([
      expect.objectContaining({ type: 'image', source: 'user-upload', fileName: 'chart.png', mimeType: 'image/png' }),
      expect.objectContaining({ type: 'file', fileName: 'spec.md', text: '# spec' }),
    ])
    // Its own copy of the image, stored under the new message.
    expect(saveUploads).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1', messageId: response.message.id, images: [expect.objectContaining({ fileName: 'chart.png', mimeType: 'image/png' })] }))
    await expect(sendRoute.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '再看', attachmentsFrom: 'msg-gone' }, {})).rejects.toThrow('找不到要附带的资料')
  })

  it('streams external model replies into a pending assistant message', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: '流式模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'local-chat-model',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const externalModelClient = {
      stream: vi.fn(async function* (input: { onUsage?(usage: { inputTokens: number; outputTokens: number; totalTokens: number }): void }) {
        yield '第一段'
        yield '第二段'
        input.onUsage?.({ inputTokens: 120, outputTokens: 30, totalTokens: 150 })
      }),
    }
    const broadcasts: OpenTeamStore[] = []
    let messageIdSeq = 0
    const onPromptSettled = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(async (store: OpenTeamStore) => {
        broadcasts.push(structuredClone(store))
      }),
      onPromptSettled,
      externalModelClient: externalModelClient as never,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 流式回答' }, {}) as { store: OpenTeamStore } | undefined

    expect(externalModelClient.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.objectContaining({ id: 'model-1' }),
      prompt: expect.stringContaining('流式回答'),
    }))
    expect(broadcasts.some(store => store.messagesById['msg-2']?.status === 'pending')).toBe(true)
    expect(broadcasts.some(store => store.messagesById['msg-2']?.content === '第一段')).toBe(true)
    const finalStore = broadcasts[broadcasts.length - 1]
    expect(finalStore?.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '第一段第二段',
      status: 'received',
      roleId: 'role-1',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    })
    expect(finalStore?.messagesById['msg-1']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
    expect(response?.store.messagesById['msg-2']).toMatchObject({
      content: '第一段第二段',
      status: 'received',
    })
    expect(response?.store.rolesById['role-1']).toMatchObject({ status: 'ready' })
    // Every member answered: the background is told, to notify the user.
    expect(onPromptSettled).toHaveBeenCalledWith(expect.objectContaining({ messagesById: expect.any(Object) }), 'chat-1', 'msg-1')
  })

  it('saves a reply being written a few times a second, not on every piece, and all of it at the end', async () => {
    vi.resetModules()
    let currentStore = createStoreWithTwoApiRoles()
    currentStore.settings.roundSummary = false
    currentStore.chatsById['chat-1'].roleIds = ['role-1']
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let clock = 1_000
    const externalModelClient = {
      stream: vi.fn(async function* () {
        // Five pieces 40 ms apart, then one 200 ms later.
        for (const piece of ['一', '二', '三', '四', '五']) {
          yield piece
          clock += 40
        }
        clock += 200
        yield '六'
      }),
    }
    const contents: string[] = []
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(async (store: OpenTeamStore) => {
        const reply = store.messagesById['msg-2']
        if (reply?.status === 'pending' && reply.content) contents.push(reply.content)
      }),
      externalModelClient: externalModelClient as never,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => clock),
      runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => undefined) },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const response = await routes.find(route => route.type === 'GROUP_MESSAGE_SEND')?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 流式回答' }, {}) as { store: OpenTeamStore }

    // The first piece at once, the fifth (160 ms on), the sixth; the second to fourth wait.
    expect(contents).toEqual(['一', '一二三四五', '一二三四五六'])
    expect(response.store.messagesById['msg-2']).toMatchObject({ content: '一二三四五六', status: 'received' })
  })

  it('retries external model failures before content starts and keeps one assistant placeholder', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: 'API 模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'local-chat-model',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const externalModelClient = {
      complete: vi.fn(async () => {
        if (externalModelClient.complete.mock.calls.length === 1) throw new Error('网络暂时不可用')
        return { content: '重试后的 API 回复' }
      }),
    }
    let messageIdSeq = 0
    // What the page was shown while the request was sent again.
    const shown: Array<OpenTeamStore['messagesById'][string] | undefined> = []
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn((store: OpenTeamStore) => { shown.push(structuredClone(store.messagesById['msg-2'])) }),
      externalModelClient,
      externalModelRetryDelaysMs: [0],
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => undefined),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 用 API 回答' }, {}) as { store: OpenTeamStore }

    expect(externalModelClient.complete).toHaveBeenCalledTimes(2)
    expect(shown.some(reply => reply?.status === 'pending' && reply.retry?.attempt === 1 && reply.retry.total === 1 && reply.retry.reason === '网络暂时不可用')).toBe(true)
    expect(response.store.messagesById['msg-2'].retry).toBeUndefined()
    expect(response.store.chatsById['chat-1'].messageIds).toEqual(['msg-1', 'msg-2'])
    expect(response.store.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '重试后的 API 回复',
      status: 'received',
      roleId: 'role-1',
    })
    expect(response.store.messagesById['msg-1']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
  })


  it('does not retry an API error that asking again cannot fix, such as a wrong key', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: 'API 模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'local-chat-model',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const externalModelClient = {
      complete: vi.fn(async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      }),
    }
    let messageIdSeq = 0
    // What the page was shown while the request was sent again.
    const shown: Array<OpenTeamStore['messagesById'][string] | undefined> = []
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn((store: OpenTeamStore) => { shown.push(structuredClone(store.messagesById['msg-2'])) }),
      externalModelClient,
      externalModelRetryDelaysMs: [0, 0, 0],
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      waitForRetry: vi.fn(async () => undefined),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const response = await sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 用 API 回答' }, {}) as { store: OpenTeamStore }

    expect(externalModelClient.complete).toHaveBeenCalledTimes(1)
    expect(response.store.messagesById['msg-2']).toMatchObject({ type: 'assistant', status: 'error' })
  })
  it('stops an active external model stream without requiring an iframe', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    startingStore.rolesById['role-1'].status = 'thinking'
    startingStore.rolesById['role-1'].lastPromptMessageId = 'msg-1'
    startingStore.rolesById['role-1'].replyAttemptId = 'attempt-1'
    startingStore.messagesById['msg-1'] = {
      id: 'msg-1',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请回答',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'pending',
      deliveryStatus: { 'role-1': 'pending' },
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-1']
    startingStore.chatsById['chat-1'].nextMessageSeq = 2

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const abort = vi.fn()
    const getByRole = vi.fn(() => undefined)
    const sendRoleMessage = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete: vi.fn() },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-stopped`),
      now: vi.fn(() => 200),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole,
      },
      sendRoleMessage,
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      externalModelRuns: {
        abort,
        register: vi.fn(),
        unregister: vi.fn(),
      },
    } as never)

    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const response = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {})

    expect(response).toMatchObject({ ok: true, messageId: 'msg-1' })
    expect(abort).toHaveBeenCalledWith('chat-1', 'role-1', 'attempt-1')
    expect(getByRole).not.toHaveBeenCalled()
    expect(sendRoleMessage).not.toHaveBeenCalled()
    expect(currentStore.rolesById['role-1']).toMatchObject({
      status: 'stopped',
      replyAttemptId: 'stopped-stopped',
    })
  })

  it('locally stops a site reply when the role iframe receiver has disconnected', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.rolesById['role-1'].status = 'thinking'
    startingStore.rolesById['role-1'].lastPromptMessageId = 'msg-1'
    startingStore.rolesById['role-1'].replyAttemptId = 'attempt-1'
    startingStore.messagesById['msg-1'] = {
      id: 'msg-1',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请回答',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'sent',
      deliveryStatus: { 'role-1': 'sent' },
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-1']
    startingStore.chatsById['chat-1'].nextMessageSeq = 2

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const broadcastStoreUpdated = vi.fn()
    const sendRoleMessage = vi.fn(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.')
    })
    const routes = createMessageHandlers({
      broadcastStoreUpdated,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-stopped`),
      now: vi.fn(() => 200),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => ({ chatId: 'chat-1', roleId: 'role-1', tabId: 101, frameId: 7, ready: true, lastSeenAt: 100 })),
      },
      sendRoleMessage,
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const response = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {}) as { store: OpenTeamStore }

    expect(response).toMatchObject({ ok: true, messageId: 'msg-1' })
    expect(sendRoleMessage).toHaveBeenCalledWith(101, 7, expect.objectContaining({
      type: 'TEAM_STOP_GENERATION',
      messageId: 'msg-1',
      replyAttemptId: 'attempt-1',
    }))
    expect(response.store.rolesById['role-1']).toMatchObject({
      status: 'stopped',
      replyAttemptId: 'stopped-stopped',
    })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(response.store)
  })

  it('finalizes the visible external assistant message even when abort does not reach the stream', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    startingStore.rolesById['role-1'].status = 'thinking'
    startingStore.rolesById['role-1'].lastPromptMessageId = 'msg-1'
    startingStore.rolesById['role-1'].replyAttemptId = 'attempt-1'
    startingStore.messagesById['msg-1'] = {
      id: 'msg-1',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '请回答',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'sent',
      deliveryStatus: { 'role-1': 'sent' },
    }
    startingStore.messagesById['msg-2'] = {
      id: 'msg-2',
      chatId: 'chat-1',
      seq: 2,
      type: 'assistant',
      content: '已经收到的流式内容',
      roleId: 'role-1',
      roleName: '工程师',
      createdAt: 2,
      status: 'pending',
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-1', 'msg-2']
    startingStore.chatsById['chat-1'].nextMessageSeq = 3

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    const abort = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: { complete: vi.fn() },
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-stopped`),
      now: vi.fn(() => 200),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
      externalModelRuns: {
        abort,
        register: vi.fn(),
        unregister: vi.fn(),
      },
    } as never)

    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const response = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {}) as { store: OpenTeamStore }

    expect(abort).toHaveBeenCalledWith('chat-1', 'role-1', 'attempt-1')
    expect(response.store.messagesById['msg-2']).toMatchObject({
      content: '已经收到的流式内容',
      status: 'received',
    })
    expect(response.store.messagesById['msg-1']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
    expect(response.store.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(response.store.rolesById['role-1'].replyAttemptId).toBeUndefined()
  })

  it('keeps a stopped external stream in its existing assistant message', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: '流式模型',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'local-chat-model',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let firstChunkConsumed!: () => void
    const firstChunkStored = new Promise<void>(resolve => {
      firstChunkConsumed = resolve
    })
    const externalModelClient = {
      stream: vi.fn(async function* () {
        yield '第一段'
        firstChunkConsumed()
        await new Promise<void>(() => undefined)
      }),
    }
    let messageIdSeq = 0
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient: externalModelClient as never,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-${++messageIdSeq}` : `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole: vi.fn(() => undefined),
      },
      sendRoleMessage: vi.fn(),
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const sendRoute = routes.find(route => route.type === 'GROUP_MESSAGE_SEND')
    const stopRoute = routes.find(route => route.type === 'GROUP_ROLE_STOP_REPLY')
    const sendPromise = sendRoute?.handler({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@all 流式回答' }, {}) as Promise<{ store: OpenTeamStore }>
    await firstChunkStored
    const stopResponse = await stopRoute?.handler({ type: 'GROUP_ROLE_STOP_REPLY', chatId: 'chat-1', roleId: 'role-1' }, {}) as { store: OpenTeamStore }

    expect(stopResponse.store.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '第一段',
      status: 'received',
      roleId: 'role-1',
    })
    expect(stopResponse.store.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(stopResponse.store.rolesById['role-1'].replyAttemptId).toBeUndefined()

    const responseOrTimeout = await Promise.race([
      sendPromise,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 25)),
    ])

    expect(currentStore.chatsById['chat-1'].messageIds).toEqual(['msg-1', 'msg-2'])
    expect(responseOrTimeout).not.toBe('timeout')
    const response = responseOrTimeout as { store: OpenTeamStore }
    expect(response.store.messagesById['msg-2']).toMatchObject({
      type: 'assistant',
      content: '第一段',
      status: 'received',
      roleId: 'role-1',
    })
    expect(response.store.rolesById['role-1']).toMatchObject({ status: 'stopped' })
    expect(response.store.rolesById['role-1'].lastPromptMessageId).toBeUndefined()
    expect(response.store.rolesById['role-1'].replyAttemptId).toBeUndefined()
  })

  it('retries external model replies by discarding the selected assistant message and streaming again', async () => {
    vi.resetModules()
    const startingStore = createStoreWithReadyRole()
    startingStore.settings.externalModelOrder = ['model-1']
    startingStore.settings.externalModelsById = {
      'model-1': {
        id: 'model-1',
        name: 'OpenRouter Claude',
        format: 'openai',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'sk-test',
        modelName: 'anthropic/claude-sonnet',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    startingStore.rolesById['role-1'].modelSource = 'external'
    startingStore.rolesById['role-1'].externalModelId = 'model-1'
    startingStore.messagesById['msg-user'] = {
      id: 'msg-user',
      chatId: 'chat-1',
      seq: 1,
      type: 'user',
      content: '重新回答这个问题',
      targetRoleIds: ['role-1'],
      createdAt: 1,
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    }
    startingStore.messagesById['msg-old-reply'] = {
      id: 'msg-old-reply',
      chatId: 'chat-1',
      seq: 2,
      type: 'assistant',
      content: '旧 API 回复',
      roleId: 'role-1',
      roleName: '工程师',
      createdAt: 2,
      status: 'received',
    }
    startingStore.chatsById['chat-1'].messageIds = ['msg-user', 'msg-old-reply']
    startingStore.chatsById['chat-1'].nextMessageSeq = 3

    let currentStore = structuredClone(startingStore)
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const result = await mutator(currentStore)
          currentStore = structuredClone(currentStore)
          return { store: currentStore, result }
        }),
      }
    })

    const { createMessageHandlers } = await import('./messageHandlers')
    let messageIdSeq = 0
    const externalModelClient = {
      stream: vi.fn(async function* () {
        yield '新的 API 回复'
      }),
      complete: vi.fn(),
    }
    const getByRole = vi.fn(() => undefined)
    const sendRoleMessage = vi.fn()
    const routes = createMessageHandlers({
      broadcastStoreUpdated: vi.fn(),
      externalModelClient,
      getChatStatusFromRoles: () => 'ready',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => prefix === 'msg' ? `${prefix}-new-${++messageIdSeq}` : `${prefix}-retry`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        bind: vi.fn(),
        getByAddress: vi.fn(),
        getByRole,
      },
      sendRoleMessage,
      sendError: vi.fn(),
      sendPrompt: vi.fn(),
    })

    const retryRoute = routes.find(route => route.type === 'GROUP_ROLE_RETRY_REPLY')
    const response = await retryRoute?.handler({ type: 'GROUP_ROLE_RETRY_REPLY', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-old-reply' }, {}) as { ok: boolean; store: OpenTeamStore }

    expect(response.ok).toBe(true)
    expect(response.store.messagesById['msg-old-reply']).toBeUndefined()
    expect(response.store.chatsById['chat-1'].messageIds).toEqual(['msg-user', 'msg-new-1'])
    expect(response.store.messagesById['msg-new-1']).toMatchObject({
      type: 'assistant',
      roleId: 'role-1',
      content: '新的 API 回复',
      status: 'received',
    })
    expect(response.store.messagesById['msg-user']).toMatchObject({
      status: 'received',
      deliveryStatus: { 'role-1': 'received' },
    })
    expect(externalModelClient.stream).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('重新回答这个问题'),
    }))
    expect(getByRole).not.toHaveBeenCalled()
    expect(sendRoleMessage).not.toHaveBeenCalled()
  })
})
