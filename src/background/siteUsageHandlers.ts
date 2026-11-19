// The page's command for 网站额度提醒 (src/group/siteUsage.ts): the user says a site that was marked
// as limiting has recovered, so its members are sent prompts again.
import { clearSiteLimit } from '../group/siteUsage'
import { isChatSite } from '../group/chatSites'
import type { OpenTeamStore } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export interface SiteUsageHandlerDependencies {
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  log: { info(event: string, details?: Record<string, unknown>): void }
}

export function createSiteUsageHandlers(deps: SiteUsageHandlerDependencies): BackgroundMessageRoute[] {
  const handleClearLimit = async (message: RuntimeMessage) => {
    const site = message.site
    if (typeof site !== 'string' || !isChatSite(site)) throw new Error('不认识这个网站')
    const { store } = await mutateStore(store => clearSiteLimit(store, site))
    deps.log.info('site-limit:cleared-by-user', { site })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  return [{ type: 'GROUP_SITE_LIMIT_CLEAR', handler: handleClearLimit }]
}
