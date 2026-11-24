import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRecentLogs, createLogger, recentLogs, type RecentLogEntry } from '../shared/logger'
import { DIAGNOSTICS_LOGS_KEY, PROBLEM_LOGS_KEY, PROBLEM_LOGS_MAX, backgroundLogs, forgetProblemLogs, keepLogsAcrossRestarts, keepProblemLogs } from './diagnosticsLogs'

afterEach(() => {
  clearRecentLogs()
  forgetProblemLogs()
  vi.useRealTimers()
})

function sessionStorage(saved?: RecentLogEntry[]) {
  const data: Record<string, unknown> = saved ? { [DIAGNOSTICS_LOGS_KEY]: saved } : {}
  return {
    data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items) }),
  }
}

describe('keeping the background logs across restarts', () => {
  it('puts back what was saved before the restart, in front of what came since', async () => {
    const log = createLogger('background', {}, { debugEnabled: false })
    log.info('after-restart')
    const storage = sessionStorage([{ at: 1, level: 'warn', scope: 'background', event: 'before-restart', details: {} }])
    await keepLogsAcrossRestarts(storage)
    expect(recentLogs().map(entry => entry.event)).toEqual(['before-restart', 'after-restart'])
  })

  it('saves new entries a moment later, in one write for a burst', async () => {
    vi.useFakeTimers()
    const storage = sessionStorage()
    await keepLogsAcrossRestarts(storage)
    const log = createLogger('background', {}, { debugEnabled: false })
    log.info('one')
    log.info('two')
    expect(storage.set).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(storage.set).toHaveBeenCalledTimes(1)
    expect((storage.data[DIAGNOSTICS_LOGS_KEY] as RecentLogEntry[]).map(entry => entry.event)).toEqual(['one', 'two'])
  })

  it('ignores a saved value that is not a list of entries', async () => {
    const storage = sessionStorage()
    storage.data[DIAGNOSTICS_LOGS_KEY] = 'broken'
    await keepLogsAcrossRestarts(storage)
    expect(recentLogs()).toEqual([])
  })

  it('does nothing without session storage', async () => {
    await expect(keepLogsAcrossRestarts(undefined)).resolves.toBeUndefined()
  })
})

const DAY = 24 * 3600_000

function localStorage(saved?: RecentLogEntry[]) {
  const data: Record<string, unknown> = saved ? { [PROBLEM_LOGS_KEY]: saved } : {}
  return {
    data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items) }),
  }
}

describe('keeping warnings and errors for a week', () => {
  it('keeps each warning and error in local storage, which a reload of the extension or the browser does not clear, and not the rest', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * DAY)
    const storage = localStorage()
    await keepProblemLogs(storage)
    const log = createLogger('background', {}, { debugEnabled: false })
    log.info('ordinary')
    // A step that went well, logged as a warning to follow deliveries: not a problem to keep.
    log.warn('orchestration-diagnostic:delivery-attempt', { chatId: 'c' })
    log.warn('site-fault:noticed', { site: 'kimi' })
    log.error('broke', { apiKey: 'sk-secret' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(storage.set).toHaveBeenCalledTimes(1)
    const kept = storage.data[PROBLEM_LOGS_KEY] as RecentLogEntry[]
    expect(kept.map(entry => entry.event)).toEqual(['site-fault:noticed', 'broke'])
    // Cleaned as every kept entry is: no key.
    expect(JSON.stringify(kept)).not.toContain('sk-secret')
  })

  it('puts back the last week\'s after a restart, the older ones and the ones over the limit gone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * DAY)
    const entry = (at: number, event: string): RecentLogEntry => ({ at, level: 'warn', scope: 'background', event, details: {} })
    const many = Array.from({ length: PROBLEM_LOGS_MAX + 5 }, (_, index) => entry(9 * DAY + index, `w${index}`))
    const storage = localStorage([entry(2 * DAY, 'eight days ago'), ...many])
    await keepProblemLogs(storage)
    const logs = backgroundLogs()
    expect(logs.some(item => item.event === 'eight days ago')).toBe(false)
    expect(logs).toHaveLength(PROBLEM_LOGS_MAX)
    expect(logs[0].event).toBe('w5')
  })

  it('gives the background\'s logs with the week\'s warnings and errors in front of the recent entries, each once, in time order', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10 * DAY)
    const earlier: RecentLogEntry = { at: 10 * DAY - 3600_000, level: 'error', scope: 'background', event: 'this morning', details: {} }
    await keepProblemLogs(localStorage([earlier]))
    const log = createLogger('background', {}, { debugEnabled: false })
    log.info('now')
    log.warn('now too')
    expect(backgroundLogs().map(entry => entry.event)).toEqual(['this morning', 'now', 'now too'])
  })

  it('does nothing without local storage, and gives the recent entries', async () => {
    await expect(keepProblemLogs(undefined)).resolves.toBeUndefined()
    createLogger('background', {}, { debugEnabled: false }).warn('only')
    expect(backgroundLogs().map(entry => entry.event)).toEqual(['only'])
  })
})
