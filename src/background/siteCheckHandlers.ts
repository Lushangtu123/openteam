// Starts a 网站自检 (src/group/siteCheck.ts) through the same handlers the page uses. The check's
// group stays from one check to the next and is asked again, so each site keeps one conversation
// instead of a new chat in the user's account every time. A group the user went on using is theirs:
// a new group is made then, and other check groups nobody used are removed. The question goes to
// everyone once their pages have loaded (a message to members with no page yet is refused), or,
// after a wait, to those that have; the others show as not reached. A site that fails is asked once
// more, its page loaded again, before it is reported: a slow page or a passing server error is not
// the site having changed.
import { SITE_CHECK_PERSONA, SITE_CHECK_PROMPT, SITE_CHECK_SITES, SITE_CHECK_TIMEOUT_MS, siteCheckGroupInUse, siteCheckQuestionIds, siteCheckResults, siteCheckRetries } from '../group/siteCheck'
import { dismissSiteFault } from '../group/siteFaults'
import { CHAT_SITE_INFO, CHAT_SITES, type ChatSite } from '../group/chatSites'
import type { GroupChat, OpenTeamStore, RuntimeFrameBinding } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { PageVisibility } from './pageVisibility'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export const SITE_CHECK_ROUTE_TYPES = ['GROUP_SITE_CHECK_START', 'SITE_FAULT_DISMISS'] as const

// How long the question waits for the members' pages to load, and how often it looks.
export const SITE_CHECK_PAGE_WAIT_MS = 45_000
const PAGE_POLL_MS = 1_000
// How often the check looks at the replies, and a little time past a question's for its last news.
const REPLY_POLL_MS = 2_000
const REPLY_GRACE_MS = 5_000
// The longest a whole check takes: the pages and the replies, twice (the second try).
export const SITE_CHECK_LONGEST_MS = 2 * (SITE_CHECK_PAGE_WAIT_MS + SITE_CHECK_TIMEOUT_MS + REPLY_GRACE_MS)

export interface SiteCheckHandlerDependencies {
  // The background's own message router.
  route(message: RuntimeMessage): Promise<unknown>
  loadStore(): Promise<OpenTeamStore>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  runtimeFrames: { getByRole(chatId: string, roleId: string): RuntimeFrameBinding | undefined }
  // Asks the open OpenTeam page to load a member's page again, resolving once it is back
  // (runtimeClient.requestRoleRecovery).
  recoverMember(chatId: string, roleId: string): Promise<boolean>
  // Whether a member's page was hidden while the check asked it (pageVisibility.ts).
  pageVisibility?: Pick<PageVisibility, 'wasHidden'>
  waitFor(ms: number): Promise<void>
  now(): number
}

interface RouteResponse {
  ok?: boolean
  error?: string
  chat?: { id?: string }
  message?: { id?: string }
  store?: OpenTeamStore
}

