// The background's kept log (logger.ts recentLogs), read from the command line (openteamcli logs):
// the entries that match some words, a level, a recent stretch of time, the last few. The entries
// were cleaned when they were kept, so nothing here needs taking out.
import { LOG_BUFFER_SIZE, type RecentLogEntry } from './logger'

export interface LogQuery {
  search?: string
  // warn: warnings and errors; error: errors only.
  level?: 'warn' | 'error'
  withinMs?: number
  limit?: number
}

export interface LogQueryResult {
  // Entries kept in all.
  total: number
  entries: Array<{ time: string; level: RecentLogEntry['level']; scope: string; event: string; details: RecentLogEntry['details'] }>
}

const DEFAULT_LIMIT = 100

export function readLogQuery(value: unknown): LogQuery {
  if (typeof value !== 'object' || value === null) return {}
  const input = value as Record<string, unknown>
  const search = typeof input.search === 'string' ? input.search.trim() : ''
  const level = input.level === 'warn' || input.level === 'error' ? input.level : undefined
  const withinMs = typeof input.withinMs === 'number' && input.withinMs > 0 ? input.withinMs : undefined
  const limit = typeof input.limit === 'number' && input.limit >= 1 ? Math.min(Math.floor(input.limit), LOG_BUFFER_SIZE) : undefined
  return { ...(search ? { search } : {}), ...(level ? { level } : {}), ...(withinMs ? { withinMs } : {}), ...(limit ? { limit } : {}) }
}

export function queryLogs(entries: RecentLogEntry[], query: LogQuery, now: number): LogQueryResult {
  const words = query.search?.toLowerCase()
  const matching = entries.filter(entry => {
    if (query.level === 'error' && entry.level !== 'error') return false
    if (query.level === 'warn' && entry.level === 'info') return false
    if (query.withinMs !== undefined && entry.at < now - query.withinMs) return false
    if (words && !`${entry.scope} ${entry.event} ${JSON.stringify(entry.details)}`.toLowerCase().includes(words)) return false
    return true
  })
  return {
    total: entries.length,
    entries: matching.slice(-(query.limit ?? DEFAULT_LIMIT)).map(entry => ({ time: new Date(entry.at).toISOString(), level: entry.level, scope: entry.scope, event: entry.event, details: entry.details })),
  }
}
