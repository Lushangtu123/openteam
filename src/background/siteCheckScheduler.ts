// Runs 定时自检 (src/group/siteCheckSchedule.ts). An alarm wakes the background at its next time; on
// waking, and whenever the background starts, a due time is run, or marked skipped when it was
// missed by too long. A run shows OpenTeam (a hidden tab reads no replies), removes the previous
// scheduled check's group, starts a 网站自检 as the settings button does, and follows it until every
// site has an outcome. It then goes back to the group the user had open, removes the check's group
// when every site worked, and otherwise keeps it and sends the sites that need attention to the
// chosen destination. Also the page's commands to set it and to run it now.
import { describeSchedule, findDueSlot, nextSlotAfter } from '../group/scheduledTasks'
import { SITE_CHECK_TIMEOUT_MS, siteCheckNeedsAttention, siteCheckResults, type SiteCheckResult } from '../group/siteCheck'
import { readSiteCheckScheduleInput, siteCheckReport, type SiteCheckRun } from '../group/siteCheckSchedule'
import type { RoundResult } from '../group/resultDestinations'
import type { OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { SITE_CHECK_PAGE_WAIT_MS } from './siteCheckHandlers'
import { mutateStore } from './storeAccess'

export const SITE_CHECK_ALARM = 'openteam-site-check'
export const SITE_CHECK_SCHEDULE_ROUTE_TYPES = ['SITE_CHECK_SCHEDULE_SAVE', 'SITE_CHECK_SCHEDULE_RUN'] as const
const PAGE_WAIT_MS = 30_000
const POLL_MS = 5_000
// The check's own wait for the pages, its wait for the replies, and a little more.
const CHECK_WAIT_MS = SITE_CHECK_PAGE_WAIT_MS + SITE_CHECK_TIMEOUT_MS + 30_000

export interface SiteCheckSchedulerDependencies {
  loadStore(): Promise<OpenTeamStore>
  // The background's own message router.
  route(message: RuntimeMessage): Promise<unknown>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  teamPageOpen(): boolean
  panelOpen(): boolean
  // Opens OpenTeam, or makes its tab the shown one in its window, without bringing the window in front.
  showTeamPage(): Promise<void>
  // Sends to one of the result destinations (resultSender.ts): its name, and why not if it did not
  // take it; undefined when there is no such destination.
  sendReport(destinationId: string, result: RoundResult, english: boolean): Promise<{ destination: string; detail?: string } | undefined>
  alarms: {
    create(name: string, info: { when: number }): void | Promise<void>
    clear(name: string): unknown
  }
  waitFor(ms: number): Promise<void>
  now(): number
  log: {
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
}

interface RouteResponse {
  ok?: boolean
  error?: string
  chatId?: string
}

export function createSiteCheckScheduler(deps: SiteCheckSchedulerDependencies) {
  let running: Promise<void> | undefined
  let checking: Promise<void> | undefined

  const routeOk = async (message: RuntimeMessage): Promise<RouteResponse> => {
    const response = await deps.route(message) as RouteResponse | undefined
    if (!response || response.ok === false) throw new Error(response?.error || `${message.type} 没有完成`)
    return response
  }

  async function sync(): Promise<void> {
    const schedule = (await deps.loadStore()).settings.siteCheckSchedule
    const next = schedule?.enabled ? nextSlotAfter(schedule, deps.now()) : undefined
    if (next === undefined) await deps.alarms.clear(SITE_CHECK_ALARM)
    else await deps.alarms.create(SITE_CHECK_ALARM, { when: next })
  }

  function checkDue(): Promise<void> {
    checking ??= lookForDue().finally(() => { checking = undefined })
    return checking
  }

  async function lookForDue(): Promise<void> {
    const now = deps.now()
    const { store, result: due } = await mutateStore(store => {
      const schedule = store.settings.siteCheckSchedule
      const found = schedule ? findDueSlot(schedule, now) : undefined
      if (!schedule || !found) return undefined
      // Claimed before it runs, so it runs once even if the background starts again meanwhile.
      schedule.lastSlotAt = found.slot
      if (!found.run) schedule.lastRun = { at: now, status: 'skipped', slotAt: found.slot, detail: '浏览器关着，错过这个时间已经超过 12 小时' }
      return found
    })
    if (due) await deps.broadcastStoreUpdated(store)
    if (due?.run) await runCheck({ slotAt: due.slot })
    await sync()
  }

  function runNow(): Promise<void> {
    return runCheck({})
  }

  // One check at a time: a second ask while one runs waits for it.
  function runCheck(timing: Pick<SiteCheckRun, 'slotAt'>): Promise<void> {
    running ??= check(timing).finally(() => { running = undefined })
    return running
  }

  async function check(timing: Pick<SiteCheckRun, 'slotAt'>): Promise<void> {
    const before = await deps.loadStore()
    const returnTo = before.currentChatId
    let chatId: string | undefined
    let run: SiteCheckRun
    let results: SiteCheckResult[] = []
    try {
      for (const id of before.chatOrder) {
        if (before.chatsById[id]?.siteCheck?.scheduled) await routeOk({ type: 'GROUP_CHAT_DELETE', chatId: id })
      }
      if (!deps.panelOpen()) {
        await deps.showTeamPage()
        await waitUntil(() => deps.teamPageOpen(), PAGE_WAIT_MS)
      }
      deps.log.info('site-check-schedule:run', { ...timing })
      chatId = (await routeOk({ type: 'GROUP_SITE_CHECK_START', scheduled: true })).chatId
      if (!chatId) throw new Error('网站自检没有开始')
      const deadline = deps.now() + CHECK_WAIT_MS
      let error: string | undefined
      while (true) {
        const store = await deps.loadStore()
        const chat = store.chatsById[chatId]
        if (!chat) throw new Error('网站自检的群聊不见了')
        results = siteCheckResults(store, chat, deps.now())
        error = chat.siteCheck?.error
        if (error || !results.some(result => result.outcome === 'waiting') || deps.now() >= deadline) break
        await deps.waitFor(POLL_MS)
      }
      // Still waiting when the time is up: no reply was read.
      results = results.map(result => result.outcome === 'waiting' ? { ...result, outcome: 'no-reply' as const } : result)
      const problems = results.filter(result => siteCheckNeedsAttention(result.outcome))
      run = error
        ? { at: deps.now(), status: 'failed', ...timing, chatId, detail: error }
        : problems.length
        ? { at: deps.now(), status: 'problems', ...timing, chatId, problems: problems.map(result => ({ site: result.site, outcome: result.outcome })) }
        : { at: deps.now(), status: 'ok', ...timing }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      deps.log.warn('site-check-schedule:failed', { ...timing, detail })
      run = { at: deps.now(), status: 'failed', ...timing, ...(chatId ? { chatId } : {}), detail }
    }

    await goBack(returnTo, chatId)
    if (run.status === 'ok' && chatId) await deps.route({ type: 'GROUP_CHAT_DELETE', chatId }).catch(() => undefined)
    await record(run)
    if (run.status !== 'ok') await deliver(run, results)
  }

  // Back to the group the user had open, if the check's group is still the open one.
  async function goBack(returnTo: string | undefined, chatId: string | undefined): Promise<void> {
    const store = await deps.loadStore()
    if (!returnTo || returnTo === chatId || !store.chatsById[returnTo]) return
    if (chatId && store.currentChatId !== chatId) return
    await deps.route({ type: 'GROUP_CHAT_SWITCH', chatId: returnTo }).catch(() => undefined)
  }

  async function record(run: SiteCheckRun): Promise<void> {
    const { store } = await mutateStore(store => {
      const schedule = store.settings.siteCheckSchedule
      if (schedule) schedule.lastRun = run
    })
    await deps.broadcastStoreUpdated(store)
  }

  async function deliver(run: SiteCheckRun, results: SiteCheckResult[]): Promise<void> {
    const store = await deps.loadStore()
    const schedule = store.settings.siteCheckSchedule
    if (!schedule?.destinationId) return
    const english = normalizeLanguage(store.settings.language) === 'en'
    const when = describeSchedule(schedule.days, schedule.time, english)
    const report: RoundResult = run.status === 'failed'
      ? { chatName: english ? 'Site check' : '网站自检', schedule: when, question: english ? `The scheduled site check could not run: ${run.detail ?? ''}` : `定时自检没能运行：${run.detail ?? ''}`, answers: [] }
      : siteCheckReport(results, when, english)
    await setDelivery(run, { status: 'sending', at: deps.now(), destination: store.settings.resultDestinations?.find(item => item.id === schedule.destinationId)?.name ?? '' })
    const sent = await deps.sendReport(schedule.destinationId, report, english).catch((error: unknown) => ({ destination: '', detail: error instanceof Error ? error.message : String(error) }))
    if (!sent) return setDelivery(run, undefined)
    if (sent.detail) deps.log.warn('site-check-schedule:send-failed', { detail: sent.detail })
    await setDelivery(run, { status: sent.detail ? 'failed' : 'sent', at: deps.now(), destination: sent.destination, ...(sent.detail ? { detail: sent.detail } : {}) })
  }

  async function setDelivery(run: SiteCheckRun, delivery: SiteCheckRun['delivery']): Promise<void> {
    const { store } = await mutateStore(store => {
      const last = store.settings.siteCheckSchedule?.lastRun
      if (last?.at !== run.at) return
      if (delivery) last.delivery = delivery
      else delete last.delivery
    })
    await deps.broadcastStoreUpdated(store)
  }

  async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = deps.now() + timeoutMs
    while (!done() && deps.now() < deadline) await deps.waitFor(1_000)
  }

  const handleSave = async (message: RuntimeMessage) => {
    const input = readSiteCheckScheduleInput(message.schedule)
    const { store } = await mutateStore(store => {
      if (input.destinationId && !store.settings.resultDestinations?.some(item => item.id === input.destinationId)) throw new Error('找不到这个推送地址')
      const previous = store.settings.siteCheckSchedule
      store.settings.siteCheckSchedule = {
        ...input,
        armedAt: deps.now(),
        ...(previous?.lastSlotAt !== undefined ? { lastSlotAt: previous.lastSlotAt } : {}),
        ...(previous?.lastRun ? { lastRun: previous.lastRun } : {}),
      }
    })
    await deps.broadcastStoreUpdated(store)
    await sync()
    return { ok: true, store }
  }

  // The check takes minutes; its result arrives through store updates.
  const handleRun = async () => {
    void runNow().catch(error => deps.log.warn('site-check-schedule:run-failed', { error: error instanceof Error ? error.message : String(error) }))
    return { ok: true }
  }

  const routes: BackgroundMessageRoute[] = [
    { type: 'SITE_CHECK_SCHEDULE_SAVE', handler: handleSave },
    { type: 'SITE_CHECK_SCHEDULE_RUN', handler: handleRun },
  ]
  return { sync, checkDue, runNow, routes }
}
