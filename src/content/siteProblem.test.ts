import { describe, expect, it } from 'vitest'
import { createSiteProblemTracker, siteProblemReason } from './siteProblem'

const status = (value: Record<string, unknown>) => ({ timestamp: 1, ...value }) as Parameters<typeof siteProblemReason>[1]

describe('site problems while a reply is pending', () => {
  it("words the page's problem for the failed reply", () => {
    expect(siteProblemReason('Grok', status({ status: 'error', reason: 'site-error', detail: 'Network error occurred' }))).toBe('Grok 页面报错：「Network error occurred」')
    expect(siteProblemReason('Grok', status({ status: 'unauthorized', reason: 'login', detail: 'Your session has ended. Sign in again.' }))).toBe('Grok 需要登录才能回复，请在 Grok 页面登录后重试（Your session has ended. Sign in again.）')
    expect(siteProblemReason('Kimi', status({ status: 'blocked', reason: 'overlay', detail: 'Tips' }))).toBe('Kimi 页面上有弹窗挡住了回复：「Tips」，请在 Kimi 页面里处理后重试')
    expect(siteProblemReason('Claude', status({ status: 'blocked', reason: 'embed-blocked', detail: 'This page can’t run in an embedded view.' }))).toBe('Claude 网页不允许在 OpenTeam 里打开，消息发不过去。请改用 Claude 的 API 成员')
    expect(siteProblemReason('Grok', status({ status: 'generating' }))).toBeUndefined()
    expect(siteProblemReason('Grok', status({ status: 'blocked', reason: 'verification' }))).toBeUndefined()
  })

  it('fails the reply only when the same problem shows on two checks in a row', () => {
    const tracker = createSiteProblemTracker('Grok')
    const error = status({ status: 'error', reason: 'site-error', detail: 'Network error occurred' })

    expect(tracker.observe('m1', error)).toBeUndefined()
    expect(tracker.observe('m1', status({ status: 'generating' }))).toBeUndefined()
    expect(tracker.observe('m1', error)).toBeUndefined()
    expect(tracker.observe('m1', error)).toBe('Grok 页面报错：「Network error occurred」')
    // Seen again after failing: it starts over.
    expect(tracker.observe('m1', error)).toBeUndefined()
    // Nothing pending, or another message: no carry-over.
    expect(tracker.observe(undefined, error)).toBeUndefined()
    expect(tracker.observe('m2', error)).toBeUndefined()
    expect(tracker.observe('m3', error)).toBeUndefined()
  })
})
