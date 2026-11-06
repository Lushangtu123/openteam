import { createStoreSyncEncoder } from '../group/storeSync'
import type { OpenTeamStore } from '../group/types'
import type { OpenTeamControlConnectionStatus } from '../shared/localControlProtocol'
import { createLogger } from '../shared/logger'

export type RuntimeMessage = { type?: string; [key: string]: unknown }

export interface BroadcastStoreUpdatedOptions {
  excludeTabId?: number
}

export const GROUP_PUSH_TYPE = 'OPENTEAM_GROUP_PUSH'

const hostTabIds = new Set<number>()
// Team pages that ask for it (`storeSync: true` on their messages) receive store deltas instead
// of the full store, which is several megabytes for a long chat history.
const storeSync = createStoreSyncEncoder()

const log = createLogger('background')

export function senderTabId(sender: chrome.runtime.MessageSender): number | undefined {
  return sender.tab?.id
}

export function senderFrameId(sender: chrome.runtime.MessageSender): number {
  return sender.frameId ?? 0
}

export function explicitTabId(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function messageTabId(message: RuntimeMessage, sender: chrome.runtime.MessageSender): number | undefined {
  return senderTabId(sender) ?? explicitTabId(message.hostTabId)
}

const hostTabListeners = new Set<() => void>()

// Called when a team page tab is first seen or goes away.
export function onHostTabsChanged(listener: () => void): void {
  hostTabListeners.add(listener)
}

export function rememberHost(sender: chrome.runtime.MessageSender, explicitTabIdValue?: unknown): void {
  const tabId = senderTabId(sender) ?? explicitTabId(explicitTabIdValue)
  if (tabId === undefined || hostTabIds.has(tabId)) return
  hostTabIds.add(tabId)
  for (const listener of hostTabListeners) listener()
}

export function forgetHostTab(tabId: number): void {
  const known = hostTabIds.delete(tabId)
  storeSync.forget(tabId)
  if (known) for (const listener of hostTabListeners) listener()
}

export function listHostTabIds(): number[] {
  return [...hostTabIds]
}

// The store is the largest message OpenTeam sends, so it only goes to the team page itself (the
// host tab's top frame). Without a frameId, Chrome would also copy it into every AI-site frame
// embedded in that tab, whose content scripts ignore it.
export async function broadcastStoreUpdated(store: OpenTeamStore, options: BroadcastStoreUpdatedOptions = {}): Promise<void> {
  for (const tabId of listHostTabIds()) {
    if (tabId === options.excludeTabId) continue
    const message = storeSync.isTracking(tabId)
      ? { type: 'GROUP_STORE_UPDATED', storeSync: storeSync.encode(store, tabId) }
      : { type: 'GROUP_STORE_UPDATED', store }
    try {
      await chrome.tabs.sendMessage(tabId, message, { frameId: 0 })
    } catch (error) {
      log.debug('group-store-updated:tab-failed', { tabId, error: error instanceof Error ? error.message : String(error) })
      forgetHostTab(tabId)
    }
  }
}

// Replaces the store in a response to the team page with a store-sync payload, when the page asked
// for one. Other callers (and other frames) keep receiving the full store.
export function encodeStoreResponse(response: unknown, message: RuntimeMessage, sender: chrome.runtime.MessageSender): unknown {
  if (!isRecord(response) || !isRecord(response.store) || message.storeSync !== true) return response
  const tabId = sender.tab?.id
  if (tabId === undefined || senderFrameId(sender) !== 0) return response
  if (message.storeSyncReset === true) storeSync.reset(tabId)
  const { store, ...rest } = response
  return { ...rest, storeSync: storeSync.encode(store as unknown as OpenTeamStore, tabId) }
}

export async function broadcastControlStatusUpdated(controlStatus: OpenTeamControlConnectionStatus): Promise<void> {
  const message = { type: 'GROUP_CONTROL_STATUS_UPDATED', controlStatus }

  for (const tabId of listHostTabIds()) {
    try {
      await chrome.tabs.sendMessage(tabId, message)
    } catch (error) {
      log.debug('control-status-updated:tab-failed', { tabId, error: error instanceof Error ? error.message : String(error) })
      forgetHostTab(tabId)
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: GROUP_PUSH_TYPE, payload: message })
  } catch (error) {
    log.debug('control-status-updated:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function sendError(message: string): Promise<void> {
  const payload = { type: 'GROUP_DELIVERY_ERROR', message }
  for (const tabId of listHostTabIds()) {
    try {
      await chrome.tabs.sendMessage(tabId, payload)
    } catch {
      forgetHostTab(tabId)
    }
  }

  try {
    await chrome.runtime.sendMessage({ type: GROUP_PUSH_TYPE, payload })
  } catch {
    // no active receiver
  }
}

export async function requestRoleRecovery(chatId: string, roleId: string, reason?: string): Promise<boolean> {
  const payload = { type: 'GROUP_ROLE_RECOVERY_REQUEST', chatId, roleId, reason }
  log.warn('orchestration-diagnostic:role-recovery-request:start', { chatId, roleId, reason, hostTabIds: listHostTabIds() })
  for (const tabId of listHostTabIds()) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, payload)
      log.warn('orchestration-diagnostic:role-recovery-request:response', { chatId, roleId, tabId, response })
      if (isRecord(response) && response.ok === true) return true
    } catch (error) {
      log.warn('orchestration-diagnostic:role-recovery-request:tab-failed', { tabId, chatId, roleId, error: error instanceof Error ? error.message : String(error) })
      forgetHostTab(tabId)
    }
  }
  log.warn('orchestration-diagnostic:role-recovery-request:not-recovered', { chatId, roleId, reason })
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
