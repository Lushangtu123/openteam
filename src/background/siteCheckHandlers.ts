// Starts a 网站自检 (src/group/siteCheck.ts) through the same handlers the page uses: a new group,
// one member per site, the group marked as a check and opened. The question goes to everyone once
// their pages have loaded (a message to members with no page yet is refused), or, after a wait, to
// those that have; the others show as not reached.
import { SITE_CHECK_PERSONA, SITE_CHECK_PROMPT, SITE_CHECK_SITES } from '../group/siteCheck'
import { dismissSiteFault } from '../group/siteFaults'
import { CHAT_SITE_INFO, CHAT_SITES, type ChatSite } from '../group/chatSites'
import type { OpenTeamStore, RuntimeFrameBinding } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export const SITE_CHECK_ROUTE_TYPES = ['GROUP_SITE_CHECK_START', 'SITE_FAULT_DISMISS'] as const

// How long the question waits for the members' pages to load, and how often it looks.
export const SITE_CHECK_PAGE_WAIT_MS = 45_000
const PAGE_POLL_MS = 1_000

export interface SiteCheckHandlerDependencies {
  // The background's own message router.
  route(message: RuntimeMessage): Promise<unknown>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  runtimeFrames: { getByRole(chatId: string, roleId: string): RuntimeFrameBinding | undefined }
  waitFor(ms: number): Promise<void>
  now(): number
}

interface RouteResponse {
  ok?: boolean
  error?: string
  chat?: { id?: string }
  store?: OpenTeamStore
}

export function createSiteCheckHandlers(deps: SiteCheckHandlerDependencies): BackgroundMessageRoute[] {
  const routeOk = async (message: RuntimeMessage): Promise<RouteResponse> => {
    const response = await deps.route(message) as RouteResponse | undefined
    if (!response || response.ok === false) throw new Error(response?.error || `${message.type} 没有完成`)
    return response
  }

  // scheduled: from 定时自检 (siteCheckScheduler.ts), which removes the group when every site worked.
  const handleStart = async (message: RuntimeMessage) => {
    const startedAt = deps.now()
    const scheduled = message.scheduled === true
    const created = await routeOk({ type: 'GROUP_CHAT_CREATE', name: `网站自检 ${timeLabel(startedAt)}`, mode: 'independent' })
    const chatId = created.chat?.id
    if (!chatId) throw new Error('网站自检的群聊没有建好')
    await routeOk({
      type: 'GROUP_ROLES_CREATE_BATCH',
      chatId,
      items: SITE_CHECK_SITES.map(site => ({ source: 'temporary', name: CHAT_SITE_INFO[site].label, systemPrompt: SITE_CHECK_PERSONA, modelSource: 'site', chatSite: site })),
    })
    const { store } = await mutateStore(store => {
      const chat = store.chatsById[chatId]
      if (chat) chat.siteCheck = { startedAt, ...(scheduled ? { scheduled: true } : {}) }
    })
    await deps.broadcastStoreUpdated(store)
    const switched = await routeOk({ type: 'GROUP_CHAT_SWITCH', chatId })
    // The page opens the group, and with it the members' pages, while this waits for them.
    void askWhenPagesReady(chatId, Object.keys(store.rolesById).filter(roleId => store.rolesById[roleId]?.chatId === chatId))
    return { ok: true, chatId, store: switched.store }
  }

  async function askWhenPagesReady(chatId: string, roleIds: string[]): Promise<void> {
    const deadline = deps.now() + SITE_CHECK_PAGE_WAIT_MS
    const readyCount = () => roleIds.filter(roleId => deps.runtimeFrames.getByRole(chatId, roleId)?.ready).length
    while (readyCount() < roleIds.length && deps.now() < deadline) await deps.waitFor(PAGE_POLL_MS)
    try {
      if (readyCount() === 0) throw new Error('没有一个网站的页面打开了。请确认 OpenTeam 页面开着、停在这个群，再重新检查。')
      await routeOk({ type: 'GROUP_MESSAGE_SEND', chatId, raw: `@all ${SITE_CHECK_PROMPT}` })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const { store } = await mutateStore(store => {
        const check = store.chatsById[chatId]?.siteCheck
        if (check) check.error = reason
      })
      await deps.broadcastStoreUpdated(store)
    }
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

// "11-17 09:05", in the computer's own time.
function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
