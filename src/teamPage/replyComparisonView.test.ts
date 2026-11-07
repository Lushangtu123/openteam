// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, OpenTeamStore } from '../group/types'
import { createReplyComparisonView } from './replyComparisonView'

afterEach(() => {
  document.body.replaceChildren()
})

function makeStore(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  const roles = [['r1', '工程师', 'chatgpt'], ['r2', '产品经理', 'claude'], ['r3', '设计师', 'gemini']] as const
  for (const [id, name, chatSite] of roles) {
    store.rolesById[id] = { id, chatId: 'c1', name, status: 'ready', contextCursor: 0, chatSite, createdAt: 1, updatedAt: 1 }
  }
  const messages: GroupMessage[] = [
    { id: 'q1', chatId: 'c1', seq: 1, type: 'user', content: '这个方案能上线吗？', targetRoleIds: ['r1', 'r2', 'r3'], createdAt: 1, status: 'pending' },
    { id: 'a1', chatId: 'c1', seq: 2, type: 'assistant', roleId: 'r1', roleName: '工程师', sourceMessageId: 'q1', content: '**可以**，注意缓存', createdAt: 2, status: 'received' },
    { id: 'a2', chatId: 'c1', seq: 3, type: 'assistant', roleId: 'r2', roleName: '产品经理', sourceMessageId: 'q1', content: '先灰度', createdAt: 3, status: 'received' },
  ]
  store.chatOrder = ['c1']
  store.chatsById.c1 = { id: 'c1', name: '评审', mode: 'independent', roleIds: ['r1', 'r2', 'r3'], messageIds: messages.map(message => message.id), nextMessageSeq: 4, status: 'ready', createdAt: 1, updatedAt: 1 }
  for (const message of messages) store.messagesById[message.id] = message
  return store
}

function setup() {
  const store = makeStore()
  const runCommand = vi.fn(async () => undefined)
  const copyText = vi.fn(async () => undefined)
  const showSuccess = vi.fn()
  const showError = vi.fn()
  const view = createReplyComparisonView({ getStore: () => store, runCommand, copyText, showError, showSuccess })
  return { store, view, runCommand, copyText, showSuccess, showError }
}

const columns = () => [...document.querySelectorAll('.reply-compare-column')].map(column => ({
  name: column.querySelector('.reply-compare-name')?.textContent,
  model: column.querySelector('.role-site-badge')?.textContent,
  state: column.querySelector('.reply-compare-state')?.textContent,
  body: column.querySelector('.reply-compare-body')?.textContent?.trim(),
}))

describe('reply comparison view', () => {
  it('shows each person who was asked side by side with their reply or its state', () => {
    const { view } = setup()

    view.open('q1')

    expect(document.querySelector('.reply-compare-question')?.textContent).toBe('这个方案能上线吗？')
    expect(columns()).toEqual([
      { name: '工程师', model: 'ChatGPT', state: undefined, body: '可以，注意缓存' },
      { name: '产品经理', model: 'Claude', state: undefined, body: '先灰度' },
      { name: '设计师', model: 'Gemini', state: '还没有回复', body: '回复到了会显示在这里。' },
    ])
    expect(document.querySelector('.reply-compare-column .reply-compare-body strong')?.textContent).toBe('可以')
  })

  it('updates the open comparison when a late reply arrives', () => {
    const { view, store } = setup()
    view.open('q1')

    store.messagesById.a3 = { id: 'a3', chatId: 'c1', seq: 4, type: 'assistant', roleId: 'r3', roleName: '设计师', sourceMessageId: 'q1', content: '交互要简化', createdAt: 4, status: 'received' }
    store.chatsById.c1.messageIds.push('a3')
    view.refresh()

    expect(columns()[2]).toEqual({ name: '设计师', model: 'Gemini', state: undefined, body: '交互要简化' })
  })

  it('asks the chosen person to summarize, sending the replies as an attached file', async () => {
    const { view, runCommand, showSuccess } = setup()
    view.open('q1')
    const select = document.querySelector<HTMLSelectElement>('.reply-compare-select')!
    select.value = 'r3'
    select.dispatchEvent(new Event('change'))

    document.querySelector<HTMLButtonElement>('.reply-compare-summarize')!.click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())

    const [type, payload] = runCommand.mock.calls[0] as unknown as [string, { chatId: string; raw: string; uploads: Array<{ fileName: string; text: string }> }]
    expect(type).toBe('GROUP_MESSAGE_SEND')
    expect(payload.chatId).toBe('c1')
    expect(payload.raw).toMatch(/^@设计师（Gemini） 附件 回复对比\.md 是几位人员对同一个问题的回答/)
    expect(payload.uploads).toEqual([{ kind: 'text', fileName: '回复对比.md', mimeType: 'text/markdown', size: expect.any(Number), text: '# 问题\n\n这个方案能上线吗？\n\n## 工程师（ChatGPT）\n\n**可以**，注意缓存\n\n## 产品经理（Claude）\n\n先灰度' }])
    await vi.waitFor(() => expect(showSuccess).toHaveBeenCalledWith('已请 设计师 汇总异同'))
    expect(document.querySelector('.reply-compare-dialog')).toBeNull()
  })

  it('suggests someone who did not answer as the summarizer and warns when an answerer is picked', () => {
    const { view } = setup()
    view.open('q1')

    const select = document.querySelector<HTMLSelectElement>('.reply-compare-select')!
    expect(select.value).toBe('r3')
    expect(document.querySelector('.reply-compare-warning')).toBeNull()
    expect(document.querySelector('.reply-compare-factcheck')?.textContent).toBe('几位都同意，不代表一定正确：数据、引语和日期请到原始出处核实。')

    select.value = 'r1'
    select.dispatchEvent(new Event('change'))
    expect(document.querySelector('.reply-compare-warning')?.textContent).toMatch(/^「.+」也回答了这个问题/)
  })

  it('asks everyone who answered to respond only where they disagree', async () => {
    const { view, runCommand, showSuccess } = setup()
    view.open('q1')

    document.querySelector<HTMLButtonElement>('.reply-compare-discuss')!.click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())

    const [, payload] = runCommand.mock.calls[0] as unknown as [string, { raw: string; uploads: Array<{ fileName: string; text: string }> }]
    expect(payload.raw).toMatch(/^@工程师（ChatGPT） @产品经理（Claude） 附件 回复对比\.md 是大家对同一个问题的回答，也包括你自己的。请只针对和别人观点不同的地方回应/)
    expect(payload.uploads[0].text).toContain('## 产品经理（Claude）\n\n先灰度')
    await vi.waitFor(() => expect(showSuccess).toHaveBeenCalledWith('已请 2 位人员针对分歧讨论'))
  })

  it('needs two answers to summarize, copies what is there and closes with Escape', async () => {
    const { view, store, copyText } = setup()
    store.messagesById.a2.status = 'error'
    view.open('q1')

    expect(document.querySelector<HTMLButtonElement>('.reply-compare-summarize')?.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('.reply-compare-discuss')?.disabled).toBe(true)
    expect(document.querySelector('.reply-compare-hint')?.textContent).toBe('至少要有两份回复才能讨论或汇总。')
    expect(columns()[1].state).toBe('回复失败')

    document.querySelector<HTMLButtonElement>('.reply-compare-copy')!.click()
    expect(copyText).toHaveBeenCalledWith('# 问题\n\n这个方案能上线吗？\n\n## 工程师（ChatGPT）\n\n**可以**，注意缓存')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.reply-compare-dialog')).toBeNull()
  })
})
