// 网站额度提醒: how much each AI site was used today, and whether it is limiting OpenTeam. Sites do
// not say how many messages they take, so OpenTeam counts the prompts each site took each day (all
// of its members together), and notes when a site says it is limiting. From then on, for
// SITE_LIMIT_COOLDOWN_MS, its members are not sent prompts: their backup answers, if they have one,
// and summaries and discussion turns go to others. The count the site had reached is kept, and on
// later days reaching NEAR_LIMIT_SHARE of it is shown on its members' cards.
import { CHAT_SITES, chatSiteLabel, type ChatSite } from './chatSites'
import type { OpenTeamStore } from './types'

export const SITE_LIMIT_COOLDOWN_MS = 3 * 60 * 60 * 1000
const NEAR_LIMIT_SHARE = 0.8
// A site limiting after fewer prompts than this that day was used elsewhere too, or limits by
// something else than a count: its count is not kept.
const MIN_LEARNED_LIMIT = 5
const LIMIT_DETAIL_MAX = 160

export interface SiteUsage {
  // The local day `sent` is for (YYYY-MM-DD).
  day: string
  // Prompts the site took that day.
  sent: number
  // The site said it is limiting: when, and what it said.
  limitedAt?: number
  limitDetail?: string
  // Until when its members are not sent prompts.
  limitedUntil?: number
  // How many prompts it had taken that day when it last said so, if at least MIN_LEARNED_LIMIT (kept
  // across days).
  limitCount?: number
  // Members whose prompt the site took while it was marked: a reply from one means it recovered.
  triedRoleIds?: string[]
}

export type SiteUsageRecord = Partial<Record<ChatSite, SiteUsage>>

export interface SiteLimit {
  limitedAt: number
  limitedUntil: number
  detail?: string
}

export interface SiteUsageToday {
  sent: number
  limitCount?: number
  nearLimit?: boolean
}

// The site's own words for limiting: a usage cap, too many requests, out of messages.
const SITE_LIMIT_TEXT = /额度[^，。,.]{0,4}用完|(?:次数|用量|额度|配额)[^，。,.]{0,6}(?:上限|用完|用尽)|达到[^，。,.]{0,6}上限|限流|过于频繁|操作频繁|too many requests|\b429\b|rate[ -]?limit|usage limit|message limit|reached (?:\w+ ){0,3}limit|out of (?:free )?messages|limit (?:reached|exceeded)/i

export function isSiteLimitMessage(text: string | undefined): boolean {
  return Boolean(text && SITE_LIMIT_TEXT.test(text))
}

export function siteUsageToday(store: OpenTeamStore, site: ChatSite, now: number): SiteUsageToday {
  const usage = store.siteUsageBySite?.[site]
  const sent = usage?.day === localDay(now) ? usage.sent : 0
  const limitCount = usage?.limitCount
  if (!limitCount) return { sent }
  return { sent, limitCount, ...(sent >= Math.ceil(limitCount * NEAR_LIMIT_SHARE) ? { nearLimit: true } : {}) }
}

// The site took a prompt.
export function recordSiteSent(store: OpenTeamStore, site: ChatSite, now: number): void {
  const usage = usageFor(store, site, now)
  usage.sent += 1
}

// The site said it is limiting. Resolves to whether that starts a new mark (a site already marked
// keeps the time it was first marked).
export function recordSiteLimit(store: OpenTeamStore, site: ChatSite, detail: string, now: number): boolean {
  if (activeSiteLimit(store, site, now)) return false
  const usage = usageFor(store, site, now)
  usage.limitedAt = now
  usage.limitedUntil = now + SITE_LIMIT_COOLDOWN_MS
  const trimmed = detail.trim().slice(0, LIMIT_DETAIL_MAX)
  if (trimmed) usage.limitDetail = trimmed
  else delete usage.limitDetail
  if (usage.sent >= MIN_LEARNED_LIMIT) usage.limitCount = usage.sent
  delete usage.triedRoleIds
  return true
}

