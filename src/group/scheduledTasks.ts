// 定时任务: a message a group sends itself every week on chosen days at a chosen time, in local
// time. When a time comes the background opens OpenTeam if it is not open and sends the message as
// if the user had typed it. A time missed while the browser was closed runs once when it comes back
// within SCHEDULED_TASK_CATCH_UP_MS; one missed by longer is skipped.
import type { OpenTeamStore, ScheduledTask, ScheduledTaskRun } from './types'

export const SCHEDULED_TASK_CATCH_UP_MS = 12 * 60 * 60 * 1000
export const MAX_SCHEDULED_TASKS_PER_CHAT = 10
export const SCHEDULED_TASK_CONTENT_MAX = 4000

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export interface ScheduledTaskInput {
  content: string
  days: number[]
  time: string
  enabled: boolean
  // Left out when the result goes nowhere.
  destinationId?: string
}

type Schedule = Pick<ScheduledTask, 'days' | 'time'>

export function readScheduledTaskInput(value: unknown): ScheduledTaskInput {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (!content) throw new Error('写下到点时要发的消息')
  if (content.length > SCHEDULED_TASK_CONTENT_MAX) throw new Error(`消息最多 ${SCHEDULED_TASK_CONTENT_MAX} 个字`)
  const rawDays = Array.isArray(input.days) ? input.days : []
  const days = [...new Set(rawDays)].filter((day): day is number => Number.isInteger(day) && (day as number) >= 0 && (day as number) <= 6).sort((a, b) => a - b)
  if (days.length === 0 || days.length !== new Set(rawDays).size) throw new Error('至少选一天，星期一到星期日')
  const time = typeof input.time === 'string' ? input.time.trim() : ''
  if (!TIME_PATTERN.test(time)) throw new Error('时间要写成 08:30 这样的 24 小时制')
  const destinationId = typeof input.destinationId === 'string' && input.destinationId ? input.destinationId : undefined
  return { content, days, time, enabled: input.enabled !== false, ...(destinationId ? { destinationId } : {}) }
}

// The task's times on the given calendar day (local), if the day is one of its days.
function slotOnDay(schedule: Schedule, year: number, month: number, date: number): number | undefined {
  const match = TIME_PATTERN.exec(schedule.time)
  if (!match) return undefined
  const slot = new Date(year, month, date, Number(match[1]), Number(match[2]))
  return schedule.days.includes(slot.getDay()) ? slot.getTime() : undefined
}

// The first time strictly after the moment.
export function nextSlotAfter(schedule: Schedule, after: number): number | undefined {
  const start = new Date(after)
  for (let offset = 0; offset <= 7; offset += 1) {
    const slot = slotOnDay(schedule, start.getFullYear(), start.getMonth(), start.getDate() + offset)
    if (slot !== undefined && slot > after) return slot
  }
  return undefined
}

// The latest time at or before the moment, looking back a week.
export function latestSlotAtOrBefore(schedule: Schedule, at: number): number | undefined {
  const start = new Date(at)
  for (let offset = 0; offset <= 7; offset += 1) {
    const slot = slotOnDay(schedule, start.getFullYear(), start.getMonth(), start.getDate() - offset)
    if (slot !== undefined && slot <= at) return slot
  }
  return undefined
}

// The time to deal with now, if any: run it (on time, or late within the catch-up window) or mark
// it skipped. Only the latest missed time counts, so a long absence runs the task once at most.
export function findDueSlot(task: ScheduledTask, now: number): { slot: number; run: boolean } | undefined {
  if (!task.enabled) return undefined
  const slot = latestSlotAtOrBefore(task, now)
  if (slot === undefined || slot <= Math.max(task.armedAt, task.lastSlotAt ?? Number.NEGATIVE_INFINITY)) return undefined
  return { slot, run: now - slot <= SCHEDULED_TASK_CATCH_UP_MS }
}

// When the background should next wake up for a scheduled task.
export function nextScheduledRunAt(store: OpenTeamStore, now: number): number | undefined {
  let next: number | undefined
  for (const chatId of store.chatOrder) {
    for (const task of store.chatsById[chatId]?.scheduledTasks ?? []) {
      if (!task.enabled) continue
      const slot = nextSlotAfter(task, now)
      if (slot !== undefined && (next === undefined || slot < next)) next = slot
    }
  }
  return next
}

// What the runner hands the send: which task, and when it was due.
export type ScheduledRunRequest = { taskId: string } & Pick<ScheduledTaskRun, 'slotAt' | 'catchUp'>

export function readScheduledRunRequest(value: unknown): ScheduledRunRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.taskId !== 'string' || !input.taskId) return undefined
  return {
    taskId: input.taskId,
    ...(typeof input.slotAt === 'number' && Number.isFinite(input.slotAt) ? { slotAt: input.slotAt } : {}),
    ...(input.catchUp === true ? { catchUp: true } : {}),
  }
}

// Done as the message is stored: the run counts as sent from then, and the message says it came
// from the task. The replies may take minutes.
export function recordScheduledRunSent(store: OpenTeamStore, chatId: string, run: ScheduledRunRequest, messageId: string | undefined, now: number): void {
  const task = store.chatsById[chatId]?.scheduledTasks?.find(item => item.id === run.taskId)
  if (!task) return
  const { taskId: _taskId, ...timing } = run
  task.lastRun = { at: now, status: 'sent', ...timing, ...(messageId ? { messageId } : {}) }
  const message = messageId ? store.messagesById[messageId] : undefined
  if (message) message.scheduledTaskId = run.taskId
}

const ZH_DAYS = ['日', '一', '二', '三', '四', '五', '六']
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Monday first, as a week is read.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function describeSchedule(days: number[], time: string, english: boolean): string {
  const ordered = WEEK_ORDER.filter(day => days.includes(day))
  if (ordered.length === 7) return english ? `Every day at ${time}` : `每天 ${time}`
  if (ordered.length === 5 && ordered.every(day => day >= 1 && day <= 5)) return english ? `Weekdays at ${time}` : `工作日 ${time}`
  return english
    ? `Every ${ordered.map(day => EN_DAYS[day]).join(', ')} at ${time}`
    : `每周${ordered.map(day => ZH_DAYS[day]).join('、')} ${time}`
}
