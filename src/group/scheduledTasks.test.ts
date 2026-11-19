import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import type { GroupChat, ScheduledTask } from './types'
import {
  describeSchedule,
  findDueSlot,
  latestSlotAtOrBefore,
  nextScheduledRunAt,
  nextSlotAfter,
  readScheduledRunRequest,
  readScheduledTaskInput,
  recordScheduledRunSent,
  SCHEDULED_TASK_CATCH_UP_MS,
} from './scheduledTasks'

// Local times, so the tests hold in any time zone. 2026-11-16 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

function task(fields: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: 'sched-1', content: '@所有人 总结今天的新闻', days: [1], time: '08:30', enabled: true, armedAt: at(1, 0), createdAt: at(1, 0), updatedAt: at(1, 0), ...fields }
}

describe('a weekly scheduled task\'s times', () => {
  it('runs next on its day at its time, a week later once that has passed', () => {
    expect(nextSlotAfter(task(), at(16, 8))).toBe(at(16, 8, 30))
    expect(nextSlotAfter(task(), at(16, 8, 30))).toBe(at(23, 8, 30))
    expect(nextSlotAfter(task({ days: [1, 3] }), at(16, 9))).toBe(at(18, 8, 30))
    expect(nextSlotAfter(task({ days: [0] }), at(16, 9))).toBe(at(22, 8, 30))
  })

  it('finds the latest time it was due, up to a week back', () => {
    expect(latestSlotAtOrBefore(task(), at(16, 8, 30))).toBe(at(16, 8, 30))
    expect(latestSlotAtOrBefore(task(), at(16, 8, 29))).toBe(at(9, 8, 30))
    expect(latestSlotAtOrBefore(task({ days: [1, 5] }), at(21, 12))).toBe(at(20, 8, 30))
  })

  it('reads as the days and the time', () => {
    expect(describeSchedule([1, 3], '08:30', false)).toBe('每周一、三 08:30')
    expect(describeSchedule([0, 6], '21:00', false)).toBe('每周六、日 21:00')
    expect(describeSchedule([1, 2, 3, 4, 5], '09:00', false)).toBe('工作日 09:00')
    expect(describeSchedule([0, 1, 2, 3, 4, 5, 6], '07:15', false)).toBe('每天 07:15')
    expect(describeSchedule([1, 3], '08:30', true)).toBe('Every Mon, Wed at 08:30')
    expect(describeSchedule([0, 1, 2, 3, 4, 5, 6], '07:15', true)).toBe('Every day at 07:15')
  })
})

describe('whether a scheduled task is due', () => {
  it('is due at its time, once', () => {
    expect(findDueSlot(task(), at(16, 8, 30))).toEqual({ slot: at(16, 8, 30), run: true })
    expect(findDueSlot(task({ lastSlotAt: at(16, 8, 30) }), at(16, 8, 31))).toBeUndefined()
    expect(findDueSlot(task(), at(16, 8, 29))).toEqual({ slot: at(9, 8, 30), run: false })
  })

  it('runs a missed time once when the browser comes back within 12 hours, however many were missed', () => {
    const daily = task({ days: [0, 1, 2, 3, 4, 5, 6], lastSlotAt: at(14, 8, 30) })
    // Closed from Saturday until Monday 12:00: Sunday and Monday were missed; Monday's runs, once.
    expect(findDueSlot(daily, at(16, 12))).toEqual({ slot: at(16, 8, 30), run: true })
    expect(at(16, 12) - at(16, 8, 30)).toBeLessThan(SCHEDULED_TASK_CATCH_UP_MS)
  })

  it('skips a time missed by more than 12 hours, marking it so it is not looked at again', () => {
    expect(findDueSlot(task({ lastSlotAt: at(9, 8, 30) }), at(16, 21))).toEqual({ slot: at(16, 8, 30), run: false })
  })

  it('does not run times from before it was made, switched on or changed', () => {
    expect(findDueSlot(task({ armedAt: at(16, 9) }), at(16, 10))).toBeUndefined()
    expect(findDueSlot(task({ armedAt: at(16, 9) }), at(23, 8, 30))).toEqual({ slot: at(23, 8, 30), run: true })
  })

  it('is never due while switched off', () => {
    expect(findDueSlot(task({ enabled: false }), at(16, 8, 30))).toBeUndefined()
  })
})

