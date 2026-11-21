import { describe, expect, it } from 'vitest'
import { monthSearches, normalizeWebSearchUsage, recordWebSearch, searchesInRange, searchQuotaState, type WebSearchUsage } from './webSearchUsage'

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

  it('counts this calendar month, and says when it nears or reaches the allowance', () => {
    const record = usage()
    expect(monthSearches(record, at(11, 21))).toBe(4)
    expect(searchQuotaState(record, undefined, at(11, 21))).toEqual({ used: 4 })
    expect(searchQuotaState(record, 10, at(11, 21))).toEqual({ used: 4, limit: 10, share: 0.4 })
    expect(searchQuotaState(record, 5, at(11, 21))).toEqual({ used: 4, limit: 5, share: 0.8, near: true })
    expect(searchQuotaState(record, 4, at(11, 21))).toEqual({ used: 4, limit: 4, share: 1, near: true, reached: true })
    expect(monthSearches(record, at(12, 1))).toBe(0)
  })

  it('keeps about a year of days, and reads back what was stored', () => {
    const record = usage()
    recordWebSearch(record, { modelId: 'gemini', chatId: 'c1' }, at(11, 21) + 401 * 86_400_000)
    expect(Object.keys(record.days)).toHaveLength(1)
    const stored = usage()
    stored.noticeMonth = '2026-11'
    expect(normalizeWebSearchUsage(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    expect(normalizeWebSearchUsage({ days: { 'bad': { total: 1 }, '2026-11-01': { total: 'x' }, '2026-11-02': { total: 1, byChat: { c: { m: 1, bad: 'x' }, d: 3 } } } })).toEqual({ days: { '2026-11-02': { total: 1, byChat: { c: { m: 1 } } } } })
    expect(normalizeWebSearchUsage(undefined)).toEqual({ days: {} })
  })
})
