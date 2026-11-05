import { sameStoredValue } from './store'
import type { OpenTeamStore } from './types'

// Store fields sent as deltas: after the first payload to a team page, only the entries that
// changed travel. Everything else in the store is small and is sent in full every time.
export const STORE_SYNC_FIELDS = [
  'chatsById',
  'rolesById',
  'messagesById',
  'roleTemplatesById',
  'orchestrationFlowsById',
  'orchestrationFlowOrderByChatId',
  'orchestrationRunsById',
  'activeOrchestrationRunIdByChatId',
  'chatNotesById',
  'messageHighlightsById',
  'externalRoleMemoriesById',
  'externalChatMemoriesById',
] as const satisfies ReadonlyArray<keyof OpenTeamStore>

export type StoreSyncField = typeof STORE_SYNC_FIELDS[number]

export interface StoreSyncPayload {
  // Changes whenever the background restarts, which also restarts the sequence.
  epoch: string
  // Numbers the payloads sent to one team page.
  sequence: number
  // Set on deltas: `store` then only holds the STORE_SYNC_FIELDS entries that changed since the
  // payload with this sequence, which the receiver must have applied first.
  baseSequence?: number
  store: OpenTeamStore
  removed?: Partial<Record<StoreSyncField, string[]>>
  // STORE_SYNC_FIELDS that are undefined in the store (only listed on deltas).
  absent?: StoreSyncField[]
}

export interface StoreSyncEncoder {
  encode(store: OpenTeamStore, destination: number): StoreSyncPayload
  // Whether `destination` has been sent a payload, so it can receive deltas.
  isTracking(destination: number): boolean
  // Makes the next payload to `destination` a full store.
  reset(destination: number): void
  forget(destination: number): void
}

export type StoreSyncResult =
  | { status: 'applied' | 'stale'; store: OpenTeamStore }
  | { status: 'gap' }

export interface StoreSyncDecoder {
  // 'stale' means a newer payload was already applied, and `store` is that newer store. 'gap'
  // means an earlier payload has not arrived; the delta is kept, and a full store should be requested.
  receive(payload: StoreSyncPayload): StoreSyncResult
  needsFullStore(): boolean
}

type FieldVersions = Map<StoreSyncField, Map<string, number>>

interface DestinationState {
  sequence: number
  versions?: FieldVersions
}

const MAX_WAITING_PAYLOADS = 50

export function createStoreSyncEncoder(epoch = randomEpoch()): StoreSyncEncoder {
  // The last value seen for each entry, with a version that changes whenever the value does.
  const latest = new Map<StoreSyncField, Map<string, { version: number; value: unknown }>>()
  const destinations = new Map<number, DestinationState>()
  let nextVersion = 0

  function versionsOf(store: OpenTeamStore): FieldVersions {
    const versions: FieldVersions = new Map()
    for (const field of STORE_SYNC_FIELDS) {
      const record = readField(store, field)
      const fieldVersions = new Map<string, number>()
      const previous = latest.get(field) ?? new Map<string, { version: number; value: unknown }>()
      const next = new Map<string, { version: number; value: unknown }>()
      for (const [key, value] of Object.entries(record ?? {})) {
        const entry = previous.get(key)
        // Copy changed values, so later changes to the caller's store cannot alter what was sent.
        const current = entry && sameStoredValue(entry.value, value) ? entry : { version: ++nextVersion, value: structuredClone(value) }
        next.set(key, current)
        fieldVersions.set(key, current.version)
      }
      latest.set(field, next)
      versions.set(field, fieldVersions)
    }
    return versions
  }

  function encode(store: OpenTeamStore, destination: number): StoreSyncPayload {
    const versions = versionsOf(store)
    const previous = destinations.get(destination)
    const sequence = (previous?.sequence ?? 0) + 1
    destinations.set(destination, { sequence, versions })
    if (!previous?.versions) return { epoch, sequence, store }

    const delta: Record<string, unknown> = { ...store }
    const removed: Partial<Record<StoreSyncField, string[]>> = {}
    const absent: StoreSyncField[] = []
    for (const field of STORE_SYNC_FIELDS) {
      const record = readField(store, field)
      const before = previous.versions.get(field) ?? new Map<string, number>()
      const after = versions.get(field) ?? new Map<string, number>()
      const changed: Record<string, unknown> = {}
      for (const [key, version] of after) {
        if (before.get(key) !== version) changed[key] = record?.[key]
      }
      const gone = [...before.keys()].filter(key => !after.has(key))
      if (gone.length > 0) removed[field] = gone
      if (record === undefined) absent.push(field)
      delta[field] = record === undefined ? undefined : changed
    }

    return {
      epoch,
      sequence,
      baseSequence: previous.sequence,
      store: delta as unknown as OpenTeamStore,
      ...(Object.keys(removed).length > 0 ? { removed } : {}),
      ...(absent.length > 0 ? { absent } : {}),
    }
  }

  return {
    encode,
    isTracking: destination => Boolean(destinations.get(destination)?.versions),
    reset(destination) {
      const state = destinations.get(destination)
      if (state) destinations.set(destination, { sequence: state.sequence })
    },
    forget(destination) {
      destinations.delete(destination)
    },
  }
}

