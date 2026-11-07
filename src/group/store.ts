import { normalizeTeamTemplates } from './teamFormation'
import { isChatSite } from './chatSites'
import {
  DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS,
  DEFAULT_ORCHESTRATION_MAX_ROUNDS,
  DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS,
  MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS,
  MAX_ORCHESTRATION_MAX_ROUNDS,
} from './types'
import { OPENTEAM_CONTROL_DEFAULT_PORT, OPENTEAM_CONTROL_LEGACY_DEFAULT_PORT } from '../shared/localControlProtocol'
import { defaultLanguageForEnvironment, normalizeLanguage } from '../shared/i18n'
import type { ExternalModelConfig, GroupChat, GroupMessage, GroupRole, MessageHighlight, OpenTeamSettings, OpenTeamStore, OpenTeamViewState, OrchestrationFlow, OrchestrationRun, RichNoteDocument, RoleTemplate } from './types'
import { normalizeMessageHighlightColor } from './highlightColors'
import { DEFAULT_CUSTOM_ROLE_TEMPLATES } from './defaultCustomRoleTemplates'

export const STORE_KEY = 'openteam.groupStore'
export const META_STORE_KEY = 'openteam.meta.v2'
export const CHAT_KEY_PREFIX = 'openteam.chat.'
export const MESSAGE_CHUNK_KEY_PREFIX = 'openteam.messages.'
export const STORE_WRITER_KEY = 'openteam.storeWriter'
export const CURRENT_STORE_VERSION = 7
export const MESSAGE_CHUNK_SIZE = 100

interface OpenTeamMetaStore {
  version: number
  currentChatId?: string
  chatOrder: string[]
  roleTemplateOrder: string[]
  roleTemplatesById: Record<string, RoleTemplate>
  orchestrationFlowsById?: Record<string, OrchestrationFlow>
  orchestrationFlowOrderByChatId?: Record<string, string[]>
  orchestrationRunsById?: Record<string, OrchestrationRun>
  activeOrchestrationRunIdByChatId?: Record<string, string>
  globalNote?: RichNoteDocument
  chatNotesById?: Record<string, RichNoteDocument>
  messageHighlightsById?: Record<string, MessageHighlight[]>
  externalRoleMemoriesById?: NonNullable<OpenTeamStore['externalRoleMemoriesById']>
  externalChatMemoriesById?: NonNullable<OpenTeamStore['externalChatMemoriesById']>
  settings: OpenTeamSettings
  viewState?: OpenTeamViewState
}

interface ChatDocument {
  version: number
  chat: GroupChat
  rolesById: Record<string, GroupRole>
  messageChunkIds: string[]
  messageCount: number
}

interface MessageChunk {
  version: number
  chatId: string
  chunkId: string
  fromSeq: number
  toSeq: number
  messages: GroupMessage[]
}

const DEFAULT_SETTINGS: OpenTeamSettings = {
  defaultMode: 'independent',
  maxContextChars: 6000,
  defaultChatSite: 'deepseek',
  externalModelOrder: [],
  externalModelsById: {},
  agentControlEnabled: false,
  agentControlPort: OPENTEAM_CONTROL_DEFAULT_PORT,
  language: defaultLanguageForEnvironment(),
}

// What this context last read from or wrote to chrome.storage for the store keys. While it is
// valid, loads skip storage entirely and saves only write the keys whose values changed. It is
// dropped as soon as storage.onChanged reports a write from any other context.
interface StorageSnapshot {
  area: chrome.storage.LocalStorageArea
  items: Map<string, unknown>
  // Whether storage has been scanned for stale keys that never made it into `items`.
  scanned: boolean
}

type StorageChanges = Record<string, chrome.storage.StorageChange>

let storeQueue: Promise<void> = Promise.resolve()
let snapshot: StorageSnapshot | undefined
let snapshotGeneration = 0
let watchedChangeEvent: unknown
let writerRevision = 0
const writerId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

export function createDefaultStore(): OpenTeamStore {
  return {
    version: CURRENT_STORE_VERSION,
    chatOrder: [],
    chatsById: {},
    rolesById: {},
    messagesById: {},
    roleTemplateOrder: defaultCustomRoleTemplateOrder(),
    roleTemplatesById: defaultCustomRoleTemplatesById(),
    orchestrationFlowsById: {},
    orchestrationFlowOrderByChatId: {},
    orchestrationRunsById: {},
    activeOrchestrationRunIdByChatId: {},
    globalNote: undefined,
    chatNotesById: {},
    messageHighlightsById: {},
    externalRoleMemoriesById: {},
    externalChatMemoriesById: {},
    settings: defaultSettings(),
    viewState: {
      chatReadSeqById: {},
      chatHasNewMessageById: {},
    },
  }
}

