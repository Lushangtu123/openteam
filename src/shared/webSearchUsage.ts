// 联网搜索's use (src/shared/webSearch.ts): each Tavily search that came back is counted for its
// local day, the API model that made it and its group; a search from the settings' 测试 counts as a
// test. The 用量 window adds the days of a range up, and the month's count is held against the
// allowance the user entered (Tavily counts its credits by the user's own plan; this is the
// calendar month here). About a year of days is kept.

export interface WebSearchDay {
  total: number
  // Group, then model: how many searches.
  byChat: Record<string, Record<string, number>>
  // Searches from the settings' 测试, in total too.
  tests?: number
}

export interface WebSearchUsage {
  // Local day, YYYY-MM-DD.
  days: Record<string, WebSearchDay>
  // The month (YYYY-MM) whose near-allowance notice was put away.
  noticeMonth?: string
}

export interface SearchQuotaState {
  used: number
  limit?: number
  share?: number
  // At NEAR_SHARE of the allowance, or past it.
  near?: true
  reached?: true
}

const KEEP_DAYS = 400
const NEAR_SHARE = 0.8
const DAY_MS = 24 * 60 * 60 * 1000

export function recordWebSearch(usage: WebSearchUsage, from: { modelId?: string; chatId?: string; test?: boolean }, now: number): void {
  const key = localDay(now)
  const day = usage.days[key] ??= { total: 0, byChat: {} }
  day.total += 1
  if (from.test) day.tests = (day.tests ?? 0) + 1
  if (from.chatId && from.modelId) {
    const models = day.byChat[from.chatId] ??= {}
    models[from.modelId] = (models[from.modelId] ?? 0) + 1
  }
  const oldest = localDay(now - KEEP_DAYS * DAY_MS)
  for (const name of Object.keys(usage.days)) if (name < oldest) delete usage.days[name]
}

// The searches from `start` to `end`: all of them, or one group's (its models' searches there).
export function searchesInRange(usage: WebSearchUsage | undefined, start: number, end: number, chatId?: string): { total: number; byModel: Record<string, number>; tests: number } {
  const from = localDay(start)
  const to = localDay(end)
  const result = { total: 0, byModel: {} as Record<string, number>, tests: 0 }
  for (const [name, day] of Object.entries(usage?.days ?? {})) {
    if (name < from || name > to) continue
    if (!chatId) {
      result.total += day.total
      result.tests += day.tests ?? 0
    }
    for (const [chat, models] of Object.entries(day.byChat)) {
      if (chatId && chat !== chatId) continue
      for (const [modelId, count] of Object.entries(models)) {
        result.byModel[modelId] = (result.byModel[modelId] ?? 0) + count
        if (chatId) result.total += count
      }
    }
  }
  return result
}

export function monthSearches(usage: WebSearchUsage | undefined, now: number): number {
  const month = localDay(now).slice(0, 7)
  return Object.entries(usage?.days ?? {}).reduce((sum, [name, day]) => name.startsWith(month) ? sum + day.total : sum, 0)
}

export function searchQuotaState(usage: WebSearchUsage | undefined, limit: number | undefined, now: number): SearchQuotaState {
  const used = monthSearches(usage, now)
  if (!limit) return { used }
  const share = Math.round(used / limit * 100) / 100
  return { used, limit, share, ...(share >= NEAR_SHARE ? { near: true as const } : {}), ...(used >= limit ? { reached: true as const } : {}) }
}

export function currentMonth(now: number): string {
  return localDay(now).slice(0, 7)
}

export function normalizeWebSearchUsage(raw: unknown): WebSearchUsage {
  const usage: WebSearchUsage = { days: {} }
  if (!isRecord(raw)) return usage
  for (const [name, value] of Object.entries(isRecord(raw.days) ? raw.days : {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || !isRecord(value) || typeof value.total !== 'number' || value.total < 0) continue
    usage.days[name] = {
      total: Math.floor(value.total),
      byChat: isRecord(value.byChat) ? Object.fromEntries(Object.entries(value.byChat).flatMap(([chat, models]) => isRecord(models) ? [[chat, counts(models)]] : [])) : {},
      ...(typeof value.tests === 'number' && value.tests > 0 ? { tests: Math.floor(value.tests) } : {}),
    }
  }
  if (typeof raw.noticeMonth === 'string' && /^\d{4}-\d{2}$/.test(raw.noticeMonth)) usage.noticeMonth = raw.noticeMonth
  return usage
}

function counts(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).flatMap(([key, value]) => typeof value === 'number' && value > 0 ? [[key, Math.floor(value)]] : []))
}

function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
