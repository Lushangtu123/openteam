// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { GroupChat, GroupMessage, GroupRole, RoomMode } from '../group/types'
import { createTeamPageState } from './appState'
import { createChatHeaderView } from './chatHeaderView'

describe('chat header view', () => {
  it('only shows orchestration for collaborative chats', () => {
    const harness = createHarness('collaborative')

    harness.view.renderChatHeader()

    expect(harness.openOrchestrationEl.hidden).toBe(false)

    harness.chat.mode = 'independent'
    harness.view.renderChatHeader()

    expect(harness.openOrchestrationEl.hidden).toBe(true)
  })

  it('renders chat status and member counts in English mode', () => {
    const harness = createHarness('collaborative', 'en')
    harness.roles.push({ id: 'role-1', chatId: harness.chat.id, name: 'Engineer', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 })
    harness.messages.push({ id: 'msg-1', chatId: harness.chat.id, seq: 1, type: 'user', content: 'Hello', createdAt: 1, status: 'received' })

    harness.view.renderChatHeader()

    expect(harness.chatStatusEl.textContent).toBe('Active')
    expect(harness.chatSubtitleEl.textContent).toBe('Collaborative mode · 1 members · 1 messages')
    expect(harness.togglePeopleDrawerEl.textContent).toBe('Members 1')
  })

  it("shows the group's avatar next to its title", () => {
    const harness = createHarness('independent')

    harness.view.renderChatHeader()

    expect(harness.chatTitleAvatarEl.hidden).toBe(false)
    expect(harness.chatTitleAvatarEl.textContent).toBe('群')
    expect(harness.chatTitleAvatarEl.className).toMatch(/^chat-avatar chat-title-avatar role-tone-\d$/)
  })

  it('shows the controls for a group only while one is open', () => {
    const harness = createHarness('collaborative')
    harness.view.renderChatHeader()
    expect([harness.chatStatusEl.hidden, harness.togglePeopleDrawerEl.hidden, harness.workflowMenuWrapEl.hidden, harness.moreMenuWrapEl.hidden]).toEqual([false, false, false, false])
    expect(harness.chatStatusEl.textContent).toBe('进行中')

    harness.setChat(undefined)
    harness.view.renderChatHeader()
    expect(harness.chatTitleEl.textContent).toBe('未选择群聊')
    expect([harness.chatStatusEl.hidden, harness.togglePeopleDrawerEl.hidden, harness.workflowMenuWrapEl.hidden, harness.moreMenuWrapEl.hidden, harness.openOrchestrationEl.hidden]).toEqual([true, true, true, true, true])
  })
})

function createHarness(mode: RoomMode, language: 'zh-CN' | 'en' = 'zh-CN') {
  const chat: GroupChat = {
    id: 'chat-1',
    name: '群聊',
    mode,
    roleIds: [],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
  const chatTitleEl = document.createElement('h2')
  const chatTitleAvatarEl = document.createElement('span')
  const chatSubtitleEl = document.createElement('p')
  const chatStatusEl = document.createElement('span')
  const togglePeopleDrawerEl = document.createElement('button')
  const openOrchestrationEl = document.createElement('button')
  const workflowMenuWrapEl = document.createElement('div')
  const moreMenuWrapEl = document.createElement('div')
  const roles: GroupRole[] = []
  const messages: GroupMessage[] = []
  let current: GroupChat | undefined = chat
  const view = createChatHeaderView({
    state: createTeamPageState(),
    chatTitleEl,
    chatTitleAvatarEl,
    chatSubtitleEl,
    chatStatusEl,
    togglePeopleDrawerEl,
    openOrchestrationEl,
    workflowMenuWrapEl,
    moreMenuWrapEl,
    getLanguage: () => language,
    getCurrentChat: () => current,
    getCurrentRoles: () => roles,
    getCurrentMessages: () => messages,
  })
  const setChat = (next: GroupChat | undefined) => { current = next }
  return { chat, roles, messages, chatTitleEl, chatTitleAvatarEl, chatStatusEl, chatSubtitleEl, togglePeopleDrawerEl, openOrchestrationEl, workflowMenuWrapEl, moreMenuWrapEl, setChat, view }
}
