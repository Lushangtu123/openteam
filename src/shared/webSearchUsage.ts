// 联网搜索's use (src/shared/webSearch.ts): each Tavily search that came back is counted for its
// local day, the API model that made it and its group; a search from the settings' 测试 counts as a
// test. The 用量 window adds the days of a range up. What the Tavily account has used and may use
// in its billing cycle is read from Tavily itself (GET /usage, src/background/webSearcher.ts), so
// it includes what the key used before OpenTeam and elsewhere; the notice comes at 80% of it.
// About a year of days is kept.

export interface WebSearchDay {
  total: number
  // Group, then model: how many searches.
  byChat: Record<string, Record<string, number>>
  // Searches from the settings' 测试, in total too.
  tests?: number
}

// Tavily's answer to GET /usage, as last read: credits, for the current billing cycle.
export interface TavilyAccount {
  checkedAt: number
  // The account's plan.
  used: number
  limit?: number
  plan?: string
  // The key's own limit, when the user set one in Tavily.
  keyUsed?: number
  keyLimit?: number
}

export interface WebSearchUsage {
  // Local day, YYYY-MM-DD.
  days: Record<string, WebSearchDay>
  account?: TavilyAccount
  // Where the near-allowance notice was put away: it comes back at the limit, with another limit,
  // or once the count starts again in a new cycle.
  noticeDismissed?: { used: number; limit: number; reached?: true }
}

export interface SearchQuotaState {
  used: number
  limit: number
  share: number
  // Whose limit: the plan's, or the key's own when that is the nearer.
  scope: 'plan' | 'key'
  checkedAt: number
  // At NEAR_SHARE of the limit, or past it.
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

// The account's credits against its limit: the plan's, or the key's own when that is nearer.
// Undefined before Tavily was asked, or when it gives no limit.
export function searchQuotaState(usage: WebSearchUsage | undefined): SearchQuotaState | undefined {
  const account = usage?.account
  if (!account) return undefined
  const options: Array<{ used: number; limit: number; scope: 'plan' | 'key' }> = []
  if (account.limit) options.push({ used: account.used, limit: account.limit, scope: 'plan' })
  if (account.keyLimit) options.push({ used: account.keyUsed ?? 0, limit: account.keyLimit, scope: 'key' })
  const nearest = options.sort((left, right) => right.used / right.limit - left.used / left.limit)[0]
  if (!nearest) return undefined
  const share = Math.round(nearest.used / nearest.limit * 100) / 100
  return { ...nearest, share, checkedAt: account.checkedAt, ...(nearest.used >= nearest.limit * NEAR_SHARE ? { near: true as const } : {}), ...(nearest.used >= nearest.limit ? { reached: true as const } : {}) }
}

// Whether the near-allowance notice should show: near, and not put away at this point.
export function searchQuotaNoticeDue(usage: WebSearchUsage | undefined): SearchQuotaState | undefined {
  const state = searchQuotaState(usage)
  if (!state?.near) return undefined
  const dismissed = usage?.noticeDismissed
  if (dismissed && dismissed.limit === state.limit && state.used >= dismissed.used && (dismissed.reached || !state.reached)) return undefined
  return state
}

// Tavily's GET /usage answer, read; throws when it is not one.
export function readTavilyAccount(raw: unknown, now: number): TavilyAccount {
  const account = isRecord(raw) && isRecord(raw.account) ? raw.account : undefined
  const key = isRecord(raw) && isRecord(raw.key) ? raw.key : undefined
  if (!account && !key) throw new Error('Tavily 没有给出用量')
  const used = credit(account?.plan_usage) ?? credit(key?.usage) ?? 0
  const limit = credit(account?.plan_limit)
  const keyLimit = credit(key?.limit)
  const keyUsed = credit(key?.usage)
  const plan = typeof account?.current_plan === 'string' && account.current_plan.trim() ? account.current_plan.trim().slice(0, 60) : undefined
  return { checkedAt: now, used, ...(limit ? { limit } : {}), ...(plan ? { plan } : {}), ...(keyLimit ? { keyLimit, keyUsed: keyUsed ?? 0 } : {}) }
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
  const account = isRecord(raw.account) ? raw.account : undefined
  if (account && typeof account.checkedAt === 'number' && credit(account.used) !== undefined) {
    const limit = credit(account.limit)
    const keyLimit = credit(account.keyLimit)
    usage.account = {
      checkedAt: account.checkedAt,
      used: credit(account.used)!,
      ...(limit ? { limit } : {}),
      ...(typeof account.plan === 'string' && account.plan ? { plan: account.plan.slice(0, 60) } : {}),
      ...(keyLimit ? { keyLimit, keyUsed: credit(account.keyUsed) ?? 0 } : {}),
    }
  }
  const dismissed = isRecord(raw.noticeDismissed) ? raw.noticeDismissed : undefined
  if (dismissed && credit(dismissed.used) !== undefined && credit(dismissed.limit)) {
    usage.noticeDismissed = { used: credit(dismissed.used)!, limit: credit(dismissed.limit)!, ...(dismissed.reached === true ? { reached: true as const } : {}) }
  }
  return usage
}

function credit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
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
