import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { ACCOUNT_FRESH_MS, createWebSearcher, WEB_SEARCH_ROUTE_TYPES } from './webSearcher'

const KEY = 'tvly-dev-0123456789'
const NOW = new Date(2026, 10, 21, 10).getTime()

const ACCOUNT = { key: { usage: 12, limit: null }, account: { current_plan: 'Researcher', plan_usage: 812, plan_limit: 1000 } }

function setup(options: { status?: number; body?: unknown; access?: boolean; usage?: { status?: number; body?: unknown } } = {}) {
  let store: OpenTeamStore = createDefaultStore()
  let clock = NOW
  const fetch = vi.fn(async (url: string, _init: RequestInit) => url.endsWith('/usage')
    ? new Response(JSON.stringify(options.usage?.body ?? ACCOUNT), { status: options.usage?.status ?? 200 })
    : new Response(JSON.stringify(options.body ?? { query: 'q', results: [{ title: 'OpenTeam', url: 'https://github.com/x/openteam', content: '一个 Chrome 扩展' }] }), { status: options.status ?? 200 }))
  const warn = vi.fn()
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
    log: { warn },
    now: () => clock,
  })
  const run = (type: string, fields: Record<string, unknown> = {}) => Promise.resolve(searcher.routes.find(route => route.type === type)!.handler({ type, ...fields }, {}))
  const searchCalls = () => fetch.mock.calls.filter(([url]) => url.endsWith('/search'))
  const usageCalls = () => fetch.mock.calls.filter(([url]) => url.endsWith('/usage'))
  return { searcher, fetch, hasAccess, broadcastStoreUpdated, run, warn, searchCalls, usageCalls, store: () => store, tick: (ms: number) => { clock += ms } }
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
    expect(ctx.searchCalls()).toHaveLength(3)
  })

  it('says, as text the member can go on with, why a search did not work', async () => {
    const search = (options: Parameters<typeof setup>[0]) => setup(options).searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('q')
    expect(await search({ status: 432, body: { detail: { error: 'limit' } }, usage: { status: 500 } })).toBe('没有搜到：Tavily 的搜索额度用完了：到 tavily.com 查看用量，或等额度在下个周期恢复（本月 OpenTeam 已搜索 0 次）')
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
    expect(WEB_SEARCH_ROUTE_TYPES).toEqual(['WEB_SEARCH_SAVE', 'WEB_SEARCH_TEST', 'WEB_SEARCH_ACCOUNT_REFRESH', 'WEB_SEARCH_NOTICE_DISMISS'])
    await ctx.run('WEB_SEARCH_SAVE', { apiKey: ` Bearer ${KEY} ` })
    expect(ctx.store().settings.webSearch).toEqual({ provider: 'tavily', apiKey: KEY })
    expect(ctx.broadcastStoreUpdated).toHaveBeenCalled()

    expect(await ctx.run('WEB_SEARCH_TEST')).toMatchObject({ ok: true, results: 1 })
    expect(JSON.parse(String(ctx.searchCalls()[0][1].body))).toMatchObject({ query: 'OpenTeam', max_results: 1 })

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

  it('says what Tavily counts, or else this month\'s searches, when the allowance is used up', async () => {
    const ctx = setup({ status: 432, body: { detail: { error: 'limit' } }, usage: { body: { account: { plan_usage: 1000, plan_limit: 1000 } } } })
    ctx.store().settings.webSearch = { provider: 'tavily', apiKey: KEY }
    expect(await ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('q')).toBe('没有搜到：Tavily 的搜索额度用完了：到 tavily.com 查看用量，或等额度在下个周期恢复（Tavily 本期已用 1000 / 1000 个额度）')

    const unread = setup({ status: 432, body: { detail: { error: 'limit' } }, usage: { status: 401 } })
    unread.store().webSearchUsage = { days: { '2026-11-02': { total: 998, byChat: {} } } }
    expect(await unread.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!('q')).toBe('没有搜到：Tavily 的搜索额度用完了：到 tavily.com 查看用量，或等额度在下个周期恢复（本月 OpenTeam 已搜索 998 次）')
  })
})

describe('the Tavily account\'s credits', () => {
  it('reads them with the key, keeps them, and reads them again after searches every few minutes', async () => {
    const ctx = setup()
    await ctx.run('WEB_SEARCH_SAVE', { apiKey: KEY })
    expect(ctx.usageCalls()).toHaveLength(0)
    await ctx.run('WEB_SEARCH_ACCOUNT_REFRESH')
    expect(ctx.store().webSearchUsage?.account).toEqual({ checkedAt: NOW, used: 812, limit: 1000, plan: 'Researcher' })
    const [url, init] = ctx.usageCalls()[0]
    expect(url).toBe('https://api.tavily.com/usage')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' })
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)

    const search = ctx.searcher.forReply({ provider: 'tavily', apiKey: KEY }, { english: false })!
    await search('a')
    expect(ctx.usageCalls()).toHaveLength(1)
    ctx.tick(ACCOUNT_FRESH_MS)
    await search('b')
    await vi.waitFor(() => expect(ctx.usageCalls()).toHaveLength(2))
    await vi.waitFor(() => expect(ctx.store().webSearchUsage?.account?.checkedAt).toBe(NOW + ACCOUNT_FRESH_MS))
  })

  it('reads them on asking, and says why it could not', async () => {
    const ctx = setup({ usage: { status: 401, body: { detail: { error: 'Unauthorized' } } } })
    expect(await ctx.run('WEB_SEARCH_ACCOUNT_REFRESH')).toEqual({ ok: true, error: '还没有填 Tavily 的 API Key' })
    ctx.store().settings.webSearch = { provider: 'tavily', apiKey: KEY }
    expect(await ctx.run('WEB_SEARCH_ACCOUNT_REFRESH')).toMatchObject({ ok: true, error: expect.stringContaining('Tavily 的 API Key 不对或已失效') })
    const ok = setup()
    ok.store().settings.webSearch = { provider: 'tavily', apiKey: KEY }
    expect(await ok.run('WEB_SEARCH_ACCOUNT_REFRESH')).toMatchObject({ ok: true, account: { used: 812, limit: 1000 } })
    expect(ok.broadcastStoreUpdated).toHaveBeenCalled()
  })

  it('forgets another key\'s credits, and puts the notice away where it is', async () => {
    const ctx = setup()
    ctx.store().settings.webSearch = { provider: 'tavily', apiKey: KEY }
    await ctx.run('WEB_SEARCH_ACCOUNT_REFRESH')
    await ctx.run('WEB_SEARCH_NOTICE_DISMISS')
    expect(ctx.store().webSearchUsage?.noticeDismissed).toEqual({ used: 812, limit: 1000 })
    await ctx.run('WEB_SEARCH_SAVE', { apiKey: 'tvly-new-key' })
    expect(ctx.store().webSearchUsage?.account).toBeUndefined()
    expect(ctx.store().webSearchUsage?.noticeDismissed).toBeUndefined()
    await ctx.run('WEB_SEARCH_SAVE', { remove: true })
    expect(ctx.store().settings.webSearch).toBeUndefined()
  })
})
