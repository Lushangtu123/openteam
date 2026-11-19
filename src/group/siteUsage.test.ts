import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import {
  activeSiteLimit,
  clearSiteLimit,
  isSiteLimitMessage,
  normalizeSiteUsageRecord,
  noteSiteTried,
  recordSiteLimit,
  recordSiteSent,
  SITE_LIMIT_COOLDOWN_MS,
  siteLimitSkipReason,
  siteUsageToday,
  takeSiteRecovery,
} from './siteUsage'

// Local times, so the tests hold in any time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

describe('a site\'s use today', () => {
  it('counts the prompts it took, starting again each day', () => {
    const store = createDefaultStore()
    expect(siteUsageToday(store, 'kimi', at(16, 9))).toEqual({ sent: 0 })
    recordSiteSent(store, 'kimi', at(16, 9))
    recordSiteSent(store, 'kimi', at(16, 10))
    recordSiteSent(store, 'chatgpt', at(16, 10))
    expect(siteUsageToday(store, 'kimi', at(16, 23, 59))).toEqual({ sent: 2 })
    expect(siteUsageToday(store, 'kimi', at(17, 0, 1))).toEqual({ sent: 0 })
    recordSiteSent(store, 'kimi', at(17, 8))
    expect(siteUsageToday(store, 'kimi', at(17, 8))).toEqual({ sent: 1 })
  })

  it('is near the limit at 80% of the count it was limited at last time', () => {
    const store = createDefaultStore()
    for (let index = 0; index < 15; index += 1) recordSiteSent(store, 'kimi', at(16, 9))
    recordSiteLimit(store, 'kimi', 'Kimi 没有发出这条消息（可能是使用额度用完）', at(16, 12))
    clearSiteLimit(store, 'kimi')
    for (let index = 0; index < 11; index += 1) recordSiteSent(store, 'kimi', at(17, 9))
    expect(siteUsageToday(store, 'kimi', at(17, 9))).toEqual({ sent: 11, limitCount: 15 })
    recordSiteSent(store, 'kimi', at(17, 9))
    expect(siteUsageToday(store, 'kimi', at(17, 9))).toEqual({ sent: 12, limitCount: 15, nearLimit: true })
  })
})