export function createSiteCheckHandlers(deps: SiteCheckHandlerDependencies): BackgroundMessageRoute[] {
  // Each running check's members.
  const checkRoles = new Map<string, string[]>()
  const routeOk = async (message: RuntimeMessage): Promise<RouteResponse> => {
    const response = await deps.route(message) as RouteResponse | undefined
    if (!response || response.ok === false) throw new Error(response?.error || `${message.type} 没有完成`)
    return response
  }

  // scheduled: from 定时自检 (siteCheckScheduler.ts).
  const handleStart = async (message: RuntimeMessage) => {
    const startedAt = deps.now()
    const scheduled = message.scheduled === true
    const before = await deps.loadStore()
    const unused = before.chatOrder.map(id => before.chatsById[id]).filter((chat): chat is GroupChat => Boolean(chat?.siteCheck) && !siteCheckGroupInUse(before, chat))
    // The newest check group nobody used is asked again; the others go.
    const [kept, ...stale] = unused
    for (const chat of stale) await routeOk({ type: 'GROUP_CHAT_DELETE', chatId: chat.id })

    const chatId = kept?.id ?? (await routeOk({ type: 'GROUP_CHAT_CREATE', name: checkName(startedAt), mode: 'independent' })).chat?.id
    if (!chatId) throw new Error('网站自检的群聊没有建好')
    const current = await deps.loadStore()
    const chat = current.chatsById[chatId]
    const present = new Set(chat?.roleIds.map(id => current.rolesById[id]).filter(role => role?.modelSource !== 'external').map(role => role?.chatSite))
    const missing = SITE_CHECK_SITES.filter(site => !present.has(site))
    if (missing.length) {
      await routeOk({
        type: 'GROUP_ROLES_CREATE_BATCH',
        chatId,
        items: missing.map(site => ({ source: 'temporary', name: CHAT_SITE_INFO[site].label, systemPrompt: SITE_CHECK_PERSONA, modelSource: 'site', chatSite: site })),
      })
    }
    const id = chatId
    const { store, result: stuck } = await mutateStore(store => {
      const chat = store.chatsById[id]
      if (!chat) return []
      const questionIds = kept ? siteCheckQuestionIds(store, chat) : []
      if (kept) {
        chat.name = checkName(startedAt)
        dropRoundsBefore(store, chat, chat.siteCheck?.questionId)
        store.chatOrder = [chat.id, ...store.chatOrder.filter(other => other !== chat.id)]
      }
      chat.siteCheck = {
        startedAt,
        ...(scheduled ? { scheduled: true } : {}),
        ...(questionIds.length ? { questionIds: questionIds.filter(question => store.messagesById[question]) } : {}),
      }
      // A member still waiting on the last check's question would not take this one.
      return chat.roleIds.filter(roleId => store.rolesById[roleId]?.status === 'thinking')
    })
    await deps.broadcastStoreUpdated(store)
    const switched = await routeOk({ type: 'GROUP_CHAT_SWITCH', chatId: id })
    // The page opens the group, and with it the members' pages, while this asks them.
    void runCheck(id, stuck)
    return { ok: true, chatId: id, store: switched.store }
  }

  async function runCheck(chatId: string, stuck: string[]): Promise<void> {
    try {
      await recover(chatId, stuck)
      const roleIds = await checkRoleIds(chatId)
      checkRoles.set(chatId, roleIds)
      if (await readyRoles(chatId, roleIds).then(ready => ready.length === 0)) throw new Error('没有一个网站的页面打开了。请确认 OpenTeam 页面开着、停在这个群，再重新检查。')
      const questionId = await ask(chatId, '@all')
      await setCheck(chatId, check => {
        check.questionId = questionId
        check.questionIds = [...(check.questionIds ?? []), questionId]
      })
      await untilAnswered(chatId)
      await retryFailures(chatId)
      await setCheck(chatId, check => finish(chatId, check))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await setCheck(chatId, check => {
        if (!check.questionId) check.error = reason
        else if (check.retry && !check.retry.messageId) check.retry.error = reason
        finish(chatId, check)
      })
    }
  }

  // The members whose page was hidden at some time during the check: one that failed then was not
  // checked. Then the check is finished.
  function finish(chatId: string, check: NonNullable<GroupChat['siteCheck']>): void {
    const roleIds = checkRoles.get(chatId) ?? []
    const hidden = roleIds.filter(roleId => deps.pageVisibility?.wasHidden(chatId, roleId, check.startedAt))
    if (hidden.length) check.hiddenRoleIds = hidden
    else delete check.hiddenRoleIds
    check.finishedAt = deps.now()
    checkRoles.delete(chatId)
  }

  // The sites that failed: their pages loaded again, and asked once more. One whose page does not
  // come back keeps its first result.
  async function retryFailures(chatId: string): Promise<void> {
    const store = await deps.loadStore()
    const chat = store.chatsById[chatId]
    if (!chat) return
    const failed = siteCheckResults(store, chat, deps.now()).filter(result => siteCheckRetries(result.outcome)).map(result => result.roleId)
    if (!failed.length) return
    await setCheck(chatId, check => { check.retry = { roleIds: failed } })
    await recover(chatId, failed)
    const ready = await readyRoles(chatId, failed)
    if (!ready.length) throw new Error('重新打开的网站页面都没有加载好')
    const names = await deps.loadStore().then(store => ready.map(roleId => `@${store.rolesById[roleId]?.name ?? ''}`))
    const messageId = await ask(chatId, names.join(' '))
    await setCheck(chatId, check => {
      check.retry = { roleIds: ready, messageId }
      check.questionIds = [...(check.questionIds ?? []), messageId]
    })
    await untilAnswered(chatId)
  }

  async function ask(chatId: string, to: string): Promise<string> {
    const sent = await routeOk({ type: 'GROUP_MESSAGE_SEND', chatId, raw: `${to} ${SITE_CHECK_PROMPT}`, siteCheckQuestion: true })
    const id = sent.message?.id
    if (!id) throw new Error('网站自检的提问没有发出')
    return id
  }

  // Until every site has a result, or the question has had its time.
  async function untilAnswered(chatId: string): Promise<void> {
    const deadline = deps.now() + SITE_CHECK_TIMEOUT_MS + REPLY_GRACE_MS
    while (deps.now() < deadline) {
      const store = await deps.loadStore()
      const chat = store.chatsById[chatId]
      if (!chat || !siteCheckResults(store, chat, deps.now()).some(result => result.outcome === 'waiting')) return
      await deps.waitFor(REPLY_POLL_MS)
    }
  }

  async function recover(chatId: string, roleIds: string[]): Promise<void> {
    await Promise.all(roleIds.map(roleId => deps.recoverMember(chatId, roleId).catch(() => false)))
  }

  // The members whose pages are ready (a page loaded again: its member out of loading too), once
  // all are or after the wait.
  async function readyRoles(chatId: string, roleIds: string[]): Promise<string[]> {
    const deadline = deps.now() + SITE_CHECK_PAGE_WAIT_MS
    const ready = async () => {
      const store = await deps.loadStore()
      return roleIds.filter(roleId => deps.runtimeFrames.getByRole(chatId, roleId)?.ready && store.rolesById[roleId]?.status !== 'loading')
    }
    let found = await ready()
    while (found.length < roleIds.length && deps.now() < deadline) {
      await deps.waitFor(PAGE_POLL_MS)
      found = await ready()
    }
    return found
  }

  async function checkRoleIds(chatId: string): Promise<string[]> {
    const store = await deps.loadStore()
    return (store.chatsById[chatId]?.roleIds ?? []).filter(roleId => store.rolesById[roleId]?.chatSite && store.rolesById[roleId]?.modelSource !== 'external')
  }

  async function setCheck(chatId: string, change: (check: NonNullable<GroupChat['siteCheck']>) => void): Promise<void> {
    const { store } = await mutateStore(store => {
      const check = store.chatsById[chatId]?.siteCheck
      if (check) change(check)
    })
    await deps.broadcastStoreUpdated(store)
  }

  // 网站失效提醒's 知道了: the notice stays away until the site replies and fails again.
  const handleFaultDismiss = async (message: RuntimeMessage) => {
    const site = CHAT_SITES.find(item => item === message.site) as ChatSite | undefined
    if (!site) throw new Error('未知的网站')
    const { store, result: changed } = await mutateStore(store => dismissSiteFault(store, site))
    if (changed) await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  return [
    { type: 'GROUP_SITE_CHECK_START', handler: handleStart },
    { type: 'SITE_FAULT_DISMISS', handler: handleFaultDismiss },
  ]
}

// A group asked again keeps the last check's round, the one the user may look back at; earlier
// rounds go, so the group does not grow with every check. Nothing but checks is in it (it is not
// in use), and its members' conversations stay.
function dropRoundsBefore(store: OpenTeamStore, chat: GroupChat, questionId: string | undefined): void {
  const at = questionId ? chat.messageIds.indexOf(questionId) : -1
  if (at <= 0) return
  for (const id of chat.messageIds.slice(0, at)) delete store.messagesById[id]
  chat.messageIds = chat.messageIds.slice(at)
}

function checkName(timestamp: number): string {
  return `网站自检 ${timeLabel(timestamp)}`
}

// "11-17 09:05", in the computer's own time.
function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
