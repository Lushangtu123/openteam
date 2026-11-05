// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoleToBackgroundMessage } from '../group/runtimeProtocol'
import type { ChatSiteAdapter, SiteStatusInfo } from './sites/types'

describe('content entrypoint site status heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    document.body.innerHTML = '<main></main>'
    delete (window as unknown as Record<string, unknown>).__OPENTEAM_LOADED__
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
    delete (window as unknown as Record<string, unknown>).__OPENTEAM_LOADED__
  })

  it('reports page health for the assigned role right away and then only when it changes', async () => {
    const { sendRuntimeMessage, handshake, setStatus } = await bootContentEntrypoint({ embedded: true, directEmbedded: true })
    const statusReports = () => sendRuntimeMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'TEAM_SITE_STATUS_UPDATE')

    // Nobody to report for until the team page assigns a role.
    await vi.advanceTimersByTimeAsync(6000)
    expect(statusReports()).toEqual([])

    handshake().roleSession.assignRole({ chatId: 'chat-1', roleId: 'role-1', roleName: '工程师' })
    expect(statusReports()).toEqual([{
      type: 'TEAM_SITE_STATUS_UPDATE',
      chatId: 'chat-1',
      roleId: 'role-1',
      siteId: 'chatgpt',
      status: 'blocked',
      reason: 'http-error',
      detail: 'Access Denied',
    }])

    await vi.advanceTimersByTimeAsync(6000)
    expect(statusReports()).toHaveLength(1)

    setStatus({ status: 'ready', timestamp: Date.now() })
    await vi.advanceTimersByTimeAsync(3000)
    expect(statusReports()).toHaveLength(2)
    expect(statusReports()[1]).toEqual({ type: 'TEAM_SITE_STATUS_UPDATE', chatId: 'chat-1', roleId: 'role-1', siteId: 'chatgpt', status: 'ready' })
  })

  it('tells the adapter how long the page has been loading', async () => {
    const { handshake, checkStatus } = await bootContentEntrypoint({ embedded: true, directEmbedded: true })
    await vi.advanceTimersByTimeAsync(4000)

    handshake().roleSession.assignRole({ chatId: 'chat-1', roleId: 'role-1', roleName: '工程师' })

    expect(checkStatus).toHaveBeenLastCalledWith({ pageAgeMs: expect.any(Number) })
    expect(checkStatus.mock.calls[checkStatus.mock.calls.length - 1][0].pageAgeMs).toBeGreaterThanOrEqual(4000)
  })
})

async function bootContentEntrypoint(options: { embedded: boolean; directEmbedded: boolean }) {
  const sendRuntimeMessage = vi.fn(async (_message: RoleToBackgroundMessage) => ({ ok: true }))
  let status: SiteStatusInfo = { status: 'blocked', reason: 'http-error', detail: 'Access Denied', timestamp: Date.now() }
  const checkStatus = vi.fn((_context: { pageAgeMs: number }) => status)
  const registerFrameRoleHandshake = vi.fn()
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      onMessage: {
        addListener: vi.fn(),
      },
    },
  })

  vi.doMock('./frameEnvironment', () => ({
    isEmbeddedFrame: () => options.embedded,
    isDirectEmbeddedFrame: () => options.directEmbedded,
  }))
  vi.doMock('./sites', () => ({
    getActiveChatSiteAdapter: () => createAdapter(checkStatus),
  }))
  vi.doMock('./runtimeClient', () => ({
    contentLog: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    sendRuntimeMessage,
  }))
  vi.doMock('./conversationMonitor', () => ({
    createConversationMonitor: () => ({
      reportConversationUpdate: vi.fn(),
      start: vi.fn(),
    }),
  }))
  vi.doMock('./replyObserver', () => ({
    createReplyObserver: () => ({
      capturePromptReplyBaseline: vi.fn(),
      clearPromptReplyBaseline: vi.fn(),
      clearReplyPolling: vi.fn(),
      startReplyPolling: vi.fn(),
      startReplyReporting: vi.fn(),
      seedStoredRoleReplies: vi.fn(),
      resetForAssignedRole: vi.fn(),
    }),
  }))
  vi.doMock('./frameHandshake', () => ({
    registerFrameRoleHandshake,
  }))

  await import('./index')
  return {
    sendRuntimeMessage,
    checkStatus,
    handshake: () => registerFrameRoleHandshake.mock.calls[0][0] as { roleSession: { assignRole(role: { chatId: string; roleId: string; roleName: string }): void } },
    setStatus: (next: SiteStatusInfo) => {
      status = next
    },
  }
}

function createAdapter(checkStatus: ChatSiteAdapter['checkStatus']): ChatSiteAdapter {
  return {
    id: 'chatgpt',
    getConversationSnapshot: () => ({
      conversationId: 'conversation-1',
      conversationUrl: 'https://chatgpt.com/c/conversation-1',
    }),
    getConversationId: () => 'conversation-1',
    getResponseContainers: () => [],
    getAllAssistantReplies: () => [],
    readResponseText: () => '',
    findResponseContainer: () => null,
    isGenerating: () => false,
    checkStatus,
    stopGenerating: async () => false,
    fillAndSend: async () => undefined,
    collectPromptDiagnostics: () => ({}),
  }
}
