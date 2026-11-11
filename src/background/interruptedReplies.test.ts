import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { BACKGROUND_STARTED_KEY, createInterruptedReplySweeper, settleInterruptedReplies, textReadBeforeInterruption, type InterruptedReplyScope } from './interruptedReplies'

// A group asked one question: a site member and an API member are still replying (the API member
// has written some of it), and a third member has answered.
function storeWithRepliesUnderWay(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.externalModelOrder = ['model-1']
  store.settings.externalModelsById = { 'model-1': { id: 'model-1', name: '本地模型', format: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test', modelName: 'm', createdAt: 1, updatedAt: 1 } }
  const role = (id: string, name: string, fields: Partial<GroupRole>): GroupRole => ({ id, chatId: 'chat-1', name, systemPrompt: '', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 50, ...fields })
  store.rolesById = {
    site: role('site', '网页成员', { chatSite: 'chatgpt', status: 'thinking', lastPromptMessageId: 'q', replyAttemptId: 'attempt-site', liveReply: { promptMessageId: 'q', content: '写到一半', updatedAt: 60 } }),
    api: role('api', 'API 成员', { modelSource: 'external', externalModelId: 'model-1', status: 'thinking', lastPromptMessageId: 'q', replyAttemptId: 'attempt-api' }),
    done: role('done', '已回复', { chatSite: 'kimi' }),
  }
  const messages: GroupMessage[] = [
    { id: 'q', chatId: 'chat-1', seq: 1, type: 'user', content: '选哪个方案', targetRoleIds: ['site', 'api', 'done'], createdAt: 40, status: 'sent', deliveryStatus: { site: 'sent', api: 'sent', done: 'received' } },
    { id: 'a-done', chatId: 'chat-1', seq: 2, type: 'assistant', content: '选 A', roleId: 'done', roleName: '已回复', sourceMessageId: 'q', createdAt: 45, status: 'received' },
    { id: 'a-api', chatId: 'chat-1', seq: 3, type: 'assistant', content: 'API 成员写到这里', roleId: 'api', roleName: 'API 成员', sourceMessageId: 'q', createdAt: 46, status: 'pending' },
  ]
  store.messagesById = Object.fromEntries(messages.map(message => [message.id, message]))
  store.chatsById['chat-1'] = { id: 'chat-1', name: '评审', mode: 'independent', roleIds: ['site', 'api', 'done'], messageIds: messages.map(message => message.id), nextMessageSeq: 4, status: 'running', createdAt: 0, updatedAt: 50 }
  store.chatOrder = ['chat-1']
  store.currentChatId = 'chat-1'
  return store
}

const options = { timestamp: 1_000, newId: (prefix: string) => `${prefix}-new`, getChatStatusFromRoles: () => 'ready' as const }
const repliesOf = (store: OpenTeamStore, roleId: string) => store.chatsById['chat-1'].messageIds.map(id => store.messagesById[id]).filter(message => message.type === 'assistant' && message.roleId === roleId)

describe('replies that were under way when their member could no longer answer', () => {
  it('ends both kinds when the background starts with no OpenTeam page open', () => {
    const store = storeWithRepliesUnderWay()

    expect(settleInterruptedReplies(store, { ...options, siteMembers: true, apiMembers: true })).toEqual([
      { chatId: 'chat-1', roleId: 'site', promptMessageId: 'q' },
      { chatId: 'chat-1', roleId: 'api', promptMessageId: 'q' },
    ])

    // The site member waits for its page again. What had been read is kept like a stopped reply,
    // where 重新同步完整回复 can read the rest from the site.
    expect(store.rolesById.site).toMatchObject({ status: 'loading', updatedAt: 1_000 })
    expect(store.rolesById.site).not.toHaveProperty('lastPromptMessageId')
    expect(store.rolesById.site).not.toHaveProperty('replyAttemptId')
    expect(store.rolesById.site).not.toHaveProperty('liveReply')
    expect(repliesOf(store, 'site')).toHaveLength(1)
    expect(repliesOf(store, 'site')[0]).toMatchObject({ id: 'msg-new', status: 'received', sourceMessageId: 'q', seq: 4 })
    expect(repliesOf(store, 'site')[0].content).toMatch(/^写到一半\n\n.*没有读完.*重新同步完整回复/s)

    // The API member can be asked again at once; what it had written is kept, marked as cut off.
    expect(store.rolesById.api).toMatchObject({ status: 'ready', updatedAt: 1_000 })
    expect(repliesOf(store, 'api')).toHaveLength(1)
    expect(repliesOf(store, 'api')[0]).toMatchObject({ id: 'a-api', status: 'error' })
    expect(repliesOf(store, 'api')[0].content).toMatch(/^API 成员写到这里\n\n.*中断.*重新回复/s)

    // The question no longer waits for them, and the member that had answered is untouched.
    expect(store.messagesById.q).toMatchObject({ status: 'received', deliveryStatus: { site: 'error', api: 'error', done: 'received' } })
    expect(store.rolesById.done).toMatchObject({ status: 'ready', updatedAt: 50 })
    expect(store.chatsById['chat-1']).toMatchObject({ status: 'ready', updatedAt: 1_000 })
  })

  it('leaves site members alone while an OpenTeam page is open, and API members when only a page closed', () => {
    const background = storeWithRepliesUnderWay()
    expect(settleInterruptedReplies(background, { ...options, siteMembers: false, apiMembers: true }).map(item => item.roleId)).toEqual(['api'])
    expect(background.rolesById.site).toMatchObject({ status: 'thinking', lastPromptMessageId: 'q', updatedAt: 50 })

    const pageClosed = storeWithRepliesUnderWay()
    expect(settleInterruptedReplies(pageClosed, { ...options, siteMembers: true, apiMembers: false }).map(item => item.roleId)).toEqual(['site'])
    expect(pageClosed.rolesById.api).toMatchObject({ status: 'thinking', lastPromptMessageId: 'q' })
    expect(pageClosed.messagesById['a-api']).toMatchObject({ status: 'pending', content: 'API 成员写到这里' })
  })

  it('leaves a reply begun after the background started: it is the new background\'s own', () => {
    const store = storeWithRepliesUnderWay()
    store.rolesById.api.updatedAt = 900

    expect(settleInterruptedReplies(store, { ...options, siteMembers: true, apiMembers: true, quietSince: 900 }).map(item => item.roleId)).toEqual(['site'])
    expect(store.rolesById.api).toMatchObject({ status: 'thinking', lastPromptMessageId: 'q' })
  })

  it('reads a kept web reply again by the text that had been read, not the note', () => {
    const store = storeWithRepliesUnderWay()
    settleInterruptedReplies(store, { ...options, siteMembers: true, apiMembers: false })

    expect(textReadBeforeInterruption(repliesOf(store, 'site')[0].content)).toBe('写到一半')
    // Nothing had been read: no text to look for.
    store.rolesById.site = { ...store.rolesById.site, status: 'thinking', lastPromptMessageId: 'q' }
    delete store.rolesById.site.liveReply
    store.chatsById['chat-1'].messageIds = store.chatsById['chat-1'].messageIds.filter(id => id !== 'msg-new')
    settleInterruptedReplies(store, { ...options, newId: () => 'msg-empty', siteMembers: true, apiMembers: false })
    expect(textReadBeforeInterruption(store.messagesById['msg-empty'].content)).toBe('')
    // Any other reply is as it is.
    expect(textReadBeforeInterruption('普通回复')).toBe('普通回复')
  })

  it('changes nothing when no reply is under way', () => {
    const store = storeWithRepliesUnderWay()
    settleInterruptedReplies(store, { ...options, siteMembers: true, apiMembers: true })
    const settled = structuredClone(store)

    expect(settleInterruptedReplies(store, { ...options, timestamp: 2_000, siteMembers: true, apiMembers: true })).toEqual([])
    expect(store).toEqual(settled)
  })
})

describe('when interrupted replies are looked for', () => {
  function setup(openTeamTabs: number, options: { startedBeforeInSession?: boolean; noSessionStorage?: boolean } = {}) {
    const settle = vi.fn(async (_scope: InterruptedReplyScope) => 1)
    const query = vi.fn(async (_queryInfo: { url: string }) => Array.from({ length: openTeamTabs }, (_, index) => ({ id: index + 1 })))
    const session: Record<string, unknown> = options.startedBeforeInSession ? { [BACKGROUND_STARTED_KEY]: true } : {}
    const sessionStorage = {
      get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, items) }),
    }
    let time = 1_000
    const sweeper = createInterruptedReplySweeper({ tabs: { query }, teamPageUrl: 'chrome-extension://test/team.html', ...(options.noSessionStorage ? {} : { sessionStorage }), settle, now: () => time, log: { warn: vi.fn() } })
    time = 5_000
    return { settle, query, sweeper, session }
  }

  it('at the first start in a browser session: every member, even with OpenTeam pages open (new pages)', async () => {
    const { settle, sweeper, session } = setup(1)
    expect(await sweeper.atBackgroundStart()).toBe(1)
    // Replies begun by this background are left alone: only those quiet since it started.
    expect(settle).toHaveBeenCalledWith({ siteMembers: true, apiMembers: true, quietSince: 1_000 })
    expect(session).toEqual({ [BACKGROUND_STARTED_KEY]: true })
  })

  it('when the browser only restarted the background: API members, and web members if no OpenTeam page is open', async () => {
    const open = setup(1, { startedBeforeInSession: true })
    await open.sweeper.atBackgroundStart()
    expect(open.settle).toHaveBeenCalledWith({ siteMembers: false, apiMembers: true, quietSince: 1_000 })
    expect(open.query).toHaveBeenCalledWith({ url: 'chrome-extension://test/team.html*' })

    const closed = setup(0, { startedBeforeInSession: true })
    await closed.sweeper.atBackgroundStart()
    expect(closed.settle).toHaveBeenCalledWith({ siteMembers: true, apiMembers: true, quietSince: 1_000 })

    // Without session storage, open pages are taken to be the same ones.
    const unknown = setup(1, { noSessionStorage: true })
    await unknown.sweeper.atBackgroundStart()
    expect(unknown.settle).toHaveBeenCalledWith({ siteMembers: false, apiMembers: true, quietSince: 1_000 })
  })

  it('after a tab is closed: web members, once no OpenTeam page is left', async () => {
    const stillOpen = setup(1)
    expect(await stillOpen.sweeper.afterTabClosed()).toBe(0)
    expect(stillOpen.settle).not.toHaveBeenCalled()

    const lastClosed = setup(0)
    expect(await lastClosed.sweeper.afterTabClosed()).toBe(1)
    expect(lastClosed.settle).toHaveBeenCalledWith({ siteMembers: true, apiMembers: false })
  })

  it('never fails the caller', async () => {
    const { settle, query, sweeper } = setup(0)
    query.mockRejectedValueOnce(new Error('no tabs API'))
    expect(await sweeper.afterTabClosed()).toBe(0)
    settle.mockRejectedValueOnce(new Error('store unavailable'))
    expect(await sweeper.atBackgroundStart()).toBe(0)
  })
})