describe('the next time any scheduled task runs', () => {
  it('is the earliest switched-on task\'s next time', () => {
    const store = createDefaultStore()
    const chat = (id: string, scheduledTasks: ScheduledTask[]): GroupChat => ({ id, name: id, mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, scheduledTasks })
    store.chatsById.a = chat('a', [task({ days: [3] }), task({ id: 'off', days: [2], enabled: false })])
    store.chatsById.b = chat('b', [task({ days: [2], time: '20:00' })])
    store.chatOrder = ['a', 'b']
    expect(nextScheduledRunAt(store, at(16, 9))).toBe(at(17, 20))
    expect(nextScheduledRunAt(createDefaultStore(), at(16, 9))).toBeUndefined()
  })
})

describe('what the user sets for a scheduled task', () => {
  it('is the message, its days and a time of day', () => {
    expect(readScheduledTaskInput({ content: '  @所有人 总结  ', days: [3, 1, 1], time: '08:30', enabled: false })).toEqual({ content: '@所有人 总结', days: [1, 3], time: '08:30', enabled: false })
    expect(readScheduledTaskInput({ content: '总结', days: [0], time: '23:59' }).enabled).toBe(true)
  })

  it('is refused without a message, a day or a valid time', () => {
    expect(() => readScheduledTaskInput({ content: ' ', days: [1], time: '08:30' })).toThrow('写下到点时要发的消息')
    expect(() => readScheduledTaskInput({ content: 'x', days: [], time: '08:30' })).toThrow('至少选一天')
    expect(() => readScheduledTaskInput({ content: 'x', days: [7], time: '08:30' })).toThrow('至少选一天')
    expect(() => readScheduledTaskInput({ content: 'x', days: [1], time: '24:00' })).toThrow('时间')
    expect(() => readScheduledTaskInput({ content: 'x', days: [1], time: '8:30' })).toThrow('时间')
    expect(() => readScheduledTaskInput({ content: 'x'.repeat(4001), days: [1], time: '08:30' })).toThrow('4000')
  })
})

describe('a scheduled run handed to the send', () => {
  it('is read from the message, keeping only what it needs', () => {
    expect(readScheduledRunRequest({ taskId: 'sched-1', slotAt: 5, catchUp: true, extra: 1 })).toEqual({ taskId: 'sched-1', slotAt: 5, catchUp: true })
    expect(readScheduledRunRequest({ taskId: 'sched-1', slotAt: 'x', catchUp: 'yes' })).toEqual({ taskId: 'sched-1' })
    expect(readScheduledRunRequest({ slotAt: 5 })).toBeUndefined()
    expect(readScheduledRunRequest(undefined)).toBeUndefined()
  })

  it('marks the message and records the run, and does nothing for a task that is gone', () => {
    const store = createDefaultStore()
    store.chatsById.c = { id: 'c', name: 'c', mode: 'collaborative', roleIds: [], messageIds: ['m'], nextMessageSeq: 2, status: 'ready', createdAt: 0, updatedAt: 0, scheduledTasks: [task()] }
    store.messagesById.m = { id: 'm', chatId: 'c', seq: 1, type: 'user', content: 'x', createdAt: 0, status: 'pending' }
    recordScheduledRunSent(store, 'c', { taskId: 'sched-1', catchUp: true }, 'm', 900)
    expect(store.chatsById.c.scheduledTasks![0].lastRun).toEqual({ at: 900, status: 'sent', catchUp: true, messageId: 'm' })
    expect(store.messagesById.m.scheduledTaskId).toBe('sched-1')
    recordScheduledRunSent(store, 'c', { taskId: 'gone' }, 'm', 950)
    expect(store.chatsById.c.scheduledTasks![0].lastRun?.at).toBe(900)
  })
})
