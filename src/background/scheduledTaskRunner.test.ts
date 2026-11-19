import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupRole, OpenTeamStore, RuntimeFrameBinding, ScheduledTask } from '../group/types'

// Local times, so the tests hold in any time zone. 2026-11-16 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

function role(id: string, fields: Partial<GroupRole>): GroupRole {
  return { id, chatId: 'chat-1', name: id, systemPrompt: '', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...fields }
}

function storeWith(task: Partial<ScheduledTask>, roles: GroupRole[] = [role('kimi', { name: '研究员', modelSource: 'site', chatSite: 'kimi' })]): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.externalModelsById = { api: { id: 'api', name: 'DeepSeek API', format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'key', modelName: 'm', createdAt: 0, updatedAt: 0 } }
  for (const item of roles) store.rolesById[item.id] = item
  store.chatsById['chat-1'] = {
    id: 'chat-1', name: '早报', mode: 'collaborative', requireManualMention: false, roleIds: roles.map(item => item.id), messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0,
    scheduledTasks: [{ id: 'sched-1', content: '总结今天的新闻', days: [1], time: '08:30', enabled: true, armedAt: at(1, 0), createdAt: at(1, 0), updatedAt: at(1, 0), ...task }],
  }
  store.chatOrder = ['chat-1']
  return store
}

async function setup(store: OpenTeamStore, options: { pageOpen?: boolean; panelOpen?: boolean; framesLoad?: boolean; sendError?: string } = {}) {
  vi.resetModules()
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const { createScheduledTaskRunner, SCHEDULED_TASK_ALARM } = await import('./scheduledTaskRunner')
  let clock = at(16, 8, 30)
  let pageOpen = options.pageOpen ?? false
  const bound = new Set<string>()
  const { recordScheduledRunSent, readScheduledRunRequest } = await import('../group/scheduledTasks')
  // The send stores the message and records the run, as the real one does.
  const route = vi.fn(async (message: { type: string; chatId?: string; raw?: string; scheduledRun?: unknown }) => {
    if (options.sendError) return { ok: false, error: options.sendError }
    const id = 'msg-sent'
    store.messagesById[id] = { id, chatId: 'chat-1', seq: 1, type: 'user', content: message.raw ?? '', createdAt: clock, status: 'pending' }
    recordScheduledRunSent(store, 'chat-1', readScheduledRunRequest(message.scheduledRun)!, id, clock)
    return { ok: true, message: { id } }
  })
  const showTeamPage = vi.fn(async () => { pageOpen = true })
  const requestRoleRecovery = vi.fn(async (_chatId: string, roleId: string) => { bound.add(roleId); return true })
  const alarms = { create: vi.fn(), clear: vi.fn() }
  const runner = createScheduledTaskRunner({
    loadStore: async () => store,
    route,
    broadcastStoreUpdated: vi.fn(),
    teamPageOpen: () => pageOpen || Boolean(options.panelOpen),
    panelOpen: () => Boolean(options.panelOpen),
    showTeamPage,
    requestRoleRecovery,
    runtimeFrames: { getByRole: (_chatId: string, roleId: string): RuntimeFrameBinding | undefined => bound.has(roleId) ? { chatId: 'chat-1', roleId, tabId: 1, frameId: 2, ready: true, lastSeenAt: 0 } : undefined },
    alarms,
    waitFor: async ms => { clock += ms; if (options.framesLoad) for (const id of store.chatsById['chat-1'].roleIds) bound.add(id) },
    now: () => clock,
    log: { info: vi.fn(), warn: vi.fn() },
  })
  return { runner, route, showTeamPage, requestRoleRecovery, alarms, SCHEDULED_TASK_ALARM, setClock: (value: number) => { clock = value } }
}

const task = (store: OpenTeamStore) => store.chatsById['chat-1'].scheduledTasks![0]

