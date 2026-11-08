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

describe('project task prompts', () => {
  it("send a member's persona with its first task in the project, also when it has spoken before", () => {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    const role: GroupRole = { id: 'r', chatId: 'c', name: '前端工程师', systemPrompt: '你在这个项目中担任「前端工程师」。', chatSite: 'claude', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
    // It answered the team's invitation before the project started.
    const invitation: GroupMessage = { id: 'inv', chatId: 'c', seq: 1, type: 'user', content: '选职位', targetRoleIds: ['r'], deliveryStatus: { r: 'received' }, createdAt: 1, status: 'received' }
    const goal: GroupMessage = { id: 'goal', chatId: 'c', seq: 2, type: 'user', content: '做记账小程序', projectGoal: true, targetRoleIds: [], createdAt: 2, status: 'received' }
    const task = (id: string, seq: number): GroupMessage => ({ id, chatId: 'c', seq, type: 'user', content: '任务', targetRoleIds: ['r'], projectRequest: { kind: 'task', taskId: 't1' }, deliveryStatus: { r: 'sent' }, createdAt: seq, status: 'pending' })
    const first = task('task-1', 3)
    const second = task('task-2', 4)
    const chat: GroupChat = {
      id: 'c', name: '项目', mode: 'collaborative', roleIds: ['r'], messageIds: ['inv', 'goal', 'task-1', 'task-2'], nextMessageSeq: 5, status: 'running', createdAt: 1, updatedAt: 1,
      project: { id: 'p', goalMessageId: 'goal', coordinatorRoleId: 'r', status: 'running', tasks: [{ id: 't1', title: '做页面', ownerRoleId: 'r', dependsOn: [], detail: '做页面', doneWhen: '能打开', status: 'doing', attempts: 1 }], steps: 1, maxSteps: 20, planAttempts: 1, reviewAttempts: 0, createdAt: 2, updatedAt: 2 },
    }
    Object.assign(store, { chatsById: { c: chat }, rolesById: { r: role }, messagesById: { inv: invitation, goal, 'task-1': first, 'task-2': second } })
    const promptFor = (userMessage: GroupMessage, messages: GroupMessage[]) => prepareRolePromptDelivery({ store, chat, role, userMessage, roles: [role], messages, timestamp: 5, newId: () => 'attempt', runtimeFrames: { getByRole: () => ({ chatId: 'c', roleId: 'r', tabId: 1, frameId: 2, ready: true, lastSeenAt: 1 }) } }).delivery!.message.content

    expect(promptFor(first, [invitation, goal, first])).toContain('人设：\n你在这个项目中担任「前端工程师」。')
    expect(promptFor(second, [invitation, goal, first, second])).not.toContain('人设：')
  })
})
