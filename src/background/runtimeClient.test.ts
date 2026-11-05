import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamControlConnectionStatus } from '../shared/localControlProtocol'

describe('background runtime client', () => {
  it('tracks host tabs and resolves sender/message tab identity', async () => {
    vi.resetModules()
    const { forgetHostTab, listHostTabIds, messageTabId, rememberHost, senderFrameId, senderTabId } = await import('./runtimeClient')

    rememberHost({ tab: { id: 101 } as chrome.tabs.Tab }, undefined)
    rememberHost({}, 202)

    expect(senderTabId({ tab: { id: 101 } as chrome.tabs.Tab })).toBe(101)
    expect(senderFrameId({ frameId: 7 })).toBe(7)
    expect(senderFrameId({})).toBe(0)
    expect(messageTabId({ hostTabId: 303 }, {})).toBe(303)
    expect(messageTabId({ hostTabId: 303 }, { tab: { id: 101 } as chrome.tabs.Tab })).toBe(101)
    expect(listHostTabIds()).toEqual([101, 202])

    forgetHostTab(101)
    expect(listHostTabIds()).toEqual([202])
  })

  it('broadcasts store updates to the top frame of known hosts and prunes failed hosts', async () => {
    vi.resetModules()
    const tabsSendMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('tab closed'))
    const runtimeSendMessage = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: tabsSendMessage },
      runtime: { sendMessage: runtimeSendMessage },
    })
    const { broadcastStoreUpdated, listHostTabIds, rememberHost } = await import('./runtimeClient')
    const store = createDefaultStore()

    rememberHost({}, 101)
    rememberHost({}, 202)
    await broadcastStoreUpdated(store)

    expect(tabsSendMessage).toHaveBeenCalledTimes(2)
    expect(tabsSendMessage).toHaveBeenNthCalledWith(1, 101, { type: 'GROUP_STORE_UPDATED', store }, { frameId: 0 })
    expect(tabsSendMessage).toHaveBeenNthCalledWith(2, 202, { type: 'GROUP_STORE_UPDATED', store }, { frameId: 0 })
    // Nothing listens for a runtime-wide copy of the store, so none is sent.
    expect(runtimeSendMessage).not.toHaveBeenCalled()
    expect(listHostTabIds()).toEqual([101])
  })

  it('broadcasts local control status updates to known hosts and runtime listeners', async () => {
    vi.resetModules()
    const tabsSendMessage = vi.fn().mockResolvedValue({ ok: true })
    const runtimeSendMessage = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: tabsSendMessage },
      runtime: { sendMessage: runtimeSendMessage },
    })
    const { broadcastControlStatusUpdated, rememberHost } = await import('./runtimeClient')
    const controlStatus: OpenTeamControlConnectionStatus = { state: 'disconnected', port: 19305, lastError: 'OpenTeam CLI daemon is not reachable.' }

    rememberHost({}, 101)
    await broadcastControlStatusUpdated(controlStatus)

    expect(tabsSendMessage).toHaveBeenCalledWith(101, { type: 'GROUP_CONTROL_STATUS_UPDATED', controlStatus })
    expect(runtimeSendMessage).toHaveBeenCalledWith({ type: 'OPENTEAM_GROUP_PUSH', payload: { type: 'GROUP_CONTROL_STATUS_UPDATED', controlStatus } })
  })

  it('sends store-sync payloads to team pages that ask for them and full stores to everyone else', async () => {
    vi.resetModules()
    const tabsSendMessage = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('chrome', { tabs: { sendMessage: tabsSendMessage }, runtime: { sendMessage: vi.fn() } })
    const { broadcastStoreUpdated, encodeStoreResponse, rememberHost } = await import('./runtimeClient')
    const store = createDefaultStore()
    const teamPage = { tab: { id: 101 } as chrome.tabs.Tab, frameId: 0 }
    const request = { type: 'GROUP_STORE_GET', storeSync: true }

    expect(encodeStoreResponse({ ok: true, store }, { type: 'GROUP_STORE_GET' }, teamPage)).toEqual({ ok: true, store })
    expect(encodeStoreResponse({ ok: true, store }, request, { ...teamPage, frameId: 3 })).toEqual({ ok: true, store })
    expect(encodeStoreResponse({ ok: false, error: 'x' }, request, teamPage)).toEqual({ ok: false, error: 'x' })

    const first = encodeStoreResponse({ ok: true, store, bindings: [] }, request, teamPage) as Record<string, any>
    expect(first).toMatchObject({ ok: true, bindings: [], storeSync: { sequence: 1, store } })
    expect(first).not.toHaveProperty('store')
    const second = encodeStoreResponse({ ok: true, store }, request, teamPage) as Record<string, any>
    expect(second.storeSync).toMatchObject({ sequence: 2, baseSequence: 1 })
    const reset = encodeStoreResponse({ ok: true, store }, { ...request, storeSyncReset: true }, teamPage) as Record<string, any>
    expect(reset.storeSync.baseSequence).toBeUndefined()

    rememberHost({}, 101)
    rememberHost({}, 202)
    await broadcastStoreUpdated(store)

    expect(tabsSendMessage).toHaveBeenCalledWith(101, { type: 'GROUP_STORE_UPDATED', storeSync: expect.objectContaining({ sequence: 4, baseSequence: 3 }) }, { frameId: 0 })
    expect(tabsSendMessage).toHaveBeenCalledWith(202, { type: 'GROUP_STORE_UPDATED', store }, { frameId: 0 })
  })

  it('forgets a team page whose tab cannot be reached', async () => {
    vi.resetModules()
    const tabsSendMessage = vi.fn().mockRejectedValueOnce(new Error('tab closed')).mockResolvedValue({ ok: true })
    vi.stubGlobal('chrome', { tabs: { sendMessage: tabsSendMessage }, runtime: { sendMessage: vi.fn() } })
    const { broadcastStoreUpdated, encodeStoreResponse, rememberHost } = await import('./runtimeClient')
    const store = createDefaultStore()
    const teamPage = { tab: { id: 101 } as chrome.tabs.Tab, frameId: 0 }
    encodeStoreResponse({ ok: true, store }, { type: 'GROUP_STORE_GET', storeSync: true }, teamPage)

    rememberHost({}, 101)
    await broadcastStoreUpdated(store)
    rememberHost({}, 101)
    await broadcastStoreUpdated(store)

    expect(tabsSendMessage).toHaveBeenLastCalledWith(101, { type: 'GROUP_STORE_UPDATED', store }, { frameId: 0 })
  })
})
