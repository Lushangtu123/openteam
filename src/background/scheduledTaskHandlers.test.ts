import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

async function setup() {
  vi.resetModules()
  const store: OpenTeamStore = createDefaultStore()
  store.chatsById['chat-1'] = { id: 'chat-1', name: '早报', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['chat-1']
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const { createScheduledTaskHandlers, SCHEDULED_TASK_ROUTE_TYPES } = await import('./scheduledTaskHandlers')
  let clock = 1000
  let seq = 0
  const schedulesChanged = vi.fn(async () => undefined)
  const runNow = vi.fn(async () => undefined)
  const routes = createScheduledTaskHandlers({ broadcastStoreUpdated: vi.fn(), newId: prefix => `${prefix}-${++seq}`, now: () => clock, schedulesChanged, runNow, log: { warn: vi.fn() } })
  const run = (type: string, payload: Record<string, unknown>) => routes.find(route => route.type === type)!.handler({ type, ...payload }, {})
  return { store, routes, run, schedulesChanged, runNow, SCHEDULED_TASK_ROUTE_TYPES, setClock: (value: number) => { clock = value } }
}

const tasks = (store: OpenTeamStore) => store.chatsById['chat-1'].scheduledTasks ?? []

describe('the page\'s scheduled task commands', () => {
  it('adds a task, armed from now, and sets the alarm again', async () => {
    const { store, routes, run, schedulesChanged, SCHEDULED_TASK_ROUTE_TYPES } = await setup()
    expect(routes.map(route => route.type)).toEqual(SCHEDULED_TASK_ROUTE_TYPES)
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: '@所有人 总结', days: [1, 3], time: '08:30' } })
    expect(tasks(store)).toEqual([{ id: 'sched-1', content: '@所有人 总结', days: [1, 3], time: '08:30', enabled: true, armedAt: 1000, createdAt: 1000, updatedAt: 1000 }])
    expect(schedulesChanged).toHaveBeenCalledTimes(1)
  })

  it('changes a task, re-arming it only when its time, days or switch change', async () => {
    const { store, run, setClock } = await setup()
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: '总结', days: [1], time: '08:30' } })
    tasks(store)[0].lastSlotAt = 500
    setClock(2000)
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'sched-1', task: { content: '总结一下', days: [1], time: '08:30' } })
    expect(tasks(store)[0]).toMatchObject({ content: '总结一下', armedAt: 1000, updatedAt: 2000, lastSlotAt: 500 })
    setClock(3000)
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'sched-1', task: { content: '总结一下', days: [1], time: '09:00' } })
    expect(tasks(store)[0].armedAt).toBe(3000)
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'sched-1', task: { content: '总结一下', days: [1], time: '09:00', enabled: false } })
    setClock(4000)
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'sched-1', task: { content: '总结一下', days: [1], time: '09:00', enabled: true } })
    expect(tasks(store)[0]).toMatchObject({ enabled: true, armedAt: 4000 })
  })

  it('refuses an eleventh task and a task it cannot find', async () => {
    const { run } = await setup()
    for (let index = 0; index < 10; index += 1) await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: `任务 ${index}`, days: [1], time: '08:30' } })
    await expect(run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: '多一个', days: [1], time: '08:30' } })).rejects.toThrow('最多 10 个')
    await expect(run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'gone', task: { content: 'x', days: [1], time: '08:30' } })).rejects.toThrow('找不到')
  })

  it('deletes a task and sets the alarm again', async () => {
    const { store, run, schedulesChanged } = await setup()
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: '总结', days: [1], time: '08:30' } })
    await run('GROUP_SCHEDULED_TASK_DELETE', { chatId: 'chat-1', taskId: 'sched-1' })
    expect(store.chatsById['chat-1'].scheduledTasks).toBeUndefined()
    expect(schedulesChanged).toHaveBeenCalledTimes(2)
  })

  it('runs a task now and answers at once', async () => {
    const { run, runNow } = await setup()
    await run('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: '总结', days: [1], time: '08:30' } })
    await expect(run('GROUP_SCHEDULED_TASK_RUN', { chatId: 'chat-1', taskId: 'sched-1' })).resolves.toMatchObject({ ok: true })
    expect(runNow).toHaveBeenCalledWith('chat-1', 'sched-1')
    await expect(run('GROUP_SCHEDULED_TASK_RUN', { chatId: 'chat-1', taskId: 'gone' })).rejects.toThrow('找不到')
  })
})
