// 把结果发出去 (src/group/resultDestinations.ts): once every member a scheduled task's message asked
// has answered, the round goes to the task's destination. When the group sums rounds up, the sender
// waits for the summary to be asked for (it is, a moment after the last answer) and sends it once it
// is written; if none is asked for, the answers go. Each round is sent once; how it went is kept on
// the task's last run. Also the page's commands to add, test and delete destinations.
import { buildSendRequest, collectRoundResult, MAX_RESULT_DESTINATIONS, readDestinationInput, readSendResponse, testRoundResult, type ResultDestination, type RoundResult } from '../group/resultDestinations'
import type { GroupMessage, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import type { BackgroundMessageRoute } from './messageRouter'
import { findAnsweredPrompt } from './replyNotifications'
import type { RuntimeMessage } from './runtimeClient'
import type { StoreMutationResult } from './storeAccess'

export const RESULT_DESTINATION_ROUTE_TYPES = ['RESULT_DESTINATION_ADD', 'RESULT_DESTINATION_DELETE', 'RESULT_DESTINATION_TEST'] as const
// How long to wait, after the last answer, for the round's summary to be asked for.
const SUMMARY_GRACE_MS = 20_000

export interface ResultSenderDependencies {
  loadStore(): Promise<OpenTeamStore>
  mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  fetch(url: string, init: RequestInit): Promise<Response>
  // Whether OpenTeam may reach the address (the user allowed its site).
  hasAccess(url: string): Promise<boolean>
  now(): number
  wait(ms: number): Promise<void>
  newId(prefix: string): string
  log: { warn(event: string, details?: Record<string, unknown>): void }
}

export function createResultSender(deps: ResultSenderDependencies) {
  // A member's prompt is settled: a scheduled task's round may be over, or its summary written.
  async function onPromptSettled(store: OpenTeamStore, chatId: string, promptId: string): Promise<void> {
    const prompt = store.messagesById[promptId]
    if (!prompt) return
    if (prompt.roundSummaryOf) {
      const question = store.messagesById[prompt.roundSummaryOf]
      if (question && destinationFor(store, chatId, question)) await deliver(chatId, question.id)
      return
    }
    if (!destinationFor(store, chatId, prompt) || !findAnsweredPrompt(store, chatId, promptId)) return
    if (summaryMayCome(store, prompt)) {
      await deps.wait(SUMMARY_GRACE_MS)
      const latest = await deps.loadStore()
      const request = latest.chatsById[chatId]?.messageIds.map(id => latest.messagesById[id]).find(message => message?.type === 'user' && message.roundSummaryOf === promptId)
      // Its answer is sent when it is written (or fails).
      if (request && !settled(request)) return
    }
    await deliver(chatId, promptId)
  }

  async function deliver(chatId: string, questionId: string): Promise<void> {
    const now = deps.now()
    const { store: claimed, result: claim } = await deps.mutateStore(store => {
      const question = store.messagesById[questionId]
      const destination = question ? destinationFor(store, chatId, question) : undefined
      const task = store.chatsById[chatId]?.scheduledTasks?.find(item => item.id === question?.scheduledTaskId)
      if (!question || !destination || !task) return undefined
      const run = task.lastRun?.messageId === questionId ? task.lastRun : undefined
      // Sent (or being sent, or failed) already: once only.
      if (run?.delivery) return undefined
      if (run) run.delivery = { status: 'sending', at: now, destination: destination.name }
      const english = normalizeLanguage(store.settings.language) === 'en'
      const result = collectRoundResult(store, chatId, questionId, english)
      return result ? { destination: { ...destination }, result, english, taskId: task.id } : undefined
    })
    if (!claim) return
    await deps.broadcastStoreUpdated(claimed)
    const detail = await send(claim.destination, claim.result, claim.english)
    if (detail) deps.log.warn('result-send:failed', { chatId, questionId, kind: claim.destination.kind, detail })
    const { store } = await deps.mutateStore(store => {
      const run = store.chatsById[chatId]?.scheduledTasks?.find(item => item.id === claim.taskId)?.lastRun
      if (run?.messageId !== questionId) return
      run.delivery = { status: detail ? 'failed' : 'sent', at: deps.now(), destination: claim.destination.name, ...(detail ? { detail } : {}) }
    })
    await deps.broadcastStoreUpdated(store)
  }

  // Undefined once the destination took it; else why not.
  async function send(destination: ResultDestination, result: RoundResult, english: boolean): Promise<string | undefined> {
    if (!destination.url) return '没有推送地址（从不含 Key 的备份恢复的），请删掉后重新添加'
    if (!await deps.hasAccess(destination.url)) return `没有访问 ${new URL(destination.url).hostname} 的权限：在定时任务窗口的推送地址里点「测试」重新允许`
    try {
      const request = await buildSendRequest(destination, result, deps.now(), english)
      const response = await deps.fetch(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body, credentials: 'omit' })
      return readSendResponse(destination.kind, response.status, await response.text())
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const handleAdd = async (message: RuntimeMessage) => {
    const input = readDestinationInput(message.destination)
    const { store, result } = await deps.mutateStore(store => {
      const destinations = store.settings.resultDestinations ?? []
      if (destinations.length >= MAX_RESULT_DESTINATIONS) throw new Error(`最多 ${MAX_RESULT_DESTINATIONS} 个推送地址`)
      const destination: ResultDestination = { id: deps.newId('result-destination'), ...input, createdAt: deps.now() }
      store.settings.resultDestinations = [...destinations, destination]
      return destination.id
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, destinationId: result, store }
  }

  // Tasks that sent to it send nowhere after.
  const handleDelete = async (message: RuntimeMessage) => {
    const destinationId = typeof message.destinationId === 'string' ? message.destinationId : ''
    const { store } = await deps.mutateStore(store => {
      const destinations = (store.settings.resultDestinations ?? []).filter(item => item.id !== destinationId)
      if (destinations.length > 0) store.settings.resultDestinations = destinations
      else delete store.settings.resultDestinations
      for (const chat of Object.values(store.chatsById)) {
        for (const task of chat.scheduledTasks ?? []) if (task.destinationId === destinationId) delete task.destinationId
      }
      if (store.settings.siteCheckSchedule?.destinationId === destinationId) delete store.settings.siteCheckSchedule.destinationId
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleTest = async (message: RuntimeMessage) => {
    const store = await deps.loadStore()
    const destination = store.settings.resultDestinations?.find(item => item.id === message.destinationId)
    if (!destination) throw new Error('找不到这个推送地址')
    const english = normalizeLanguage(store.settings.language) === 'en'
    const detail = await send(destination, testRoundResult(english), english)
    if (detail) throw new Error(`没发出去：${detail}`)
    return { ok: true }
  }

  // 定时自检's report (siteCheckScheduler.ts): to the destination by its id; undefined when it is gone.
  async function sendTo(destinationId: string, result: RoundResult, english: boolean): Promise<{ destination: string; detail?: string } | undefined> {
    const destination = (await deps.loadStore()).settings.resultDestinations?.find(item => item.id === destinationId)
    if (!destination) return undefined
    const detail = await send(destination, result, english)
    return { destination: destination.name, ...(detail ? { detail } : {}) }
  }

  const routes: BackgroundMessageRoute[] = [
    { type: 'RESULT_DESTINATION_ADD', handler: handleAdd },
    { type: 'RESULT_DESTINATION_DELETE', handler: handleDelete },
    { type: 'RESULT_DESTINATION_TEST', handler: handleTest },
  ]
  return { onPromptSettled, sendTo, routes }
}

// The destination of the task that sent the message, if it has one.
function destinationFor(store: OpenTeamStore, chatId: string, message: GroupMessage): ResultDestination | undefined {
  if (!message.scheduledTaskId) return undefined
  const task = store.chatsById[chatId]?.scheduledTasks?.find(item => item.id === message.scheduledTaskId)
  return task?.destinationId ? store.settings.resultDestinations?.find(item => item.id === task.destinationId) : undefined
}

// As requestRoundSummary decides (roundHandlers.ts): summaries on (a vote is always summed up), and
// at least two members answered.
function summaryMayCome(store: OpenTeamStore, question: GroupMessage): boolean {
  if (store.settings.roundSummary === false && !question.poll) return false
  return Object.values(question.deliveryStatus ?? {}).filter(status => status === 'received').length >= 2
}

function settled(message: GroupMessage): boolean {
  const statuses = Object.values(message.deliveryStatus ?? {})
  return statuses.length > 0 && statuses.every(status => status === 'received' || status === 'error')
}
