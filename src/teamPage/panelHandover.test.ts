import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPanelHandover, PANEL_HANDOVER_MAX_WAIT_MS } from './panelHandover'

afterEach(() => {
  vi.useRealTimers()
})

function setup(replying: boolean) {
  vi.useFakeTimers()
  const state = { replying }
  const yieldToPanel = vi.fn()
  const handover = createPanelHandover({ replying: () => state.replying, yieldToPanel, log: { info: vi.fn(), warn: vi.fn() } })
  return { state, yieldToPanel, handover }
}

describe('an OpenTeam tab handing its members’ pages to the side panel', () => {
  it('hands them over at once when no member is replying', () => {
    const { yieldToPanel, handover } = setup(false)
    handover.panelChanged(true)
    expect(yieldToPanel).toHaveBeenCalledWith(true)
    expect(handover.waiting()).toBe(false)
  })

  it('keeps them while a member replies, and hands them over once the replies are in', () => {
    const { state, yieldToPanel, handover } = setup(true)
    handover.panelChanged(true)
    expect(yieldToPanel).not.toHaveBeenCalled()
    expect(handover.waiting()).toBe(true)

    // Still replying: nothing yet.
    handover.storeChanged()
    expect(yieldToPanel).not.toHaveBeenCalled()

    state.replying = false
    handover.storeChanged()
    expect(yieldToPanel).toHaveBeenCalledWith(true)
    expect(handover.waiting()).toBe(false)
    // Nothing more once handed over.
    handover.storeChanged()
    expect(yieldToPanel).toHaveBeenCalledTimes(1)
  })

  it('hands them over after 3 minutes even if a member still replies (the new page goes on reading it)', () => {
    const { yieldToPanel, handover } = setup(true)
    handover.panelChanged(true)
    vi.advanceTimersByTime(PANEL_HANDOVER_MAX_WAIT_MS - 1_000)
    expect(yieldToPanel).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(yieldToPanel).toHaveBeenCalledWith(true)
    expect(handover.waiting()).toBe(false)
  })

  it('takes them back when the panel closes, also while it still waited', () => {
    const { yieldToPanel, handover } = setup(true)
    handover.panelChanged(true)
    handover.panelChanged(false)
    expect(yieldToPanel).toHaveBeenCalledWith(false)
    expect(handover.waiting()).toBe(false)
    vi.advanceTimersByTime(PANEL_HANDOVER_MAX_WAIT_MS)
    expect(yieldToPanel).not.toHaveBeenCalledWith(true)
  })

  it('does not wait twice when told again that the panel is open', () => {
    const { state, yieldToPanel, handover } = setup(true)
    handover.panelChanged(true)
    vi.advanceTimersByTime(PANEL_HANDOVER_MAX_WAIT_MS / 2)
    handover.panelChanged(true)
    vi.advanceTimersByTime(PANEL_HANDOVER_MAX_WAIT_MS / 2)
    expect(yieldToPanel).toHaveBeenCalledWith(true)
    state.replying = false
    expect(yieldToPanel).toHaveBeenCalledTimes(1)
  })
})