export async function loadStore(): Promise<OpenTeamStore> {
  const caching = cachingAvailable()
  const cached = caching ? usableSnapshot() : undefined
  if (cached?.items.has(META_STORE_KEY)) {
    return assembleV2Store(structuredClone(cached.items))
  }

  const generation = snapshotGeneration
  const metaResult = await chrome.storage.local.get(META_STORE_KEY)
  if (metaResult[META_STORE_KEY]) {
    const items = await readV2Items(metaResult[META_STORE_KEY])
    if (caching && generation === snapshotGeneration) {
      snapshot = { area: chrome.storage.local, items: structuredClone(items), scanned: false }
    }
    return assembleV2Store(items)
  }

  const legacyResult = await chrome.storage.local.get(STORE_KEY)
  const legacyStore = normalizeStore(legacyResult[STORE_KEY])
  if (legacyResult[STORE_KEY]) {
    await saveStore(legacyStore)
  }
  return legacyStore
}

export async function saveStore(store: OpenTeamStore): Promise<void> {
  const normalized = normalizeStore(store)
  const items = buildStorageItems(normalized)
  const activeKeys = new Set(Object.keys(items))
  const caching = cachingAvailable()
  const scannedSnapshot = caching ? usableSnapshot() : undefined
  const staleKeys = scannedSnapshot?.scanned
    ? [...scannedSnapshot.items.keys()].filter(key => !activeKeys.has(key))
    : await findStaleStorageKeys(activeKeys)

  // Re-read after the scan: another context may have written meanwhile, and then every key is written.
  const previous = caching ? usableSnapshot() : undefined
  const changedItems: Record<string, unknown> = {}
  const nextItems = new Map<string, unknown>()
  for (const [key, value] of Object.entries(items)) {
    const previousValue = previous?.items.get(key)
    if (previous?.items.has(key) && sameStoredValue(previousValue, value)) {
      nextItems.set(key, previousValue)
    } else {
      changedItems[key] = value
      if (caching) nextItems.set(key, jsonClone(value))
    }
  }

  if (caching) {
    // Record the new state before writing, so this context's own onChanged events already match it.
    snapshot = { area: chrome.storage.local, items: nextItems, scanned: true }
    if (Object.keys(changedItems).length > 0 || staleKeys.length > 0) {
      changedItems[STORE_WRITER_KEY] = { id: writerId, revision: ++writerRevision }
    }
  }

  try {
    if (Object.keys(changedItems).length > 0) await chrome.storage.local.set(changedItems)
    if (staleKeys.length > 0) await chrome.storage.local.remove(staleKeys)
  } catch (error) {
    dropSnapshot()
    throw error
  }
}

export async function updateStore<T>(mutator: (draft: OpenTeamStore) => T | Promise<T>): Promise<T> {
  const store = await loadStore()
  const result = await mutator(store)
  await saveStore(store)
  return result
}

