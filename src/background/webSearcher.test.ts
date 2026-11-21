import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createWebSearcher, WEB_SEARCH_ROUTE_TYPES } from './webSearcher'

const KEY = 'tvly-dev-0123456789'
const NOW = new Date(2026, 10, 21, 10).getTime()

function setup(options: { status?: number; body?: unknown; access?: boolean } = {}) {
  let store: OpenTeamStore = createDefaultStore()
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(options.body ?? { query: 'q', results: [{ title: 'OpenTeam', url: 'https://github.com/x/openteam', content: '一个 Chrome 扩展' }] }), { status: options.status ?? 200 }))
  const hasAccess = vi.fn(async (_pattern: string) => options.access ?? true)
  const broadcastStoreUpdated = vi.fn()
  const searcher = createWebSearcher({
    fetch,
    hasAccess,
    loadStore: async () => store,
    mutateStore: async mutator => {
      const result = await mutator(store)
      store = structuredClone(store)
      return { store, result }
    },
    broadcastStoreUpdated,
    log: { warn: vi.fn() },
    now: () => NOW,
  })
  const run = (type: string, fields: Record<string, unknown> = {}) => Promise.resolve(searcher.routes.find(route => route.type === type)!.handler({ type, ...fields }, {}))
  return { searcher, fetch, hasAccess, broadcastStoreUpdated, run, store: () => store }
}

describe('an API member searching while it answers', () => {
  it('asks Tavily with the user\'s key and gives the results back as material', async () => {
    const ctx = setup()
    const searches: Array<{ query: string; results: number }> = []
    const search = ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false, onSearch: entry => searches.push(entry) })!
    const text = await search('OpenTeam 是什么', { topic: 'news', timeRange: 'week' })
    expect(text).toContain('搜索「OpenTeam 是什么」的结果')
    expect(text).toContain('https://github.com/x/openteam')
    const [url, init] = ctx.fetch.mock.calls[0]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' })
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(String(init.body))).toMatchObject({ query: 'OpenTeam 是什么', topic: 'news', time_range: 'week', max_results: 5 })
    expect(searches).toEqual([{ query: 'OpenTeam 是什么', results: 1 }])
  })

  it('is not offered without a key', () => {
    expect(setup().searcher.forReply(undefined, { english: false })).toBeUndefined()
  })

  it('searches at most three times an answer, and the same search once', async () => {
    const ctx = setup()
    const search = ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!
    await search('a')
    await search('a')
    await search('b')
    await search('c')
    expect(await search('d')).toBe('这次回答最多搜索 3 次，没有再搜「d」。')
    expect(ctx.fetch).toHaveBeenCalledTimes(3)
  })

  it('says, as text the member can go on with, why a search did not work', async () => {
    const search = (options: Parameters<typeof setup>[0]) => setup(options).searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('q')
    expect(await search({ status: 432, body: { detail: { error: 'limit' } } })).toBe('没有搜到：Tavily 的搜索额度用完了：到 tavily.com 查看用量，或等下个月额度恢复（本月 OpenTeam 已搜索 0 次）')
    expect(await search({ access: false })).toBe('没有搜到：OpenTeam 没有访问 api.tavily.com 的权限，请到设置 → 模型 → 联网搜索 重新保存 Key')
    expect(await setup().searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('  ')).toBe('没有搜：缺少搜索词')
    const failing = setup()
    failing.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await failing.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('q')).toBe('没有搜到：Failed to fetch')
  })

  it('stops with the answer when it is stopped', async () => {
    const ctx = setup()
    const controller = new AbortController()
    ctx.fetch.mockImplementationOnce(async (_url, init) => {
      controller.abort()
      throw init.signal?.reason ?? new DOMException('Aborted', 'AbortError')
    })
    const search = ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false, signal: controller.signal })!
    await expect(search('q')).rejects.toThrow()
  })
})

