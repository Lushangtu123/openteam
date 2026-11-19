// Runs the groups' 定时任务 (src/group/scheduledTasks.ts). One alarm wakes the background at the
// next time any task is due; on waking, and whenever the background starts, every due task is dealt
// with: run, or marked skipped when it was missed by too long.
// When it asks web members, a run shows OpenTeam (opened if need be, made the shown tab of its
// window, the window not brought in front): a hidden tab barely runs, and its members' replies are
// not read (seen live: a DeepSeek reply in a never-shown tab went unread for two minutes). It then
// waits for the asked members' pages, asks the page to load those still missing, and sends the
// message as the user would. Members whose pages never load are skipped by the send, as they are
// for the user.
import { defaultMentionTargetForMessage, parseGroupMentions, roleMentionLabelOptionsFromSettings } from '../group/mentionParser'
import { findDueSlot, nextScheduledRunAt } from '../group/scheduledTasks'
import { activeSiteLimit } from '../group/siteUsage'
import type { GroupRole, OpenTeamStore, RuntimeFrameBinding, ScheduledTask, ScheduledTaskRun } from '../group/types'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export const SCHEDULED_TASK_ALARM = 'openteam-scheduled-tasks'
// How long a run waits for the OpenTeam page to open, and for the members' pages to load on their own.
export const SCHEDULED_PAGE_WAIT_MS = 30_000
export const SCHEDULED_MEMBER_WAIT_MS = 20_000
const POLL_MS = 1_000
// Later than this after its time, a run is a catch-up (the browser was closed or asleep).
const LATE_MS = 5 * 60 * 1000

