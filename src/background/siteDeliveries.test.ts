import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupRole, OpenTeamStore } from '../group/types'
import type { MessageHandlersDependencies } from './messageHandlerDeps'
import type { PromptDelivery } from './promptDelivery'

function storeWithKimi(role: Partial<GroupRole>): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.externalModelsById = { api: { id: 'api', name: 'DeepSeek API', format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'key', modelName: 'm', createdAt: 0, updatedAt: 0 } }
  store.chatsById['chat-1'] = { id: 'chat-1', name: '群', mode: 'independent', roleIds: ['role-1'], messageIds: ['msg-q'], nextMessageSeq: 2, status: 'running', createdAt: 0, updatedAt: 0 }
  store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '研究员', systemPrompt: '', modelSource: 'site', chatSite: 'kimi', status: 'thinking', lastPromptMessageId: 'msg-q', replyAttemptId: 'attempt-1', contextCursor: 0, createdAt: 0, updatedAt: 0, ...role }
  store.messagesById['msg-q'] = { id: 'msg-q', chatId: 'chat-1', seq: 1, type: 'user', content: '问题', targetRoleIds: ['role-1'], createdAt: 0, status: 'pending', deliveryStatus: { 'role-1': 'pending' } }
  return store
}

const delivery: PromptDelivery = {
  roleId: 'role-1',
  chatSite: 'kimi',
  tabId: 7,
  frameId: 3,
  message: { type: 'TEAM_SEND_PROMPT', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-q', replyAttemptId: 'attempt-1', content: '完整的提示词' },
  hasBackup: true,
}

async function setup(role: Partial<GroupRole>, sendPrompt: MessageHandlersDependencies['sendPrompt']) {
  vi.resetModules()
  const store = storeWithKimi(role)
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const { sendPromptDelivery } = await import('./siteDeliveries')
  const answerForMember = vi.fn(async () => undefined)
  const sendError = vi.fn()
  const warn = vi.fn()
  const deps: MessageHandlersDependencies = {
    broadcastStoreUpdated: vi.fn(),
    getChatStatusFromRoles: () => 'ready',
    log: { debug: vi.fn(), info: vi.fn(), warn },
    newId: vi.fn((prefix: string) => `${prefix}-x`),
    now: () => 100,
    runtimeFrames: { bind: vi.fn(), getByAddress: vi.fn(), getByRole: vi.fn(() => ({ chatId: 'chat-1', roleId: 'role-1', tabId: 7, frameId: 3, ready: true, lastSeenAt: 0 })) },
    sendRoleMessage: vi.fn(),
    sendError,
    sendPrompt,
    answerForMember,
    waitForRetry: vi.fn(async () => undefined),
  }
  return { store, deps, answerForMember, sendError, warn, send: () => sendPromptDelivery(deps, 'chat-1', 'msg-q', delivery) }
}

const blocked = { siteHealth: { siteId: 'kimi' as const, status: 'blocked' as const, reason: 'overlay' as const, updatedAt: 1 } }

describe('a web member\'s prompt and its backup', () => {
  it('goes to the backup at once when the member\'s site is blocked, without trying the site', async () => {
    const sendPrompt = vi.fn(async () => undefined)
    const { send, answerForMember, store } = await setup({ ...blocked, backupModelId: 'api' }, sendPrompt)
    await expect(send()).resolves.toBe(false)
    expect(sendPrompt).not.toHaveBeenCalled()
    expect(answerForMember).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'role-1', messageId: 'msg-q', replyAttemptId: 'attempt-1', prompt: '完整的提示词', answeredBy: 'DeepSeek API' }))
    // Still the member's question to answer: the backup's reply settles it.
    expect(store.messagesById['msg-q'].deliveryStatus).toEqual({ 'role-1': 'pending' })
    expect(store.rolesById['role-1'].status).toBe('thinking')
  })

  it('goes to the backup when the prompt cannot be sent, and stops trying once the site says it is blocked', async () => {
    let store: OpenTeamStore | undefined
    const sendPrompt = vi.fn(async () => {
      // The page reports the pop-up as the send fails.
      store!.rolesById['role-1'].siteHealth = blocked.siteHealth
      throw new Error('Kimi 页面上有弹窗挡住了发送')
    })
    const ctx = await setup({ backupModelId: 'api' }, sendPrompt)
    store = ctx.store
    await expect(ctx.send()).resolves.toBe(false)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(ctx.answerForMember).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.store.rolesById['role-1'].status).toBe('thinking')
  })

  it('goes to the backup at once when the page refuses the prompt (not signed in), though its site said it was usable', async () => {
    const sendPrompt = vi.fn(async () => { throw new Error('Kimi 没有发出这条消息：这个页面还没有登录 Kimi，请先在 Kimi 页面登录') })
    const { send, answerForMember, sendError, store } = await setup({ backupModelId: 'api', siteHealth: { siteId: 'kimi', status: 'ready', reason: 'guest', updatedAt: 1 } }, sendPrompt)
    await expect(send()).resolves.toBe(false)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(answerForMember).toHaveBeenCalledTimes(1)
    expect(sendError).not.toHaveBeenCalled()
    expect(store.rolesById['role-1'].status).toBe('thinking')
  })

  it('keeps trying, and does not hand over, while the member\'s page is only gone for a moment', async () => {
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValueOnce(undefined)
    const { send, answerForMember } = await setup({ backupModelId: 'api' }, sendPrompt)
    await expect(send()).resolves.toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(answerForMember).not.toHaveBeenCalled()
  })

  it('fails as before when the member has no backup', async () => {
    const sendPrompt = vi.fn(async () => { throw new Error('Kimi 页面上有弹窗挡住了发送') })
    const { send, answerForMember, sendError, store } = await setup(blocked, sendPrompt)
    await expect(send()).resolves.toBe(false)
    expect(answerForMember).not.toHaveBeenCalled()
    expect(sendError).toHaveBeenCalled()
    expect(store.rolesById['role-1'].status).toBe('error')
    expect(store.messagesById['msg-q'].deliveryStatus).toEqual({ 'role-1': 'error' })
  })

  it('sends to the site as usual when it is not blocked, backup or not', async () => {
    const sendPrompt = vi.fn(async () => undefined)
    const { send, answerForMember } = await setup({ backupModelId: 'api' }, sendPrompt)
    await expect(send()).resolves.toBe(true)
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(answerForMember).not.toHaveBeenCalled()
  })
})
