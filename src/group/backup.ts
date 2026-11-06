import { normalizeStoreData } from './store'
import type { OpenTeamStore } from './types'

export const BACKUP_FORMAT = 'openteam-backup'
export const BACKUP_VERSION = 1

export interface BackupImage {
  id: string
  chatId: string
  messageId: string
  mimeType: string
  fileName: string
  size: number
  createdAt: number
  // Base64 of the image bytes.
  data: string
}

// A whole OpenTeam data set in one JSON file. API keys of external models are only written into it
// when the user asks for that: a backup file is easy to copy, share or upload by accident.
export interface OpenTeamBackup {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  extensionVersion?: string
  store: OpenTeamStore
  images: BackupImage[]
}

export interface BackupSummary {
  chats: number
  messages: number
  people: number
  images: number
}

export type RestoreMode = 'merge' | 'replace'

export interface RestoreResult {
  store: OpenTeamStore
  addedChatIds: string[]
  // Chats left as they are because the current data already has a chat with the same id.
  skippedChatIds: string[]
}

export interface BackupModel {
  id: string
  name: string
}

export type ParsedBackup =
  // `modelsWithoutKeys`: external models saved without an API key. OpenTeam cannot keep a model
  // without its key, so these are only restored where this browser already has them configured.
  | { ok: true; backup: OpenTeamBackup; modelsWithoutKeys: BackupModel[] }
  | { ok: false; error: string }

export function createBackup(store: OpenTeamStore, options: { exportedAt: Date; extensionVersion?: string; images?: BackupImage[]; includeApiKeys?: boolean }): OpenTeamBackup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: options.exportedAt.toISOString(),
    ...(options.extensionVersion ? { extensionVersion: options.extensionVersion } : {}),
    store: options.includeApiKeys ? store : withoutApiKeys(store),
    images: options.images ?? [],
  }
}

export function parseBackup(raw: unknown): ParsedBackup {
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) return { ok: false, error: '这不是 OpenTeam 备份文件' }
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) return { ok: false, error: '这个备份来自更新版本的 OpenTeam，请先升级扩展' }
  if (!isRecord(raw.store) || !Array.isArray(raw.store.chatOrder) || !isRecord(raw.store.chatsById)) return { ok: false, error: '备份文件里没有可用的群聊数据' }

  const images = Array.isArray(raw.images) ? raw.images.filter(isBackupImage) : []
  const rawModels = isRecord(raw.store.settings) && isRecord(raw.store.settings.externalModelsById) ? Object.entries(raw.store.settings.externalModelsById) : []
  const modelsWithoutKeys = rawModels
    .filter(([, model]) => isRecord(model) && !(typeof model.apiKey === 'string' && model.apiKey.trim()))
    .map(([id, model]) => ({ id, name: isRecord(model) && typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id }))
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      version: raw.version,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
      ...(typeof raw.extensionVersion === 'string' ? { extensionVersion: raw.extensionVersion } : {}),
      store: normalizeStoreData(raw.store),
      images,
    },
    modelsWithoutKeys,
  }
}

export function summarizeBackup(backup: OpenTeamBackup): BackupSummary {
  const chats = backup.store.chatOrder.filter(chatId => backup.store.chatsById[chatId])
  return {
    chats: chats.length,
    messages: chats.reduce((count, chatId) => count + backup.store.chatsById[chatId].messageIds.length, 0),
    people: Object.values(backup.store.roleTemplatesById).filter(template => template.type !== 'builtin').length,
    images: backup.images.length,
  }
}

// Ids of the stored images that messages show: the blobs worth backing up, and the ones to keep.
export function referencedImageIds(store: OpenTeamStore): string[] {
  return [...new Set(Object.values(store.messagesById)
    .flatMap(message => message.attachments ?? [])
    .filter(attachment => attachment.type === 'image' && attachment.status === 'ready')
    .map(attachment => attachment.id))]
}