export interface ScheduledTaskRunnerDependencies {
  loadStore(): Promise<OpenTeamStore>
  // The background's own message router.
  route(message: RuntimeMessage): Promise<unknown>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  // An OpenTeam page (tab or side panel) is open and has introduced itself.
  teamPageOpen(): boolean
  // OpenTeam is in the side panel, which is shown while it is open.
  panelOpen(): boolean
  // Opens OpenTeam, or makes its tab the shown one in its window, without bringing the window in front.
  showTeamPage(): Promise<void>
  requestRoleRecovery(chatId: string, roleId: string, reason: string): Promise<boolean>
  runtimeFrames: { getByRole(chatId: string, roleId: string): RuntimeFrameBinding | undefined }
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

export interface ScheduledTaskRunner {
  // Sets the alarm for the next due time, or clears it.
  sync(): Promise<void>
  // Deals with every due task, then sets the alarm again.
  checkDue(): Promise<void>
  // 立即运行: once now, whatever its days.
  runNow(chatId: string, taskId: string): Promise<void>
}

interface RouteResponse {
  ok?: boolean
  error?: string
}

export function createScheduledTaskRunner(deps: ScheduledTaskRunnerDependencies): ScheduledTaskRunner {
  const running = new Set<string>()
  let checking: Promise<void> | undefined

  async function sync(): Promise<void> {
    const next = nextScheduledRunAt(await deps.loadStore(), deps.now())
    if (next === undefined) await deps.alarms.clear(SCHEDULED_TASK_ALARM)
    else await deps.alarms.create(SCHEDULED_TASK_ALARM, { when: next })
  }

  function checkDue(): Promise<void> {
    // The alarm and a background start can come together; one look is enough.
    checking ??= lookForDue().finally(() => { checking = undefined })
    return checking
  }

  async function lookForDue(): Promise<void> {
    const now = deps.now()
    const { store, result } = await mutateStore(store => {
      const runs: Array<{ chatId: string; taskId: string; slot: number }> = []
      let changed = false
      for (const chatId of store.chatOrder) {
        for (const task of store.chatsById[chatId]?.scheduledTasks ?? []) {
          const due = findDueSlot(task, now)
          if (!due) continue
          // Claimed before it runs, so it runs once even if the background starts again meanwhile.
          task.lastSlotAt = due.slot
          changed = true
          if (due.run) runs.push({ chatId, taskId: task.id, slot: due.slot })
          else task.lastRun = { at: now, status: 'skipped', slotAt: due.slot, detail: '浏览器关着，错过这个时间已经超过 12 小时' }
        }
      }
      return { runs, changed }
    })
    if (result.changed) await deps.broadcastStoreUpdated(store)
    // Side by side: a send answers only once its API members have replied.
    await Promise.all(result.runs.map(run => runTask(run.chatId, run.taskId, { slotAt: run.slot, ...(now - run.slot > LATE_MS ? { catchUp: true } : {}) })))
    await sync()
  }

  async function runNow(chatId: string, taskId: string): Promise<void> {
    await runTask(chatId, taskId, {})
  }

  async function runTask(chatId: string, taskId: string, timing: Pick<ScheduledTaskRun, 'slotAt' | 'catchUp'>): Promise<void> {
    const key = `${chatId}:${taskId}`
    if (running.has(key)) return
    running.add(key)
    try {
      const store = await deps.loadStore()
      const chat = store.chatsById[chatId]
      const task = chat?.scheduledTasks?.find(item => item.id === taskId)
      if (!chat || !task) return
      deps.log.info('scheduled-task:run', { chatId, taskId, ...timing })
      await prepareMembers(store, chatId, task)
      // The send records the run as sent once the message is stored, and answers once the API
      // members have replied.
      const response = await deps.route({ type: 'GROUP_MESSAGE_SEND', chatId, raw: task.content, scheduledRun: { taskId, ...timing } }) as RouteResponse | undefined
      if (!response || response.ok === false) throw new Error(response?.error || '消息没有发出')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      deps.log.warn('scheduled-task:failed', { chatId, taskId, detail })
      const failed: ScheduledTaskRun = { at: deps.now(), status: 'failed', ...timing, detail }
      const { store } = await mutateStore(store => {
        const task = store.chatsById[chatId]?.scheduledTasks?.find(item => item.id === taskId)
        if (task) task.lastRun = failed
      })
      await deps.broadcastStoreUpdated(store)
    } finally {
      running.delete(key)
    }
  }

  // The asked web members' pages, shown and loaded: OpenTeam shown, then a wait for the pages to
  // load on their own (the open group's do), then the page asked to load the rest.
  async function prepareMembers(store: OpenTeamStore, chatId: string, task: ScheduledTask): Promise<void> {
    const members = targetWebMembers(store, chatId, task.content, deps.now())
    if (members.length === 0) return
    if (!deps.panelOpen()) {
      await deps.showTeamPage()
      await waitUntil(() => deps.teamPageOpen(), SCHEDULED_PAGE_WAIT_MS)
    }
    const ready = () => members.filter(role => deps.runtimeFrames.getByRole(chatId, role.id)?.ready)
    await waitUntil(() => ready().length === members.length, SCHEDULED_MEMBER_WAIT_MS)
    const missing = members.filter(role => !deps.runtimeFrames.getByRole(chatId, role.id)?.ready)
    await Promise.all(missing.map(role => deps.requestRoleRecovery(chatId, role.id, 'scheduled-task').catch(() => false)))
  }

  async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = deps.now() + timeoutMs
    while (!done() && deps.now() < deadline) await deps.waitFor(POLL_MS)
  }

  return { sync, checkDue, runNow }
}

// The web members whose pages the message goes to, read as the send will read it. A member whose site
// is limiting is passed over by the send, or answered for by its backup: its page is not needed.
function targetWebMembers(store: OpenTeamStore, chatId: string, raw: string, now: number): GroupRole[] {
  const chat = store.chatsById[chatId]
  if (!chat) return []
  const roles = chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
  const parsed = parseGroupMentions(raw, roles, { ...roleMentionLabelOptionsFromSettings(store.settings), defaultTarget: defaultMentionTargetForMessage(raw, chat) })
  if (!parsed.ok) return []
  const manual = parsed.mentionedRoleIds.length > 0 || Boolean(parsed.mentionsAll)
  const targets = chat.requireManualMention && !manual ? [] : parsed.targetRoleIds
  return roles.filter(role => targets.includes(role.id) && role.modelSource !== 'external' && !activeSiteLimit(store, role.chatSite ?? store.settings.defaultChatSite, now))
}
