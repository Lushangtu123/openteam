// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { SiteCheckRun } from '../group/siteCheckSchedule'
import type { OpenTeamStore } from '../group/types'
import { createSiteCheckDeliveryNotice } from './siteCheckDeliveryNotice'

function setup(lastRun?: SiteCheckRun, language: 'en' | 'zh-CN' = 'zh-CN') {
  document.body.innerHTML = '<div id="site-check-delivery-notice" hidden></div>'
  const store: OpenTeamStore = createDefaultStore()
  store.settings.siteCheckSchedule = { days: [1], time: '09:00', enabled: true, armedAt: 0, destinationId: 'dest-1', ...(lastRun ? { lastRun } : {}) }
  const openSchedule = vi.fn()
  const runCommand = vi.fn(async () => undefined)
  const showError = vi.fn()
  const notice = createSiteCheckDeliveryNotice({ element: document.getElementById('site-check-delivery-notice'), language: () => language, getStore: () => store, openSchedule, runCommand, showError })
  notice.render()
  const box = () => document.getElementById('site-check-delivery-notice')!
  const buttons = () => [...box().querySelectorAll('button')]
  return { store, notice, openSchedule, runCommand, showError, box, buttons }
}

const failed: SiteCheckRun = { at: 5, status: 'problems', problems: [{ site: 'kimi', outcome: 'no-reply' }], delivery: { status: 'failed', at: 6, destination: 'open team', detail: '没有访问 discord.com 的权限' } }

describe('the notice that a scheduled site check\'s result was not sent', () => {
  it('says where it did not go and why, with a way to the window and a way to put it away', async () => {
    const ctx = setup(failed)
    expect(ctx.box().hidden).toBe(false)
    expect(ctx.box().querySelector('p')?.textContent).toBe('定时自检发现 Kimi 要处理，但没发到「open team」：没有访问 discord.com 的权限')
    expect(ctx.buttons().map(node => node.textContent)).toEqual(['打开定时自检', '知道了'])
    ctx.buttons()[0].click()
    expect(ctx.openSchedule).toHaveBeenCalledTimes(1)
    ctx.buttons()[1].click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('SITE_CHECK_NOTICE_DISMISS'))
  })

  it('says so for a check that could not run, and in English', () => {
    const ctx = setup({ at: 5, status: 'failed', detail: 'x', delivery: { status: 'failed', at: 6, destination: 'ops', detail: 'HTTP 404' } }, 'en')
    expect(ctx.box().querySelector('p')?.textContent).toBe('The scheduled site check could not run, and that was not sent to "ops": HTTP 404')
  })

  it('stays hidden when the result went, nothing was sent, or it was put away', () => {
    for (const run of [undefined, { ...failed, delivery: { status: 'sent' as const, at: 6, destination: 'open team' } }, { at: 5, status: 'ok' as const }, { ...failed, noticeDismissed: true }]) {
      expect(setup(run).box().hidden).toBe(true)
    }
  })

  it('is not built again when nothing it shows changed', () => {
    const ctx = setup(failed)
    const first = ctx.buttons()[0]
    ctx.notice.render()
    expect(ctx.buttons()[0]).toBe(first)
  })
})
