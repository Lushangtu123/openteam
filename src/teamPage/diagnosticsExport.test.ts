// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultStore } from '../group/store'
import { clearRecentLogs, createLogger } from '../shared/logger'
import { exportDiagnostics } from './diagnosticsExport'

afterEach(() => clearRecentLogs())

describe('exporting diagnostics', () => {
  it('builds the report from the store, the background logs and the page logs, and saves it as a file', async () => {
    const store = createDefaultStore()
    createLogger('team-page', {}, { debugEnabled: false }).warn('render:slow', { ms: 900 })
    const saved: Array<{ name: string; text: string }> = []

    const report = await exportDiagnostics({
      getStore: () => store,
      extensionVersion: '1.5.0',
      userAgent: 'Chrome/156',
      now: () => new Date(2026, 10, 17, 9, 5).getTime(),
      getBackgroundLogs: async () => [{ at: 1, level: 'error', scope: 'background', event: 'send:failed', details: {} }],
      getUpdateState: async () => ({ enabled: true }),
      save: (name, text) => { saved.push({ name, text }) },
    })

    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('openteam-diagnostics-20261117-0905.json')
    const parsed = JSON.parse(saved[0].text)
    expect(parsed).toEqual(report)
    expect(parsed.extensionVersion).toBe('1.5.0')
    expect(parsed.backgroundLogs.map((entry: { event: string }) => entry.event)).toEqual(['send:failed'])
    expect(parsed.pageLogs.map((entry: { event: string }) => entry.event)).toEqual(['render:slow'])
  })

  it('still exports when the background cannot be reached, and says so', async () => {
    const saved: string[] = []
    await exportDiagnostics({
      getStore: () => createDefaultStore(),
      extensionVersion: '1.5.0',
      userAgent: 'Chrome/156',
      now: () => 0,
      getBackgroundLogs: async () => { throw new Error('Could not establish connection') },
      getUpdateState: async () => undefined,
      save: (_name, text) => { saved.push(text) },
    })
    const parsed = JSON.parse(saved[0])
    expect(parsed.backgroundLogs).toEqual([])
    expect(parsed.backgroundLogsError).toBe('Could not establish connection')
  })
})
