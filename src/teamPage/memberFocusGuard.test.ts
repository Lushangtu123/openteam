// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_INPUT_MESSAGE } from '../shared/frameInput'
import { createMemberFocusGuard, type MemberFocusGuard } from './memberFocusGuard'

let guard: MemberFocusGuard | undefined

function setup(showingPages = false) {
  document.body.replaceChildren()
  const messageInputEl = document.createElement('textarea')
  const searchEl = document.createElement('input')
  const hostEl = document.createElement('div')
  const frame = document.createElement('iframe')
  frame.tabIndex = 0
  hostEl.append(frame)
  document.body.append(messageInputEl, searchEl, hostEl)
  let showing = showingPages
  guard = createMemberFocusGuard({ hostEl, isShowingPages: () => showing, homeFocusEl: messageInputEl, typingLimitMs: 10_000 })
  return {
    messageInputEl,
    searchEl,
    frame,
    setShowing: (value: boolean) => { showing = value },
    // What the browser does when a page inside the frame takes the focus.
    frameTakesFocus() {
      frame.focus()
      window.dispatchEvent(new Event('blur'))
    },
    note(typing: boolean) {
      window.dispatchEvent(new MessageEvent('message', { data: { type: FRAME_INPUT_MESSAGE, typing }, source: frame.contentWindow }))
    },
  }
}

afterEach(() => {
  guard?.dispose()
  guard = undefined
  vi.useRealTimers()
})

describe('member focus guard', () => {
  it('takes the focus back from a hidden page that grabs it, to where the user was', () => {
    vi.useFakeTimers()
    const { searchEl, frame, frameTakesFocus } = setup()

    searchEl.focus()
    frameTakesFocus()
    expect(document.activeElement).toBe(frame)
    vi.advanceTimersByTime(200)

    expect(document.activeElement).toBe(searchEl)
  })

  it('lets a page keep the focus while it types a prompt, and takes it back when it is done', () => {
    vi.useFakeTimers()
    const { messageInputEl, frame, frameTakesFocus, note } = setup()

    messageInputEl.focus()
    note(true)
    frameTakesFocus()
    vi.advanceTimersByTime(3_000)
    expect(document.activeElement).toBe(frame)

    note(false)
    vi.advanceTimersByTime(0)
    expect(document.activeElement).toBe(messageInputEl)
  })

  it('takes the focus back from a page that never says it is done, at the limit', () => {
    vi.useFakeTimers()
    const { messageInputEl, frame, frameTakesFocus, note } = setup()

    messageInputEl.focus()
    note(true)
    frameTakesFocus()
    vi.advanceTimersByTime(9_000)
    expect(document.activeElement).toBe(frame)

    vi.advanceTimersByTime(1_500)
    expect(document.activeElement).toBe(messageInputEl)
  })

  it('leaves the focus in a page while the user is looking at the AI pages', () => {
    vi.useFakeTimers()
    const { searchEl, frame, frameTakesFocus } = setup(true)

    searchEl.focus()
    frameTakesFocus()
    vi.advanceTimersByTime(1_000)

    expect(document.activeElement).toBe(frame)
  })

  it('ignores typing notes from windows that are not member frames', () => {
    vi.useFakeTimers()
    const { searchEl, frame, frameTakesFocus } = setup()

    searchEl.focus()
    window.dispatchEvent(new MessageEvent('message', { data: { type: FRAME_INPUT_MESSAGE, typing: true }, source: window }))
    frameTakesFocus()
    vi.advanceTimersByTime(200)

    expect(document.activeElement).toBe(searchEl)
    expect(document.activeElement).not.toBe(frame)
  })
})
