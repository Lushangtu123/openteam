// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { GroupChat, RoomMode } from '../group/types'
import { createComposerModesView, PLACEHOLDER_MENTION_ONLY, PLACEHOLDER_REPLY_ALL } from './composerModesView'

describe('composer reply modes', () => {
  it('switches "reply without @" and turn-by-turn discussions, and says what a plain message does', async () => {
    const harness = createHarness('collaborative')
    harness.view.render()
    expect(harness.modesEl.hidden).toBe(false)
    expect(harness.replyAll.getAttribute('aria-checked')).toBe('false')
    expect(harness.replyAll.textContent?.trim()).toBe('不@也回复')
    expect(harness.input.placeholder).toBe(PLACEHOLDER_MENTION_ONLY)

    harness.replyAll.click()
    harness.discussion.click()
    await Promise.resolve()
    expect(harness.runCommand.mock.calls).toEqual([
      ['GROUP_CHAT_UPDATE', { chatId: 'chat-1', requireManualMention: false }],
      ['GROUP_CHAT_UPDATE', { chatId: 'chat-1', discussionMode: true }],
    ])

    harness.chat.requireManualMention = false
    harness.chat.discussionMode = true
    harness.view.render()
    expect([harness.replyAll.getAttribute('aria-checked'), harness.discussion.getAttribute('aria-checked')]).toEqual(['true', 'true'])
    expect(harness.input.placeholder).toBe(PLACEHOLDER_REPLY_ALL)
    harness.replyAll.click()
    await Promise.resolve()
    expect(harness.runCommand).toHaveBeenLastCalledWith('GROUP_CHAT_UPDATE', { chatId: 'chat-1', requireManualMention: true })
  })

  it('is hidden in independent groups, and in English says so in English', () => {
    const harness = createHarness('independent', 'en')
    harness.view.render()
    expect(harness.modesEl.hidden).toBe(true)
    expect(harness.discussion.textContent?.trim()).toBe('Take turns')
    expect(harness.input.placeholder).toBe('Message the group; @ a member to get a reply, or it is only recorded')
  })

  it('hides the input box while no group is open', () => {
    const composer = document.createElement('form')
    const modesEl = document.createElement('div')
    let chat: GroupChat | undefined
    const view = createComposerModesView({ composerFormEl: composer, modesEl, replyAllToggleEl: document.createElement('button'), discussionToggleEl: document.createElement('button'), messageInputEl: document.createElement('textarea'), getLanguage: () => 'zh-CN', getCurrentChat: () => chat, runCommand: vi.fn(), showError: vi.fn() })
    view.render()
    expect(composer.classList.contains('no-chat')).toBe(true)
    chat = { id: 'chat-1', name: '群聊', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    view.render()
    expect(composer.classList.contains('no-chat')).toBe(false)
  })

  it('reports a failed change', async () => {
    const harness = createHarness('collaborative')
    harness.runCommand.mockRejectedValueOnce(new Error('没保存上'))
    harness.view.render()
    harness.discussion.click()
    await vi.waitFor(() => expect(harness.showError).toHaveBeenCalledWith('没保存上'))
  })
})

function createHarness(mode: RoomMode, language = 'zh-CN') {
  const chat: GroupChat = { id: 'chat-1', name: '群聊', mode, roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  const modesEl = document.createElement('div')
  const replyAll = document.createElement('button')
  replyAll.append(document.createElement('span'))
  const discussion = document.createElement('button')
  discussion.append(document.createElement('span'))
  const input = document.createElement('textarea')
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const showError = vi.fn()
  const view = createComposerModesView({ modesEl, replyAllToggleEl: replyAll, discussionToggleEl: discussion, messageInputEl: input, getLanguage: () => language, getCurrentChat: () => chat, runCommand, showError })
  view.register()
  return { chat, modesEl, replyAll, discussion, input, runCommand, showError, view }
}
