// The page's commands for a group's 定时任务: save (new or changed), delete, and run now. Saving or
// deleting sets the alarm again (src/background/scheduledTaskRunner.ts).
import { MAX_SCHEDULED_TASKS_PER_CHAT, readScheduledTaskInput } from '../group/scheduledTasks'
import type { OpenTeamStore, ScheduledTask } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore, requireChat } from './storeAccess'

export const SCHEDULED_TASK_ROUTE_TYPES = ['GROUP_SCHEDULED_TASK_SAVE', 'GROUP_SCHEDULED_TASK_DELETE', 'GROUP_SCHEDULED_TASK_RUN'] as const

export interface ScheduledTaskHandlerDependencies {
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  newId(prefix: string): string
  now(): number
  // The tasks changed: the alarm is set again.
  schedulesChanged(): Promise<void>
  runNow(chatId: string, taskId: string): Promise<void>
  log: { warn(event: string, details?: Record<string, unknown>): void }
}

export function createScheduledTaskHandlers(deps: ScheduledTaskHandlerDependencies): BackgroundMessageRoute[] {
  const handleSave = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const taskId = typeof message.taskId === 'string' && message.taskId ? message.taskId : undefined
    const input = readScheduledTaskInput(message.task)
    const now = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const tasks = chat.scheduledTasks ?? []
      if (!taskId) {
        if (tasks.length >= MAX_SCHEDULED_TASKS_PER_CHAT) throw new Error(`一个群聊最多 ${MAX_SCHEDULED_TASKS_PER_CHAT} 个定时任务`)
        const task: ScheduledTask = { id: deps.newId('sched'), ...input, armedAt: now, createdAt: now, updatedAt: now }
        chat.scheduledTasks = [...tasks, task]
        return task
      }
      const task = tasks.find(item => item.id === taskId)
      if (!task) throw new Error('找不到这个定时任务')
      const rescheduled = input.time !== task.time || input.days.join() !== task.days.join() || (input.enabled && !task.enabled)
      Object.assign(task, input, { updatedAt: now })
      // A changed time, or one switched back on, does not run times that have already passed.
      if (rescheduled) task.armedAt = now
      return task
    })
    await deps.broadcastStoreUpdated(store)
    await deps.schedulesChanged()
    return { ok: true, task: result, store }
  }

  const handleDelete = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const taskId = requireText(message.taskId, '缺少定时任务 ID')
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const tasks = (chat.scheduledTasks ?? []).filter(item => item.id !== taskId)
      if (tasks.length > 0) chat.scheduledTasks = tasks
      else delete chat.scheduledTasks
    })
    await deps.broadcastStoreUpdated(store)
    await deps.schedulesChanged()
    return { ok: true, store }
  }

  // Answered at once: opening OpenTeam and loading members' pages can take a minute. The task's
  // last run shows how it went.
  const handleRun = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const taskId = requireText(message.taskId, '缺少定时任务 ID')
    const { store } = await mutateStore(store => {
      if (!requireChat(store, chatId).scheduledTasks?.some(item => item.id === taskId)) throw new Error('找不到这个定时任务')
    })
    void deps.runNow(chatId, taskId).catch(error => deps.log.warn('scheduled-task:run-now-failed', { chatId, taskId, error: error instanceof Error ? error.message : String(error) }))
    return { ok: true, store }
  }

  return [
    { type: 'GROUP_SCHEDULED_TASK_SAVE', handler: handleSave },
    { type: 'GROUP_SCHEDULED_TASK_DELETE', handler: handleDelete },
    { type: 'GROUP_SCHEDULED_TASK_RUN', handler: handleRun },
  ]
}

function requireText(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error)
  return value
}
