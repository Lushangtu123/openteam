// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createStreamingReveal } from './streamingReveal'

function harness(options: { reduceMotion?: boolean } = {}) {
  const frames: Array<(time: number) => void> = []
  let time = 0
  const rendered: string[] = []
  const reveal = createStreamingReveal({
    render: (body, text) => { body.textContent = text; rendered.push(text) },
    catchUpMs: 100,
    minFrameMs: 0,
    requestFrame: callback => frames.push(callback),
    cancelFrame: () => undefined,
    reduceMotion: () => options.reduceMotion ?? false,
  })
  const body = document.createElement('div')
  document.body.append(body)
  const runFrames = (count: number, step = 20) => {
    for (let index = 0; index < count && frames.length; index += 1) {
      time += step
      frames.shift()!(time)
    }
  }
  return { reveal, body, rendered, runFrames, frames }
}

describe('smooth reveal of streaming replies', () => {
  it('reveals new text a few characters at a time until it catches up', () => {
    const { reveal, body, rendered, runFrames } = harness()

    reveal.show('r1', body, '你好，这是第一段回复。')
    expect(body.textContent).toBe('')
    runFrames(2)
    const partway = body.textContent ?? ''
    expect(partway.length).toBeGreaterThan(0)
    expect(partway.length).toBeLessThan('你好，这是第一段回复。'.length)
    runFrames(20)
    expect(body.textContent).toBe('你好，这是第一段回复。')
    expect(reveal.isRevealing('r1')).toBe(false)

    // More text arrives: only the new part flows in, from where it was.
    reveal.show('r1', body, '你好，这是第一段回复。接着是第二段。')
    expect(body.textContent).toBe('你好，这是第一段回复。')
    runFrames(20)
    expect(body.textContent).toBe('你好，这是第一段回复。接着是第二段。')
    expect(rendered.every(text => '你好，这是第一段回复。接着是第二段。'.startsWith(text))).toBe(true)
  })

  it('shows rewritten text at once, and everything at once with reduced motion', () => {
    const { reveal, body, runFrames } = harness()
    reveal.show('r1', body, 'Draft answer')
    runFrames(20)
    reveal.show('r1', body, 'Final answer, rewritten')
    expect(body.textContent).toBe('Final answer, rewritten')

    const calm = harness({ reduceMotion: true })
    calm.reveal.show('r2', calm.body, '一次显示全部')
    expect(calm.body.textContent).toBe('一次显示全部')
    expect(calm.frames).toHaveLength(0)
  })

  it('continues in the newest place the reply is drawn, and forgets finished replies', () => {
    const { reveal, body, runFrames } = harness()
    reveal.show('r1', body, 'abcdefghijklmnopqrstuvwxyz')
    runFrames(1)
    // The row is redrawn: the reveal carries on in the new body.
    body.remove()
    const fresh = document.createElement('div')
    document.body.append(fresh)
    reveal.show('r1', fresh, 'abcdefghijklmnopqrstuvwxyz')
    runFrames(30)
    expect(fresh.textContent).toBe('abcdefghijklmnopqrstuvwxyz')

    reveal.retain(new Set())
    expect(reveal.isRevealing('r1')).toBe(false)
  })

  it('never cuts an emoji in half', () => {
    const { reveal, body, rendered, runFrames } = harness()
    reveal.show('r1', body, '好😀好😀好😀好😀')
    runFrames(30, 5)
    expect(rendered.every(text => !/[\uD800-\uDBFF]$/.test(text))).toBe(true)
  })
})
