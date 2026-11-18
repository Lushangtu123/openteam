// 附上网页 (src/group/webPage.ts). Clicking the OpenTeam icon, or 发到 OpenTeam in a page's menu,
// keeps which page that was; Chrome lets OpenTeam read that one tab until it moves on (activeTab).
// Nothing is read until the user clicks 附上 on the OpenTeam page. The offer lives in session
// storage, where the OpenTeam page watches it.
import { isReadablePageUrl, WEB_PAGE_OFFER_KEY, WEB_PAGE_OFFER_TTL_MS, webPageUpload, type CapturedWebPage, type WebPageOffer } from '../group/webPage'
import type { OpenTeamLanguage } from '../group/types'
import type { RuntimeMessage } from './runtimeClient'

interface OfferedTab {
  id?: number
  url?: string
  title?: string
}

export interface WebPageOfferDependencies {
  // chrome-extension://<id>/: a click on the OpenTeam page itself keeps the offer as it is.
  extensionOrigin: string
  storage: {
    get(key: string): Promise<Record<string, unknown>>
    set(items: Record<string, unknown>): Promise<void>
    remove(key: string): Promise<void>
  }
  getTab(tabId: number): Promise<OfferedTab | undefined>
  // Runs readPageInTab in the tab.
  readTab(tabId: number): Promise<CapturedWebPage>
  language(): Promise<OpenTeamLanguage>
  now(): number
}

type Handler = (message: RuntimeMessage, sender: unknown) => Promise<unknown>

export function createWebPageOffers(deps: WebPageOfferDependencies) {
  async function offer(tab: OfferedTab, selection?: string): Promise<void> {
    if (tab.url?.startsWith(deps.extensionOrigin)) return
    if (tab.id === undefined || !isReadablePageUrl(tab.url)) {
      await deps.storage.remove(WEB_PAGE_OFFER_KEY)
      return
    }
    const next: WebPageOffer = {
      tabId: tab.id,
      url: tab.url!,
      title: tab.title?.trim() || new URL(tab.url!).hostname,
      ...(selection?.trim() ? { selection: selection.trim() } : {}),
      offeredAt: deps.now(),
    }
    await deps.storage.set({ [WEB_PAGE_OFFER_KEY]: next })
  }

  async function currentOffer(): Promise<WebPageOffer | undefined> {
    const saved = (await deps.storage.get(WEB_PAGE_OFFER_KEY))[WEB_PAGE_OFFER_KEY] as WebPageOffer | undefined
    if (!saved || typeof saved.tabId !== 'number' || deps.now() - saved.offeredAt > WEB_PAGE_OFFER_TTL_MS) return undefined
    return saved
  }

  const read: Handler = async () => {
    const offered = await currentOffer()
    // Whatever happens next, this offer is used up: a failure says how to offer the page again.
    await deps.storage.remove(WEB_PAGE_OFFER_KEY)
    if (!offered) throw new Error('没有可以附上的网页。在要附上的网页上点一次 OpenTeam 图标。')
    const tab = await deps.getTab(offered.tabId).catch(() => undefined)
    if (!tab) throw new Error('那个网页已经关掉了')
    if (tab.url !== offered.url) throw new Error('那个网页已经换了。回到要附上的网页，再点一次 OpenTeam 图标。')
    let page: CapturedWebPage
    try {
      page = await deps.readTab(offered.tabId)
    } catch (error) {
      throw new Error(`读不了这个网页：${error instanceof Error ? error.message : String(error)}`)
    }
    const selection = page.selection?.trim() || offered.selection
    return { ok: true, upload: webPageUpload({ ...page, title: page.title || offered.title, selection }, await deps.language()) }
  }

  const dismiss: Handler = async () => {
    await deps.storage.remove(WEB_PAGE_OFFER_KEY)
    return { ok: true }
  }

  return {
    offer,
    handlers: [
      { type: 'WEB_PAGE_READ' as const, handler: read },
      { type: 'WEB_PAGE_DISMISS' as const, handler: dismiss },
    ],
  }
}

// Runs inside the page (chrome.scripting.executeScript sends this function's source), so it uses
// nothing from outside itself. The page's article is its text where there is one, else its main
// part, else the whole page; what the user selected comes too.
export function readPageInTab(): CapturedWebPage {
  const textOf = (element: Element) => (element as HTMLElement).innerText ?? element.textContent ?? ''
  let text = ''
  for (const selector of ['article', 'main, [role="main"]']) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const candidate = textOf(element)
      if (candidate.trim().length >= 200 && candidate.length > text.length) text = candidate
    }
    if (text) break
  }
  return {
    title: document.title,
    url: location.href,
    selection: String(getSelection() ?? ''),
    text: text || (document.body ? textOf(document.body) : ''),
  }
}