export function updateStoreQueued<T>(mutator: (draft: OpenTeamStore) => T | Promise<T>): Promise<T> {
  const run = async () => updateStore(mutator)
  const next = storeQueue.then(run, run)
  storeQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

// Normalizes store data from outside storage (a backup file) the same way a load does.
export function normalizeStoreData(raw: unknown): OpenTeamStore {
  return normalizeStore(raw)
}

function normalizeStore(raw: unknown): OpenTeamStore {
  if (!isRecord(raw)) {
    return createDefaultStore()
  }

  const defaults = createDefaultStore()
  const storedVersion = typeof raw.version === 'number' ? raw.version : 0
  const normalized: OpenTeamStore = {
    version: Math.max(storedVersion, CURRENT_STORE_VERSION),
    chatOrder: readStringArray(raw.chatOrder, defaults.chatOrder),
    chatsById: readRecord(raw.chatsById),
    rolesById: readRecord(raw.rolesById),
    messagesById: readRecord(raw.messagesById),
    roleTemplateOrder: normalizeRoleTemplateOrder(raw.roleTemplateOrder, raw.roleTemplatesById, defaults.roleTemplateOrder),
    roleTemplatesById: normalizeRoleTemplateRecord(raw.roleTemplatesById),
    orchestrationFlowsById: normalizeOrchestrationFlowRecord(raw.orchestrationFlowsById),
    orchestrationFlowOrderByChatId: readStringArrayRecord(raw.orchestrationFlowOrderByChatId),
    orchestrationRunsById: normalizeOrchestrationRunRecord(raw.orchestrationRunsById),
    activeOrchestrationRunIdByChatId: readStringRecord(raw.activeOrchestrationRunIdByChatId),
    globalNote: normalizeNoteDocument(raw.globalNote),
    chatNotesById: readNoteRecord(raw.chatNotesById),
    messageHighlightsById: readHighlightsRecord(raw.messageHighlightsById),
    externalRoleMemoriesById: readExternalRoleMemoryRecord(raw.externalRoleMemoriesById),
    externalChatMemoriesById: readExternalChatMemoryRecord(raw.externalChatMemoriesById),
    settings: normalizeSettings(raw.settings, storedVersion),
    viewState: normalizeViewState(raw.viewState),
  }

  if (typeof raw.currentChatId === 'string') {
    normalized.currentChatId = raw.currentChatId
  }

  if (shouldSeedDefaultCustomTemplates(storedVersion, normalized)) {
    seedDefaultCustomTemplates(normalized)
  }
  if (shouldMigrateDefaultCustomTemplateSites(storedVersion)) {
    migrateDefaultCustomTemplateSites(normalized)
  }

  return normalized
}

// Reads the meta document plus every chat document and message chunk it references.
async function readV2Items(rawMeta: unknown): Promise<Map<string, unknown>> {
  const items = new Map<string, unknown>([[META_STORE_KEY, rawMeta]])
  const chatKeys = normalizeMetaStore(rawMeta).chatOrder.map(chatStorageKey)
  const chatResult = await chrome.storage.local.get(chatKeys)
  const chatDocuments: ChatDocument[] = []
  for (const key of chatKeys) {
    if (chatResult[key] === undefined) continue
    items.set(key, chatResult[key])
    const document = normalizeChatDocument(chatResult[key])
    if (document) chatDocuments.push(document)
  }

  const chunkKeys = chatDocuments.flatMap(document => document.messageChunkIds.map(chunkId => messageChunkStorageKey(document.chat.id, chunkId)))
  const chunkResult = chunkKeys.length > 0 ? await chrome.storage.local.get(chunkKeys) : {}
  for (const key of chunkKeys) {
    if (chunkResult[key] !== undefined) items.set(key, chunkResult[key])
  }
  return items
}

// Builds the store from raw storage items. The result shares objects with `items`.
function assembleV2Store(items: Map<string, unknown>): OpenTeamStore {
  const meta = normalizeMetaStore(items.get(META_STORE_KEY))
  const chatDocuments = meta.chatOrder
    .map(chatId => normalizeChatDocument(items.get(chatStorageKey(chatId))))
    .filter((document): document is ChatDocument => Boolean(document))

  const store = createDefaultStore()
  store.version = meta.version
  store.currentChatId = meta.currentChatId
  store.chatOrder = chatDocuments.map(document => document.chat.id)
  store.roleTemplateOrder = [...meta.roleTemplateOrder]
  store.roleTemplatesById = normalizeRoleTemplateRecord(meta.roleTemplatesById)
  store.orchestrationFlowsById = { ...(meta.orchestrationFlowsById ?? {}) }
  store.orchestrationFlowOrderByChatId = { ...(meta.orchestrationFlowOrderByChatId ?? {}) }
  store.orchestrationRunsById = { ...(meta.orchestrationRunsById ?? {}) }
  store.activeOrchestrationRunIdByChatId = { ...(meta.activeOrchestrationRunIdByChatId ?? {}) }
  store.globalNote = meta.globalNote
  store.chatNotesById = { ...(meta.chatNotesById ?? {}) }
  store.messageHighlightsById = { ...(meta.messageHighlightsById ?? {}) }
  store.externalRoleMemoriesById = { ...(meta.externalRoleMemoriesById ?? {}) }
  store.externalChatMemoriesById = { ...(meta.externalChatMemoriesById ?? {}) }
  store.settings = normalizeSettings(meta.settings)
  store.viewState = normalizeViewState(meta.viewState)

  for (const document of chatDocuments) {
    store.chatsById[document.chat.id] = { ...document.chat, messageIds: [] }
    store.rolesById = { ...store.rolesById, ...document.rolesById }

    for (const chunkId of document.messageChunkIds) {
      const chunk = normalizeMessageChunk(items.get(messageChunkStorageKey(document.chat.id, chunkId)))
      if (!chunk || chunk.chatId !== document.chat.id) continue

      for (const message of chunk.messages) {
        store.messagesById[message.id] = message
        store.chatsById[document.chat.id].messageIds.push(message.id)
      }
    }
  }

  if (store.currentChatId && !store.chatsById[store.currentChatId]) {
    store.currentChatId = store.chatOrder[0]
  }

  return normalizeStore(store)
}

function buildStorageItems(store: OpenTeamStore): Record<string, unknown> {
  const chatIds = uniqueStrings([...store.chatOrder, ...Object.keys(store.chatsById)])
  const meta: OpenTeamMetaStore = {
    version: CURRENT_STORE_VERSION,
    currentChatId: store.currentChatId,
    chatOrder: chatIds,
    roleTemplateOrder: customRoleTemplateOrder(store),
    roleTemplatesById: customRoleTemplatesById(store),
    orchestrationFlowsById: normalizeOrchestrationFlowRecord(store.orchestrationFlowsById),
    orchestrationFlowOrderByChatId: readStringArrayRecord(store.orchestrationFlowOrderByChatId),
    orchestrationRunsById: normalizeOrchestrationRunRecord(store.orchestrationRunsById),
    activeOrchestrationRunIdByChatId: readStringRecord(store.activeOrchestrationRunIdByChatId),
    globalNote: normalizeNoteDocument(store.globalNote),
    chatNotesById: readNoteRecord(store.chatNotesById),
    messageHighlightsById: readHighlightsRecord(store.messageHighlightsById),
    externalRoleMemoriesById: readExternalRoleMemoryRecord(store.externalRoleMemoriesById),
    externalChatMemoriesById: readExternalChatMemoryRecord(store.externalChatMemoriesById),
    settings: normalizeSettings(store.settings),
    viewState: normalizeViewState(store.viewState),
  }
  const items: Record<string, unknown> = { [META_STORE_KEY]: meta }
  const messagesByChatId = groupMessagesByChat(store)

  for (const chatId of chatIds) {
    const chat = store.chatsById[chatId]
    if (!chat) continue

    const rolesById = collectChatRoles(store, chat)
    const messages = collectChatMessages(store, chat, messagesByChatId.get(chatId) ?? [])
    const messageChunkIds: string[] = []

    messages.forEach((_, index) => {
      if (index % MESSAGE_CHUNK_SIZE !== 0) return

      const chunkMessages = messages.slice(index, index + MESSAGE_CHUNK_SIZE)
      const chunkId = chunkIdForIndex(index / MESSAGE_CHUNK_SIZE)
      messageChunkIds.push(chunkId)
      const chunk: MessageChunk = {
        version: CURRENT_STORE_VERSION,
        chatId,
        chunkId,
        fromSeq: chunkMessages[0]?.seq ?? 0,
        toSeq: chunkMessages[chunkMessages.length - 1]?.seq ?? 0,
        messages: chunkMessages,
      }
      items[messageChunkStorageKey(chatId, chunkId)] = chunk
    })

    const chatDocument: ChatDocument = {
      version: CURRENT_STORE_VERSION,
      chat: { ...chat, messageIds: messages.map(message => message.id) },
      rolesById,
      messageChunkIds,
      messageCount: messages.length,
    }
    items[chatStorageKey(chatId)] = chatDocument
  }

  return items
}

async function findStaleStorageKeys(activeKeys: Set<string>): Promise<string[]> {
  return (await listStorageKeys()).filter(key => (
    key === STORE_KEY
    || key.startsWith(CHAT_KEY_PREFIX)
    || key.startsWith(MESSAGE_CHUNK_KEY_PREFIX)
  ) && !activeKeys.has(key))
}

// storage.local.getKeys() (Chrome 130+) lists keys without reading every value.
async function listStorageKeys(): Promise<string[]> {
  const area = chrome.storage.local as chrome.storage.LocalStorageArea & { getKeys?: () => Promise<string[]> }
  if (typeof area.getKeys === 'function') return area.getKeys()
  return Object.keys(await area.get(null))
}

function cachingAvailable(): boolean {
  const changeEvent = chrome.storage?.onChanged
  if (typeof changeEvent?.addListener !== 'function') return false
  if (watchedChangeEvent !== changeEvent) {
    changeEvent.addListener(handleStorageChanged)
    watchedChangeEvent = changeEvent
    dropSnapshot()
  }
  return true
}

function usableSnapshot(): StorageSnapshot | undefined {
  if (snapshot && snapshot.area !== chrome.storage.local) dropSnapshot()
  return snapshot
}

function dropSnapshot(): void {
  snapshot = undefined
  snapshotGeneration += 1
}

function handleStorageChanged(changes: StorageChanges, areaName: string): void {
  if (areaName !== 'local' || !snapshot) return
  const writer = changes[STORE_WRITER_KEY]?.newValue
  if (isRecord(writer) && writer.id === writerId) return

  const current = snapshot
  const foreignChange = Object.entries(changes).some(([key, change]) => (
    isStoreStorageKey(key)
    // A removal of a key this context no longer holds is its own stale-key cleanup.
    && !(change.newValue === undefined && !current.items.has(key))
  ))
  if (foreignChange) dropSnapshot()
}

function isStoreStorageKey(key: string): boolean {
  return key === META_STORE_KEY
    || key === STORE_KEY
    || key === STORE_WRITER_KEY
    || key.startsWith(CHAT_KEY_PREFIX)
    || key.startsWith(MESSAGE_CHUNK_KEY_PREFIX)
}

// Compares values the way chrome.storage stores them: properties set to undefined are not stored.
export function sameStoredValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => sameStoredValue(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined)
  const rightKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => sameStoredValue(leftRecord[key], rightRecord[key]))
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeMetaStore(raw: unknown): OpenTeamMetaStore {
  const defaults = createDefaultStore()
  if (!isRecord(raw)) {
    return {
      version: CURRENT_STORE_VERSION,
      chatOrder: [],
    roleTemplateOrder: [],
    roleTemplatesById: {},
    orchestrationFlowsById: {},
    orchestrationFlowOrderByChatId: {},
    orchestrationRunsById: {},
    activeOrchestrationRunIdByChatId: {},
    chatNotesById: {},
    messageHighlightsById: {},
    externalRoleMemoriesById: {},
    externalChatMemoriesById: {},
    settings: defaults.settings,
    viewState: defaults.viewState,
  }
  }

  const meta: OpenTeamMetaStore = {
    version: typeof raw.version === 'number' ? raw.version : CURRENT_STORE_VERSION,
    chatOrder: readStringArray(raw.chatOrder, []),
    roleTemplateOrder: normalizeRoleTemplateOrder(raw.roleTemplateOrder, raw.roleTemplatesById, []),
    roleTemplatesById: normalizeRoleTemplateRecord(raw.roleTemplatesById),
    orchestrationFlowsById: normalizeOrchestrationFlowRecord(raw.orchestrationFlowsById),
    orchestrationFlowOrderByChatId: readStringArrayRecord(raw.orchestrationFlowOrderByChatId),
    orchestrationRunsById: normalizeOrchestrationRunRecord(raw.orchestrationRunsById),
    activeOrchestrationRunIdByChatId: readStringRecord(raw.activeOrchestrationRunIdByChatId),
    globalNote: normalizeNoteDocument(raw.globalNote),
    chatNotesById: readNoteRecord(raw.chatNotesById),
    messageHighlightsById: readHighlightsRecord(raw.messageHighlightsById),
    externalRoleMemoriesById: readExternalRoleMemoryRecord(raw.externalRoleMemoriesById),
    externalChatMemoriesById: readExternalChatMemoryRecord(raw.externalChatMemoriesById),
    settings: normalizeSettings(raw.settings, typeof raw.version === 'number' ? raw.version : 0),
    viewState: normalizeViewState(raw.viewState),
  }

  if (typeof raw.currentChatId === 'string') {
    meta.currentChatId = raw.currentChatId
  }

  return meta
}

