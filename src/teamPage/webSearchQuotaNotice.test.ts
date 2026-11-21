// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createWebSearchQuotaNotice } from './webSearchQuotaNotice'
import type { WebSearchUsage } from '../shared/webSearchUsage'

const NOW = new Date(2026, 10, 21, 10).getTime()

function setup(used: number, limit?: number, noticeDismissed?: WebSearchUsage['noticeDismissed'], keyLimit?: number) {
  document.body.innerHTML = '<div id="web-search-quota-notice" hidden></div>'
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.webSearch = { provider: 'tavily', apiKey: 'tvly-x' }
  store.webSearchUsage = { days: {}, account: { checkedAt: NOW, used, ...(limit ? { limit } : {}), ...(keyLimit ? { keyLimit, keyUsed: used } : {}) }, ...(noticeDismissed ? { noticeDismissed } : {}) }
  const openUsage = vi.fn()
  const runCommand = vi.fn(async () => undefined)
  const notice = createWebSearchQuotaNotice({ element: document.getElementById('web-search-quota-notice'), language: () => 'zh-CN', getStore: () => store, openUsage, runCommand, showError: vi.fn() })
  notice.render()
  const box = () => document.getElementById('web-search-quota-notice')!
  return { store, notice, openUsage, runCommand, box, buttons: () => [...box().querySelectorAll('button')] }
}

describe('the notice that the Tavily account nears its limit', () => {
  it('shows at 80%, says how many, and offers 用量 and 知道了', async () => {
    const ctx = setup(800, 1000)
    expect(ctx.box().hidden).toBe(false)
    expect(ctx.box().querySelector('p')?.textContent).toBe('Tavily 账户本期已用 800 / 1000 个额度（80%）。用完后 API 成员的搜索会失败。')
    expect(ctx.buttons().map(node => node.textContent)).toEqual(['查看用量', '知道了'])
    ctx.buttons()[0].click()
    expect(ctx.openUsage).toHaveBeenCalledTimes(1)
    ctx.buttons()[1].click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('WEB_SEARCH_NOTICE_DISMISS'))
  })

  it('says when the credits are used up, and names the key when its own limit is nearer', () => {
    expect(setup(1000, 1000).box().querySelector('p')?.textContent).toBe('Tavily 账户本期的 1000 个额度已经用完，API 成员的搜索会失败，直到额度恢复。')
    expect(setup(90, 1000, undefined, 100).box().querySelector('p')?.textContent).toBe('这个 Tavily Key 本期已用 90 / 100 个额度（90%）。用完后 API 成员的搜索会失败。')
  })

  it('stays hidden below 80%, without a limit, or once put away', () => {
    expect(setup(799, 1000).box().hidden).toBe(true)
    expect(setup(5000).box().hidden).toBe(true)
    expect(setup(900, 1000, { used: 850, limit: 1000 }).box().hidden).toBe(true)
    expect(setup(1000, 1000, { used: 850, limit: 1000 }).box().hidden).toBe(false)
  })
})
