import { createStoreSyncDecoder, type StoreSyncPayload } from '../group/storeSync'
import type { OpenTeamStore, RoleSiteHealthReason, RoleSiteHealthStatus } from '../group/types'
import type { OpenTeamControlConnectionStatus } from '../shared/localControlProtocol'

export interface RuntimeResponse<T = unknown> {
  ok?: boolean
  error?: string
  store?: OpenTeamStore
  storeSync?: StoreSyncPayload
  controlStatus?: OpenTeamControlConnectionStatus
  data?: T
}

export type StorePushMessage =
  | { type: 'GROUP_STORE_UPDATED'; store?: OpenTeamStore; storeSync?: StoreSyncPayload }
  | { type: 'GROUP_CONTROL_STATUS_UPDATED'; controlStatus: OpenTeamControlConnectionStatus }
  | { type: 'GROUP_ORCHESTRATION_AUTO_STREAM_CHUNK'; streamId: string; chunk?: string; content?: string }
  | { type: 'GROUP_ROLE_STATUS_UPDATED'; store?: OpenTeamStore }
  | { type: 'GROUP_MESSAGE_DELIVERED'; store?: OpenTeamStore }
  | { type: 'GROUP_MESSAGE_RECEIVED'; store?: OpenTeamStore }
  | { type: 'GROUP_DELIVERY_ERROR'; store?: OpenTeamStore; error?: string; message?: string }
  | { type: 'GROUP_ROLE_RECOVERY_REQUEST'; chatId: string; roleId: string; reason?: string }
  | { type: 'TEAM_FRAME_ROLE_READY'; chatId: string; roleId: string; store?: OpenTeamStore }
  | { type: 'TEAM_SITE_STATUS_UPDATE'; chatId?: string; roleId?: string; status: RoleSiteHealthStatus; reason?: RoleSiteHealthReason; detail?: string }

export interface TeamPageRuntimeClientDependencies {
  getHostTabId(): number | undefined
  applyStore(store: OpenTeamStore): void
  refreshStore(showFailure?: boolean): Promise<void>
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
}

export interface TeamPageRuntimeClient {
  sendRuntimeMessage<T>(type: string, payload?: Record<string, unknown>): Promise<RuntimeResponse<T>>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // Turns a pushed store-sync payload into the store to show, or undefined when there is nothing
  // new to show (a stale payload, or one that waits for an earlier payload and a full store reload).
  receiveStorePush(payload: StoreSyncPayload): OpenTeamStore | undefined
}

export function createTeamPageRuntimeClient(deps: TeamPageRuntimeClientDependencies): TeamPageRuntimeClient {
  const storeSync = createStoreSyncDecoder()
  let fullStoreRefresh: Promise<void> | undefined

  const sendRawMessage = <T>(type: string, payload: Record<string, unknown>): Promise<RuntimeResponse<T>> => {
    return new Promise((resolve, reject) => {
      const message: Record<string, unknown> = { type, ...payload, storeSync: true }
      if (storeSync.needsFullStore()) message.storeSyncReset = true
      const hostTabId = deps.getHostTabId()
      if (hostTabId !== undefined && typeof message.hostTabId !== 'number') message.hostTabId = hostTabId
      deps.log.debug('runtime-send:start', { type, hostTabId: message.hostTabId })

      chrome.runtime.sendMessage(message, response => {
        const lastError = chrome.runtime.lastError
        if (lastError) {
          deps.log.warn('runtime-send:failed', { type, error: lastError.message })
          reject(new Error(lastError.message))
          return
        }

        deps.log.debug('runtime-send:response', { type, ok: response?.ok, error: response?.error })
        resolve((response ?? {}) as RuntimeResponse<T>)
      })
    })
  }

  const sendRuntimeMessage = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<RuntimeResponse<T>> => {
    const response = await sendRawMessage<T>(type, payload)
    if (!response.storeSync) return response

    const { storeSync: syncPayload, ...rest } = response
    const result = storeSync.receive(syncPayload)
    if (result.status !== 'gap') return { ...rest, store: result.store }

    // An earlier payload has not arrived yet: fetch the whole store so the caller gets a current one.
    deps.log.warn('store-sync:gap', { type, sequence: syncPayload.sequence, baseSequence: syncPayload.baseSequence })
    const full = await sendRawMessage<T>('GROUP_STORE_GET', {})
    const fullResult = full.storeSync ? storeSync.receive(full.storeSync) : undefined
    return { ...rest, store: fullResult && fullResult.status !== 'gap' ? fullResult.store : full.store }
  }

  const runCommand = async (type: string, payload: Record<string, unknown> = {}): Promise<void> => {
    const response = await sendRuntimeMessage(type, payload)
    if (response.ok === false) throw new Error(response.error || `${type} failed`)
    if (response.store) {
      deps.applyStore(response.store)
      return
    }
    await deps.refreshStore(false)
  }

  const receiveStorePush = (payload: StoreSyncPayload): OpenTeamStore | undefined => {
    const result = storeSync.receive(payload)
    if (result.status === 'applied') return result.store
    if (result.status === 'gap' && !fullStoreRefresh) {
      deps.log.warn('store-sync:gap', { type: 'GROUP_STORE_UPDATED', sequence: payload.sequence, baseSequence: payload.baseSequence })
      // The next request asks for a full store, because the decoder now needs one.
      fullStoreRefresh = deps.refreshStore(false).finally(() => {
        fullStoreRefresh = undefined
      })
    }
    return undefined
  }

  return { sendRuntimeMessage, runCommand, receiveStorePush }
}