describe('the 联网搜索 key, from the settings', () => {
  it('saves a key, tests it, and removes it', async () => {
    const ctx = setup()
    expect(WEB_SEARCH_ROUTE_TYPES).toEqual(['WEB_SEARCH_SAVE', 'WEB_SEARCH_TEST', 'WEB_SEARCH_LIMIT_SET', 'WEB_SEARCH_NOTICE_DISMISS'])
    await ctx.run('WEB_SEARCH_SAVE', { apiKey: ` Bearer ${KEY} ` })
    expect(ctx.store().settings.webSearch).toEqual({ provider: 'tavily', apiKey: KEY })
    expect(ctx.broadcastStoreUpdated).toHaveBeenCalledTimes(1)

    expect(await ctx.run('WEB_SEARCH_TEST')).toMatchObject({ ok: true, results: 1 })
    expect(JSON.parse(String(ctx.fetch.mock.calls[0][1].body))).toMatchObject({ query: 'OpenTeam', max_results: 1 })

    await ctx.run('WEB_SEARCH_SAVE', { remove: true })
    expect(ctx.store().settings.webSearch).toBeUndefined()
    await expect(ctx.run('WEB_SEARCH_TEST')).rejects.toThrow('还没有填 Tavily 的 API Key')
    await expect(ctx.run('WEB_SEARCH_SAVE', { apiKey: '' })).rejects.toThrow('填上 Tavily 的 API Key')
  })

  it('tests a key before it is saved, and says why one does not work', async () => {
    const ctx = setup({ status: 401, body: { detail: { error: 'Unauthorized' } } })
    await expect(ctx.run('WEB_SEARCH_TEST', { apiKey: KEY })).rejects.toThrow('Tavily 的 API Key 不对或已失效')
    expect((ctx.fetch.mock.calls[0][1].headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
  })
})

describe('counting the searches', () => {
  it('counts each search that came back for its model and group, and a test as a test', async () => {
    const ctx = setup()
    const search = ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false, chatId: 'c1', modelId: 'gemini' })!
    await search('a')
    await search('a')
    await search('b')
    expect(ctx.store().webSearchUsage?.days['2026-11-21']).toEqual({ total: 2, byChat: { c1: { gemini: 2 } } })
    await ctx.run('WEB_SEARCH_TEST', { apiKey: KEY })
    expect(ctx.store().webSearchUsage?.days['2026-11-21']).toMatchObject({ total: 3, tests: 1 })

    const failing = setup({ status: 401 })
    await failing.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false, chatId: 'c1', modelId: 'gemini' })!('a')
    expect(failing.store().webSearchUsage?.days ?? {}).toEqual({})
  })

  it('says how many searches this month when the allowance is used up', async () => {
    const ctx = setup({ status: 432, body: { detail: { error: 'limit' } } })
    ctx.store().webSearchUsage = { days: { '2026-11-02': { total: 998, byChat: {} } } }
    expect(await ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('q')).toBe('没有搜到：Tavily 的搜索额度用完了：到 tavily.com 查看用量，或等下个月额度恢复（本月 OpenTeam 已搜索 998 次）')
  })

  it('keeps the monthly allowance, also when the key changes, and puts the notice away for the month', async () => {
    const ctx = setup()
    await ctx.run('WEB_SEARCH_SAVE', { apiKey: KEY })
    await ctx.run('WEB_SEARCH_LIMIT_SET', { monthlyLimit: 1000 })
    expect(ctx.store().settings.webSearch).toEqual({ provider: 'tavily', apiKey: KEY, monthlyLimit: 1000 })
    await ctx.run('WEB_SEARCH_SAVE', { apiKey: 'tvly-new-key' })
    expect(ctx.store().settings.webSearch).toEqual({ provider: 'tavily', apiKey: 'tvly-new-key', monthlyLimit: 1000 })
    await ctx.run('WEB_SEARCH_LIMIT_SET', { monthlyLimit: null })
    expect(ctx.store().settings.webSearch).toEqual({ provider: 'tavily', apiKey: 'tvly-new-key' })
    await expect(ctx.run('WEB_SEARCH_LIMIT_SET', { monthlyLimit: 0.5 })).rejects.toThrow('每月额度要写一个正整数')

    await ctx.run('WEB_SEARCH_NOTICE_DISMISS')
    expect(ctx.store().webSearchUsage?.noticeMonth).toBe('2026-11')
  })
})

