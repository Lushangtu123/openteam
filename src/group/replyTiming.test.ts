import { describe, expect, it } from 'vitest'
import { REPLY_SIGNAL_INTERVAL_MS, REPLY_STUCK_AFTER_MS } from './replyTiming'

describe('how long a member may be silent before its reply counts as stuck', () => {
  it('leaves a late sign of life room to arrive before the member counts as stuck', () => {
    // A page's timers may fire up to a minute late when the page is out of view.
    expect(REPLY_STUCK_AFTER_MS - REPLY_SIGNAL_INTERVAL_MS).toBeGreaterThanOrEqual(60_000)
  })
})
