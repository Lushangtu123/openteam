import { describe, expect, it } from 'vitest'
import { chatModeSwitchBlocker, isRoomMode, sharedWithRole, switchChatMode } from './chatMode'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage } from './types'

function setup(mode: GroupChat['mode'] = 'independent') {
  const store = createDefaultStore()
  const chat: GroupChat = { id: 'c', name: '调研', mode, roleIds: ['r'], messageIds: [], nextMessageSeq: 8, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.chatsById.c = chat
  store.rolesById.r = { id: 'r', chatId: 'c', name: '研究员', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  return { store, chat }
}

describe('changing a group\'s mode', () => {
  it('makes a group 协作 from its latest message on, and 独立 again', () => {
    const { store, chat } = setup()
    expect(switchChatMode(store, chat, 'collaborative')).toBe(true)
    expect(chat).toMatchObject({ mode: 'collaborative', sharedFromSeq: 7 })
    expect(switchChatMode(store, chat, 'collaborative')).toBe(false)
    expect(switchChatMode(store, chat, 'independent')).toBe(true)
    expect(chat.mode).toBe('independent')
    expect('sharedFromSeq' in chat).toBe(false)
    expect(isRoomMode('collaborative')).toBe(true)
    expect(isRoomMode('team')).toBe(false)
  })

  it('waits while members answer, a discussion, a 编排 or a 项目 runs', () => {
    const { store, chat } = setup()
    expect(chatModeSwitchBlocker(store, chat)).toBeUndefined()
    store.rolesById.r.status = 'thinking'
    expect(() => switchChatMode(store, chat, 'collaborative')).toThrow('成员还在回答，等这一轮结束再切换模式')
    expect(chat.mode).toBe('independent')
    store.rolesById.r.status = 'ready'
    store.activeOrchestrationRunIdByChatId.c = 'run-1'
    expect(chatModeSwitchBlocker(store, chat)).toBe('编排还在进行，结束后再切换模式')
  })

  it('shares earlier messages with a member only when they were its own or sent to it', () => {
    const { chat } = setup('collaborative')
    chat.sharedFromSeq = 5
    const message = (seq: number, fields: Partial<GroupMessage>): GroupMessage => ({ id: `m${seq}`, chatId: 'c', seq, type: 'assistant', content: 'x', createdAt: seq, status: 'received', ...fields })
    expect(sharedWithRole(chat, 'r', message(6, { roleId: 'e' }))).toBe(true)
    expect(sharedWithRole(chat, 'r', message(4, { roleId: 'e' }))).toBe(false)
    expect(sharedWithRole(chat, 'r', message(4, { roleId: 'r' }))).toBe(true)
    expect(sharedWithRole(chat, 'r', message(3, { type: 'user', targetRoleIds: ['r'] }))).toBe(true)
    delete chat.sharedFromSeq
    expect(sharedWithRole(chat, 'r', message(1, { roleId: 'e' }))).toBe(true)
  })
})
