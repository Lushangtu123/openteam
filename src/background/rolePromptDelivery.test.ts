import { describe, expect, it } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { ExternalModelFormat, GroupChat, GroupMessage, GroupRole } from '../group/types'
import { prepareRolePromptDelivery } from './rolePromptDelivery'

describe('team execution handbook delivery', () => {
  it.each(['site', 'openai', 'local-agent'] as const)('sends the selected handbook intact to a %s member', source => {
    const store = createDefaultStore()
    const content = '# PWA\n先核对需求，再实现、验证和交付。\n' + '完整手册内容。'.repeat(1200)
    const chat: GroupChat = { id: 'c', name: '项目', mode: 'collaborative', roleIds: ['r'], messageIds: ['m'], nextMessageSeq: 2, status: 'ready', createdAt: 1, updatedAt: 1, executionHandbook: { id: 'pwa', name: 'PWA Skills', content } }
    const role: GroupRole = { id: 'r', chatId: 'c', name: '工程师', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1, ...(source === 'site' ? { chatSite: 'chatgpt' as const } : { modelSource: 'external' as const, externalModelId: 'model' }) }
    const userMessage: GroupMessage = { id: 'm', chatId: 'c', seq: 1, type: 'user', content: '实现待办工具', targetRoleIds: ['r'], createdAt: 1, status: 'pending' }
    if (source !== 'site') store.settings.externalModelsById.model = { id: 'model', name: '模型', format: source as ExternalModelFormat, baseUrl: '', apiKey: '', modelName: 'custom', createdAt: 1, updatedAt: 1 }
    store.chatsById.c = chat
    store.rolesById.r = role
    store.messagesById.m = userMessage
    const prepared = prepareRolePromptDelivery({ store, chat, role, userMessage, roles: [role], messages: [userMessage], timestamp: 2, newId: () => 'attempt', runtimeFrames: { getByRole: () => ({ chatId: 'c', roleId: 'r', tabId: 1, frameId: 2, ready: true, lastSeenAt: 1 }) } })
    const prompt = prepared.externalDelivery?.prompt ?? prepared.delivery?.message.content
    expect(prompt).toContain(content)
    expect(prompt).toContain('PWA Skills')
    expect(prompt).toContain('实现待办工具')
  })
})