function normalizeChatDocument(raw: unknown): ChatDocument | undefined {
  if (!isRecord(raw) || !isRecord(raw.chat) || typeof raw.chat.id !== 'string') {
    return undefined
  }

  return {
    version: typeof raw.version === 'number' ? raw.version : CURRENT_STORE_VERSION,
    chat: raw.chat as unknown as GroupChat,
    rolesById: readRecord(raw.rolesById),
    messageChunkIds: readStringArray(raw.messageChunkIds, []),
    messageCount: typeof raw.messageCount === 'number' ? raw.messageCount : 0,
  }
}

function normalizeMessageChunk(raw: unknown): MessageChunk | undefined {
  if (!isRecord(raw) || typeof raw.chatId !== 'string' || typeof raw.chunkId !== 'string' || !Array.isArray(raw.messages)) {
    return undefined
  }

  return {
    version: typeof raw.version === 'number' ? raw.version : CURRENT_STORE_VERSION,
    chatId: raw.chatId,
    chunkId: raw.chunkId,
    fromSeq: typeof raw.fromSeq === 'number' ? raw.fromSeq : 0,
    toSeq: typeof raw.toSeq === 'number' ? raw.toSeq : 0,
    messages: raw.messages.filter((message): message is GroupMessage => isRecord(message) && typeof message.id === 'string'),
  }
}

