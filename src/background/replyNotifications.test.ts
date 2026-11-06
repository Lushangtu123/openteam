import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { DeliveryStatus, OpenTeamStore } from '../group/types'
import { chatIdFromNotificationId, createReplyNotifier, findAnsweredPrompt, replyNotificationText } from './replyNotifications'

function storeWith(statuses: Record<string, DeliveryStatus>, settings: Partial<OpenTeamStore['settings']> = {}): OpenTeamStore {
  const store = createDefaultStore()
  store.settings = { ...store.settings, language: 'zh-CN', ...settings }
  store.chatsById['chat-1'] = { id: 'chat-1', name: '上线评审', mode: 'independent', roleIds: ['r1', 'r2'], messageIds: ['m1'], nextMessageSeq: 2, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.rolesById.r1 = { id: 'r1', chatId: 'chat-1', name: '工程师', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
  store.rolesById.r2 = { id: 'r2', chatId: 'chat-1', name: '设计师', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
  store.messagesById.m1 = { id: 'm1', chatId: 'chat-1', seq: 1, type: 'user', content: '能上线吗', createdAt: 0, status: 'sent', deliveryStatus: statuses }
  return store
}

describe('reply notifications', () => {
  it('counts a message as answered once every member replied or failed', () => {
    expect(findAnsweredPrompt(storeWith({ r1: 'received', r2: 'sent' }), 'chat-1', 'm1')).toBeUndefined()
    expect(findAnsweredPrompt(storeWith({}), 'chat-1', 'm1')).toBeUndefined()
    expect(findAnsweredPrompt(storeWith({ r1: 'received', r2: 'error' }), 'chat-1', 'm1')).toEqual({
      chatId: 'chat-1', chatName: '上线评审', messageId: 'm1', repliedNames: ['工程师'], failedNames: ['设计师'],
    })
  })

  it('leaves out OpenTeam’s own requests and counts a discussion as answered once it has finished', () => {
    const store = storeWith({ r1: 'received' })
    store.messagesById.m1 = { ...store.messagesById.m1, roundSummaryOf: 'm0' }
    expect(findAnsweredPrompt(store, 'chat-1', 'm1')).toBeUndefined()

    const chat = store.chatsById['chat-1']
    store.messagesById.m1 = { id: 'm1', chatId: 'chat-1', seq: 1, type: 'user', content: '要不要重写？', targetRoleIds: ['r1', 'r2'], discussionTopic: true, createdAt: 0, status: 'received' }
    store.messagesById.t1 = { id: 't1', chatId: 'chat-1', seq: 2, type: 'user', content: '', targetRoleIds: ['r2'], discussionTurnOf: 'm1', discussionTurn: 1, createdAt: 0, status: 'received', deliveryStatus: { r2: 'received' } }
    store.messagesById.a1 = { id: 'a1', chatId: 'chat-1', seq: 3, type: 'assistant', content: '不要', roleId: 'r2', roleName: '设计师', sourceMessageId: 't1', createdAt: 0, status: 'received' }
    chat.messageIds = ['m1', 't1', 'a1']
    chat.discussion = { id: 'd1', topicMessageId: 'm1', roleIds: ['r1', 'r2'], maxTurns: 1, turn: 1, status: 'running', failedTurns: 0, startedAt: 0, updatedAt: 0 }

    expect(findAnsweredPrompt(store, 'chat-1', 't1')).toBeUndefined()
    expect(findAnsweredPrompt(store, 'chat-1', 'm1')).toBeUndefined()
    chat.discussion.status = 'done'
    expect(findAnsweredPrompt(store, 'chat-1', 'm1')).toEqual({ chatId: 'chat-1', chatName: '上线评审', messageId: 'm1', repliedNames: ['设计师'], failedNames: [] })
  })

  it('words the notification in the chosen language', () => {
    const answered = { chatId: 'chat-1', chatName: '上线评审', messageId: 'm1', repliedNames: ['工程师', '设计师'], failedNames: ['增长'] }
    expect(replyNotificationText(answered, 'zh-CN')).toEqual({ title: '「上线评审」的回复都到了', message: '工程师、设计师 已回复；增长 没有回复成功' })
    expect(replyNotificationText(answered, 'en')).toEqual({ title: 'All replies are in: 上线评审', message: '工程师, 设计师 replied; 增长 could not reply' })
  })

  it('notifies once, only while the OpenTeam tab is out of view, and not when turned off', async () => {
    const create = vi.fn(async () => undefined)
    let inView = true
    const notifier = createReplyNotifier({ create, isTeamPageInView: async () => inView, iconUrl: 'icon.png', log: { warn: vi.fn() } })

    expect(await notifier.notify(storeWith({ r1: 'received', r2: 'received' }), 'chat-1', 'm1')).toBe(false)
    expect(create).not.toHaveBeenCalled()

    inView = false
    const store = storeWith({ r1: 'received', r2: 'received' })
    store.messagesById.m2 = { ...store.messagesById.m1, id: 'm2' }
    expect(await notifier.notify(store, 'chat-1', 'm2')).toBe(true)
    expect(await notifier.notify(store, 'chat-1', 'm2')).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('openteam-replies:chat-1:m2', expect.objectContaining({ type: 'basic', iconUrl: 'icon.png', title: '「上线评审」的回复都到了' }))

    const off = storeWith({ r1: 'received', r2: 'received' }, { replyNotifications: false })
    off.messagesById.m3 = { ...off.messagesById.m1, id: 'm3' }
    expect(await notifier.notify(off, 'chat-1', 'm3')).toBe(false)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('finds the group of a clicked notification', () => {
    expect(chatIdFromNotificationId('openteam-replies:chat-1:m2')).toBe('chat-1')
    expect(chatIdFromNotificationId('something-else')).toBeUndefined()
  })
})