describe('a group\'s scheduled task coming due', () => {
  it('shows OpenTeam, has the member\'s page loaded, sends the message and marks it as the task\'s', async () => {
    const store = storeWith({})
    const ctx = await setup(store)
    await ctx.runner.checkDue()
    expect(ctx.showTeamPage).toHaveBeenCalledTimes(1)
    // The member's page did not load on its own, so the page is asked to load it.
    expect(ctx.requestRoleRecovery).toHaveBeenCalledWith('chat-1', 'kimi', 'scheduled-task')
    expect(ctx.route).toHaveBeenCalledWith({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '总结今天的新闻', scheduledRun: { taskId: 'sched-1', slotAt: at(16, 8, 30) } })
    expect(task(store)).toMatchObject({ lastSlotAt: at(16, 8, 30), lastRun: { status: 'sent', slotAt: at(16, 8, 30), messageId: 'msg-sent' } })
    expect(task(store).lastRun?.catchUp).toBeUndefined()
    expect(store.messagesById['msg-sent'].scheduledTaskId).toBe('sched-1')
    // Next Monday.
    expect(ctx.alarms.create).toHaveBeenCalledWith(ctx.SCHEDULED_TASK_ALARM, { when: at(23, 8, 30) })
  })

  it('shows an open OpenTeam too, a hidden tab not reading replies, and does not reload pages that load on their own', async () => {
    const store = storeWith({})
    const ctx = await setup(store, { pageOpen: true, framesLoad: true })
    await ctx.runner.checkDue()
    expect(ctx.showTeamPage).toHaveBeenCalledTimes(1)
    expect(ctx.requestRoleRecovery).not.toHaveBeenCalled()
    expect(ctx.route).toHaveBeenCalledTimes(1)
  })

  it('leaves OpenTeam in the side panel, which is shown while open', async () => {
    const store = storeWith({})
    const ctx = await setup(store, { panelOpen: true, framesLoad: true })
    await ctx.runner.checkDue()
    expect(ctx.showTeamPage).not.toHaveBeenCalled()
    expect(ctx.route).toHaveBeenCalledTimes(1)
  })

  it('runs once, however often the background looks', async () => {
    const store = storeWith({})
    const ctx = await setup(store, { pageOpen: true, framesLoad: true })
    await Promise.all([ctx.runner.checkDue(), ctx.runner.checkDue()])
    await ctx.runner.checkDue()
    expect(ctx.route).toHaveBeenCalledTimes(1)
  })

  it('opens no page for a task that asks only API members', async () => {
    const store = storeWith({ content: '@分析师 总结' }, [role('api-member', { name: '分析师', modelSource: 'external', externalModelId: 'api' }), role('kimi', { name: '研究员', modelSource: 'site', chatSite: 'kimi' })])
    const ctx = await setup(store)
    await ctx.runner.checkDue()
    expect(ctx.showTeamPage).not.toHaveBeenCalled()
    expect(ctx.route).toHaveBeenCalledWith(expect.objectContaining({ type: 'GROUP_MESSAGE_SEND', chatId: 'chat-1', raw: '@分析师 总结' }))
  })

  it('runs a time missed within 12 hours late, once, and says it was late', async () => {
    const store = storeWith({ days: [0, 1, 2, 3, 4, 5, 6], lastSlotAt: at(14, 8, 30) })
    const ctx = await setup(store, { pageOpen: true, framesLoad: true })
    ctx.setClock(at(16, 12))
    await ctx.runner.checkDue()
    expect(ctx.route).toHaveBeenCalledTimes(1)
    expect(task(store).lastRun).toMatchObject({ status: 'sent', slotAt: at(16, 8, 30), catchUp: true })
  })

  it('skips a time missed by more than 12 hours, saying so, and sends nothing', async () => {
    const store = storeWith({ lastSlotAt: at(9, 8, 30) })
    const ctx = await setup(store)
    ctx.setClock(at(16, 21))
    await ctx.runner.checkDue()
    expect(ctx.route).not.toHaveBeenCalled()
    expect(ctx.showTeamPage).not.toHaveBeenCalled()
    expect(task(store)).toMatchObject({ lastSlotAt: at(16, 8, 30), lastRun: { status: 'skipped', slotAt: at(16, 8, 30) } })
    expect(task(store).lastRun?.detail).toContain('12 小时')
  })

  it('records why it could not send', async () => {
    const store = storeWith({})
    const ctx = await setup(store, { pageOpen: true, framesLoad: true, sendError: '以下成员不可用，请等待或恢复：研究员' })
    await ctx.runner.checkDue()
    expect(task(store).lastRun).toMatchObject({ status: 'failed', detail: '以下成员不可用，请等待或恢复：研究员' })
  })

  it('clears the alarm when no task is switched on', async () => {
    const store = storeWith({ enabled: false })
    const ctx = await setup(store)
    await ctx.runner.checkDue()
    expect(ctx.route).not.toHaveBeenCalled()
    expect(ctx.alarms.clear).toHaveBeenCalledWith(ctx.SCHEDULED_TASK_ALARM)
  })

  it('runs now when asked, whatever its days, without moving its next time', async () => {
    const store = storeWith({ lastSlotAt: at(16, 8, 30) })
    const ctx = await setup(store, { pageOpen: true, framesLoad: true })
    ctx.setClock(at(18, 14))
    await ctx.runner.runNow('chat-1', 'sched-1')
    expect(ctx.route).toHaveBeenCalledTimes(1)
    expect(task(store).lastRun).toMatchObject({ status: 'sent' })
    expect(task(store).lastRun?.slotAt).toBeUndefined()
    expect(task(store).lastSlotAt).toBe(at(16, 8, 30))
  })
})
