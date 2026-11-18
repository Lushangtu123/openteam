// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { WEB_PAGE_OFFER_KEY, WEB_PAGE_OFFER_TTL_MS, type WebPageOffer } from '../group/webPage'
import { createWebPageOffers, readPageInTab } from './webPageOffers'

const NOW = 1_800_000_000_000
const EXTENSION = 'chrome-extension://abc/'

function setup(options: { tabUrl?: string; tabGone?: boolean; readFails?: boolean; selection?: string } = {}) {
  let saved: Record<string, unknown> = {}
  let now = NOW
  const readTab = vi.fn(async () => {
    if (options.readFails) throw new Error('Cannot access contents of the page')
    return { title: '页面标题', url: 'https://example.com/post', selection: options.selection ?? '', text: '正文' }
  })
  const offers = createWebPageOffers({
    extensionOrigin: EXTENSION,
    storage: {
      get: async key => (key in saved ? { [key]: saved[key] } : {}),
      set: async items => { saved = { ...saved, ...items } },
      remove: async key => { const { [key]: _removed, ...rest } = saved; saved = rest },
    },
    getTab: async tabId => options.tabGone ? undefined : { id: tabId, url: options.tabUrl ?? 'https://example.com/post', title: '页面标题' },
    readTab,
    language: async () => 'zh-CN',
    now: () => now,
  })
  const read = (offers.handlers.find(handler => handler.type === 'WEB_PAGE_READ'))!.handler
  const dismiss = (offers.handlers.find(handler => handler.type === 'WEB_PAGE_DISMISS'))!.handler
  return { offers, read, dismiss, readTab, saved: () => saved[WEB_PAGE_OFFER_KEY] as WebPageOffer | undefined, setNow: (value: number) => { now = value } }
}

describe('offering the page the user was on', () => {
  it('keeps the page the icon was clicked on, and nothing of its content yet', async () => {
    const { offers, saved, readTab } = setup()
    await offers.offer({ id: 7, url: 'https://example.com/post', title: '页面标题' })
    expect(saved()).toEqual({ tabId: 7, url: 'https://example.com/post', title: '页面标题', offeredAt: NOW })
    expect(readTab).not.toHaveBeenCalled()
  })

  it('keeps what was selected when 发到 OpenTeam was chosen on a selection', async () => {
    const { offers, saved } = setup()
    await offers.offer({ id: 7, url: 'https://example.com/post', title: 't' }, '一段话')
    expect(saved()?.selection).toBe('一段话')
  })

  it('leaves the offer alone when the icon is clicked on the OpenTeam page, and drops it on a page it cannot read', async () => {
    const { offers, saved } = setup()
    await offers.offer({ id: 7, url: 'https://example.com/post', title: 't' })
    await offers.offer({ id: 9, url: `${EXTENSION}team.html`, title: 'OpenTeam' })
    expect(saved()?.tabId).toBe(7)
    await offers.offer({ id: 8, url: 'chrome://extensions', title: 'Extensions' })
    expect(saved()).toBeUndefined()
  })
})

describe('reading the offered page', () => {
  it('reads it when the user attaches it, as a Markdown file, and forgets the offer', async () => {
    const { offers, read, readTab, saved } = setup({ selection: '选中' })
    await offers.offer({ id: 7, url: 'https://example.com/post', title: '页面标题' })
    const response = await read({ type: 'WEB_PAGE_READ' }, {}) as { ok: boolean; upload: { fileName: string; text: string } }
    expect(readTab).toHaveBeenCalledWith(7)
    expect(response.ok).toBe(true)
    expect(response.upload.fileName).toBe('网页-页面标题.md')
    expect(response.upload.text).toContain('## 选中的文字\n\n选中')
    expect(saved()).toBeUndefined()
  })

  it('uses the selection from the menu when the page has none now', async () => {
    const { offers, read } = setup()
    await offers.offer({ id: 7, url: 'https://example.com/post', title: 't' }, '菜单里的选中')
    const response = await read({ type: 'WEB_PAGE_READ' }, {}) as { upload: { text: string } }
    expect(response.upload.text).toContain('菜单里的选中')
  })

  it('says what to do when the page was closed, moved on, or could not be read', async () => {
    for (const [options, error] of [
      [{ tabGone: true }, '那个网页已经关掉了'],
      [{ tabUrl: 'https://example.com/other' }, '那个网页已经换了。回到要附上的网页，再点一次 OpenTeam 图标'],
      [{ readFails: true }, '读不了这个网页：Cannot access contents of the page'],
    ] as const) {
      const { offers, read, saved } = setup(options)
      await offers.offer({ id: 7, url: 'https://example.com/post', title: 't' })
      await expect(read({ type: 'WEB_PAGE_READ' }, {})).rejects.toThrow(error)
      expect(saved()).toBeUndefined()
    }
  })

  it('has nothing to read once the offer is old or dismissed', async () => {
    const { offers, read, dismiss, setNow } = setup()
    await offers.offer({ id: 7, url: 'https://example.com/post', title: 't' })
    setNow(NOW + WEB_PAGE_OFFER_TTL_MS + 1)
    await expect(read({ type: 'WEB_PAGE_READ' }, {})).rejects.toThrow('没有可以附上的网页')
    setNow(NOW)
    await offers.offer({ id: 7, url: 'https://example.com/post', title: 't' })
    await dismiss({ type: 'WEB_PAGE_DISMISS' }, {})
    await expect(read({ type: 'WEB_PAGE_READ' }, {})).rejects.toThrow('没有可以附上的网页')
  })
})

describe('reading a page from inside it', () => {
  it('takes the article when there is one, else the main part, else the whole page', () => {
    const long = '文'.repeat(250)
    document.title = '标题'
    document.body.innerHTML = `<nav>导航</nav><article><p>${long}</p></article><footer>页脚</footer>`
    expect(readPageInTab()).toMatchObject({ title: '标题', text: long })

    document.body.innerHTML = `<nav>导航</nav><main><p>${long}</p></main>`
    expect(readPageInTab().text).toBe(long)

    document.body.innerHTML = '<article>短</article><p>全部内容</p>'
    expect(readPageInTab().text).toBe('短全部内容')
  })

  it('carries the selection and the address', () => {
    document.body.innerHTML = '<p id="p">选中这几个字</p>'
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('p')!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    expect(readPageInTab()).toMatchObject({ selection: '选中这几个字', url: location.href })
    getSelection()!.removeAllRanges()
  })
})
