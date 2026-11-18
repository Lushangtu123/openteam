// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { registerFrameRoleHandshake } from './frameHandshake'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

const EXTENSION = 'chrome-extension://ext'

function setup() {
  const sent: unknown[] = []
  const order: string[] = []
  let finishLink: () => void = () => undefined
  const linkOverPort = vi.fn(() => new Promise<void>(resolve => {
    order.push('link')
    finishLink = () => resolve()
  }))
  const assignRole = vi.fn()
  const handshake = registerFrameRoleHandshake({
    siteAdapter: { getConversationSnapshot: () => ({ conversationId: 'conv', conversationUrl: 'https://chat.deepseek.com/a/chat/s/conv' }), getConversationId: () => 'conv' } as unknown as ChatSiteAdapter,
    roleSession: { assignRole } as unknown as RoleSession,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    extensionOrigin: EXTENSION,
    seedStoredRoleReplies: vi.fn(),
    sendRuntimeMessage: async <T,>(message: unknown) => {
      order.push('ready')
      sent.push(message)
      return { ok: true, role: { id: 'r', name: '甲', chatId: 'c' }, replyHistory: [] } as T
    },
    linkOverPort,
  })
  const assign = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'OPENTEAM_ASSIGN_FRAME_ROLE', chatId: 'c', roleId: 'r', ...data }, origin: EXTENSION, source: window.parent }))
  return { handshake, sent, order, linkOverPort, assignRole, assign, finishLink: () => finishLink() }
}

describe('a member page told which member it is', () => {
  it('in an OpenTeam tab, says it is ready at once, without a port', async () => {
    const { sent, linkOverPort, assign, assignRole } = setup()
    assign({ hostTabId: 7 })
    await vi.waitFor(() => expect(assignRole).toHaveBeenCalled())
    expect(linkOverPort).not.toHaveBeenCalled()
    expect(sent[0]).toMatchObject({ type: 'TEAM_FRAME_ROLE_READY', chatId: 'c', roleId: 'r', hostTabId: 7 })
  })

  it('in the side panel, links over its port first, then says it is ready', async () => {
    const { sent, order, assign, finishLink } = setup()
    assign({ transport: 'port' })
    await vi.waitFor(() => expect(order).toEqual(['link']))
    expect(sent).toEqual([])
    finishLink()
    await vi.waitFor(() => expect(order).toEqual(['link', 'ready']))
  })

  it('says so again when asked, after the background restarted', async () => {
    const { handshake, sent, assign, assignRole } = setup()
    assign({ hostTabId: 7 })
    await vi.waitFor(() => expect(assignRole).toHaveBeenCalled())
    handshake.announceAgain()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ type: 'TEAM_FRAME_ROLE_READY', roleId: 'r' })
  })

  it('ignores an assignment from anywhere but the OpenTeam page around it', () => {
    const { sent, linkOverPort } = setup()
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'OPENTEAM_ASSIGN_FRAME_ROLE', roleId: 'r', transport: 'port' }, origin: 'https://evil.example', source: window.parent }))
    expect(linkOverPort).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})
