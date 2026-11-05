import { describe, expect, it } from 'vitest'
import { collectReplies, comparisonDiscussionRequest, comparisonSummaryRequest, countRepliesByQuestion, formatComparisonDocument, hasAnswered, pickSummarizer } from './replyComparison'
import { createDefaultStore } from './store'
import type { GroupMessage, OpenTeamStore } from './types'

function makeStore(): { store: OpenTeamStore; question: GroupMessage } {
  const store = createDefaultStore()
  const roleIds = ['r1', 'r2', 'r3', 'r4']
  for (const [index, roleId] of roleIds.entries()) {
    store.rolesById[roleId] = { id: roleId, chatId: 'c1', name: ['工程师', '产品经理', '设计师', '增长专家'][index], status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1, chatSite: 'chatgpt' }
  }
  const question: GroupMessage = { id: 'q1', chatId: 'c1', seq: 1, type: 'user', content: '这个方案能上线吗？', targetRoleIds: roleIds, createdAt: 1, status: 'pending', deliveryStatus: { r1: 'received', r2: 'received', r3: 'sent', r4: 'error' } }
  const messages: GroupMessage[] = [
    question,
    { id: 'a1', chatId: 'c1', seq: 2, type: 'assistant', roleId: 'r1', roleName: '工程师', sourceMessageId: 'q1', content: '旧回答', createdAt: 2, status: 'received' },
    { id: 'a2', chatId: 'c1', seq: 3, type: 'assistant', roleId: 'r2', roleName: '产品经理', sourceMessageId: 'q1', content: '能，但先灰度', createdAt: 3, status: 'received' },
    { id: 'a3', chatId: 'c1', seq: 4, type: 'assistant', roleId: 'r1', roleName: '工程师', sourceMessageId: 'q1', content: '技术上可以，注意缓存', createdAt: 4, status: 'received' },
    { id: 'a4', chatId: 'c1', seq: 5, type: 'assistant', roleId: 'r3', roleName: '设计师', sourceMessageId: 'q1', content: '正在', createdAt: 5, status: 'pending' },
    { id: 'other', chatId: 'c1', seq: 6, type: 'assistant', roleId: 'r2', roleName: '产品经理', sourceMessageId: 'q2', content: '别的问题', createdAt: 6, status: 'received' },
  ]
  store.chatOrder = ['c1']
  store.chatsById.c1 = { id: 'c1', name: '评审', mode: 'independent', roleIds, messageIds: messages.map(message => message.id), nextMessageSeq: 7, status: 'ready', createdAt: 1, updatedAt: 1 }
  for (const message of messages) store.messagesById[message.id] = message
  return { store, question }
}

describe('reply comparison', () => {
  it('lines up everyone the question went to with their latest reply and its state', () => {
    const { store, question } = makeStore()

    const comparison = collectReplies(store, question)

    expect(comparison.replies.map(reply => [reply.roleName, reply.status, reply.message?.content])).toEqual([
      ['工程师', 'replied', '技术上可以，注意缓存'],
      ['产品经理', 'replied', '能，但先灰度'],
      ['设计师', 'replying', '正在'],
      ['增长专家', 'failed', undefined],
    ])
  })

  it('counts the people who answered each question with content', () => {
    const { store } = makeStore()
    const messages = store.chatsById.c1.messageIds.map(id => store.messagesById[id])

    const counts = countRepliesByQuestion(messages)

    expect(counts.get('q1')).toBe(3)
    expect(counts.get('q2')).toBe(1)
  })

  it('writes the question and the finished answers into one document', () => {
    const { store, question } = makeStore()

    const document = formatComparisonDocument(collectReplies(store, question), 'zh-CN', reply => `${reply.roleName}（ChatGPT）`)

    expect(document).toBe('# 问题\n\n这个方案能上线吗？\n\n## 工程师（ChatGPT）\n\n技术上可以，注意缓存\n\n## 产品经理（ChatGPT）\n\n能，但先灰度')
    expect(comparisonSummaryRequest('回复对比.md', 'zh-CN')).toContain('附件 回复对比.md')
    expect(comparisonSummaryRequest('replies.md', 'en')).toContain('The attached replies.md')
    expect(comparisonSummaryRequest('回复对比.md', 'zh-CN')).toContain('没有人给出来源')
    expect(comparisonDiscussionRequest('回复对比.md', 'zh-CN')).toContain('请只针对和别人观点不同的地方回应')
  })

  it('prefers a summarizer who did not answer and uses another model', () => {
    const { store, question } = makeStore()
    const comparison = collectReplies(store, question)
    const roles = () => Object.values(store.rolesById)
    // Still replying, and failed: neither can take on a summary.
    store.rolesById.r3.status = 'thinking'
    store.rolesById.r4.status = 'error'
    store.rolesById.r5 = { ...store.rolesById.r1, id: 'r5', name: '同模型旁观者' }
    store.rolesById.r6 = { ...store.rolesById.r1, id: 'r6', name: '换模型旁观者', chatSite: 'claude' }

    expect(pickSummarizer(roles(), comparison, 'deepseek')?.name).toBe('换模型旁观者')

    delete store.rolesById.r6
    expect(pickSummarizer(roles(), comparison, 'deepseek')?.name).toBe('同模型旁观者')

    delete store.rolesById.r5
    // Only people who answered are free; anyone ready will do.
    expect(pickSummarizer(roles(), comparison, 'deepseek')?.name).toBe('工程师')
    expect(hasAnswered(comparison, 'r1')).toBe(true)
    expect(hasAnswered(comparison, 'r3')).toBe(false)
  })
})