// 'replace' makes the backup the whole data set, except that external models configured here are
// kept (a backup usually has no API keys). 'merge' adds the backup's chats (with their people,
// messages, notes, highlights, flows and runs), custom people and external models that the current
// data does not have, and keeps everything else, including settings, as it is.
export function restoreBackup(current: OpenTeamStore, backupStore: OpenTeamStore, mode: RestoreMode): RestoreResult {
  const backupChatIds = backupStore.chatOrder.filter(chatId => backupStore.chatsById[chatId])
  if (mode === 'replace') {
    const store = structuredClone(backupStore)
    for (const modelId of current.settings.externalModelOrder) {
      const model = current.settings.externalModelsById[modelId]
      if (!model || store.settings.externalModelsById[modelId]) continue
      store.settings.externalModelsById[modelId] = structuredClone(model)
      store.settings.externalModelOrder.push(modelId)
    }
    return { store, addedChatIds: backupChatIds, skippedChatIds: [] }
  }

  const store = structuredClone(current)
  const source = structuredClone(backupStore)
  const addedChatIds: string[] = []
  const skippedChatIds: string[] = []
  for (const chatId of backupChatIds) {
    if (store.chatsById[chatId]) {
      skippedChatIds.push(chatId)
      continue
    }
    addChat(store, source, chatId)
    addedChatIds.push(chatId)
  }

  for (const templateId of source.roleTemplateOrder) {
    const template = source.roleTemplatesById[templateId]
    if (!template || template.type === 'builtin' || store.roleTemplatesById[templateId]) continue
    store.roleTemplatesById[templateId] = template
    store.roleTemplateOrder.push(templateId)
  }

  // External models the restored people may use (only those saved with their API key).
  for (const modelId of source.settings.externalModelOrder) {
    const model = source.settings.externalModelsById[modelId]
    if (!model || store.settings.externalModelsById[modelId]) continue
    store.settings.externalModelsById[modelId] = model
    store.settings.externalModelOrder.push(modelId)
  }

  // Saved teams the current data does not have.
  for (const template of source.settings.teamTemplates ?? []) {
    const templates = store.settings.teamTemplates ?? []
    if (templates.some(existing => existing.id === template.id)) continue
    store.settings.teamTemplates = [...templates, template]
  }

  if (!store.globalNote && source.globalNote) store.globalNote = source.globalNote
  if (!store.currentChatId && addedChatIds.length > 0) store.currentChatId = addedChatIds[0]
  return { store, addedChatIds, skippedChatIds }
}

function addChat(store: OpenTeamStore, source: OpenTeamStore, chatId: string): void {
  const chat = source.chatsById[chatId]
  store.chatsById[chatId] = chat
  store.chatOrder.push(chatId)

  const roleIds = new Set(chat.roleIds)
  for (const [roleId, role] of Object.entries(source.rolesById)) {
    if (roleIds.has(roleId) || role.chatId === chatId) {
      store.rolesById[roleId] = role
      const roleMemory = source.externalRoleMemoriesById?.[roleId]
      if (roleMemory) (store.externalRoleMemoriesById ??= {})[roleId] = roleMemory
    }
  }

  const messageIds = new Set(chat.messageIds)
  for (const [messageId, message] of Object.entries(source.messagesById)) {
    if (!messageIds.has(messageId) && message.chatId !== chatId) continue
    store.messagesById[messageId] = message
    const highlights = source.messageHighlightsById?.[messageId]
    if (highlights) (store.messageHighlightsById ??= {})[messageId] = highlights
  }

  const note = source.chatNotesById?.[chatId]
  if (note) (store.chatNotesById ??= {})[chatId] = note
  const chatMemory = source.externalChatMemoriesById?.[chatId]
  if (chatMemory) (store.externalChatMemoriesById ??= {})[chatId] = chatMemory

  const flowIds = source.orchestrationFlowOrderByChatId[chatId] ?? []
  if (flowIds.length > 0) store.orchestrationFlowOrderByChatId[chatId] = flowIds
  for (const [flowId, flow] of Object.entries(source.orchestrationFlowsById)) {
    if (flow.chatId === chatId || flowIds.includes(flowId)) store.orchestrationFlowsById[flowId] = flow
  }
  for (const [runId, run] of Object.entries(source.orchestrationRunsById)) {
    if (run.chatId === chatId) store.orchestrationRunsById[runId] = run
  }
  const activeRunId = source.activeOrchestrationRunIdByChatId[chatId]
  if (activeRunId) store.activeOrchestrationRunIdByChatId[chatId] = activeRunId

  const readSeq = source.viewState?.chatReadSeqById?.[chatId]
  if (readSeq !== undefined) {
    store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
    ;(store.viewState.chatReadSeqById ??= {})[chatId] = readSeq
  }
}

function withoutApiKeys(store: OpenTeamStore): OpenTeamStore {
  const externalModelsById = Object.fromEntries(
    Object.entries(store.settings.externalModelsById).map(([id, model]) => [id, { ...model, apiKey: '' }]),
  )
  return { ...store, settings: { ...store.settings, externalModelsById } }
}

function isBackupImage(value: unknown): value is BackupImage {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.chatId === 'string'
    && typeof value.messageId === 'string'
    && typeof value.mimeType === 'string'
    && value.mimeType.startsWith('image/')
    && typeof value.data === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
