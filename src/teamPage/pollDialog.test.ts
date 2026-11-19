// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupRole, OpenTeamStore } from '../group/types'
import { openPollDialog } from './pollDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

function setup() {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  const role = (id: string, name: string): GroupRole => ({ id, chatId: 'chat-1', name, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 })
  for (const item of [role('r1', '研究员'), role('r2', '校对'), role('r3', '分析师')]) store.rolesById[item.id] = item
  store.chatsById['chat-1'] = { id: 'chat-1', name: '选型', mode: 'collaborative', roleIds: ['r1', 'r2', 'r3'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const showError = vi.fn()
  openPollDialog('chat-1', { getStore: () => store, runCommand, showError, refusalWaitMs: 20 })
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const options = () => [...document.querySelectorAll<HTMLInputElement>('.poll-option-input')]
  const members = () => [...document.querySelectorAll<HTMLInputElement>('.poll-member input')]
  const submit = () => q<HTMLFormElement>('.poll-form').dispatchEvent(new Event('submit', { cancelable: true }))
  return { store, runCommand, showError, question: () => q<HTMLTextAreaElement>('#poll-question'), options, members, submit, q }
}

describe('the window that starts a vote', () => {
  it('starts with the question focused, two lettered options and every member ticked', () => {
    const { question, options, members } = setup()
    expect(document.activeElement).toBe(question())
    expect(options()).toHaveLength(2)
    expect([...document.querySelectorAll('.poll-option-letter')].map(node => node.textContent)).toEqual(['A', 'B'])
    expect(members().map(box => [box.parentElement?.textContent, box.checked])).toEqual([['研究员', true], ['校对', true], ['分析师', true]])
  })

  it('adds options up to six, and removes them down to two', () => {
    const { options, q } = setup()
    const add = q<HTMLButtonElement>('.poll-add-option')
    for (let index = 0; index < 4; index += 1) add.click()
    expect(options()).toHaveLength(6)
    expect(add.hidden).toBe(true)
    document.querySelectorAll<HTMLButtonElement>('.poll-remove-option')[0].click()
    expect(options()).toHaveLength(5)
    expect([...document.querySelectorAll('.poll-option-letter')].map(node => node.textContent)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(add.hidden).toBe(false)
  })

  it('sends the vote to the ticked members', async () => {
    const { runCommand, question, options, members, submit } = setup()
    question().value = ' 选哪个方案？ '
    options()[0].value = '方案一'
    options()[1].value = '方案二'
    members()[1].checked = false
    submit()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', { chatId: 'chat-1', raw: '@研究员（DeepSeek） @分析师（DeepSeek） 选哪个方案？', poll: { question: '选哪个方案？', options: ['方案一', '方案二'] } }))
    await vi.waitFor(() => expect(document.querySelector('.poll-modal')).toBeNull())
  })

  it('says what is missing instead of sending', () => {
    const { runCommand, question, options, members, submit } = setup()
    submit()
    expect(document.querySelector('.team-form-error')?.textContent).toBe('写下要投票的问题')
    question().value = '选哪个？'
    options()[0].value = '一'
    submit()
    expect(document.querySelector('.team-form-error')?.textContent).toBe('至少要两个选项')
    options()[1].value = '二'
    members().forEach((box, index) => { box.checked = index === 0 })
    submit()
    expect(document.querySelector('.team-form-error')?.textContent).toBe('至少选两位成员来投票')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('shows the error the send gives, and closes on Esc', async () => {
    const { runCommand, question, options, submit } = setup()
    runCommand.mockRejectedValueOnce(new Error('项目进行中，不能发起投票'))
    question().value = '选哪个？'
    options()[0].value = '一'
    options()[1].value = '二'
    submit()
    await vi.waitFor(() => expect(document.querySelector('.team-form-error')?.textContent).toBe('项目进行中，不能发起投票'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.poll-modal')).toBeNull()
  })

  it('closes while the members are still voting, and shows a later error on the page', async () => {
    const { runCommand, showError, question, options, submit } = setup()
    let fail: (error: Error) => void = () => undefined
    runCommand.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    question().value = '选哪个？'
    options()[0].value = '一'
    options()[1].value = '二'
    submit()
    await vi.waitFor(() => expect(document.querySelector('.poll-modal')).toBeNull())
    fail(new Error('API 请求失败'))
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith('API 请求失败'))
  })
})
