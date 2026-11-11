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

describe('content entrypoint prompts while the site is still writing', () => {
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

  const prompt = { type: 'TEAM_SEND_PROMPT', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-2', replyAttemptId: 'attempt-2', content: '新问题' }
  const roleStatuses = (sendRuntimeMessage: { mock: { calls: Array<[RoleToBackgroundMessage]> } }, status: string) => sendRuntimeMessage.mock.calls.map(call => call[0]).filter(message => message.type === 'TEAM_ROLE_STATUS' && message.status === status)

  it('types a prompt only once the site has finished the reply it was writing, and leaves that reply out', async () => {
    const page = await bootContentEntrypoint({ embedded: true, directEmbedded: true })
    page.handshake().roleSession.assignRole({ chatId: 'chat-1', roleId: 'role-1', roleName: '工程师' })
    // The page was opened again while the site was still writing an earlier reply.
    page.site.generating = true
    const sendResponse = vi.fn()

    page.receive(prompt, sendResponse)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(page.adapter.fillAndSend).not.toHaveBeenCalled()
    expect(page.replyObserver.capturePromptReplyBaseline).not.toHaveBeenCalled()
    // Meanwhile the member says it is still taking the prompt, so it does not count as stuck.
    expect(roleStatuses(page.sendRuntimeMessage, 'sending').length).toBeGreaterThanOrEqual(2)

    page.site.generating = false
    await vi.advanceTimersByTimeAsync(3_000)
    // What the site wrote before is on the page before the prompt: it is not this prompt's reply.
    expect(page.replyObserver.capturePromptReplyBaseline).toHaveBeenCalledWith('msg-2')
    expect(page.adapter.fillAndSend).toHaveBeenCalledWith('新问题', true)
    expect(page.replyObserver.capturePromptReplyBaseline.mock.invocationCallOrder[0]).toBeLessThan(page.adapter.fillAndSend.mock.invocationCallOrder[0])
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, messageId: 'msg-2' })
  })

  it('drops a prompt that was waiting when its reply is stopped, without reporting a failure', async () => {
    const page = await bootContentEntrypoint({ embedded: true, directEmbedded: true })
    page.handshake().roleSession.assignRole({ chatId: 'chat-1', roleId: 'role-1', roleName: '工程师' })
    page.site.generating = true
    const sendResponse = vi.fn()

    page.receive(prompt, sendResponse)
    await vi.advanceTimersByTimeAsync(5_000)
    const stopResponse = vi.fn()
    page.receive({ type: 'TEAM_STOP_GENERATION', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-2', replyAttemptId: 'attempt-2' }, stopResponse)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(page.adapter.stopGenerating).toHaveBeenCalled()
    expect(stopResponse).toHaveBeenCalledWith({ ok: true })
    expect(page.adapter.fillAndSend).not.toHaveBeenCalled()
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, messageId: 'msg-2', skipped: true })
    expect(page.sendRuntimeMessage.mock.calls.map(call => call[0].type)).not.toContain('TEAM_ROLE_ERROR')
  })
})

async function bootContentEntrypoint(options: { embedded: boolean; directEmbedded: boolean }) {
  const sendRuntimeMessage = vi.fn(async (_message: RoleToBackgroundMessage) => ({ ok: true }))
  let status: SiteStatusInfo = { status: 'blocked', reason: 'http-error', detail: 'Access Denied', timestamp: Date.now() }
  const checkStatus = vi.fn((_context: { pageAgeMs: number }) => status)
  const registerFrameRoleHandshake = vi.fn()
  const messageListeners: Array<(message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown> = []
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      onMessage: {
        addListener: vi.fn(listener => messageListeners.push(listener)),
      },
    },
  })
  const site = { generating: false }
  const adapter = createAdapter(checkStatus, site)
  const replyObserver = {
    capturePromptReplyBaseline: vi.fn(),
    clearPromptReplyBaseline: vi.fn(),
    clearReplyPolling: vi.fn(),
    startReplyPolling: vi.fn(),
    startReplyReporting: vi.fn(),
    seedStoredRoleReplies: vi.fn(),
    resetForAssignedRole: vi.fn(),
  }
  vi.doMock('./typingTurn', () => ({
    requestTypingTurn: () => ({ granted: Promise.resolve(), done: vi.fn() }),
    watchPromptInBox: () => () => undefined,
  }))

  vi.doMock('./frameEnvironment', () => ({
    isEmbeddedFrame: () => options.embedded,
    isDirectEmbeddedFrame: () => options.directEmbedded,
  }))
  vi.doMock('./sites', () => ({
    getActiveChatSiteAdapter: () => adapter,
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
    createReplyObserver: () => replyObserver,
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
    site,
    adapter,
    replyObserver,
    receive: (message: Record<string, unknown>, sendResponse: (response?: unknown) => void) => messageListeners.forEach(listener => listener(message, {}, sendResponse)),
  }
}

function createAdapter(checkStatus: ChatSiteAdapter['checkStatus'], site: { generating: boolean } = { generating: false }) {
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
    isGenerating: () => site.generating,
    checkStatus,
    stopGenerating: vi.fn(async () => {
      site.generating = false
      return true
    }),
    fillAndSend: vi.fn(async (_content: string, _autoSend?: boolean) => undefined),
    collectPromptDiagnostics: () => ({}),
  } satisfies ChatSiteAdapter
}
