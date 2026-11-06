import { describe, expect, it, vi } from 'vitest'
import { createRoleHealthTracker, rolePageHealthLabel, UNRESPONSIVE_AFTER_MS } from './roleHealth'

function createTracker() {
  let time = 1_000
  const timers: Array<{ at: number; handler: () => void; cleared: boolean }> = []
  const onChange = vi.fn()
  const tracker = createRoleHealthTracker({
    now: () => time,
    setTimer: (handler, ms) => timers.push({ at: time + ms, handler, cleared: false }) - 1,
    clearTimer: timer => {
      timers[timer].cleared = true
    },
    onChange,
  })
  const advance = (ms: number) => {
    time += ms
    for (const timer of timers) {
      if (!timer.cleared && timer.at <= time) {
        timer.cleared = true
        timer.handler()
      }
    }
  }
  return { tracker, onChange, advance }
}

describe('role page health tracker', () => {
  it('follows a page from opening to connected to its reported state', () => {
    const { tracker } = createTracker()
    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'closed' })

    tracker.frameOpened('chat-1', 'role-1')
    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'opening' })

    tracker.frameConnected('chat-1', 'role-1')
    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'checking' })

    tracker.siteReported('chat-1', 'role-1', { status: 'unauthorized', reason: 'login' })
    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'login-required', reason: 'login' })

    tracker.siteReported('chat-1', 'role-1', { status: 'ready', reason: 'guest' })
    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'ready', reason: 'guest' })

    tracker.frameClosed('chat-1', 'role-1')
    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'closed' })
  })

  it('marks a page that never connects as unresponsive and re-renders when that happens', () => {
    const { tracker, onChange, advance } = createTracker()
    tracker.frameOpened('chat-1', 'role-1')
    onChange.mockClear()

    advance(UNRESPONSIVE_AFTER_MS - 1)
    expect(tracker.get('chat-1', 'role-1').status).toBe('opening')
    expect(onChange).not.toHaveBeenCalled()

    advance(1)
    expect(tracker.get('chat-1', 'role-1').status).toBe('unresponsive')
    expect(onChange).toHaveBeenCalledWith('chat-1', 'role-1')
  })

  it('does not turn a connected page unresponsive later', () => {
    const { tracker, onChange, advance } = createTracker()
    tracker.frameOpened('chat-1', 'role-1')
    tracker.frameConnected('chat-1', 'role-1')
    onChange.mockClear()

    advance(UNRESPONSIVE_AFTER_MS * 2)

    expect(tracker.get('chat-1', 'role-1').status).toBe('checking')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps a report through a repeated handshake but drops it when the page loads a new document', () => {
    const { tracker } = createTracker()
    tracker.frameOpened('chat-1', 'role-1')
    tracker.frameConnected('chat-1', 'role-1')
    tracker.siteReported('chat-1', 'role-1', { status: 'ready' })

    tracker.frameConnected('chat-1', 'role-1')
    expect(tracker.get('chat-1', 'role-1').status).toBe('ready')

    tracker.frameOpened('chat-1', 'role-1')
    expect(tracker.get('chat-1', 'role-1').status).toBe('opening')
  })

  it('treats a report as proof of connection even without a handshake notice', () => {
    const { tracker } = createTracker()
    tracker.frameOpened('chat-1', 'role-1')
    tracker.siteReported('chat-1', 'role-1', { status: 'blocked', reason: 'http-error', detail: '403' })

    expect(tracker.get('chat-1', 'role-1')).toEqual({ status: 'blocked', reason: 'http-error', detail: '403' })
  })

  it('labels each state', () => {
    expect(rolePageHealthLabel({ status: 'ready', reason: 'guest' })).toBe('可以发送（未登录）')
    expect(rolePageHealthLabel({ status: 'blocked', reason: 'verification' })).toBe('需要人机验证')
    expect(rolePageHealthLabel({ status: 'blocked', reason: 'embed-blocked' })).toBe('网站不允许嵌入')
    expect(rolePageHealthLabel({ status: 'error', reason: 'no-editor' })).toBe('找不到输入框')
    expect(rolePageHealthLabel({ status: 'unresponsive' })).toBe('网页没有响应')
  })
})