function collectChatRoles(store: OpenTeamStore, chat: GroupChat): Record<string, GroupRole> {
  const roleIds = new Set(chat.roleIds)
  return Object.fromEntries(Object.entries(store.rolesById).filter(([roleId, role]) => roleIds.has(roleId) || role.chatId === chat.id))
}

function groupMessagesByChat(store: OpenTeamStore): Map<string, GroupMessage[]> {
  const messagesByChatId = new Map<string, GroupMessage[]>()
  for (const message of Object.values(store.messagesById)) {
    const messages = messagesByChatId.get(message.chatId)
    if (messages) messages.push(message)
    else messagesByChatId.set(message.chatId, [message])
  }
  return messagesByChatId
}

// `messagesInChat` holds every stored message whose chatId is this chat, from groupMessagesByChat.
function collectChatMessages(store: OpenTeamStore, chat: GroupChat, messagesInChat: GroupMessage[]): GroupMessage[] {
  const messageIds = new Set(chat.messageIds)
  const messagesById = new Map<string, GroupMessage>()

  for (const messageId of chat.messageIds) {
    const message = store.messagesById[messageId]
    if (message) messagesById.set(message.id, message)
  }

  for (const message of messagesInChat) {
    if (!messageIds.has(message.id)) {
      messagesById.set(message.id, message)
    }
  }

  return [...messagesById.values()].sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt)
}

function normalizeRoleTemplateRecord(raw: unknown): Record<string, RoleTemplate> {
  const record = readRecord(raw)
  const normalized: Record<string, RoleTemplate> = {}
  for (const [id, value] of Object.entries(record)) {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.systemPrompt !== 'string') continue
    if (value.type === 'builtin') continue
    normalized[id] = {
      ...(value as unknown as RoleTemplate),
      type: 'custom',
    }
  }
  return normalized
}

function normalizeRoleTemplateOrder(rawOrder: unknown, rawTemplates: unknown, fallback: string[]): string[] {
  const templates = normalizeRoleTemplateRecord(rawTemplates)
  const ids = new Set(Object.keys(templates))
  return readStringArray(rawOrder, fallback).filter(id => ids.has(id))
}

function normalizeOrchestrationFlowRecord(raw: unknown): Record<string, OrchestrationFlow> {
  const record = readRecord(raw)
  const normalized: Record<string, OrchestrationFlow> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.chatId !== 'string' || typeof value.name !== 'string') continue
    const stages = normalizeOrchestrationStages(value.stages)
    const legacyGraphStages = isRecord(value.graph) ? normalizeOrchestrationStages(value.graph.stageNodes) : []
    const executableStages = stages.length > 0 ? stages : legacyGraphStages
    normalized[value.id || key] = {
      ...(value as unknown as OrchestrationFlow),
      stages: executableStages,
      graph: normalizeOrchestrationGraphSnapshot(value.graph),
      maxNodeExecutions: normalizeOrchestrationMaxNodeExecutions(value.maxNodeExecutions),
      maxRounds: normalizeOrchestrationMaxRounds(value.maxRounds),
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    }
  }
  return normalized
}