export function clearSiteLimit(store: OpenTeamStore, site: ChatSite): void {
  const usage = store.siteUsageBySite?.[site]
  if (!usage) return
  delete usage.limitedAt
  delete usage.limitedUntil
  delete usage.limitDetail
  delete usage.triedRoleIds
}

export function activeSiteLimit(store: OpenTeamStore, site: ChatSite, now: number): SiteLimit | undefined {
  const usage = store.siteUsageBySite?.[site]
  if (usage?.limitedAt === undefined || usage.limitedUntil === undefined || usage.limitedUntil <= now) return undefined
  return { limitedAt: usage.limitedAt, limitedUntil: usage.limitedUntil, ...(usage.limitDetail ? { detail: usage.limitDetail } : {}) }
}

// The marked site took a member's prompt anyway (the user sent it again by hand).
export function noteSiteTried(store: OpenTeamStore, site: ChatSite, roleId: string, now: number): void {
  if (!activeSiteLimit(store, site, now)) return
  const usage = store.siteUsageBySite![site]!
  if (!usage.triedRoleIds?.includes(roleId)) usage.triedRoleIds = [...(usage.triedRoleIds ?? []), roleId]
}

// A member on the site replied: when the site took its prompt while marked, the site recovered and
// the mark goes. Resolves to whether it went.
export function takeSiteRecovery(store: OpenTeamStore, site: ChatSite, roleId: string): boolean {
  if (!store.siteUsageBySite?.[site]?.triedRoleIds?.includes(roleId)) return false
  clearSiteLimit(store, site)
  return true
}

// Why a member was not sent this round's message.
export function siteLimitSkipReason(site: ChatSite, limit: SiteLimit, now: number, english: boolean): string {
  const label = chatSiteLabel(site)
  const since = clockTime(limit.limitedAt, now, english)
  const until = clockTime(limit.limitedUntil, now, english)
  return english
    ? `${label} has been rate-limiting since ${since}, so this round skipped it; it gets messages again after ${until}. If it has recovered, click "Recovered" on the member card.`
    : `${label} 从 ${since} 起在限流，这一轮没有发给它，${until} 后再发。已经恢复的话，在成员卡片上点「已恢复」。`
}

// The time of day, with the date when it is not today.
export function clockTime(time: number, now: number, english: boolean): string {
  const date = new Date(time)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (localDay(time) === localDay(now)) return clock
  return english ? `${date.getMonth() + 1}/${date.getDate()} ${clock}` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

export function normalizeSiteUsageRecord(raw: unknown): SiteUsageRecord {
  const result: SiteUsageRecord = {}
  if (!isRecord(raw)) return result
  for (const site of CHAT_SITES) {
    const value = raw[site]
    if (!isRecord(value) || typeof value.day !== 'string' || typeof value.sent !== 'number') continue
    const usage: SiteUsage = { day: value.day, sent: Math.max(0, Math.floor(value.sent)) }
    if (typeof value.limitedAt === 'number') usage.limitedAt = value.limitedAt
    if (typeof value.limitedUntil === 'number') usage.limitedUntil = value.limitedUntil
    if (typeof value.limitDetail === 'string') usage.limitDetail = value.limitDetail
    if (typeof value.limitCount === 'number' && value.limitCount > 0) usage.limitCount = Math.floor(value.limitCount)
    if (Array.isArray(value.triedRoleIds)) {
      const ids = value.triedRoleIds.filter((id): id is string => typeof id === 'string')
      if (ids.length > 0) usage.triedRoleIds = ids
    }
    result[site] = usage
  }
  return result
}

// The site's entry, its count started again on a new day.
function usageFor(store: OpenTeamStore, site: ChatSite, now: number): SiteUsage {
  const record = store.siteUsageBySite ??= {}
  const today = localDay(now)
  const usage = record[site] ??= { day: today, sent: 0 }
  if (usage.day !== today) {
    usage.day = today
    usage.sent = 0
  }
  return usage
}

function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