export function createStoreSyncDecoder(): StoreSyncDecoder {
  let state: { epoch: string; sequence: number; store: OpenTeamStore } | undefined
  const waiting = new Map<string, StoreSyncPayload>()

  function receive(payload: StoreSyncPayload): StoreSyncResult {
    const sameEpoch = state?.epoch === payload.epoch
    if (state && sameEpoch && payload.sequence <= state.sequence) return { status: 'stale', store: state.store }

    if (payload.baseSequence === undefined) {
      if (!sameEpoch) waiting.clear()
      state = { epoch: payload.epoch, sequence: payload.sequence, store: payload.store }
    } else if (state && sameEpoch && payload.baseSequence === state.sequence) {
      state = { epoch: payload.epoch, sequence: payload.sequence, store: applyDelta(state.store, payload) }
    } else {
      waiting.set(waitingKey(payload.epoch, payload.baseSequence), payload)
      while (waiting.size > MAX_WAITING_PAYLOADS) waiting.delete(waiting.keys().next().value!)
      return { status: 'gap' }
    }

    applyWaiting()
    return { status: 'applied', store: state.store }
  }

  function applyWaiting(): void {
    if (!state) return
    for (let next = waiting.get(waitingKey(state.epoch, state.sequence)); next; next = waiting.get(waitingKey(state.epoch, state.sequence))) {
      waiting.delete(waitingKey(state.epoch, state.sequence))
      state = { epoch: next.epoch, sequence: next.sequence, store: applyDelta(state.store, next) }
    }
    for (const [key, payload] of waiting) {
      if (payload.epoch !== state.epoch || payload.sequence <= state.sequence) waiting.delete(key)
    }
  }

  return {
    receive,
    // Until a first store has arrived, or while a delta waits for one that never came.
    needsFullStore: () => !state || waiting.size > 0,
  }
}

function applyDelta(base: OpenTeamStore, payload: StoreSyncPayload): OpenTeamStore {
  const next: Record<string, unknown> = { ...payload.store }
  for (const field of STORE_SYNC_FIELDS) {
    if (payload.absent?.includes(field)) {
      next[field] = undefined
      continue
    }
    const merged: Record<string, unknown> = { ...readField(base, field), ...readField(payload.store, field) }
    for (const key of payload.removed?.[field] ?? []) delete merged[key]
    next[field] = merged
  }
  return next as unknown as OpenTeamStore
}

function readField(store: OpenTeamStore, field: StoreSyncField): Record<string, unknown> | undefined {
  return store[field] as Record<string, unknown> | undefined
}

function waitingKey(epoch: string, baseSequence: number): string {
  return `${epoch}:${baseSequence}`
}

function randomEpoch(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
