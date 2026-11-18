import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemberLink, MEMBER_LINK_RECONNECT_MS } from './memberLink'

afterEach(() => {
  vi.useRealTimers()
})

function fakePorts() {
  const opened: Array<{ posted: unknown[]; receive(message: unknown): void; close(): void }> = []
  const connect = vi.fn(() => {
    const messageListeners: Array<(message: unknown) => void> = []
    const disconnectListeners: Array<() => void> = []
    const posted: unknown[] = []
    opened.push({ posted, receive: message => messageListeners.forEach(listener => listener(message)), close: () => disconnectListeners.forEach(listener => listener()) })
    return {
      postMessage: (message: unknown) => posted.push(message),
      onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    }
  })
  return { connect, opened }
}

describe('a member page held by the side panel, linked over a port', () => {
  it('is linked once the background says so', async () => {
    const { connect, opened } = fakePorts()
    const link = createMemberLink({ connect, dispatch: () => false, onRelinked: vi.fn() })
    expect(link.active()).toBe(false)
    const linked = link.start()
    expect(link.active()).toBe(true)
    opened[0].receive({ type: 'linked', tabId: -1000 })
    await expect(linked).resolves.toBeUndefined()
  })

  it('sends to the background and gets its answer', async () => {
    const { connect, opened } = fakePorts()
    const link = createMemberLink({ connect, dispatch: () => false, onRelinked: vi.fn() })
    const linked = link.start()
    opened[0].receive({ type: 'linked', tabId: -1000 })
    await linked
    const answer = link.send({ type: 'TEAM_SEND_ACK', chatId: 'c', roleId: 'r', messageId: 'm' })
    await vi.waitFor(() => expect(opened[0].posted).toHaveLength(1))
    const request = opened[0].posted[0] as { id: number; message: unknown }
    expect(request.message).toEqual({ type: 'TEAM_SEND_ACK', chatId: 'c', roleId: 'r', messageId: 'm' })
    opened[0].receive({ replyTo: request.id, response: { ok: true } })
    await expect(answer).resolves.toEqual({ ok: true })
  })

  it('hands what the background sends to the page’s handlers, and returns their answer', async () => {
    const { connect, opened } = fakePorts()
    const dispatch = vi.fn((message: unknown, respond: (response?: unknown) => void) => {
      if ((message as { type: string }).type === 'TEAM_STOP_GENERATION') {
        setTimeout(() => respond({ ok: true, stopped: true }), 0)
        return true
      }
      return false
    })
    const link = createMemberLink({ connect, dispatch, onRelinked: vi.fn() })
    void link.start()
    opened[0].receive({ id: 4, message: { type: 'TEAM_STOP_GENERATION', chatId: 'c', roleId: 'r' } })
    await vi.waitFor(() => expect(opened[0].posted).toContainEqual({ replyTo: 4, response: { ok: true, stopped: true } }))
    // A message no handler takes is answered at once, as a tab message would be.
    opened[0].receive({ id: 5, message: { type: 'SOMETHING_ELSE' } })
    expect(opened[0].posted).toContainEqual({ replyTo: 5, response: undefined })
  })

  it('links again when the background restarts, fails what was waiting, and announces itself again', async () => {
    vi.useFakeTimers()
    const { connect, opened } = fakePorts()
    const onRelinked = vi.fn()
    const link = createMemberLink({ connect, dispatch: () => false, onRelinked })
    void link.start()
    opened[0].receive({ type: 'linked', tabId: -1000 })
    const waiting = link.send({ type: 'TEAM_SEND_ACK', chatId: 'c', roleId: 'r', messageId: 'm' })
    const failed = expect(waiting).rejects.toThrow('OpenTeam 的后台重新启动了')
    await vi.advanceTimersByTimeAsync(0)
    expect(opened[0].posted).toHaveLength(1)
    opened[0].close()
    await failed
    await vi.advanceTimersByTimeAsync(MEMBER_LINK_RECONNECT_MS)
    expect(connect).toHaveBeenCalledTimes(2)
    opened[1].receive({ type: 'linked', tabId: -1001 })
    await vi.waitFor(() => expect(onRelinked).toHaveBeenCalledTimes(1))
  })
})
