import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { RoundResult } from '../group/resultDestinations'
import type { SiteCheckSchedule } from '../group/siteCheckSchedule'
import type { GroupMessage, OpenTeamStore } from '../group/types'

// Local times, so the tests hold in any time zone. 2026-11-16 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

function storeWith(schedule: Partial<SiteCheckSchedule> | undefined): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatsById['chat-work'] = { id: 'chat-work', name: '工作群', mode: 'collaborative', requireManualMention: false, roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['chat-work']
  store.currentChatId = 'chat-work'
  store.settings.resultDestinations = [{ id: 'dest-1', kind: 'feishu', name: '运维群', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', createdAt: 0 }]
  if (schedule) store.settings.siteCheckSchedule = { days: [1], time: '09:00', enabled: true, armedAt: at(1, 0), ...schedule }
  return store
}

// replies: what each check member does — reply OK, fail, or never answer.
// finishAfter: how many waits pass before the check marks itself finished (its second try).
async function setup(store: OpenTeamStore, options: { replies?: Record<string, 'ok' | 'error' | 'none'>; startError?: string; checkError?: string; panelOpen?: boolean; sendDetail?: string; finishAfter?: number } = {}) {
  vi.resetModules()
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const { createSiteCheckScheduler, SITE_CHECK_ALARM } = await import('./siteCheckScheduler')
  let clock = at(16, 9)
  let waits = 0
  let checkChatId: string | undefined
  let pageOpen = false
  const replies = options.replies ?? { chatgpt: 'ok', kimi: 'ok' }
  // The start, switch and delete act on the store as the real routes do.
  const route = vi.fn(async (message: { type: string; chatId?: string; scheduled?: boolean }) => {
    if (message.type === 'GROUP_SITE_CHECK_START') {
      if (options.startError) return { ok: false, error: options.startError }
      const chatId = `chat-check-${Object.keys(store.chatsById).length}`
      const roleIds = Object.keys(replies).map(site => `${chatId}-${site}`)
      const question: GroupMessage = { id: `${chatId}-q`, chatId, seq: 1, type: 'user', content: '只回复 OK', createdAt: clock, status: 'sent', deliveryStatus: Object.fromEntries(roleIds.map(id => [id, 'sent'])) }
      store.messagesById[question.id] = question
      const messageIds = [question.id]
      for (const [site, reply] of Object.entries(replies)) {
        const roleId = `${chatId}-${site}`
        store.rolesById[roleId] = { id: roleId, chatId, name: site, systemPrompt: '', modelSource: 'site', chatSite: site as 'kimi', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
        if (reply === 'none') continue
        const id = `${roleId}-reply`
        store.messagesById[id] = { id, chatId, seq: 2, type: 'assistant', roleId, sourceMessageId: question.id, content: reply === 'ok' ? 'OK' : '回复失败：RESPONSE_NOT_FOUND', createdAt: clock, status: reply === 'ok' ? 'received' : 'error' }
        messageIds.push(id)
      }
      const finished = options.finishAfter ? {} : { finishedAt: clock }
      store.chatsById[chatId] = { id: chatId, name: '网站自检', mode: 'independent', requireManualMention: false, roleIds, messageIds, nextMessageSeq: 3, status: 'ready', createdAt: clock, updatedAt: clock, siteCheck: { startedAt: clock, ...finished, ...(message.scheduled ? { scheduled: true } : {}), ...(options.checkError ? { error: options.checkError } : {}) } }
      checkChatId = chatId
      waits = 0
      store.chatOrder.unshift(chatId)
      store.currentChatId = chatId
      return { ok: true, chatId }
    }
    if (message.type === 'GROUP_CHAT_SWITCH') {
      store.currentChatId = message.chatId
      return { ok: true }
    }
    if (message.type === 'GROUP_CHAT_DELETE') {
      delete store.chatsById[message.chatId!]
      store.chatOrder = store.chatOrder.filter(id => id !== message.chatId)
      return { ok: true }
    }
    return { ok: false, error: `unexpected ${message.type}` }
  })
  const sent: RoundResult[] = []
  const sendReport = vi.fn(async (_destinationId: string, result: RoundResult): Promise<{ destination: string; detail?: string } | undefined> => {
    sent.push(result)
    return { destination: '运维群', ...(options.sendDetail ? { detail: options.sendDetail } : {}) }
  })
  const showTeamPage = vi.fn(async () => { pageOpen = true })
  const alarms = { create: vi.fn(), clear: vi.fn() }
  const scheduler = createSiteCheckScheduler({
    loadStore: async () => store,
    route,
    broadcastStoreUpdated: vi.fn(),
    teamPageOpen: () => pageOpen || Boolean(options.panelOpen),
    panelOpen: () => Boolean(options.panelOpen),
    showTeamPage,
    sendReport,
    alarms,
    waitFor: async ms => {
      clock += ms
      waits += 1
      const check = checkChatId ? store.chatsById[checkChatId]?.siteCheck : undefined
      if (check && options.finishAfter && waits >= options.finishAfter) check.finishedAt = clock
    },
    now: () => clock,
    log: { info: vi.fn(), warn: vi.fn() },
  })
  const run = (type: string, message: Record<string, unknown> = {}) => scheduler.routes.find(item => item.type === type)!.handler({ type, ...message }, {})
  return { scheduler, route, sent, sendReport, showTeamPage, alarms, run, SITE_CHECK_ALARM, setClock: (value: number) => { clock = value } }
}

const schedule = (store: OpenTeamStore) => store.settings.siteCheckSchedule!

describe('定时自检 coming due', () => {
  it('shows OpenTeam, checks, goes back to the open group and keeps the check\'s group for the next check', async () => {
    const store = storeWith({ destinationId: 'dest-1' })
    const ctx = await setup(store)
    await ctx.scheduler.checkDue()
    expect(ctx.showTeamPage).toHaveBeenCalledTimes(1)
    expect(ctx.route).toHaveBeenCalledWith({ type: 'GROUP_SITE_CHECK_START', scheduled: true })
    expect(store.currentChatId).toBe('chat-work')
    // Asked again next time, so each site keeps its conversation (siteCheckHandlers.ts).
    expect(store.chatOrder).toEqual(['chat-check-1', 'chat-work'])
    expect(ctx.route.mock.calls.map(([message]) => message.type)).not.toContain('GROUP_CHAT_DELETE')
    expect(schedule(store)).toMatchObject({ lastSlotAt: at(16, 9), lastRun: { status: 'ok', slotAt: at(16, 9) } })
    expect(schedule(store).lastRun?.chatId).toBeUndefined()
    // Nothing is sent when every site worked.
    expect(ctx.sendReport).not.toHaveBeenCalled()
    // Next Monday.
    expect(ctx.alarms.create).toHaveBeenCalledWith(ctx.SITE_CHECK_ALARM, { when: at(23, 9) })
  })

  it('keeps the check\'s group when some sites need attention, and sends those sites to the destination', async () => {
    const store = storeWith({ destinationId: 'dest-1' })
    const ctx = await setup(store, { replies: { chatgpt: 'ok', kimi: 'error', claude: 'none' } })
    await ctx.scheduler.checkDue()
    const run = schedule(store).lastRun!
    expect(run).toMatchObject({ status: 'problems', problems: [{ site: 'kimi', outcome: 'failed' }, { site: 'claude', outcome: 'no-reply' }], delivery: { status: 'sent', destination: '运维群' } })
    expect(store.chatsById[run.chatId!]?.siteCheck?.scheduled).toBe(true)
    expect(store.currentChatId).toBe('chat-work')
    expect(ctx.sendReport).toHaveBeenCalledWith('dest-1', expect.anything(), false)
    expect(ctx.sent[0]).toMatchObject({ chatName: '网站自检', schedule: '每周一 09:00', question: '3 个网站里有 2 个需要处理，其余正常。' })
    expect(ctx.sent[0].answers.map(answer => answer.member)).toEqual(['Kimi', 'Claude'])
  })

  it('says when the destination did not take it', async () => {
    const store = storeWith({ destinationId: 'dest-1' })
    const ctx = await setup(store, { replies: { kimi: 'error' }, sendDetail: 'HTTP 404' })
    await ctx.scheduler.checkDue()
    expect(schedule(store).lastRun?.delivery).toMatchObject({ status: 'failed', detail: 'HTTP 404' })
  })

  it('waits for the check to finish, its second try included, before it reports', async () => {
    const store = storeWith({ destinationId: 'dest-1' })
    // Every site has a result at once, but the check is still asking a site again.
    const ctx = await setup(store, { replies: { chatgpt: 'ok', kimi: 'error' }, finishAfter: 3 })
    await ctx.scheduler.checkDue()
    expect(ctx.sendReport).toHaveBeenCalledTimes(1)
    expect(schedule(store).lastRun).toMatchObject({ status: 'problems', at: at(16, 9) + 3 * 5_000 })
  })

  it('records a check that could not run, and sends that too', async () => {
    const store = storeWith({ destinationId: 'dest-1' })
    const ctx = await setup(store, { checkError: '没有一个网站的页面打开了。' })
    await ctx.scheduler.checkDue()
    expect(schedule(store).lastRun).toMatchObject({ status: 'failed', detail: '没有一个网站的页面打开了。' })
    expect(ctx.sent[0]).toMatchObject({ question: '定时自检没能运行：没有一个网站的页面打开了。', answers: [] })

    const other = storeWith({})
    const failing = await setup(other, { startError: '后台没有回应' })
    await failing.scheduler.checkDue()
    expect(schedule(other).lastRun).toMatchObject({ status: 'failed', detail: '后台没有回应' })
    expect(other.currentChatId).toBe('chat-work')
  })

  it('does not show OpenTeam in a tab while it is in the side panel', async () => {
    const store = storeWith({})
    const ctx = await setup(store, { panelOpen: true })
    await ctx.scheduler.checkDue()
    expect(ctx.showTeamPage).not.toHaveBeenCalled()
    expect(schedule(store).lastRun?.status).toBe('ok')
  })

  it('skips a time missed by over 12 hours, and runs nothing when off, not yet due, or not set', async () => {
    const store = storeWith({})
    const ctx = await setup(store)
    ctx.setClock(at(17, 9, 1))
    await ctx.scheduler.checkDue()
    expect(ctx.route).not.toHaveBeenCalled()
    expect(schedule(store)).toMatchObject({ lastSlotAt: at(16, 9), lastRun: { status: 'skipped', slotAt: at(16, 9) } })

    for (const value of [{ enabled: false }, { armedAt: at(16, 9) }, undefined]) {
      const quiet = await setup(storeWith(value))
      await quiet.scheduler.checkDue()
      expect(quiet.route).not.toHaveBeenCalled()
    }
    const off = await setup(storeWith({ enabled: false }))
    await off.scheduler.sync()
    expect(off.alarms.clear).toHaveBeenCalledWith(off.SITE_CHECK_ALARM)
  })
})

describe('setting 定时自检 from the page', () => {
  it('saves it from now on, keeping the last run, and sets the alarm', async () => {
    const store = storeWith({ lastSlotAt: 5, lastRun: { at: 6, status: 'ok' } })
    const ctx = await setup(store)
    await ctx.run('SITE_CHECK_SCHEDULE_SAVE', { schedule: { days: [1, 3], time: '10:15', enabled: true, destinationId: 'dest-1' } })
    expect(schedule(store)).toEqual({ days: [1, 3], time: '10:15', enabled: true, destinationId: 'dest-1', armedAt: at(16, 9), lastSlotAt: 5, lastRun: { at: 6, status: 'ok' } })
    expect(ctx.alarms.create).toHaveBeenCalledWith(ctx.SITE_CHECK_ALARM, { when: at(16, 10, 15) })
    await expect(ctx.run('SITE_CHECK_SCHEDULE_SAVE', { schedule: { days: [], time: '10:15' } })).rejects.toThrow('至少选一天')
    await expect(ctx.run('SITE_CHECK_SCHEDULE_SAVE', { schedule: { days: [1], time: '10:15', destinationId: 'nosuch' } })).rejects.toThrow('推送地址')
  })

  it('runs it now without waiting for the check to finish', async () => {
    const store = storeWith({})
    const ctx = await setup(store)
    expect(await ctx.run('SITE_CHECK_SCHEDULE_RUN')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(schedule(store).lastRun?.status).toBe('ok'))
    expect(schedule(store).lastRun?.slotAt).toBeUndefined()
  })
})

describe('定时自检\'s destination: a test, and its failure noticed', () => {
  it('sends a test message to the chosen destination, saying why one did not arrive', async () => {
    const store = storeWith({})
    const ctx = await setup(store)
    expect(await ctx.run('SITE_CHECK_SCHEDULE_TEST', { destinationId: 'dest-1' })).toMatchObject({ ok: true })
    expect(ctx.sendReport).toHaveBeenCalledWith('dest-1', expect.anything(), false)
    expect(ctx.sent[0]).toMatchObject({ chatName: '网站自检', question: '测试消息', answers: [{ member: 'OpenTeam', text: '能看到这条，定时自检发现要处理的网站时就会发到这里。' }] })
    await expect(ctx.run('SITE_CHECK_SCHEDULE_TEST', { destinationId: '' })).rejects.toThrow('先选一个推送地址')

    const failing = await setup(storeWith({}), { sendDetail: 'HTTP 404' })
    await expect(failing.run('SITE_CHECK_SCHEDULE_TEST', { destinationId: 'dest-1' })).rejects.toThrow('没发出去：HTTP 404')
    const gone = await setup(storeWith({}))
    gone.sendReport.mockResolvedValueOnce(undefined)
    await expect(gone.run('SITE_CHECK_SCHEDULE_TEST', { destinationId: 'dest-1' })).rejects.toThrow('找不到这个推送地址')
  })

  it('puts away the notice that a run\'s result was not sent, for that run', async () => {
    const store = storeWith({ lastRun: { at: 5, status: 'problems', delivery: { status: 'failed', at: 6, destination: '运维群', detail: 'HTTP 404' } } })
    const ctx = await setup(store)
    await ctx.run('SITE_CHECK_NOTICE_DISMISS')
    expect(schedule(store).lastRun?.noticeDismissed).toBe(true)
  })
})

