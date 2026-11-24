import { describe, expect, it, vi } from 'vitest'
import { SITE_CHECK_SITES, siteCheckResults } from '../group/siteCheck'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupMessage, OpenTeamStore } from '../group/types'
import type { RuntimeMessage } from './runtimeClient'

// What a site does each time it is asked: reply OK, fail, never answer, show an error page (until
// its page is loaded again), or ask to sign in.
type Answer = 'ok' | 'error' | 'none' | 'page-error' | 'login'

interface Options {
  failOn?: string
  // How many looks pass before each member's page is ready (never, when left out of it).
  readyAfter?: Record<string, number>
  // Per site, its answer to the first question and to the second.
  answers?: Record<string, Answer[]>
  // Pages that do not come back when loaded again.
  noComeback?: string[]
  store?: OpenTeamStore
}

const allReady = () => Object.fromEntries(SITE_CHECK_SITES.map(site => [site, 0]))

async function setup(options: Options = {}) {
  vi.resetModules()
  const store = options.store ?? createDefaultStore()
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const routed: RuntimeMessage[] = []
  const route = vi.fn<[RuntimeMessage], Promise<unknown>>()
  const broadcastStoreUpdated = vi.fn()
  let clock = new Date(2026, 10, 17, 9, 5).getTime()
  let looks = 0
  const readyAfter = options.readyAfter ?? allReady()
  const gone = new Set<string>()
  const runtimeFrames = {
    getByRole: (_chatId: string, roleId: string) => {
      const site = store.rolesById[roleId]?.chatSite ?? ''
      return site in readyAfter && looks >= readyAfter[site] && !gone.has(roleId) ? { ready: true } as never : undefined
    },
  }
  const waitFor = vi.fn(async (ms: number) => {
    looks += 1
    clock += ms
  })
  const asked = new Map<string, number>()
  const recoverMember = vi.fn(async (_chatId: string, roleId: string) => {
    const role = store.rolesById[roleId]
    if (options.noComeback?.includes(role.chatSite!)) {
      gone.add(roleId)
      return false
    }
    delete role.siteHealth
    role.status = 'ready'
    return true
  })
  let sentAtLook: number | undefined
  let seq = 0
  route.mockImplementation(async (message: RuntimeMessage) => {
    routed.push(message)
    if (message.type === options.failOn) return { ok: false, error: `${options.failOn} failed` }
    if (message.type === 'GROUP_CHAT_CREATE') {
      const id = `chat-check-${++seq}`
      store.chatsById[id] = { id, name: String(message.name), mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
      store.chatOrder.unshift(id)
      return { ok: true, chat: { id }, store }
    }
    if (message.type === 'GROUP_CHAT_DELETE') {
      delete store.chatsById[message.chatId as string]
      store.chatOrder = store.chatOrder.filter(id => id !== message.chatId)
      return { ok: true, store }
    }
    if (message.type === 'GROUP_ROLES_CREATE_BATCH') {
      const chat = store.chatsById[message.chatId as string]
      for (const item of message.items as Array<{ chatSite: string; name: string }>) {
        const id = `${chat.id}-${item.chatSite}`
        store.rolesById[id] = { id, chatId: chat.id, name: item.name, chatSite: item.chatSite as never, modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
        chat.roleIds.push(id)
      }
    }
    if (message.type === 'GROUP_MESSAGE_SEND') {
      sentAtLook ??= looks
      const chat = store.chatsById[message.chatId as string]
      const raw = String(message.raw)
      const to = chat.roleIds.filter(id => raw.startsWith('@all') || raw.includes(`@${store.rolesById[id].name} `))
      const question: GroupMessage = { id: `q-${chat.messageIds.length}-${looks}`, chatId: chat.id, seq: chat.nextMessageSeq++, type: 'user', content: raw, createdAt: clock, status: 'sent', deliveryStatus: {} }
      store.messagesById[question.id] = question
      chat.messageIds.push(question.id)
      for (const roleId of to) {
        const role = store.rolesById[roleId]
        const site = role.chatSite!
        const time = asked.get(roleId) ?? 0
        asked.set(roleId, time + 1)
        const answer = options.answers?.[site]?.[time] ?? 'ok'
        question.deliveryStatus![roleId] = answer === 'ok' ? 'received' : answer === 'error' ? 'error' : 'sent'
        if (answer === 'page-error') role.siteHealth = { siteId: site, status: 'blocked', reason: 'http-error', detail: '504 Gateway Time-out', updatedAt: clock }
        if (answer === 'login') role.siteHealth = { siteId: site, status: 'unauthorized', reason: 'login', updatedAt: clock }
        if (answer !== 'ok' && answer !== 'error') continue
        const reply: GroupMessage = { id: `${question.id}-${site}`, chatId: chat.id, seq: chat.nextMessageSeq++, type: 'assistant', roleId, sourceMessageId: question.id, content: answer === 'ok' ? 'OK' : '回复失败：RESPONSE_NOT_FOUND', createdAt: clock, status: answer === 'ok' ? 'received' : 'error' }
        store.messagesById[reply.id] = reply
        chat.messageIds.push(reply.id)
      }
      return { ok: true, message: question, store }
    }
    return { ok: true, store }
  })
  const { SITE_CHECK_ROUTE_TYPES, createSiteCheckHandlers } = await import('./siteCheckHandlers')
  const routes = createSiteCheckHandlers({ route, loadStore: async () => store, broadcastStoreUpdated, runtimeFrames, recoverMember, waitFor, now: () => clock })
  const start = (fields: Record<string, unknown> = {}) => Promise.resolve(routes.find(entry => entry.type === 'GROUP_SITE_CHECK_START')!.handler({ type: 'GROUP_SITE_CHECK_START', ...fields }, {})) as Promise<{ ok: boolean; chatId: string }>
  // Started, and followed to its end.
  const check = async (fields: Record<string, unknown> = {}) => {
    const { chatId } = await start(fields)
    await vi.waitFor(() => expect(store.chatsById[chatId].siteCheck?.finishedAt).toBeDefined())
    return store.chatsById[chatId]
  }
  const run = (type: string, fields: Record<string, unknown> = {}) => Promise.resolve(routes.find(entry => entry.type === type)!.handler({ type, ...fields }, {}))
  const outcomes = (chat: GroupChat) => Object.fromEntries(siteCheckResults(store, chat, clock).map(result => [result.site, `${result.outcome}${result.retried ? ' (again)' : ''}`]))
  const sends = () => routed.filter(message => message.type === 'GROUP_MESSAGE_SEND').map(message => String(message.raw))
  return { store, routes, run, routed, start, check, outcomes, sends, recoverMember, broadcastStoreUpdated, SITE_CHECK_ROUTE_TYPES, sentAtLook: () => sentAtLook }
}

describe('background site check', () => {
  it('makes a group with one member on each site, marks it, opens it and asks everyone to reply OK once their pages are ready', async () => {
    const { store, routes, routed, check, outcomes, recoverMember, SITE_CHECK_ROUTE_TYPES, sentAtLook } = await setup({ readyAfter: { gemini: 0, chatgpt: 1, claude: 1, deepseek: 3, grok: 2, qwen: 0, kimi: 1 } })
    expect(routes.map(entry => entry.type)).toEqual(SITE_CHECK_ROUTE_TYPES)

    const chat = await check()
    expect(routed.map(message => message.type)).toEqual(['GROUP_CHAT_CREATE', 'GROUP_ROLES_CREATE_BATCH', 'GROUP_CHAT_SWITCH', 'GROUP_MESSAGE_SEND'])
    expect(routed[0]).toMatchObject({ name: '网站自检 11-17 09:05', mode: 'independent' })
    const items = routed[1].items as Array<Record<string, unknown>>
    expect(items.map(item => item.chatSite)).toEqual(['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'kimi'])
    expect(items[0]).toMatchObject({ source: 'temporary', name: 'Gemini', modelSource: 'site' })
    expect(routed[3]).toMatchObject({ chatId: chat.id, raw: expect.stringMatching(/^@all .*OK/) })
    // DeepSeek's page was the last to be ready, after three looks.
    expect(sentAtLook()).toBe(3)
    // Every site replied: no second try.
    const question = chat.messageIds[0]
    expect(chat.siteCheck).toMatchObject({ startedAt: new Date(2026, 10, 17, 9, 5).getTime(), questionId: question, questionIds: [question] })
    expect(chat.siteCheck?.retry).toBeUndefined()
    expect(Object.values(outcomes(chat))).toEqual(Array(7).fill('ok'))
    expect(recoverMember).not.toHaveBeenCalled()
    expect(store.chatsById[chat.id].siteCheck?.scheduled).toBeUndefined()
  })

  it('asks a site that failed once more, its page loaded again, and reports only what failed twice', async () => {
    const answers: Record<string, Answer[]> = { gemini: ['error', 'ok'], deepseek: ['none', 'none'], qwen: ['page-error', 'ok'] }
    const { store, check, outcomes, sends, recoverMember } = await setup({ answers })
    const chat = await check()
    expect(recoverMember.mock.calls.map(([, roleId]) => store.rolesById[roleId].chatSite)).toEqual(['gemini', 'deepseek', 'qwen'])
    expect(sends()).toEqual([expect.stringMatching(/^@all /), expect.stringMatching(/^@Gemini @DeepSeek @Qwen .*OK/)])
    expect(chat.siteCheck?.retry).toMatchObject({ roleIds: ['gemini', 'deepseek', 'qwen'].map(site => `${chat.id}-${site}`), messageId: expect.any(String) })
    expect(chat.siteCheck?.questionIds).toHaveLength(2)
    expect(outcomes(chat)).toMatchObject({ gemini: 'ok (again)', deepseek: 'no-reply (again)', qwen: 'ok (again)', chatgpt: 'ok', kimi: 'ok' })
  })

  it('leaves signing in to the user, without a second try', async () => {
    const { check, outcomes, recoverMember } = await setup({ answers: { kimi: ['login'] } })
    const chat = await check()
    expect(outcomes(chat).kimi).toBe('login')
    expect(recoverMember).not.toHaveBeenCalled()
    expect(chat.siteCheck?.retry).toBeUndefined()
  })

  it('keeps a site\'s first result when its page does not come back for the second try', async () => {
    const { check, outcomes, sends } = await setup({ answers: { grok: ['error'] }, noComeback: ['grok'] })
    const chat = await check()
    expect(sends()).toHaveLength(1)
    expect(chat.siteCheck?.retry).toMatchObject({ error: '重新打开的网站页面都没有加载好' })
    expect(outcomes(chat).grok).toBe('failed')
  })

  it('stops and says why when a step fails', async () => {
    const { routed, start } = await setup({ failOn: 'GROUP_ROLES_CREATE_BATCH' })
    await expect(start()).rejects.toThrow('GROUP_ROLES_CREATE_BATCH failed')
    expect(routed.map(message => message.type)).toEqual(['GROUP_CHAT_CREATE', 'GROUP_ROLES_CREATE_BATCH'])
  })

  it('asks the members whose pages are ready when the others are still not after the wait', async () => {
    const { check, sends } = await setup({ readyAfter: { gemini: 0, chatgpt: 0 } })
    const chat = await check()
    expect(sends()[0]).toMatch(/^@all /)
    expect(chat.siteCheck?.error).toBeUndefined()
  })

  it('says on the group why nothing was asked when no page became ready', async () => {
    const { routed, check } = await setup({ readyAfter: {} })
    const chat = await check()
    expect(chat.siteCheck?.error).toContain('OpenTeam')
    expect(routed.map(message => message.type)).not.toContain('GROUP_MESSAGE_SEND')
  })
})

describe('the next check asks the same group again', () => {
  it('so each site keeps its conversation: no new group, the last round kept and the ones before it gone', async () => {
    const ctx = await setup()
    const first = await ctx.check()
    const members = [...first.roleIds]
    const firstRound = [...first.messageIds]
    await ctx.check()
    const third = await ctx.check({ scheduled: true })
    expect(ctx.routed.filter(message => message.type === 'GROUP_CHAT_CREATE')).toHaveLength(1)
    expect(third.id).toBe(first.id)
    expect(third.roleIds).toEqual(members)
    // The second check's round stays to look back at; the first one's went.
    for (const id of firstRound) expect(ctx.store.messagesById[id]).toBeUndefined()
    expect(third.messageIds).toHaveLength(16)
    expect(third.siteCheck).toMatchObject({ scheduled: true, questionIds: [expect.any(String), expect.any(String)] })
    expect(third.siteCheck?.finishedAt).toBeDefined()
    expect(third.name).toBe('网站自检 11-17 09:05')
  })

  it('wakes a member left waiting by the last check before asking, and adds a site the group lacks', async () => {
    const ctx = await setup()
    const chat = await ctx.check()
    const kimi = `${chat.id}-kimi`
    ctx.store.rolesById[`${chat.id}-gemini`].status = 'thinking'
    chat.roleIds = chat.roleIds.filter(id => id !== kimi)
    delete ctx.store.rolesById[kimi]
    await ctx.check()
    expect(ctx.recoverMember).toHaveBeenCalledWith(chat.id, `${chat.id}-gemini`)
    expect(ctx.routed.filter(message => message.type === 'GROUP_ROLES_CREATE_BATCH').slice(-1)[0]).toMatchObject({ chatId: chat.id, items: [{ chatSite: 'kimi', name: 'Kimi' }] })
    expect(ctx.outcomes(ctx.store.chatsById[chat.id]).kimi).toBe('ok')
  })

  it('leaves a group the user went on using, makes a new one, and removes the other check groups nobody used', async () => {
    const store = createDefaultStore()
    const group = (id: string, fields: Partial<GroupChat> = {}): GroupChat => ({ id, name: id, mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, siteCheck: { startedAt: 0 }, ...fields })
    const message = (id: string, chatId: string, type: GroupMessage['type']): GroupMessage => ({ id, chatId, seq: 1, type, content: 'x', createdAt: 0, status: 'received' })
    // Two older checks nobody used, one the user talked in, one they renamed, and a work group.
    store.chatsById = {
      old1: group('old1', { messageIds: ['o1'] }),
      old2: group('old2'),
      talked: group('talked', { messageIds: ['t1', 't2'] }),
      renamed: group('renamed', { siteCheck: { startedAt: 0, kept: true } }),
      work: { ...group('work'), siteCheck: undefined },
    }
    store.chatOrder = ['talked', 'renamed', 'old1', 'work', 'old2']
    Object.assign(store.messagesById, { o1: message('o1', 'old1', 'user'), t1: message('t1', 'talked', 'user'), t2: message('t2', 'talked', 'user') })
    const ctx = await setup({ store })
    const chat = await ctx.check()
    // The newest nobody used is asked again; the older one goes; the others stay.
    expect(chat.id).toBe('old1')
    expect(Object.keys(store.chatsById).sort()).toEqual(['old1', 'renamed', 'talked', 'work'])
    expect(store.chatOrder[0]).toBe('old1')
    // The group from before had its question unmarked: it counts as a check question still.
    expect(chat.siteCheck?.questionIds?.[0]).toBe('o1')

    // Only groups the user is using: a new one.
    const only = createDefaultStore()
    only.chatsById = { talked: group('talked', { messageIds: ['t1', 't2'] }) }
    only.chatOrder = ['talked']
    Object.assign(only.messagesById, { t1: message('t1', 'talked', 'user'), t2: message('t2', 'talked', 'user') })
    const fresh = await setup({ store: only })
    const made = await fresh.check()
    expect(made.id).not.toBe('talked')
    expect(only.chatsById.talked).toBeDefined()
  })
})

describe('a check from 定时自检, and 网站失效提醒\'s 知道了', () => {
  it('marks the group as the scheduled one', async () => {
    const { check } = await setup()
    expect((await check({ scheduled: true })).siteCheck).toMatchObject({ scheduled: true })
    const other = await setup()
    expect((await other.check()).siteCheck?.scheduled).toBeUndefined()
  })

  it('puts a site\'s notice away until it fails again after a reply', async () => {
    const { store, run, broadcastStoreUpdated } = await setup()
    store.siteFaultsBySite = { kimi: { count: 2, keys: ['a', 'b'], firstAt: 1, lastAt: 2, step: 'reply' } }
    await run('SITE_FAULT_DISMISS', { site: 'kimi' })
    expect(store.siteFaultsBySite.kimi?.dismissed).toBe(true)
    expect(broadcastStoreUpdated).toHaveBeenCalledTimes(1)
    await expect(run('SITE_FAULT_DISMISS', { site: 'nosuch' })).rejects.toThrow('未知的网站')
  })
})
