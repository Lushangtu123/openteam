// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversationMonitor } from './conversationMonitor'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

describe('conversation monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    history.replaceState(null, '', '/')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports the page's own address changes, once they settle", async () => {
    const sendRuntimeMessage = vi.fn(async (_message: unknown) => ({ ok: true }) as never)
    const monitor = createConversationMonitor({
      siteAdapter: { getConversationSnapshot: () => ({ conversationUrl: location.href }) } as unknown as ChatSiteAdapter,
      roleSession: { getAssignedRole: () => ({ roleId: 'role-1', chatId: 'chat-1' }), getAssignedChatId: () => 'chat-1' } as unknown as RoleSession,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as never,
      sendRuntimeMessage: sendRuntimeMessage as never,
    })
    const pushState = history.pushState
    monitor.start()
    // It watches the address instead of patching the History object of its own world.
    expect(history.pushState).toBe(pushState)
    await vi.advanceTimersByTimeAsync(600)
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)

    // The site moves to its new conversation (in the page's own world, which a content script's
    // history.pushState patch would never see), passing through another address on the way.
    history.pushState(null, '', '/c/first')
    history.pushState(null, '', '/c/abc')
    await vi.advanceTimersByTimeAsync(1_600)

    expect(sendRuntimeMessage).toHaveBeenCalledTimes(2)
    expect(sendRuntimeMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'TEAM_ROLE_CONVERSATION_UPDATED',
      chatId: 'chat-1',
      roleId: 'role-1',
      conversationUrl: expect.stringMatching(/\/c\/abc$/),
    }))

    // Nothing changes, nothing is sent.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(2)
  })
})
