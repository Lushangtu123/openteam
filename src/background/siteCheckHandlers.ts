// Starts a 网站自检 (src/group/siteCheck.ts) through the same handlers the page uses: a new group,
// one member per site, the group marked as a check and opened, and the question sent to everyone.
import { CHAT_SITE_INFO } from '../group/chatSites'
import { SITE_CHECK_PERSONA, SITE_CHECK_PROMPT, SITE_CHECK_SITES } from '../group/siteCheck'
import type { OpenTeamStore } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export const SITE_CHECK_ROUTE_TYPES = ['GROUP_SITE_CHECK_START'] as const

export interface SiteCheckHandlerDependencies {
  // The background's own message router.
  route(message: RuntimeMessage): Promise<unknown>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
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

  const handleStart = async () => {
    const startedAt = deps.now()
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
      if (chat) chat.siteCheck = { startedAt }
    })
    await deps.broadcastStoreUpdated(store)
    await routeOk({ type: 'GROUP_CHAT_SWITCH', chatId })
    const sent = await routeOk({ type: 'GROUP_MESSAGE_SEND', chatId, raw: `@all ${SITE_CHECK_PROMPT}` })
    return { ok: true, chatId, store: sent.store }
  }

  return [{ type: 'GROUP_SITE_CHECK_START', handler: handleStart }]
}

// "11-17 09:05", in the computer's own time.
function timeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
