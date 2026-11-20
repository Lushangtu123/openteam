import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import { clearSiteFault, dismissSiteFault, layoutFaultStep, normalizeSiteFaultRecord, recordSiteFault, SITE_FAULT_THRESHOLD, siteFaultMessage, siteFaultNotices } from './siteFaults'

describe('which failures point at a changed page', () => {
  it('reads the step from what the member page reported', () => {
    expect(layoutFaultStep('RESPONSE_NOT_FOUND')).toBe('reply')
    expect(layoutFaultStep('页面上没有找到这条回复')).toBe('reply')
    expect(layoutFaultStep('页面上只有之前的回复')).toBe('reply')
    expect(layoutFaultStep('DeepSeek 发送按钮暂不可用，请稍后重试')).toBe('send')
    expect(layoutFaultStep('ChatGPT 输入框暂不可用，请稍后重试')).toBe('input')
    expect(layoutFaultStep('Claude editor did not accept the prompt text')).toBe('input')
    expect(layoutFaultStep('Qwen editor is not a textarea')).toBe('input')
    expect(layoutFaultStep('Element not found: div.ProseMirror')).toBe('page')
  })

  it('leaves out what is not the page: limits, sign-in, the connection, a slow site', () => {
    for (const reason of ['You have reached your message limit', '请求过于频繁', 'Could not establish connection. Receiving end does not exist.', '连接断开', '站点写了太久，没有等到这条回复写完', 'Kimi 页面上有弹窗挡住了发送', '服务器繁忙，请稍后再试', '', undefined]) {
      expect(layoutFaultStep(reason), String(reason)).toBeUndefined()
    }
  })
})

describe('counting a site\'s failures', () => {
  const at = 1_800_000_000_000

  it('shows the notice once the site failed twice for different prompts, and once only', () => {
    const store = createDefaultStore()
    expect(recordSiteFault(store, 'chatgpt', { key: 'role-1:msg-1', step: 'reply', now: at })).toBe(false)
    expect(siteFaultNotices(store)).toEqual([])
    // A retry of the same prompt is the same failure.
    expect(recordSiteFault(store, 'chatgpt', { key: 'role-1:msg-1', step: 'reply', now: at + 1 })).toBe(false)
    expect(store.siteFaultsBySite?.chatgpt?.count).toBe(1)
    expect(recordSiteFault(store, 'chatgpt', { key: 'role-2:msg-2', step: 'send', detail: 'ChatGPT 发送按钮暂不可用', now: at + 2 })).toBe(true)
    expect(recordSiteFault(store, 'chatgpt', { key: 'role-1:msg-3', step: 'send', now: at + 3 })).toBe(false)
    const [notice] = siteFaultNotices(store)
    expect(notice).toMatchObject({ site: 'chatgpt', label: 'ChatGPT', fault: { count: 3, firstAt: at, lastAt: at + 3, step: 'send' } })
    expect(siteFaultMessage(notice, false)).toBe('ChatGPT 可能改版了：上次回复以来连续失败 3 次，最近一次找不到发送按钮。要等 OpenTeam 更新适配后它的成员才能用。')
    expect(siteFaultMessage(notice, true)).toContain('ChatGPT may have changed its pages: 3 failures in a row')
  })

  it('takes a site check\'s failure as enough', () => {
    const store = createDefaultStore()
    expect(recordSiteFault(store, 'kimi', { key: 'role-1:msg-1', step: 'reply', now: at, decisive: true })).toBe(true)
    expect(store.siteFaultsBySite?.kimi?.count).toBe(SITE_FAULT_THRESHOLD)
  })

  it('starts again when the site replies, and keeps a dismissed notice away until then', () => {
    const store = createDefaultStore()
    recordSiteFault(store, 'gemini', { key: 'a', step: 'input', now: at })
    recordSiteFault(store, 'gemini', { key: 'b', step: 'input', now: at + 1 })
    expect(dismissSiteFault(store, 'gemini')).toBe(true)
    expect(dismissSiteFault(store, 'gemini')).toBe(false)
    expect(recordSiteFault(store, 'gemini', { key: 'c', step: 'input', now: at + 2 })).toBe(false)
    expect(siteFaultNotices(store)).toEqual([])

    expect(clearSiteFault(store, 'gemini')).toBe(true)
    expect(clearSiteFault(store, 'gemini')).toBe(false)
    recordSiteFault(store, 'gemini', { key: 'd', step: 'input', now: at + 3 })
    expect(recordSiteFault(store, 'gemini', { key: 'e', step: 'input', now: at + 4 })).toBe(true)
  })

  it('lists the latest failure first', () => {
    const store = createDefaultStore()
    for (const [site, time] of [['claude', at], ['deepseek', at + 10]] as const) {
      recordSiteFault(store, site, { key: 'a', step: 'reply', now: time })
      recordSiteFault(store, site, { key: 'b', step: 'reply', now: time })
    }
    expect(siteFaultNotices(store).map(notice => notice.site)).toEqual(['deepseek', 'claude'])
  })

  it('reads back what was stored, and drops what is not a record', () => {
    const store = createDefaultStore()
    recordSiteFault(store, 'qwen', { key: 'a', step: 'send', detail: 'x', now: at })
    dismissSiteFault(store, 'qwen')
    expect(normalizeSiteFaultRecord(JSON.parse(JSON.stringify(store.siteFaultsBySite)))).toEqual(store.siteFaultsBySite)
    expect(normalizeSiteFaultRecord({ qwen: { count: 0, firstAt: 1, lastAt: 1 }, grok: 'x', nosuch: { count: 2, firstAt: 1, lastAt: 1 } })).toEqual({})
    expect(normalizeSiteFaultRecord({ grok: { count: 2, firstAt: 1, lastAt: 2, step: 'weird' } })).toEqual({ grok: { count: 2, keys: [], firstAt: 1, lastAt: 2, step: 'page' } })
  })
})
