// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createSidePanel, isSidePanel, PANEL_RECONNECT_DELAY_MS } from './sidePanel'

function fakePort() {
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  return {
    port: {
      onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
    },
    push: (message: unknown) => messageListeners.forEach(listener => listener(message)),
    disconnect: () => disconnectListeners.forEach(listener => listener()),
  }
}

function setup(options: { memberPagesFor?: () => string | undefined } = {}) {
  document.body.innerHTML = '<button id="open-in-tab" hidden></button>'
  const ports: Array<ReturnType<typeof fakePort>> = []
  const connect = vi.fn(() => {
    const port = fakePort()
    ports.push(port)
    return port.port
  })
  const onPush = vi.fn()
  const onReconnected = vi.fn()
  const sendRuntimeMessage = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => ({ ok: true }))
  const closeWindow = vi.fn()
  const panel = createSidePanel({
    connect,
    onPush,
    onReconnected,
    sendRuntimeMessage,
    getWindowId: async () => 4,
    memberPagesFor: options.memberPagesFor ?? (() => 'chat-1'),
    openInTabButton: document.getElementById('open-in-tab') as HTMLButtonElement,
    closeWindow,
  })
  return { panel, ports, connect, onPush, onReconnected, sendRuntimeMessage, closeWindow }
}

describe('knowing it is in the side panel', () => {
  it('is told so by its address', () => {
    expect(isSidePanel('?view=panel')).toBe(true)
    expect(isSidePanel('')).toBe(false)
    expect(isSidePanel('?view=tab')).toBe(false)
  })
})

describe('OpenTeam in the side panel', () => {
  it('hears what OpenTeam tabs hear, over its port', async () => {
    const { panel, ports, onPush } = setup()
    await panel.start()
    ports[0].push({ type: 'GROUP_STORE_UPDATED', store: { x: 1 } })
    expect(onPush).toHaveBeenCalledWith({ type: 'GROUP_STORE_UPDATED', store: { x: 1 } })
  })

  it('connects again when the background restarts, and catches up', async () => {
    vi.useFakeTimers()
    try {
      const { panel, ports, connect, onReconnected, onPush } = setup()
      await panel.start()
      ports[0].disconnect()
      expect(connect).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(PANEL_RECONNECT_DELAY_MS)
      expect(connect).toHaveBeenCalledTimes(2)
      expect(onReconnected).toHaveBeenCalledTimes(1)
      ports[1].push({ type: 'GROUP_DELIVERY_ERROR', message: 'x' })
      expect(onPush).toHaveBeenCalledWith({ type: 'GROUP_DELIVERY_ERROR', message: 'x' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks for a tab to hold the members’ AI pages once per group that has any', async () => {
    let chat: string | undefined = 'chat-1'
    const { panel, sendRuntimeMessage } = setup({ memberPagesFor: () => chat })
    await panel.start()
    expect(sendRuntimeMessage).toHaveBeenCalledWith('TEAM_PAGE_HOST_ENSURE', { windowId: 4 })
    panel.refresh()
    panel.refresh()
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)
    chat = undefined
    panel.refresh()
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1)
    chat = 'chat-2'
    panel.refresh()
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(2)
  })

  it('asks again when it is looked at, in case that tab was closed', async () => {
    const { panel, sendRuntimeMessage } = setup()
    await panel.start()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(2)
  })

  it('shows a member’s AI page in the OpenTeam tab, and stays open', async () => {
    const { panel, sendRuntimeMessage, closeWindow } = setup({ memberPagesFor: () => undefined })
    await panel.start()
    await panel.showMemberPage('chat-1', 'role-1')
    expect(sendRuntimeMessage).toHaveBeenCalledWith('TEAM_PAGE_SHOW', { windowId: 4, chatId: 'chat-1', roleId: 'role-1' })
    expect(closeWindow).not.toHaveBeenCalled()
  })

  it('opens OpenTeam in a tab and closes the panel', async () => {
    const { panel, sendRuntimeMessage, closeWindow } = setup({ memberPagesFor: () => undefined })
    await panel.start()
    const button = document.getElementById('open-in-tab') as HTMLButtonElement
    expect(button.hidden).toBe(false)
    button.click()
    await vi.waitFor(() => expect(closeWindow).toHaveBeenCalled())
    expect(sendRuntimeMessage).toHaveBeenCalledWith('TEAM_PAGE_SHOW', { windowId: 4 })
  })
})
