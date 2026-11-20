import { describe, expect, it } from 'vitest'
import { normalizeSiteCheckSchedule, readSiteCheckScheduleInput, siteCheckReport } from './siteCheckSchedule'
import type { SiteCheckResult } from './siteCheck'

describe('定时自检\'s settings', () => {
  it('takes days, a time, whether it is on, and where problems go', () => {
    expect(readSiteCheckScheduleInput({ days: [5, 1, 3], time: '08:30', enabled: true, destinationId: 'dest-1' })).toEqual({ days: [1, 3, 5], time: '08:30', enabled: true, destinationId: 'dest-1' })
    expect(readSiteCheckScheduleInput({ days: [0], time: '23:59', enabled: false, destinationId: '' })).toEqual({ days: [0], time: '23:59', enabled: false })
    expect(() => readSiteCheckScheduleInput({ days: [], time: '08:30' })).toThrow('至少选一天')
    expect(() => readSiteCheckScheduleInput({ days: [1], time: '8:30' })).toThrow('24 小时制')
  })

  it('reads back what was stored, and nothing that is not a schedule', () => {
    const stored = {
      days: [1, 2], time: '09:00', enabled: true, destinationId: 'dest-1', armedAt: 5, lastSlotAt: 9,
      lastRun: { at: 10, status: 'problems', slotAt: 9, chatId: 'chat-1', problems: [{ site: 'kimi', outcome: 'no-reply' }, { site: 'nosuch', outcome: 'ok' }], delivery: { status: 'sent', at: 11, destination: '飞书' } },
    }
    expect(normalizeSiteCheckSchedule(stored)).toEqual({ ...stored, lastRun: { ...stored.lastRun, problems: [{ site: 'kimi', outcome: 'no-reply' }] } })
    expect(normalizeSiteCheckSchedule({ days: [9], time: '09:00' })).toBeUndefined()
    expect(normalizeSiteCheckSchedule('x')).toBeUndefined()
    expect(normalizeSiteCheckSchedule({ days: [1], time: '09:00', lastRun: { at: 1, status: 'weird' } })).toEqual({ days: [1], time: '09:00', enabled: true, armedAt: 0 })
  })
})

describe('what a 定时自检 sends', () => {
  it('lists the sites that need attention, with what to do', () => {
    const results: SiteCheckResult[] = [
      { roleId: 'r1', site: 'chatgpt', label: 'ChatGPT', outcome: 'ok' },
      { roleId: 'r2', site: 'kimi', label: 'Kimi', outcome: 'no-reply' },
      { roleId: 'r3', site: 'claude', label: 'Claude', outcome: 'login' },
    ]
    const report = siteCheckReport(results, '每天 09:00', false)
    expect(report).toMatchObject({ chatName: '网站自检', schedule: '每天 09:00', question: '3 个网站里有 2 个需要处理，其余正常。' })
    expect(report.answers.map(answer => answer.member)).toEqual(['Kimi', 'Claude'])
    expect(report.answers[0]).toMatchObject({ failed: true, text: expect.stringContaining('网站可能改版了') })
    expect(siteCheckReport(results, '', true).question).toBe('2 of 3 sites need attention; the others work.')
  })
})