function normalizeOrchestrationStages(raw: unknown): OrchestrationFlow['stages'] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(stage => {
    if (!isRecord(stage) || typeof stage.id !== 'string' || (stage.kind !== 'roles' && stage.kind !== 'review') || typeof stage.name !== 'string' || !Array.isArray(stage.roleIds)) return []
    const position = normalizeOrchestrationNodePosition(stage.position)
    const review = normalizeOrchestrationReviewConfig(stage.review)
    return [{
      ...(stage as unknown as OrchestrationFlow['stages'][number]),
      ...(review ? { review } : {}),
      ...(position ? { position } : {}),
    }]
  })
}

function normalizeOrchestrationReviewConfig(raw: unknown): OrchestrationFlow['stages'][number]['review'] | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.reviewerRoleIds)) return undefined
  return {
    ...raw,
    reviewerRoleIds: readStringArray(raw.reviewerRoleIds, []),
    instructions: typeof raw.instructions === 'string' ? raw.instructions : undefined,
    maxAttempts: normalizeOrchestrationReviewMaxAttempts(raw.maxAttempts),
    onMaxAttempts: raw.onMaxAttempts === 'continue' ? 'continue' : 'stop',
  }
}

function normalizeOrchestrationNodePosition(raw: unknown): OrchestrationFlow['stages'][number]['position'] | undefined {
  if (!isRecord(raw) || typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined
  return { x: raw.x, y: raw.y }
}

function normalizeOrchestrationGraphSnapshot(raw: unknown): OrchestrationFlow['graph'] {
  if (!isRecord(raw)) return undefined
  return {
    stageNodes: normalizeOrchestrationStages(raw.stageNodes),
    edges: normalizeOrchestrationGraphEdges(raw.edges),
  }
}

function normalizeOrchestrationGraphEdges(raw: unknown): NonNullable<OrchestrationFlow['graph']>['edges'] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).flatMap(edge => {
    if (typeof edge.sourceStageId !== 'string' || typeof edge.targetStageId !== 'string') return []
    const sourcePort = edge.sourcePort === 'continue'
      ? 'fail'
      : edge.sourcePort === 'out' || edge.sourcePort === 'pass' || edge.sourcePort === 'fail'
        ? edge.sourcePort
        : undefined
    const targetPort = edge.targetPort === 'in' ? edge.targetPort : undefined
    const vertices = normalizeOrchestrationEdgeVertices(edge.vertices)
    return [{
      sourceStageId: edge.sourceStageId,
      targetStageId: edge.targetStageId,
      ...(sourcePort ? { sourcePort } : {}),
      ...(targetPort ? { targetPort } : {}),
      ...(vertices ? { vertices } : {}),
    }]
  })
}

function normalizeOrchestrationEdgeVertices(raw: unknown): NonNullable<NonNullable<OrchestrationFlow['graph']>['edges'][number]['vertices']> | undefined {
  if (!Array.isArray(raw)) return undefined
  const vertices = raw.flatMap(vertex => {
    if (!isRecord(vertex) || typeof vertex.x !== 'number' || typeof vertex.y !== 'number' || !Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) return []
    return [{ x: vertex.x, y: vertex.y }]
  })
  return vertices.length > 0 ? vertices : undefined
}

function normalizeOrchestrationRunRecord(raw: unknown): Record<string, OrchestrationRun> {
  const record = readRecord(raw)
  const normalized: Record<string, OrchestrationRun> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.chatId !== 'string' || typeof value.flowId !== 'string') continue
    normalized[value.id || key] = {
      ...(value as unknown as OrchestrationRun),
      status: normalizeOrchestrationRunStatus(value.status),
      currentRound: typeof value.currentRound === 'number' ? value.currentRound : 1,
      maxNodeExecutions: normalizeOrchestrationMaxNodeExecutions(value.maxNodeExecutions),
      maxRounds: normalizeOrchestrationMaxRounds(value.maxRounds),
      stageRuns: Array.isArray(value.stageRuns) ? value.stageRuns as OrchestrationRun['stageRuns'] : [],
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    }
  }
  return normalized
}

function normalizeOrchestrationRunStatus(raw: unknown): OrchestrationRun['status'] {
  return raw === 'running' || raw === 'completed' || raw === 'stopped' || raw === 'error' ? raw : 'pending'
}

function normalizeOrchestrationMaxRounds(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ORCHESTRATION_MAX_ROUNDS
  return Math.min(MAX_ORCHESTRATION_MAX_ROUNDS, Math.max(1, Math.floor(raw)))
}

function normalizeOrchestrationMaxNodeExecutions(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS
  return Math.min(MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS, Math.max(1, Math.floor(raw)))
}

function normalizeOrchestrationReviewMaxAttempts(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS
  return Math.min(MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS, Math.max(1, Math.floor(raw)))
}

