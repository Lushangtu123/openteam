import { describe, expect, it } from 'vitest'
import type { RecentLogEntry } from './logger'
import { queryLogs, readLogQuery } from './logQuery'

const AT = new Date(2026, 10, 21, 9).getTime()
const entry = (minutesAgo: number, level: RecentLogEntry['level'], event: string, details: Record<string, unknown> = {}): RecentLogEntry => ({ at: AT - minutesAgo * 60_000, level, scope: 'background', event, details })

const LOG: RecentLogEntry[] = [
  entry(120, 'info', 'external-model:send:start', { modelId: 'm1' }),
  entry(50, 'warn', 'external-model:fallback', { mainModel: 'gemini-flash-latest', reason: 'HTTP 503：busy' }),
  entry(30, 'error', 'message-handler:failed', { type: 'LIBRARY_ADD_URL', error: 'HTTP 403' }),
  entry(5, 'info', 'library-refresh:failed', { error: '网站拒绝了后台读取（HTTP 403）' }),
]

describe('reading the background log', () => {
  it('gives the newest entries last, with their time written out', () => {
    const result = queryLogs(LOG, {}, AT)
    expect(result.total).toBe(4)
    expect(result.entries.map(item => item.event)).toEqual(['external-model:send:start', 'external-model:fallback', 'message-handler:failed', 'library-refresh:failed'])
    expect(result.entries[0]).toEqual({ time: new Date(AT - 120 * 60_000).toISOString(), level: 'info', scope: 'background', event: 'external-model:send:start', details: { modelId: 'm1' } })
  })

  it('keeps what matches the words, in the event or its details, any case', () => {
    expect(queryLogs(LOG, { search: 'FALLBACK' }, AT).entries.map(item => item.event)).toEqual(['external-model:fallback'])
    expect(queryLogs(LOG, { search: '403' }, AT).entries.map(item => item.event)).toEqual(['message-handler:failed', 'library-refresh:failed'])
  })

  it('keeps warnings and errors, or errors only', () => {
    expect(queryLogs(LOG, { level: 'warn' }, AT).entries.map(item => item.level)).toEqual(['warn', 'error'])
    expect(queryLogs(LOG, { level: 'error' }, AT).entries.map(item => item.level)).toEqual(['error'])
  })

  it('keeps the recent ones, and the last few', () => {
    expect(queryLogs(LOG, { withinMs: 40 * 60_000 }, AT).entries.map(item => item.event)).toEqual(['message-handler:failed', 'library-refresh:failed'])
    const last = queryLogs(LOG, { limit: 1 }, AT)
    expect(last.entries.map(item => item.event)).toEqual(['library-refresh:failed'])
    expect(last.total).toBe(4)
  })

  it('reads the query it is sent, leaving out what is not one', () => {
    expect(readLogQuery({ search: ' 403 ', level: 'warn', withinMs: 600_000, limit: 20 })).toEqual({ search: '403', level: 'warn', withinMs: 600_000, limit: 20 })
    expect(readLogQuery({ search: '', level: 'debug', withinMs: -1, limit: 0 })).toEqual({})
    expect(readLogQuery({ limit: 9999 })).toEqual({ limit: 400 })
    expect(readLogQuery('nonsense')).toEqual({})
  })
})