describe('a site that says it is limiting', () => {
  it('is kept away from for 3 hours, from the first time it said so', () => {
    const store = createDefaultStore()
    recordSiteSent(store, 'kimi', at(16, 14))
    expect(recordSiteLimit(store, 'kimi', '使用额度用完', at(16, 14, 5))).toBe(true)
    expect(recordSiteLimit(store, 'kimi', '又一次', at(16, 14, 30))).toBe(false)
    expect(activeSiteLimit(store, 'kimi', at(16, 17))).toEqual({ limitedAt: at(16, 14, 5), limitedUntil: at(16, 14, 5) + SITE_LIMIT_COOLDOWN_MS, detail: '使用额度用完' })
    expect(activeSiteLimit(store, 'kimi', at(16, 17, 5))).toBeUndefined()
    expect(activeSiteLimit(store, 'chatgpt', at(16, 15))).toBeUndefined()
    // Limited again later: a new 3 hours.
    expect(recordSiteLimit(store, 'kimi', '再次限流', at(16, 18))).toBe(true)
    expect(activeSiteLimit(store, 'kimi', at(16, 20))?.limitedAt).toBe(at(16, 18))
  })

  it('keeps the count it had reached only when that was at least 5, keeping an earlier one otherwise', () => {
    const store = createDefaultStore()
    for (let index = 0; index < 4; index += 1) recordSiteSent(store, 'kimi', at(16, 9))
    recordSiteLimit(store, 'kimi', '限流', at(16, 9))
    expect(siteUsageToday(store, 'kimi', at(16, 9)).limitCount).toBeUndefined()
    clearSiteLimit(store, 'kimi')
    recordSiteSent(store, 'kimi', at(16, 10))
    recordSiteLimit(store, 'kimi', '限流', at(16, 10))
    expect(siteUsageToday(store, 'kimi', at(16, 10)).limitCount).toBe(5)
    clearSiteLimit(store, 'kimi')
    recordSiteSent(store, 'kimi', at(17, 9))
    recordSiteLimit(store, 'kimi', '限流', at(17, 9))
    expect(siteUsageToday(store, 'kimi', at(17, 9)).limitCount).toBe(5)
  })

  it('is used again once the user says it recovered', () => {
    const store = createDefaultStore()
    recordSiteLimit(store, 'kimi', '限流', at(16, 14))
    clearSiteLimit(store, 'kimi')
    expect(activeSiteLimit(store, 'kimi', at(16, 15))).toBeUndefined()
  })

  it('is used again once a prompt it took while marked gets a reply', () => {
    const store = createDefaultStore()
    recordSiteLimit(store, 'kimi', '限流', at(16, 14))
    // A reply to a prompt from before the mark says nothing about the limit.
    expect(takeSiteRecovery(store, 'kimi', 'role-a')).toBe(false)
    noteSiteTried(store, 'kimi', 'role-b', at(16, 15))
    expect(takeSiteRecovery(store, 'kimi', 'role-a')).toBe(false)
    expect(activeSiteLimit(store, 'kimi', at(16, 15))).toBeDefined()
    expect(takeSiteRecovery(store, 'kimi', 'role-b')).toBe(true)
    expect(activeSiteLimit(store, 'kimi', at(16, 15))).toBeUndefined()
    expect(store.siteUsageBySite?.kimi?.triedRoleIds).toBeUndefined()
  })

  it('is told by the site\'s own words, in Chinese or English', () => {
    for (const text of [
      'Kimi 没有发出这条消息（可能是使用额度用完或排队人数太多），请到 Kimi 页面查看',
      '今日对话次数已达上限',
      '请求过于频繁，请稍后再试',
      '429 Too Many Requests',
      'You\'ve reached our limit of messages per hour. Please try again later.',
      'You are out of free messages until 5:00 PM',
      'You\'ve reached your usage limit',
      'Rate limit exceeded',
    ]) expect(isSiteLimitMessage(text), text).toBe(true)
    for (const text of ['服务器繁忙，请稍后再试', 'Network error occurred', 'RESPONSE_NOT_FOUND', '回复超时', 'Limitations of this approach']) expect(isSiteLimitMessage(text), text).toBe(false)
  })

  it('is why a member is passed over, said with the times', () => {
    const limit = { limitedAt: at(16, 14, 5), limitedUntil: at(16, 17, 5), detail: '额度用完' }
    expect(siteLimitSkipReason('kimi', limit, at(16, 15), false)).toBe('Kimi 从 14:05 起在限流，这一轮没有发给它，17:05 后再发。已经恢复的话，在成员卡片上点「已恢复」。')
    expect(siteLimitSkipReason('kimi', { ...limit, limitedUntil: at(17, 1) }, at(16, 23), true)).toBe('Kimi has been rate-limiting since 14:05, so this round skipped it; it gets messages again after 11/17 01:00. If it has recovered, click "Recovered" on the member card.')
  })
})

describe('stored site use', () => {
  it('keeps only well-formed entries for known sites', () => {
    expect(normalizeSiteUsageRecord({
      kimi: { day: '2026-11-16', sent: 3, limitedAt: 5, limitedUntil: 9, limitDetail: 'x', limitCount: 3, triedRoleIds: ['a', 1] },
      chatgpt: { day: 7, sent: 1 },
      nowhere: { day: '2026-11-16', sent: 1 },
      gemini: { day: '2026-11-16', sent: -2 },
    })).toEqual({
      kimi: { day: '2026-11-16', sent: 3, limitedAt: 5, limitedUntil: 9, limitDetail: 'x', limitCount: 3, triedRoleIds: ['a'] },
      gemini: { day: '2026-11-16', sent: 0 },
    })
    expect(normalizeSiteUsageRecord('x')).toEqual({})
  })
})
