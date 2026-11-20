// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { SiteCheckSchedule } from '../group/siteCheckSchedule'
import type { OpenTeamStore } from '../group/types'
import { currentSiteCheckScheduleDialog, openSiteCheckScheduleDialog } from './siteCheckScheduleDialog'

// 2026-11-16 is a Monday.
const NOW = new Date(2026, 10, 16, 8, 0).getTime()

function setup(schedule?: Partial<SiteCheckSchedule>, destinations = true) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  if (destinations) store.settings.resultDestinations = [{ id: 'dest-1', kind: 'feishu', name: '运维群', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x', createdAt: 0 }]
  if (schedule) store.settings.siteCheckSchedule = { days: [1], time: '09:00', enabled: true, armedAt: 0, ...schedule }
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const requestHostAccess = vi.fn(async (_url: string) => true)
  const dialog = openSiteCheckScheduleDialog({ getStore: () => store, runCommand, requestHostAccess, now: () => NOW })
  const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
  const days = () => [...document.querySelectorAll<HTMLInputElement>('.scheduled-task-day input')]
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.site-check-schedule-dialog button')].find(node => node.textContent?.trim() === label)!
  return { store, runCommand, requestHostAccess, dialog, $, days, button }
}

afterEach(() => {
  currentSiteCheckScheduleDialog()?.close()
})

describe('the 定时自检 window', () => {
  it('starts on every day at 09:00, switched on, sending nowhere', async () => {
    const ctx = setup()
    expect(ctx.$('#site-check-schedule-title').textContent).toBe('定时自检')
    expect(ctx.$('.site-check-schedule-status').textContent).toBe('还没有设置。')
    expect(ctx.$<HTMLInputElement>('#site-check-schedule-enabled').checked).toBe(true)
    expect(ctx.days().every(box => box.checked)).toBe(true)
    expect(ctx.$<HTMLInputElement>('#site-check-schedule-time').value).toBe('09:00')
    expect(ctx.$<HTMLSelectElement>('#site-check-schedule-destination').value).toBe('')

    ctx.$<HTMLSelectElement>('#site-check-schedule-destination').value = 'dest-1'
    ctx.button('保存').click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('SITE_CHECK_SCHEDULE_SAVE', { schedule: { days: [1, 2, 3, 4, 5, 6, 0], time: '09:00', enabled: true, destinationId: 'dest-1' } }))
  })

  it('shows what is set, the next time and how the last run went', () => {
    const ctx = setup({ days: [1, 3], time: '10:30', destinationId: 'dest-1', lastRun: { at: NOW - 3_600_000, status: 'problems', problems: [{ site: 'kimi', outcome: 'no-reply' }, { site: 'claude', outcome: 'login' }], delivery: { status: 'sent', at: NOW, destination: '运维群' } } })
    expect(ctx.days().filter(box => box.checked).map(box => box.value)).toEqual(['1', '3'])
    expect(ctx.$<HTMLInputElement>('#site-check-schedule-time').value).toBe('10:30')
    expect(ctx.$<HTMLSelectElement>('#site-check-schedule-destination').value).toBe('dest-1')
    const status = ctx.$('.site-check-schedule-status')
    expect(status.textContent).toMatch(/^每周一、三 10:30，下次：.+　上次：.+ 要处理：Kimi、Claude（检查用的群已保留）　已发送到「运维群」$/)
    expect(status.classList.contains('scheduled-task-failed')).toBe(true)
  })

  it('says it is off, and where to add a destination when there is none', () => {
    const ctx = setup({ enabled: false, lastRun: { at: NOW, status: 'ok' } }, false)
    expect(ctx.$('.site-check-schedule-status').textContent).toMatch(/^已停用　上次：.+ 全部正常$/)
    expect(ctx.$<HTMLInputElement>('#site-check-schedule-enabled').checked).toBe(false)
    expect(ctx.$('.scheduled-task-destination-field .tiny').textContent).toBe('还没有推送地址：在任意群聊的「定时任务」窗口里添加。')
  })

  it('wants a day, says why a save failed, and runs now', async () => {
    const ctx = setup()
    for (const box of ctx.days()) box.checked = false
    ctx.button('保存').click()
    expect(ctx.$('.team-form-error').textContent).toBe('至少选一天')
    expect(ctx.runCommand).not.toHaveBeenCalled()

    ctx.days()[0].checked = true
    ctx.runCommand.mockRejectedValueOnce(new Error('找不到这个推送地址'))
    ctx.button('保存').click()
    await vi.waitFor(() => expect(ctx.$('.team-form-error').textContent).toBe('找不到这个推送地址'))

    ctx.button('立即运行').click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('SITE_CHECK_SCHEDULE_RUN', undefined))
    expect(ctx.button('立即运行').querySelector('svg')).not.toBeNull()
  })

  it('leaves the buttons as they are while saving, so 立即运行 does not flash, and takes one click at a time', async () => {
    const ctx = setup()
    let finish = () => {}
    ctx.runCommand.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
    const runNow = ctx.button('立即运行')
    const save = ctx.button('保存')
    const seen: boolean[] = []
    const watch = new MutationObserver(() => seen.push(runNow.disabled, save.disabled))
    watch.observe(document.querySelector('.site-check-schedule-dialog')!, { attributes: true, subtree: true })
    save.click()
    runNow.click()
    save.click()
    expect(runNow.disabled).toBe(false)
    expect(save.disabled).toBe(false)
    finish()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    watch.disconnect()
    expect(seen.every(disabled => !disabled)).toBe(true)
    expect(ctx.runCommand).toHaveBeenCalledTimes(1)
    runNow.click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledTimes(2))
  })

  it('says a save worked and when the next check is, until something is changed again', async () => {
    const ctx = setup()
    const saved = () => ctx.$('.site-check-schedule-saved')
    expect(saved().hidden).toBe(true)
    // The background stores it; the window shows what it was told.
    ctx.runCommand.mockImplementationOnce(async (_type, payload) => {
      ctx.store.settings.siteCheckSchedule = { ...(payload!.schedule as SiteCheckSchedule), armedAt: NOW }
      return undefined
    })
    ctx.button('保存').click()
    await vi.waitFor(() => expect(saved().hidden).toBe(false))
    expect(saved().textContent).toMatch(/^已保存，下次检查：.+ 09:00$/)
    expect(saved().querySelector('svg')).not.toBeNull()
    expect(saved().getAttribute('role')).toBe('status')

    ctx.$<HTMLInputElement>('#site-check-schedule-enabled').click()
    expect(saved().hidden).toBe(true)

    ctx.runCommand.mockImplementationOnce(async (_type, payload) => {
      ctx.store.settings.siteCheckSchedule = { ...(payload!.schedule as SiteCheckSchedule), armedAt: NOW }
      return undefined
    })
    ctx.button('保存').click()
    await vi.waitFor(() => expect(saved().textContent).toBe('已保存，定时自检已停用'))

    ctx.runCommand.mockRejectedValueOnce(new Error('找不到这个推送地址'))
    ctx.button('保存').click()
    await vi.waitFor(() => expect(ctx.$('.team-form-error').textContent).toBe('找不到这个推送地址'))
    expect(saved().hidden).toBe(true)
  })

  it('keeps what is being typed when the store updates, and closes with Esc', () => {
    const ctx = setup({ time: '09:00' })
    ctx.$<HTMLInputElement>('#site-check-schedule-time').value = '11:11'
    ctx.store.settings.siteCheckSchedule!.lastRun = { at: NOW, status: 'ok' }
    ctx.dialog.refresh()
    expect(ctx.$<HTMLInputElement>('#site-check-schedule-time').value).toBe('11:11')
    expect(ctx.$('.site-check-schedule-status').textContent).toContain('全部正常')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.site-check-schedule-dialog')).toBeNull()
    expect(currentSiteCheckScheduleDialog()).toBeUndefined()
  })

  it('sends a test message to the chosen destination, asking for the site\'s access from the click', async () => {
    const ctx = setup()
    const status = () => ctx.$('.site-check-schedule-test-status').textContent
    ctx.button('测试推送').click()
    expect(status()).toBe('先选一个推送地址。')
    expect(ctx.runCommand).not.toHaveBeenCalled()

    ctx.$<HTMLSelectElement>('#site-check-schedule-destination').value = 'dest-1'
    ctx.button('测试推送').click()
    // Asked in the click itself: the browser shows its prompt only then.
    expect(ctx.requestHostAccess).toHaveBeenCalledWith('https://open.feishu.cn/open-apis/bot/v2/hook/x')
    expect(status()).toBe('正在发送…')
    await vi.waitFor(() => expect(status()).toBe('测试消息已发到「运维群」，去那里看看收到没有。'))
    expect(ctx.runCommand).toHaveBeenCalledWith('SITE_CHECK_SCHEDULE_TEST', { destinationId: 'dest-1' })

    ctx.runCommand.mockRejectedValueOnce(new Error('没发出去：HTTP 404'))
    ctx.button('测试推送').click()
    await vi.waitFor(() => expect(status()).toBe('没发出去：HTTP 404'))

    ctx.runCommand.mockClear()
    ctx.requestHostAccess.mockResolvedValueOnce(false)
    ctx.button('测试推送').click()
    await vi.waitFor(() => expect(status()).toBe('需要你允许 OpenTeam 访问 open.feishu.cn，才能往这里推送。'))
    expect(ctx.runCommand).not.toHaveBeenCalled()
  })

  it('asks for the destination\'s access as it saves, and says when it was not given', async () => {
    const ctx = setup()
    ctx.$<HTMLSelectElement>('#site-check-schedule-destination').value = 'dest-1'
    ctx.requestHostAccess.mockResolvedValueOnce(false)
    ctx.button('保存').click()
    expect(ctx.requestHostAccess).toHaveBeenCalledWith('https://open.feishu.cn/open-apis/bot/v2/hook/x')
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('SITE_CHECK_SCHEDULE_SAVE', expect.anything()))
    await vi.waitFor(() => expect(ctx.$('.team-form-error').textContent).toBe('已保存，但没有允许 OpenTeam 访问 open.feishu.cn，有网站要处理时会发不出去。点「测试推送」可以再允许一次。'))

    ctx.requestHostAccess.mockClear()
    ctx.$<HTMLSelectElement>('#site-check-schedule-destination').value = ''
    ctx.button('保存').click()
    await vi.waitFor(() => expect(ctx.$('.site-check-schedule-saved').hidden).toBe(false))
    expect(ctx.requestHostAccess).not.toHaveBeenCalled()
    expect(ctx.$('.team-form-error').textContent).toBe('')
  })
})
