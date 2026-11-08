// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { GroupChat, RoomMode } from '../group/types'
import { createComposerModesView, PLACEHOLDER_MENTION_ONLY, PLACEHOLDER_REPLY_ALL } from './composerModesView'

describe('composer reply modes', () => {
  it('switches "reply without @" and how members answer, and says what a plain message does', async () => {
    const harness = createHarness('collaborative')
    harness.view.render()
    expect(harness.modesEl.hidden).toBe(false)
    expect(harness.replyAll.getAttribute('aria-checked')).toBe('false')
    expect(harness.replyAll.textContent?.trim()).toBe('不@也回复')
    expect(harness.styleLabel()).toBe('各自回答')
    expect(harness.checked()).toEqual(['parallel'])
    expect(harness.input.placeholder).toBe(PLACEHOLDER_MENTION_ONLY)

    harness.replyAll.click()
    harness.item('review').click()
    // Choosing the style the group already has changes nothing.
    harness.item('parallel').click()
    await Promise.resolve()
    expect(harness.runCommand.mock.calls).toEqual([
      ['GROUP_CHAT_UPDATE', { chatId: 'chat-1', requireManualMention: false }],
      ['GROUP_CHAT_UPDATE', { chatId: 'chat-1', collaborationStyle: 'review' }],
    ])

    harness.chat.requireManualMention = false
    harness.chat.crossReview = true
    harness.view.render()
    expect(harness.replyAll.getAttribute('aria-checked')).toBe('true')
    expect(harness.styleLabel()).toBe('互相审')
    expect(harness.checked()).toEqual(['review'])
    expect(harness.input.placeholder).toBe(PLACEHOLDER_REPLY_ALL)

    harness.chat.discussionMode = true
    delete harness.chat.crossReview
    harness.view.render()
    expect([harness.styleLabel(), ...harness.checked()]).toEqual(['轮流讨论', 'turns'])
    harness.replyAll.click()
    await Promise.resolve()
    expect(harness.runCommand).toHaveBeenLastCalledWith('GROUP_CHAT_UPDATE', { chatId: 'chat-1', requireManualMention: true })
  })

  it('is hidden in independent groups, and in English says so in English', () => {
    const harness = createHarness('independent', 'en')
    harness.chat.discussionMode = true
    harness.view.render()
    expect(harness.modesEl.hidden).toBe(true)
    expect(harness.styleLabel()).toBe('Take turns')
    expect(harness.input.placeholder).toBe('Message the group; @ a member to get a reply, or it is only recorded')
  })

  it('hides the input box while no group is open', () => {
    const composer = document.createElement('form')
    const modesEl = document.createElement('div')
    let chat: GroupChat | undefined
    const view = createComposerModesView({ composerFormEl: composer, modesEl, replyAllToggleEl: document.createElement('button'), styleToggleEl: document.createElement('button'), styleMenuEl: document.createElement('div'), messageInputEl: document.createElement('textarea'), getLanguage: () => 'zh-CN', getCurrentChat: () => chat, runCommand: vi.fn(), showError: vi.fn() })
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
    harness.item('turns').click()
    await vi.waitFor(() => expect(harness.showError).toHaveBeenCalledWith('没保存上'))
  })
})

function createHarness(mode: RoomMode, language = 'zh-CN') {
  const chat: GroupChat = { id: 'chat-1', name: '群聊', mode, roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  const modesEl = document.createElement('div')
  const replyAll = document.createElement('button')
  replyAll.append(document.createElement('span'))
  const styleToggle = document.createElement('button')
  styleToggle.append(document.createElement('span'))
  const styleMenu = document.createElement('div')
  for (const style of ['review', 'turns', 'parallel']) {
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitemradio')
    item.dataset.collaborationStyle = style
    styleMenu.append(item)
  }
  const input = document.createElement('textarea')
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const showError = vi.fn()
  const view = createComposerModesView({ modesEl, replyAllToggleEl: replyAll, styleToggleEl: styleToggle, styleMenuEl: styleMenu, messageInputEl: input, getLanguage: () => language, getCurrentChat: () => chat, runCommand, showError })
  view.register()
  const item = (style: string) => styleMenu.querySelector<HTMLButtonElement>(`[data-collaboration-style="${style}"]`)!
  const styleLabel = () => styleToggle.textContent?.trim()
  const checked = () => [...styleMenu.querySelectorAll<HTMLElement>('[aria-checked="true"]')].map(element => element.dataset.collaborationStyle)
  return { chat, modesEl, replyAll, item, styleLabel, checked, input, runCommand, showError, view }
}
