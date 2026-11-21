// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createWebSearchQuotaNotice } from './webSearchQuotaNotice'

const NOW = new Date(2026, 10, 21, 10).getTime()

function setup(used: number, monthlyLimit?: number, noticeMonth?: string) {
  document.body.innerHTML = '<div id="web-search-quota-notice" hidden></div>'
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.webSearch = { provider: 'tavily', apiKey: 'tvly-x', ...(monthlyLimit ? { monthlyLimit } : {}) }
  store.webSearchUsage = { days: { '2026-11-03': { total: used, byChat: {} } }, ...(noticeMonth ? { noticeMonth } : {}) }
  const openUsage = vi.fn()
  const runCommand = vi.fn(async () => undefined)
  const notice = createWebSearchQuotaNotice({ element: document.getElementById('web-search-quota-notice'), language: () => 'zh-CN', getStore: () => store, now: () => NOW, openUsage, runCommand, showError: vi.fn() })
  notice.render()
  const box = () => document.getElementById('web-search-quota-notice')!
  return { store, notice, openUsage, runCommand, box, buttons: () => [...box().querySelectorAll('button')] }
}

describe('the notice that web searches near the monthly allowance', () => {
  it('shows at 80%, says how many, and offers 用量 and 知道了', async () => {
    const ctx = setup(80, 100)
    expect(ctx.box().hidden).toBe(false)
    expect(ctx.box().querySelector('p')?.textContent).toBe('联网搜索本月已用 80 次，是你填的额度 100 次的 80%。用完后 API 成员的搜索会失败。')
    expect(ctx.buttons().map(node => node.textContent)).toEqual(['查看用量', '知道了'])
    ctx.buttons()[0].click()
    expect(ctx.openUsage).toHaveBeenCalledTimes(1)
    ctx.buttons()[1].click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('WEB_SEARCH_NOTICE_DISMISS'))
  })

  it('says when the allowance is reached', () => {
    expect(setup(120, 100).box().querySelector('p')?.textContent).toBe('联网搜索本月已用 120 次，到了你填的额度 100 次。API 成员的搜索可能已经失败。')
  })

  it('stays hidden below 80%, without an allowance, or once put away this month', () => {
    expect(setup(79, 100).box().hidden).toBe(true)
    expect(setup(500).box().hidden).toBe(true)
    expect(setup(90, 100, '2026-11').box().hidden).toBe(true)
    expect(setup(90, 100, '2026-10').box().hidden).toBe(false)
  })
})
