// A page read in a tab opened in the background (not switched to) and closed once read: for a site
// that refuses OpenTeam's quiet fetch (bot protection such as DataDome or Cloudflare answers 403) or
// whose text a script writes. The page loads as the user would see it, with their sign-ins. One page
// at a time, so at most one such tab is open.
import type { CapturedWebPage } from '../group/webPage'

export interface TabPageReaderDependencies {
  tabs: {
    create(props: { url: string; active: boolean }): Promise<{ id?: number }>
    remove(tabId: number): Promise<unknown>
    get(tabId: number): Promise<{ status?: string; url?: string }>
    onUpdated: {
      addListener(listener: (tabId: number, info: { status?: string }) => void): void
      removeListener(listener: (tabId: number, info: { status?: string }) => void): void
    }
  }
  // Runs readPageInTab in the tab (webPageOffers.ts).
  readTab(tabId: number): Promise<CapturedWebPage>
  // After the page says it loaded, the time its scripts get to write the text.
  settleMs?: number
  loadTimeoutMs?: number
}

const SETTLE_MS = 2_500
const LOAD_TIMEOUT_MS = 30_000

export function createTabPageReader(deps: TabPageReaderDependencies) {
  let queue: Promise<unknown> = Promise.resolve()

  function read(url: string): Promise<{ title: string; url: string; text: string }> {
    const run = queue.then(() => readOne(url), () => readOne(url))
    queue = run.catch(() => undefined)
    return run
  }

  async function readOne(url: string): Promise<{ title: string; url: string; text: string }> {
    const tab = await deps.tabs.create({ url, active: false })
    const tabId = tab.id
    if (tabId === undefined) throw new Error('打不开标签页')
    try {
      await loaded(tabId)
      await new Promise(resolve => setTimeout(resolve, deps.settleMs ?? SETTLE_MS))
      const page = await deps.readTab(tabId)
      const text = page.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      if (!text) throw new Error('在标签页里也没有读到文字')
      return { title: page.title.trim(), url: page.url || url, text }
    } finally {
      await deps.tabs.remove(tabId).catch(() => undefined)
    }
  }

  // Resolves once the tab's page has loaded; throws when it does not in time.
  function loaded(tabId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutMs = deps.loadTimeoutMs ?? LOAD_TIMEOUT_MS
      const timer = setTimeout(() => finish(new Error('在标签页里 30 秒内没有打开')), timeoutMs)
      const listener = (id: number, info: { status?: string }) => {
        if (id === tabId && info.status === 'complete') finish()
      }
      function finish(error?: Error) {
        clearTimeout(timer)
        deps.tabs.onUpdated.removeListener(listener)
        if (error) reject(error)
        else resolve()
      }
      deps.tabs.onUpdated.addListener(listener)
      // It may have loaded before the listener was added.
      deps.tabs.get(tabId).then(current => { if (current.status === 'complete') finish() }, () => undefined)
    })
  }

  return { read }
}
