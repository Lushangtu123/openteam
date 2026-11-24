import { describe, expect, it } from 'vitest'
import { createPageVisibility } from './pageVisibility'

describe('whether a member\'s page was hidden', () => {
  it('remembers when each member\'s page was hidden, and tells whether that was during a time', () => {
    let clock = 1_000
    const pages = createPageVisibility(() => clock)
    pages.record('chat-1', 'role-1', false)
    expect(pages.wasHidden('chat-1', 'role-1', 0)).toBe(false)

    clock = 2_000
    pages.record('chat-1', 'role-1', true)
    clock = 2_500
    // Said again while hidden: still the same time hidden.
    pages.record('chat-1', 'role-1', true)
    clock = 5_000
    pages.record('chat-1', 'role-1', false)

    expect(pages.wasHidden('chat-1', 'role-1', 1_000)).toBe(true)
    expect(pages.wasHidden('chat-1', 'role-1', 4_000)).toBe(true)
    // After it was shown again.
    expect(pages.wasHidden('chat-1', 'role-1', 5_001)).toBe(false)
    // Another member, another group, a member never heard from.
    expect(pages.wasHidden('chat-1', 'role-2', 0)).toBe(false)
    expect(pages.wasHidden('chat-2', 'role-1', 0)).toBe(false)

    // Hidden now.
    clock = 9_000
    pages.record('chat-1', 'role-2', true)
    clock = 20_000
    expect(pages.wasHidden('chat-1', 'role-2', 15_000)).toBe(true)
  })

  it('keeps a member\'s last few hidden times only', () => {
    let clock = 0
    const pages = createPageVisibility(() => clock)
    for (let index = 0; index < 30; index += 1) {
      clock = index * 10
      pages.record('c', 'r', true)
      clock = index * 10 + 5
      pages.record('c', 'r', false)
    }
    expect(pages.wasHidden('c', 'r', 0)).toBe(true)
    // The earliest are forgotten: only times since then count.
    expect(pages.wasHidden('c', 'r', 0, 50)).toBe(false)
    expect(pages.wasHidden('c', 'r', 280, 300)).toBe(true)
  })
})
