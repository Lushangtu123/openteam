// Chrome sends only SameSite=None cookies with a WebSocket handshake made by a site that is framed in
// an extension page, although ordinary requests from the same frame carry all of the site's cookies
// (the extension page counts as first-party for them). Grok's chat gateway (wss://grok.com/ws/…)
// needs its Lax cookies, so in the team page Grok reports "your network or security software is
// blocking Grok's real-time connection". For the team page's own tabs, a session rule puts the
// cookies Chrome would send to that URL in a normal tab onto the handshake. Normal Grok tabs and the
// cookies themselves are left alone.

export interface WebSocketCookieSite {
  // Session rule id; session rules are separate from the static frame rules.
  ruleId: number
  // The URL whose cookies the handshake should carry.
  cookieUrl: string
  urlFilter: string
  initiatorDomain: string
}

export const WEBSOCKET_COOKIE_SITES: readonly WebSocketCookieSite[] = [
  { ruleId: 9001, cookieUrl: 'https://grok.com/ws/mgw/', urlFilter: '||grok.com/ws/', initiatorDomain: 'grok.com' },
]

export interface CookieLike {
  name: string
  value: string
}

export interface SessionRuleUpdate {
  removeRuleIds: number[]
  addRules: chrome.declarativeNetRequest.Rule[]
}

export interface WebSocketCookieSyncDependencies {
  // The cookies the frame's handshake should carry: the site's unpartitioned cookies, and those
  // partitioned for frames in the team page (Cloudflare's cf_clearance is one of these).
  getCookies(url: string): Promise<CookieLike[]>
  updateSessionRules(update: SessionRuleUpdate): Promise<void>
  listTabIds(): number[]
  log: { info(event: string, details?: Record<string, unknown>): void; warn(event: string, details?: Record<string, unknown>): void }
  setTimer?(handler: () => void, ms: number): unknown
}

export interface WebSocketCookieSync {
  // Rebuilds the rules now.
  sync(): Promise<void>
  // Rebuilds them shortly, once for a burst of cookie changes or new tabs.
  schedule(): void
  // Whether a cookie change on this domain matters.
  watchesDomain(domain: string): boolean
}

const SYNC_DELAY_MS = 300

export function cookieHeader(cookies: CookieLike[]): string {
  return cookies.filter(cookie => cookie.name).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

export function buildWebSocketCookieRule(site: WebSocketCookieSite, header: string, tabIds: number[]): chrome.declarativeNetRequest.Rule {
  return {
    id: site.ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'cookie', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: header }],
    },
    condition: {
      urlFilter: site.urlFilter,
      resourceTypes: ['websocket' as chrome.declarativeNetRequest.ResourceType],
      initiatorDomains: [site.initiatorDomain],
      tabIds,
    },
  }
}

export function createWebSocketCookieSync(deps: WebSocketCookieSyncDependencies): WebSocketCookieSync {
  let pending = false
  let running: Promise<void> | undefined
  let again = false

  async function syncNow(): Promise<void> {
    const tabIds = [...new Set(deps.listTabIds())].sort((a, b) => a - b)
    const addRules: chrome.declarativeNetRequest.Rule[] = []
    for (const site of WEBSOCKET_COOKIE_SITES) {
      if (tabIds.length === 0) continue
      try {
        const header = cookieHeader(await deps.getCookies(site.cookieUrl))
        if (header) addRules.push(buildWebSocketCookieRule(site, header, tabIds))
      } catch (error) {
        deps.log.warn('websocket-cookies:read-failed', { site: site.initiatorDomain, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await deps.updateSessionRules({ removeRuleIds: WEBSOCKET_COOKIE_SITES.map(site => site.ruleId), addRules })
    deps.log.info('websocket-cookies:synced', { tabIds, rules: addRules.length })
  }

  async function sync(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        await syncNow()
      } while (again)
    })().finally(() => {
      running = undefined
    })
    return running
  }

  function schedule(): void {
    if (pending) return
    pending = true
    const setTimer = deps.setTimer ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
    setTimer(() => {
      pending = false
      sync().catch(error => deps.log.warn('websocket-cookies:sync-failed', { error: error instanceof Error ? error.message : String(error) }))
    }, SYNC_DELAY_MS)
  }

  function watchesDomain(domain: string): boolean {
    const bare = domain.replace(/^\./, '')
    return WEBSOCKET_COOKIE_SITES.some(site => bare === site.initiatorDomain || site.initiatorDomain.endsWith(`.${bare}`) || bare.endsWith(`.${site.initiatorDomain}`))
  }

  return { sync, schedule, watchesDomain }
}
