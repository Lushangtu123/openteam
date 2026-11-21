import { describe, expect, it } from 'vitest'
import { monthSearches, normalizeWebSearchUsage, readTavilyAccount, recordWebSearch, searchesInRange, searchQuotaNoticeDue, searchQuotaState, type WebSearchUsage } from './webSearchUsage'

// Local times. 2026-11-21 is a Saturday.
const at = (month: number, day: number, hour = 10) => new Date(2026, month - 1, day, hour).getTime()

function usage(): WebSearchUsage {
  const record: WebSearchUsage = { days: {} }
  recordWebSearch(record, { modelId: 'gemini', chatId: 'c1' }, at(10, 31))
  recordWebSearch(record, { modelId: 'gemini', chatId: 'c1' }, at(11, 1))
  recordWebSearch(record, { modelId: 'kimi', chatId: 'c2' }, at(11, 20))
  recordWebSearch(record, { modelId: 'gemini', chatId: 'c2' }, at(11, 21))
  recordWebSearch(record, { test: true }, at(11, 21))
  return record
}

describe('counting web searches', () => {
  it('counts each search for its day, model and group, and a test on its own', () => {
    const record = usage()
    expect(record.days['2026-11-21']).toEqual({ total: 2, byChat: { c2: { gemini: 1 } }, tests: 1 })
    expect(record.days['2026-10-31']).toEqual({ total: 1, byChat: { c1: { gemini: 1 } } })
  })

  it('adds up a stretch of days, for all groups or one', () => {
    const record = usage()
    expect(searchesInRange(record, at(11, 20, 0), at(11, 21, 23))).toEqual({ total: 3, byModel: { kimi: 1, gemini: 1 }, tests: 1 })
    expect(searchesInRange(record, 0, at(11, 21, 23), 'c1')).toEqual({ total: 2, byModel: { gemini: 2 }, tests: 0 })
  })

  it('counts this calendar month', () => {
    const record = usage()
    expect(monthSearches(record, at(11, 21))).toBe(4)
    expect(monthSearches(record, at(12, 1))).toBe(0)
  })

  it('keeps about a year of days, and reads back what was stored', () => {
    const record = usage()
    recordWebSearch(record, { modelId: 'gemini', chatId: 'c1' }, at(11, 21) + 401 * 86_400_000)
    expect(Object.keys(record.days)).toHaveLength(1)
    const stored = usage()
    stored.account = { checkedAt: at(11, 21), used: 320, limit: 1000, plan: 'Researcher', keyUsed: 20, keyLimit: 100 }
    stored.noticeDismissed = { used: 820, limit: 1000 }
    expect(normalizeWebSearchUsage(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    expect(normalizeWebSearchUsage({ days: { 'bad': { total: 1 }, '2026-11-01': { total: 'x' }, '2026-11-02': { total: 1, byChat: { c: { m: 1, bad: 'x' }, d: 3 } } } })).toEqual({ days: { '2026-11-02': { total: 1, byChat: { c: { m: 1 } } } } })
    expect(normalizeWebSearchUsage(undefined)).toEqual({ days: {} })
  })
})

describe('the Tavily account\'s credits', () => {
  const answer = { key: { usage: 150, limit: null, search_usage: 150 }, account: { current_plan: 'Researcher', plan_usage: 812, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } }

  it('reads Tavily\'s answer, the plan\'s and the key\'s own limit', () => {
    expect(readTavilyAccount(answer, 5)).toEqual({ checkedAt: 5, used: 812, limit: 1000, plan: 'Researcher' })
    expect(readTavilyAccount({ key: { usage: 90, limit: 100 }, account: { plan_usage: 300, plan_limit: 1000 } }, 5)).toEqual({ checkedAt: 5, used: 300, limit: 1000, keyUsed: 90, keyLimit: 100 })
    expect(() => readTavilyAccount({ detail: 'x' }, 5)).toThrow('Tavily 没有给出用量')
  })

  it('holds the credits against the nearer limit, and says when it is near or reached', () => {
    expect(searchQuotaState(undefined)).toBeUndefined()
    expect(searchQuotaState({ days: {}, account: { checkedAt: 5, used: 40 } })).toBeUndefined()
    expect(searchQuotaState({ days: {}, account: { checkedAt: 5, used: 400, limit: 1000 } })).toEqual({ used: 400, limit: 1000, share: 0.4, scope: 'plan', checkedAt: 5 })
    expect(searchQuotaState({ days: {}, account: { checkedAt: 5, used: 400, limit: 1000, keyUsed: 85, keyLimit: 100 } })).toEqual({ used: 85, limit: 100, share: 0.85, scope: 'key', checkedAt: 5, near: true })
    expect(searchQuotaState({ days: {}, account: { checkedAt: 5, used: 1000, limit: 1000 } })).toMatchObject({ share: 1, near: true, reached: true })
  })

  it('shows the notice once near, until put away, and again at the limit or in a new cycle', () => {
    const near = (used: number, noticeDismissed?: WebSearchUsage['noticeDismissed']) => searchQuotaNoticeDue({ days: {}, account: { checkedAt: 5, used, limit: 1000 }, ...(noticeDismissed ? { noticeDismissed } : {}) })
    expect(near(799)).toBeUndefined()
    expect(near(800)).toMatchObject({ used: 800 })
    expect(near(850, { used: 820, limit: 1000 })).toBeUndefined()
    expect(near(1000, { used: 820, limit: 1000 })).toMatchObject({ reached: true })
    expect(near(1000, { used: 1000, limit: 1000, reached: true })).toBeUndefined()
    expect(near(805, { used: 990, limit: 1000 })).toMatchObject({ used: 805 })
    expect(near(850, { used: 820, limit: 4000 })).toMatchObject({ used: 850 })
  })
})
