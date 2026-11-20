// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createSiteFaultNotice } from './siteFaultNotice'

function setup(language: 'en' | 'zh-CN' = 'zh-CN') {
  document.body.innerHTML = '<div id="site-fault-notice" hidden></div>'
  let store: OpenTeamStore = createDefaultStore()
  const startSiteCheck = vi.fn()
  const runCommand = vi.fn(async () => undefined)
  const showError = vi.fn()
  const notice = createSiteFaultNotice({ element: document.getElementById('site-fault-notice'), language: () => language, getStore: () => store, startSiteCheck, runCommand, showError })
  return { notice, startSiteCheck, runCommand, showError, box: () => document.getElementById('site-fault-notice')!, setStore: (next: OpenTeamStore) => { store = next }, store: () => store }
}

describe('the notice for a site that seems to have changed', () => {
  it('stays hidden until a site failed enough times, then says which and offers the check', async () => {
    const ctx = setup()
    ctx.notice.render()
    expect(ctx.box().hidden).toBe(true)

    ctx.store().siteFaultsBySite = { kimi: { count: 1, keys: ['a'], firstAt: 1, lastAt: 2, step: 'reply' } }
    ctx.notice.render()
    expect(ctx.box().hidden).toBe(true)

    ctx.store().siteFaultsBySite = { kimi: { count: 2, keys: ['a', 'b'], firstAt: 1, lastAt: 2, step: 'reply' } }
    ctx.notice.render()
    expect(ctx.box().hidden).toBe(false)
    expect(ctx.box().textContent).toContain('Kimi 可能改版了：上次回复以来连续失败 2 次，最近一次提问发出去了，但读不到回复。')
    const buttons = [...ctx.box().querySelectorAll('button')]
    expect(buttons.map(node => node.textContent)).toEqual(['运行网站自检', '知道了'])
    expect(buttons[0].querySelector('svg')).not.toBeNull()

    buttons[0].click()
    expect(ctx.startSiteCheck).toHaveBeenCalledTimes(1)
    buttons[1].click()
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('SITE_FAULT_DISMISS', { site: 'kimi' }))
  })

  it('is not built again when nothing it shows changed, so its buttons keep the focus', () => {
    const ctx = setup()
    ctx.store().siteFaultsBySite = { gemini: { count: 2, keys: ['a', 'b'], firstAt: 1, lastAt: 2, step: 'input' } }
    ctx.notice.render()
    const first = ctx.box().querySelector('button')
    ctx.setStore(structuredClone(ctx.store()))
    ctx.notice.render()
    expect(ctx.box().querySelector('button')).toBe(first)
  })

  it('names every such site, in English too, and goes away once dismissed', () => {
    const ctx = setup('en')
    ctx.store().siteFaultsBySite = {
      gemini: { count: 2, keys: ['a', 'b'], firstAt: 1, lastAt: 2, step: 'input' },
      deepseek: { count: 4, keys: ['a', 'b'], firstAt: 1, lastAt: 9, step: 'send' },
    }
    ctx.notice.render()
    expect([...ctx.box().querySelectorAll('p')].map(node => node.textContent?.split(':')[0])).toEqual(['DeepSeek may have changed its pages', 'Gemini may have changed its pages'])
    ctx.store().siteFaultsBySite!.gemini!.dismissed = true
    ctx.store().siteFaultsBySite!.deepseek!.dismissed = true
    ctx.notice.render()
    expect(ctx.box().hidden).toBe(true)
  })

  it('says why a dismissal failed, and lets it be tried again', async () => {
    const ctx = setup()
    ctx.runCommand.mockRejectedValueOnce(new Error('后台没有回应'))
    ctx.store().siteFaultsBySite = { qwen: { count: 2, keys: ['a', 'b'], firstAt: 1, lastAt: 2, step: 'page' } }
    ctx.notice.render()
    const dismiss = [...ctx.box().querySelectorAll('button')][1]
    dismiss.click()
    await vi.waitFor(() => expect(ctx.showError).toHaveBeenCalledWith('后台没有回应'))
    expect(dismiss.disabled).toBe(false)
  })
})
