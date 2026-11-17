import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearRecentLogs, createLogger, recentLogs, type RecentLogEntry } from '../shared/logger'
import { DIAGNOSTICS_LOGS_KEY, keepLogsAcrossRestarts } from './diagnosticsLogs'

afterEach(() => {
  clearRecentLogs()
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
