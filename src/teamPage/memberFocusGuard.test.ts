// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_INPUT_GRANT_MESSAGE, FRAME_INPUT_MESSAGE } from '../shared/frameInput'
import { createMemberFocusGuard, type MemberFocusGuard } from './memberFocusGuard'

let guard: MemberFocusGuard | undefined

function memberFrame(hostEl: HTMLElement) {
  const frame = document.createElement('iframe')
  frame.tabIndex = 0
  hostEl.append(frame)
  const grants: string[] = []
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((message: unknown) => {
    const data = message as { type?: string; turnId?: string }
    if (data.type === FRAME_INPUT_GRANT_MESSAGE && data.turnId) grants.push(data.turnId)
  })
  const say = (state: 'request' | 'done', turnId: string) =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: FRAME_INPUT_MESSAGE, state, turnId }, source: frame.contentWindow, origin: 'https://chat.deepseek.com' }))
  return {
    frame,
    grants,
    request: (turnId: string) => say('request', turnId),
    done: (turnId: string) => say('done', turnId),
    // What the browser does when the page inside takes the focus.
    takeFocus() {
      frame.focus()
      window.dispatchEvent(new Event('blur'))
    },
  }
}

function setup(showingPages = false) {
  document.body.replaceChildren()
  const messageInputEl = document.createElement('textarea')
  const searchEl = document.createElement('input')
  const hostEl = document.createElement('div')
  document.body.append(messageInputEl, searchEl, hostEl)
  guard = createMemberFocusGuard({ hostEl, isShowingPages: () => showingPages, homeFocusEl: messageInputEl, userPauseMs: 1500, turnLimitMs: 10_000 })
  const typeKey = (target: HTMLElement = messageInputEl) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  return { messageInputEl, searchEl, hostEl, typeKey }
}

afterEach(() => {
  guard?.dispose()
  guard = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('member focus guard', () => {
  it('grants a turn at once when the user is not typing, and takes the focus back when the page is done', () => {
    vi.useFakeTimers()
    const { searchEl, hostEl } = setup()
    const page = memberFrame(hostEl)

    searchEl.focus()
    page.request('t1')
    vi.advanceTimersByTime(0)
    expect(page.grants).toEqual(['t1'])

    page.takeFocus()
    vi.advanceTimersByTime(500)
    expect(document.activeElement).toBe(page.frame)

    page.done('t1')
    expect(document.activeElement).toBe(searchEl)
  })

  it('makes a page wait while the user types, and lets it type after a pause', () => {
    vi.useFakeTimers()
    const { messageInputEl, hostEl, typeKey } = setup()
    const page = memberFrame(hostEl)

    messageInputEl.focus()
    typeKey()
    page.request('t1')
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(300)
      typeKey()
    }
    expect(page.grants).toEqual([])

    vi.advanceTimersByTime(1_400)
    expect(page.grants).toEqual([])
    vi.advanceTimersByTime(200)
    expect(page.grants).toEqual(['t1'])
  })

  it('waits while a pinyin entry is unfinished', () => {
    vi.useFakeTimers()
    const { messageInputEl, hostEl } = setup()
    const page = memberFrame(hostEl)

    messageInputEl.focus()
    messageInputEl.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    page.request('t1')
    vi.advanceTimersByTime(5_000)
    expect(page.grants).toEqual([])

    messageInputEl.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
    vi.advanceTimersByTime(1_600)
    expect(page.grants).toEqual(['t1'])
  })

  it('lets one page type at a time', () => {
    vi.useFakeTimers()
    const { hostEl } = setup()
    const first = memberFrame(hostEl)
    const second = memberFrame(hostEl)

    first.request('a')
    second.request('b')
    vi.advanceTimersByTime(0)
    expect(first.grants).toEqual(['a'])
    expect(second.grants).toEqual([])

    first.done('a')
    vi.advanceTimersByTime(0)
    expect(second.grants).toEqual(['b'])
  })

  it('takes the focus back at once from a page that grabs it without a turn', () => {
    vi.useFakeTimers()
    const { searchEl, hostEl } = setup()
    const page = memberFrame(hostEl)

    searchEl.focus()
    page.takeFocus()
    expect(document.activeElement).toBe(page.frame)
    vi.advanceTimersByTime(60)

    expect(document.activeElement).toBe(searchEl)
  })

  it('ends a turn the page never gives back, at the limit', () => {
    vi.useFakeTimers()
    const { messageInputEl, hostEl } = setup()
    const first = memberFrame(hostEl)
    const second = memberFrame(hostEl)

    messageInputEl.focus()
    first.request('a')
    second.request('b')
    vi.advanceTimersByTime(0)
    first.takeFocus()
    vi.advanceTimersByTime(9_000)
    expect(document.activeElement).toBe(first.frame)
    expect(second.grants).toEqual([])

    vi.advanceTimersByTime(1_100)
    expect(document.activeElement).toBe(messageInputEl)
    expect(second.grants).toEqual(['b'])
  })

  it('leaves the focus in a page while the user is looking at the AI pages', () => {
    vi.useFakeTimers()
    const { searchEl, hostEl } = setup(true)
    const page = memberFrame(hostEl)

    searchEl.focus()
    page.takeFocus()
    vi.advanceTimersByTime(1_000)

    expect(document.activeElement).toBe(page.frame)
  })

  it('ignores turn messages from windows that are not member frames', () => {
    vi.useFakeTimers()
    const { searchEl, hostEl } = setup()
    const page = memberFrame(hostEl)

    searchEl.focus()
    window.dispatchEvent(new MessageEvent('message', { data: { type: FRAME_INPUT_MESSAGE, state: 'request', turnId: 'x' }, source: window }))
    vi.advanceTimersByTime(0)
    page.takeFocus()
    vi.advanceTimersByTime(60)

    expect(document.activeElement).toBe(searchEl)
  })
})