function shouldSeedDefaultCustomTemplates(storedVersion: number, store: OpenTeamStore): boolean {
  return storedVersion < CURRENT_STORE_VERSION && store.roleTemplateOrder.length === 0 && Object.keys(store.roleTemplatesById).length === 0
}

function shouldMigrateDefaultCustomTemplateSites(storedVersion: number): boolean {
  return storedVersion < 6
}

function migrateDefaultCustomTemplateSites(store: OpenTeamStore): void {
  for (const template of DEFAULT_CUSTOM_ROLE_TEMPLATES) {
    const storedTemplate = store.roleTemplatesById[template.id]
    if (storedTemplate?.type === 'custom' && storedTemplate.defaultChatSite === 'gemini') {
      storedTemplate.defaultChatSite = 'deepseek'
    }
  }
}

function seedDefaultCustomTemplates(store: OpenTeamStore): void {
  store.roleTemplateOrder = defaultCustomRoleTemplateOrder()
  store.roleTemplatesById = defaultCustomRoleTemplatesById()
}

function defaultCustomRoleTemplateOrder(): string[] {
  return DEFAULT_CUSTOM_ROLE_TEMPLATES.map(template => template.id)
}

function defaultCustomRoleTemplatesById(): Record<string, RoleTemplate> {
  return Object.fromEntries(DEFAULT_CUSTOM_ROLE_TEMPLATES.map(template => [template.id, { ...template }]))
}

function defaultSettings(): OpenTeamSettings {
  return { ...DEFAULT_SETTINGS, language: defaultLanguageForEnvironment() }
}

function customRoleTemplateOrder(store: OpenTeamStore): string[] {
  const customIds = new Set(Object.entries(store.roleTemplatesById)
    .filter(([, template]) => template.type !== 'builtin')
    .map(([id]) => id))
  return store.roleTemplateOrder.filter(id => customIds.has(id))
}

function customRoleTemplatesById(store: OpenTeamStore): Record<string, RoleTemplate> {
  return Object.fromEntries(Object.entries(store.roleTemplatesById).filter(([, template]) => template.type !== 'builtin'))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function chunkIdForIndex(index: number): string {
  return String(index + 1).padStart(6, '0')
}

export function chatStorageKey(chatId: string): string {
  return `${CHAT_KEY_PREFIX}${chatId}`
}

export function messageChunkStorageKey(chatId: string, chunkId: string): string {
  return `${MESSAGE_CHUNK_KEY_PREFIX}${chatId}.${chunkId}`
}

function normalizeSettings(raw: unknown, storedVersion = CURRENT_STORE_VERSION): OpenTeamSettings {
  if (!isRecord(raw)) {
    return defaultSettings()
  }

  const externalModelsById = normalizeExternalModelRecord(raw.externalModelsById)
  const defaultChatSite = readSettingsChatSite(raw.defaultChatSite)
  return {
    defaultMode: raw.defaultMode === 'collaborative' ? 'collaborative' : DEFAULT_SETTINGS.defaultMode,
    maxContextChars: typeof raw.maxContextChars === 'number' ? raw.maxContextChars : DEFAULT_SETTINGS.maxContextChars,
    defaultChatSite: storedVersion < 6 && defaultChatSite === 'gemini' ? DEFAULT_SETTINGS.defaultChatSite : defaultChatSite,
    externalModelOrder: normalizeExternalModelOrder(raw.externalModelOrder, externalModelsById),
    externalModelsById,
    agentControlEnabled: raw.agentControlEnabled === true,
    agentControlPort: readAgentControlPort(raw.agentControlPort, storedVersion),
    language: readSettingsLanguage(raw.language),
    ...teamTemplatesSetting(raw.teamTemplates),
    ...(raw.replyNotifications === false ? { replyNotifications: false } : {}),
    ...(raw.replyKeyPoints === false ? { replyKeyPoints: false } : {}),
    ...(raw.roundSummary === false ? { roundSummary: false } : {}),
  }
}

function teamTemplatesSetting(raw: unknown): Pick<OpenTeamSettings, 'teamTemplates'> {
  const teamTemplates = normalizeTeamTemplates(raw)
  return teamTemplates.length > 0 ? { teamTemplates } : {}
}

function readSettingsLanguage(raw: unknown): OpenTeamSettings['language'] {
  if (typeof raw === 'undefined' || raw === null) return defaultLanguageForEnvironment()
  return normalizeLanguage(raw)
}

function readAgentControlPort(raw: unknown, storedVersion: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return DEFAULT_SETTINGS.agentControlPort
  if (raw < 1024 || raw > 65535) return DEFAULT_SETTINGS.agentControlPort
  if (storedVersion < 7 && raw === OPENTEAM_CONTROL_LEGACY_DEFAULT_PORT) return OPENTEAM_CONTROL_DEFAULT_PORT
  return raw
}

function readSettingsChatSite(raw: unknown): OpenTeamSettings['defaultChatSite'] {
  return isChatSite(raw) ? raw : DEFAULT_SETTINGS.defaultChatSite
}

function normalizeExternalModelRecord(raw: unknown): Record<string, ExternalModelConfig> {
  const record = readRecord(raw)
  const normalized: Record<string, ExternalModelConfig> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!isRecord(value)) continue
    const id = readTrimmedString(value.id) ?? key
    const name = readTrimmedString(value.name)
    const baseUrl = readTrimmedString(value.baseUrl)
    const apiKey = readTrimmedString(value.apiKey)
    const modelName = readTrimmedString(value.modelName)
    const format = value.format === 'anthropic' ? 'anthropic' : value.format === 'openai' ? 'openai' : value.format === 'local-agent' ? 'local-agent' : undefined
    const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0
    const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : 0
    if (format === 'local-agent') {
      const localAgentId = readTrimmedString(value.localAgentId)
      const workspace = readTrimmedString(value.workspace)
      if (!id || !name || !localAgentId || !workspace) continue
      normalized[id] = { id, name, format, baseUrl: '', apiKey: '', modelName: localAgentId, localAgentId, workspace, createdAt, updatedAt }
      continue
    }
    if (!id || !name || !baseUrl || !apiKey || !modelName || !format) continue
    normalized[id] = {
      id,
      name,
      format,
      baseUrl,
      apiKey,
      modelName,
      createdAt,
      updatedAt,
    }
  }
  return normalized
}

