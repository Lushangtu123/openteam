// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { GroupChat } from '../group/types'
import { createChatModeSwitch } from './chatModeSwitch'

function setup(chat: GroupChat | undefined, language = 'zh-CN') {
  document.body.innerHTML = '<button id="switch-chat-mode" hidden><span class="header-menu-label"></span><span class="header-menu-hint"></span></button>'
  const button = document.getElementById('switch-chat-mode') as HTMLButtonElement
  const runCommand = vi.fn(async () => undefined)
  const confirm = vi.fn(() => true)
  const showError = vi.fn()
  const view = createChatModeSwitch({ buttonEl: button, getLanguage: () => language, getCurrentChat: () => chat, runCommand, confirm, showError })
  view.register()
  view.render()
  return { button, runCommand, confirm, showError, label: () => button.querySelector('.header-menu-label')!.textContent }
}

const chat = (fields: Partial<GroupChat> = {}): GroupChat => ({ id: 'c', name: '调研群', mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1, ...fields })

describe('更多 → changing the group\'s mode', () => {
  it('offers the other mode, asks, and changes it', async () => {
    const ctx = setup(chat())
    expect(ctx.button.hidden).toBe(false)
    expect(ctx.label()).toBe('改成协作群聊')
    ctx.button.click()
    expect(ctx.confirm).toHaveBeenCalledWith('把「调研群」改成协作群聊吗？之后成员能看到彼此的回复，可以用「不@也回复」和「轮流讨论」。之前各自的回答不会发给其他成员。')
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('GROUP_CHAT_UPDATE', { chatId: 'c', mode: 'collaborative' }))

    const back = setup(chat({ mode: 'collaborative' }), 'en')
    expect(back.label()).toBe('Make independent')
    back.confirm.mockReturnValueOnce(false)
    back.button.click()
    expect(back.runCommand).not.toHaveBeenCalled()
  })

  it('says why it could not', async () => {
    const ctx = setup(chat())
    ctx.runCommand.mockRejectedValueOnce(new Error('成员还在回答，等这一轮结束再切换模式') as never)
    ctx.button.click()
    await vi.waitFor(() => expect(ctx.showError).toHaveBeenCalledWith('成员还在回答，等这一轮结束再切换模式'))
  })

  it('is offered for any open group, a 网站自检 group too', () => {
    expect(setup(undefined).button.hidden).toBe(true)
    expect(setup(chat({ siteCheck: { startedAt: 1 } })).button.hidden).toBe(false)
  })
})
