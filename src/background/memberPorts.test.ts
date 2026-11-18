import { describe, expect, it, vi } from 'vitest'
import { createMemberPorts, isMemberPortTabId, MEMBER_PORT_GONE_ERROR } from './memberPorts'

function fakePort(url = 'https://chat.deepseek.com/') {
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  const posted: unknown[] = []
  return {
    port: {
      name: 'openteam-member',
      sender: { url, origin: new URL(url).origin, documentId: 'doc-1' },
      postMessage: vi.fn((message: unknown) => posted.push(message)),
      disconnect: vi.fn(),
      onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    } as unknown as chrome.runtime.Port,
    posted,
    receive: (message: unknown) => messageListeners.forEach(listener => listener(message)),
    close: () => disconnectListeners.forEach(listener => listener()),
  }
}

function setup(handleWith: (message: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown> = async () => ({ ok: true })) {
  const handle = vi.fn(handleWith)
  const onGone = vi.fn()
  const ports = createMemberPorts({
    panelPageUrl: 'chrome-extension://ext/team.html?view=panel',
    isMemberPageUrl: url => url.startsWith('https://chat.deepseek.com/'),
    handle,
    onGone,
  })
  return { ports, handle, onGone }
}

describe('member pages in the side panel, reached over their ports', () => {
  it('gives each page an address of its own that no tab can have, and says it is linked', () => {
    const { ports } = setup()
    const first = fakePort()
    const second = fakePort()
    ports.connect(first.port)
    ports.connect(second.port)
    const [a, b] = [first.posted[0], second.posted[0]] as Array<{ type: string; tabId: number }>
    expect(a.type).toBe('linked')
    expect(isMemberPortTabId(a.tabId)).toBe(true)
    expect(isMemberPortTabId(b.tabId)).toBe(true)
    expect(a.tabId).not.toBe(b.tabId)
    expect(isMemberPortTabId(12)).toBe(false)
    expect(isMemberPortTabId(-1)).toBe(false)
  })

  it('refuses a port from a page that is not an AI site OpenTeam uses', () => {
    const { ports } = setup()
    const stranger = fakePort('https://example.com/')
    ports.connect(stranger.port)
    expect(stranger.port.disconnect).toHaveBeenCalled()
    expect(stranger.posted).toEqual([])
  })

  it('passes what the page sends on as if it came from a frame of the OpenTeam page, and answers', async () => {
    const { ports, handle } = setup(async () => ({ ok: true, role: { id: 'r' } }))
    const page = fakePort()
    ports.connect(page.port)
    const { tabId } = page.posted[0] as { tabId: number }
    page.receive({ id: 7, message: { type: 'TEAM_FRAME_ROLE_READY', roleId: 'r' } })
    await vi.waitFor(() => expect(page.posted).toContainEqual({ replyTo: 7, response: { ok: true, role: { id: 'r' } } }))
    const sender = handle.mock.calls[0][1]
    expect(sender).toMatchObject({ tab: { id: tabId, url: 'chrome-extension://ext/team.html?view=panel' }, frameId: 0, url: 'https://chat.deepseek.com/', documentId: 'doc-1' })
  })

  it('answers with the error when handling fails', async () => {
    const { ports } = setup(async () => { throw new Error('缺少成员 ID') })
    const page = fakePort()
    ports.connect(page.port)
    page.receive({ id: 3, message: { type: 'TEAM_FRAME_ROLE_READY' } })
    await vi.waitFor(() => expect(page.posted).toContainEqual({ replyTo: 3, response: { ok: false, error: '缺少成员 ID' } }))
  })

  it('sends to the page and waits for its answer, as a message to a tab would', async () => {
    const { ports } = setup()
    const page = fakePort()
    ports.connect(page.port)
    const { tabId } = page.posted[0] as { tabId: number }
    const answer = ports.send(tabId, { type: 'TEAM_STOP_GENERATION', chatId: 'c', roleId: 'r' })
    const request = page.posted[1] as { id: number; message: unknown }
    expect(request.message).toEqual({ type: 'TEAM_STOP_GENERATION', chatId: 'c', roleId: 'r' })
    page.receive({ replyTo: request.id, response: { ok: true } })
    await expect(answer).resolves.toEqual({ ok: true })
  })

  it('fails what was waiting, and says the page is gone, when its port closes', async () => {
    const { ports, onGone } = setup()
    const page = fakePort()
    ports.connect(page.port)
    const { tabId } = page.posted[0] as { tabId: number }
    const answer = ports.send(tabId, { type: 'TEAM_STOP_GENERATION', chatId: 'c', roleId: 'r' })
    page.close()
    await expect(answer).rejects.toThrow(MEMBER_PORT_GONE_ERROR)
    expect(onGone).toHaveBeenCalledWith(tabId)
    await expect(ports.send(tabId, { type: 'TEAM_STOP_GENERATION', chatId: 'c', roleId: 'r' })).rejects.toThrow(MEMBER_PORT_GONE_ERROR)
  })
})