function normalizeExternalModelOrder(raw: unknown, modelsById: Record<string, ExternalModelConfig>): string[] {
  const ids = new Set(Object.keys(modelsById))
  const ordered = readStringArray(raw, []).filter(id => ids.has(id))
  for (const id of ids) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  return ordered
}

function normalizeViewState(raw: unknown): NonNullable<OpenTeamStore['viewState']> {
  if (!isRecord(raw)) {
    return { chatReadSeqById: {}, chatHasNewMessageById: {} }
  }

  return {
    chatReadSeqById: readNumberRecord(raw.chatReadSeqById),
    chatHasNewMessageById: readBooleanRecord(raw.chatHasNewMessageById),
  }
}

function readStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback]
  }

  return raw.filter((item): item is string => typeof item === 'string')
}

function readStringArrayRecord(raw: unknown): Record<string, string[]> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, readStringArray(value, [])]))
}

function readStringRecord(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function readRecord<T>(raw: unknown): Record<string, T> {
  if (!isRecord(raw)) {
    return {}
  }

  return raw as Record<string, T>
}

function readNumberRecord(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

function readBooleanRecord(raw: unknown): Record<string, boolean> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

function readNoteRecord(raw: unknown): Record<string, RichNoteDocument> {
  if (!isRecord(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [key, normalizeNoteDocument(value)] as const)
      .filter((entry): entry is [string, RichNoteDocument] => Boolean(entry[1])),
  )
}

function readHighlightsRecord(raw: unknown): Record<string, MessageHighlight[]> {
  if (!isRecord(raw)) return {}
  const result: Record<string, MessageHighlight[]> = {}
  for (const [messageId, rawHighlights] of Object.entries(raw)) {
    if (!Array.isArray(rawHighlights)) continue
    const highlights = rawHighlights
      .filter((highlight): highlight is MessageHighlight => {
        return (
          isRecord(highlight) &&
          typeof highlight.id === 'string' &&
          typeof highlight.messageId === 'string' &&
          typeof highlight.text === 'string' &&
          typeof highlight.startOffset === 'number' &&
          typeof highlight.endOffset === 'number' &&
          typeof highlight.createdAt === 'number'
        )
      })
      .map(highlight => ({ ...highlight, color: normalizeMessageHighlightColor(highlight.color) }))
    if (highlights.length > 0) result[messageId] = highlights
  }
  return result
}

function readExternalRoleMemoryRecord(raw: unknown): NonNullable<OpenTeamStore['externalRoleMemoriesById']> {
  if (!isRecord(raw)) return {}
  const result: NonNullable<OpenTeamStore['externalRoleMemoriesById']> = {}
  for (const [roleId, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const memoryRoleId = readTrimmedString(value.roleId) ?? roleId
    if (!memoryRoleId || typeof value.summarizedThroughSeq !== 'number' || typeof value.updatedAt !== 'number') continue
    result[memoryRoleId] = {
      roleId: memoryRoleId,
      summary: readTrimmedString(value.summary),
      summarizedThroughSeq: value.summarizedThroughSeq,
      updatedAt: value.updatedAt,
    }
  }
  return result
}

function readExternalChatMemoryRecord(raw: unknown): NonNullable<OpenTeamStore['externalChatMemoriesById']> {
  if (!isRecord(raw)) return {}
  const result: NonNullable<OpenTeamStore['externalChatMemoriesById']> = {}
  for (const [chatId, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const memoryChatId = readTrimmedString(value.chatId) ?? chatId
    if (!memoryChatId || typeof value.summarizedThroughSeq !== 'number' || typeof value.updatedAt !== 'number') continue
    result[memoryChatId] = {
      chatId: memoryChatId,
      summary: readTrimmedString(value.summary),
      summarizedThroughSeq: value.summarizedThroughSeq,
      updatedAt: value.updatedAt,
    }
  }
  return result
}

function normalizeNoteDocument(raw: unknown): RichNoteDocument | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined
  return raw as RichNoteDocument
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
