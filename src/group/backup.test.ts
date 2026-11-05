import { describe, expect, it } from 'vitest'
import { BACKUP_FORMAT, BACKUP_VERSION, createBackup, parseBackup, referencedImageIds, restoreBackup, summarizeBackup } from './backup'
import { createDefaultStore } from './store'
import type { GroupMessage, OpenTeamStore } from './types'

function addChat(store: OpenTeamStore, chatId: string, messageCount = 2): void {
  const roleId = `${chatId}-role`
  const messageIds = Array.from({ length: messageCount }, (_, index) => `${chatId}-msg-${index}`)
  store.chatOrder.push(chatId)
  store.chatsById[chatId] = { id: chatId, name: chatId, mode: 'independent', roleIds: [roleId], messageIds, nextMessageSeq: messageCount + 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.rolesById[roleId] = { id: roleId, chatId, name: `${chatId} 工程师`, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  messageIds.forEach((id, index) => {
    store.messagesById[id] = { id, chatId, seq: index + 1, type: 'user', content: `${chatId} message ${index}`, createdAt: index, status: 'sent' } satisfies GroupMessage
  })
}

function storeWithKeyedModel(apiKey: string): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.externalModelOrder = ['model-1']
  store.settings.externalModelsById = { 'model-1': { id: 'model-1', name: 'GPT API', format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey, modelName: 'gpt', createdAt: 1, updatedAt: 1 } }
  return store
}

function roundTrip(store: OpenTeamStore, includeApiKeys = false) {
  const parsed = parseBackup(JSON.parse(JSON.stringify(createBackup(store, { exportedAt: new Date('2026-11-05T08:00:00Z'), includeApiKeys }))))
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed
}

describe('backup', () => {
  it('never writes API keys into the backup file', () => {
    const store = storeWithKeyedModel('sk-secret')
    addChat(store, 'chat-1')

    const backup = createBackup(store, { exportedAt: new Date('2026-11-05T08:00:00Z'), extensionVersion: '1.0.3' })

    expect(JSON.stringify(backup)).not.toContain('sk-secret')
    expect(backup.store.settings.externalModelsById['model-1']).toMatchObject({ name: 'GPT API', apiKey: '' })
    expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2026-11-05T08:00:00.000Z', extensionVersion: '1.0.3' })
    expect(store.settings.externalModelsById['model-1'].apiKey).toBe('sk-secret')
  })

  it('writes API keys only when asked to, and names the models that come without one', () => {
    const store = storeWithKeyedModel('sk-secret')

    const withKeys = roundTrip(store, true)
    expect(withKeys.backup.store.settings.externalModelsById['model-1'].apiKey).toBe('sk-secret')
    expect(withKeys.modelsWithoutKeys).toEqual([])

    const withoutKeys = roundTrip(store)
    // OpenTeam cannot keep a model without its key, so it is not in the restored data, only named.
    expect(withoutKeys.backup.store.settings.externalModelsById['model-1']).toBeUndefined()
    expect(withoutKeys.modelsWithoutKeys).toEqual([{ id: 'model-1', name: 'GPT API' }])
  })

  it('rejects files that are not usable backups', () => {
    expect(parseBackup({ hello: 'world' })).toEqual({ ok: false, error: '这不是 OpenTeam 备份文件' })
    expect(parseBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, store: {} })).toEqual({ ok: false, error: '这个备份来自更新版本的 OpenTeam，请先升级扩展' })
    expect(parseBackup({ format: BACKUP_FORMAT, version: 1, store: { chatOrder: 'x' } })).toEqual({ ok: false, error: '备份文件里没有可用的群聊数据' })
  })

  it('keeps only well-formed images and counts what a backup holds', () => {
    const store = createDefaultStore()
    addChat(store, 'chat-1', 3)
    addChat(store, 'chat-2', 2)
    const raw = JSON.parse(JSON.stringify(createBackup(store, { exportedAt: new Date(), images: [{ id: 'img-1', chatId: 'chat-1', messageId: 'chat-1-msg-0', mimeType: 'image/png', fileName: 'a.png', size: 3, createdAt: 1, data: 'AAAA' }] })))
    raw.images.push({ id: 'bad', mimeType: 'text/html', data: 'x' })

    const parsed = parseBackup(raw)
    if (!parsed.ok) throw new Error(parsed.error)

    expect(parsed.backup.images.map(image => image.id)).toEqual(['img-1'])
    expect(summarizeBackup(parsed.backup)).toMatchObject({ chats: 2, messages: 5, images: 1 })
  })

  it('merges in only the chats that are not there yet, with everything that belongs to them', () => {
    const current = storeWithKeyedModel('sk-current')
    addChat(current, 'chat-1')
    current.currentChatId = 'chat-1'
    current.chatsById['chat-1'].name = 'current name'

    const source = createDefaultStore()
    addChat(source, 'chat-1')
    addChat(source, 'chat-2', 3)
    source.chatNotesById = { 'chat-2': { type: 'doc', content: [] } as never }
    source.messageHighlightsById = { 'chat-2-msg-1': [{ id: 'h1', messageId: 'chat-2-msg-1', text: 'x', startOffset: 0, endOffset: 1, createdAt: 1 }] }
    source.orchestrationFlowsById = { 'flow-1': { id: 'flow-1', chatId: 'chat-2', name: 'flow', stages: [], createdAt: 1, updatedAt: 1 } as never }
    source.orchestrationFlowOrderByChatId = { 'chat-2': ['flow-1'] }
    source.orchestrationRunsById = { 'run-1': { id: 'run-1', chatId: 'chat-2', flowId: 'flow-1', status: 'completed' } as never }
    source.externalChatMemoriesById = { 'chat-2': { chatId: 'chat-2', summarizedThroughSeq: 2, updatedAt: 1 } }
    source.externalRoleMemoriesById = { 'chat-2-role': { roleId: 'chat-2-role', summarizedThroughSeq: 2, updatedAt: 1 } }
    source.roleTemplateOrder.push('custom-1')
    source.roleTemplatesById['custom-1'] = { id: 'custom-1', type: 'custom', name: '新人员', systemPrompt: 'p', createdAt: 1, updatedAt: 1 }
    source.settings.externalModelOrder = ['model-1', 'model-2']
    source.settings.externalModelsById = {
      'model-1': { id: 'model-1', name: 'GPT API (old)', format: 'openai', baseUrl: 'https://a', apiKey: 'sk-old', modelName: 'gpt', createdAt: 1, updatedAt: 1 },
      'model-2': { id: 'model-2', name: 'Other API', format: 'openai', baseUrl: 'https://b', apiKey: 'sk-other', modelName: 'm', createdAt: 1, updatedAt: 1 },
    }
    source.settings.defaultChatSite = 'grok'

    const { store, addedChatIds, skippedChatIds } = restoreBackup(current, roundTrip(source, true).backup.store, 'merge')

    expect(addedChatIds).toEqual(['chat-2'])
    expect(skippedChatIds).toEqual(['chat-1'])
    expect(store.chatOrder).toEqual(['chat-1', 'chat-2'])
    expect(store.chatsById['chat-1'].name).toBe('current name')
    expect(store.currentChatId).toBe('chat-1')
    expect(store.rolesById['chat-2-role'].name).toBe('chat-2 工程师')
    expect(store.chatsById['chat-2'].messageIds.every(id => store.messagesById[id])).toBe(true)
    expect(store.chatNotesById?.['chat-2']).toBeDefined()
    expect(store.messageHighlightsById?.['chat-2-msg-1']).toHaveLength(1)
    expect(store.orchestrationFlowsById['flow-1']).toBeDefined()
    expect(store.orchestrationFlowOrderByChatId['chat-2']).toEqual(['flow-1'])
    expect(store.orchestrationRunsById['run-1']).toBeDefined()
    expect(store.externalChatMemoriesById?.['chat-2']).toBeDefined()
    expect(store.externalRoleMemoriesById?.['chat-2-role']).toBeDefined()
    expect(store.roleTemplatesById['custom-1'].name).toBe('新人员')
    expect(store.roleTemplateOrder).toContain('custom-1')
    expect(store.settings.defaultChatSite).toBe(current.settings.defaultChatSite)
    expect(store.settings.externalModelsById['model-1']).toMatchObject({ name: 'GPT API', apiKey: 'sk-current' })
    expect(store.settings.externalModelsById['model-2']).toMatchObject({ name: 'Other API', apiKey: 'sk-other' })
    expect(store.settings.externalModelOrder).toEqual(['model-1', 'model-2'])
    expect(current.chatOrder).toEqual(['chat-1'])
  })

  it('replaces everything but keeps the API models configured here', () => {
    const current = storeWithKeyedModel('sk-current')
    addChat(current, 'chat-old')
    const source = storeWithKeyedModel('sk-from-elsewhere')
    addChat(source, 'chat-new')
    source.settings.defaultChatSite = 'claude'

    const { store, addedChatIds } = restoreBackup(current, roundTrip(source).backup.store, 'replace')

    expect(addedChatIds).toEqual(['chat-new'])
    expect(store.chatOrder).toEqual(['chat-new'])
    expect(store.chatsById['chat-old']).toBeUndefined()
    expect(store.settings.defaultChatSite).toBe('claude')
    expect(store.settings.externalModelsById['model-1'].apiKey).toBe('sk-current')
  })

  it('lists the stored images that messages show', () => {
    const store = createDefaultStore()
    addChat(store, 'chat-1')
    store.messagesById['chat-1-msg-0'].attachments = [
      { id: 'img-1', type: 'image', status: 'ready' } as never,
      { id: 'img-2', type: 'image', status: 'error' } as never,
    ]

    expect(referencedImageIds(store)).toEqual(['img-1'])
  })
})
