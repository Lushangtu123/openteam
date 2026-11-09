// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_INPUT_GRANT_MESSAGE, FRAME_INPUT_MESSAGE } from '../shared/frameInput'
import { requestTypingTurn, watchPromptInBox } from './typingTurn'

const OPENTEAM = 'chrome-extension://openteam'

// A page window inside OpenTeam: its parent records what the page posts to it.
function embeddedPage() {
  const posted: Array<{ message: { type: string; state: string; turnId: string }; origin: string }> = []
  const parent = {
    postMessage(message: unknown, origin: string) {
      posted.push({ message: message as { type: string; state: string; turnId: string }, origin })
    },
  }
  const pageWindow = Object.assign(new EventTarget(), { parent }) as unknown as Window
  const answer = (turnId: string, origin = OPENTEAM, source: unknown = parent) =>
    pageWindow.dispatchEvent(Object.assign(new Event('message'), { data: { type: FRAME_INPUT_GRANT_MESSAGE, turnId }, origin, source }))
  return { pageWindow, posted, answer }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('typing turns, page side', () => {
  it('does not wait outside OpenTeam', async () => {
    const turn = requestTypingTurn({ extensionOrigin: OPENTEAM, win: window })
    await expect(turn.granted).resolves.toBeUndefined()
  })

  it('asks OpenTeam for a turn, types when it is granted, and gives it back once', async () => {
    const { pageWindow, posted, answer } = embeddedPage()
    const turn = requestTypingTurn({ extensionOrigin: OPENTEAM, win: pageWindow })
    let granted = false
    void turn.granted.then(() => { granted = true })

    expect(posted).toEqual([{ message: { type: FRAME_INPUT_MESSAGE, state: 'request', turnId: expect.any(String) }, origin: OPENTEAM }])
    const turnId = posted[0].message.turnId

    answer(turnId, 'https://evil.example')
    answer('another-turn')
    await Promise.resolve()
    expect(granted).toBe(false)

    answer(turnId)
    await turn.granted
    expect(granted).toBe(true)

    turn.done()
    turn.done()
    expect(posted.filter(entry => entry.message.state === 'done')).toEqual([{ message: { type: FRAME_INPUT_MESSAGE, state: 'done', turnId }, origin: OPENTEAM }])
  })

  it('types anyway when no turn comes within the limit', async () => {
    vi.useFakeTimers()
    const { pageWindow } = embeddedPage()
    const turn = requestTypingTurn({ extensionOrigin: OPENTEAM, win: pageWindow, waitLimitMs: 5_000 })
    let granted = false
    void turn.granted.then(() => { granted = true })

    await vi.advanceTimersByTimeAsync(4_900)
    expect(granted).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(granted).toBe(true)
  })
})

describe('watchPromptInBox', () => {
  it('calls back once the box holds the prompt, whatever the spacing', () => {
    vi.useFakeTimers()
    const editor = document.createElement('div')
    editor.textContent = ''
    const onInBox = vi.fn()
    const stop = watchPromptInBox(() => editor, '第一行\n\n第二行 内容', onInBox)

    vi.advanceTimersByTime(100)
    expect(onInBox).not.toHaveBeenCalled()

    editor.textContent = '第一行 第二行内容'
    vi.advanceTimersByTime(60)
    expect(onInBox).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(200)
    expect(onInBox).toHaveBeenCalledTimes(1)
    stop()
  })

  it('reads a textarea by its value', () => {
    vi.useFakeTimers()
    const box = document.createElement('textarea')
    const onInBox = vi.fn()
    const stop = watchPromptInBox(() => box, '你好', onInBox)

    box.value = '你好'
    vi.advanceTimersByTime(60)
    expect(onInBox).toHaveBeenCalledTimes(1)
    stop()
  })
})
