import { describe, expect, it } from 'vitest'
import { getUnsyncedMessagesForRole } from './contextSync'
import { buildRoundSummaryPrompt, hasRoundSummary, isKeyPointsHeading, isRoundSummaryMessage, keyPointsInstruction, pickSummarizer, readSummarizableRound, wantsKeyPoints } from './roundSummary'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from './types'

function role(id: string, name: string, extra: Partial<GroupRole> = {}): GroupRole {
  return { id, chatId: 'chat-1', name, systemPrompt: '', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...extra }
}

function setup(): { store: OpenTeamStore; chat: GroupChat; add(message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>): GroupMessage } {
  const store = createDefaultStore()
  const chat: GroupChat = { id: 'chat-1', name: '评审', mode: 'collaborative', roleIds: ['a', 'b', 'c'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatsById[chat.id] = chat
  for (const member of [role('a', '工程师'), role('b', '设计师'), role('c', '产品')]) store.rolesById[member.id] = member
  const add = (message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>) => {
    const full: GroupMessage = { chatId: chat.id, seq: chat.nextMessageSeq, createdAt: chat.nextMessageSeq, status: 'received', ...message }
    chat.nextMessageSeq += 1
    store.messagesById[full.id] = full
    chat.messageIds.push(full.id)
    return full
  }
  return { store, chat, add }
}

describe('key points', () => {
  it('recognizes the key-points heading as replies render it', () => {
    for (const heading of ['要点', '要点：', '核心要点:', 'Key points', 'Key points:', 'TL;DR']) expect(isKeyPointsHeading(heading)).toBe(true)
    for (const heading of ['要点在于成本', '背景', '']) expect(isKeyPointsHeading(heading)).toBe(false)
    expect(keyPointsInstruction('zh-CN')).toContain('「**要点**」')
    expect(keyPointsInstruction('en')).toContain('"**Key points**"')
    // The points are a list, and nothing comes before the heading: that is what the page folds to.
    expect(keyPointsInstruction('zh-CN')).toMatch(/第一行.*「\*\*要点\*\*」.*「- 」开头/)
    expect(keyPointsInstruction('en')).toMatch(/very first line.*"\*\*Key points\*\*".*starting with "- "/)
  })

  it('asks for key points only when a message goes to two or more members', () => {
    const { store, chat, add } = setup()
    const round = add({ id: 'q1', type: 'user', content: '选哪个？', targetRoleIds: ['a', 'b'] })
    const single = add({ id: 'q2', type: 'user', content: '你呢？', targetRoleIds: ['a'] })
    expect(wantsKeyPoints(store.settings, chat, round)).toBe(true)
    expect(wantsKeyPoints(store.settings, chat, single)).toBe(false)
    expect(wantsKeyPoints(store.settings, chat, { ...round, orchestrationKind: 'task' })).toBe(false)
    expect(wantsKeyPoints(store.settings, chat, { ...round, roundSummaryOf: 'q0' })).toBe(false)
    chat.teamFormation = { invitationIds: ['q1'] } as unknown as GroupChat['teamFormation']
    expect(wantsKeyPoints(store.settings, chat, round)).toBe(false)
    expect(wantsKeyPoints({ replyKeyPoints: false }, undefined, round)).toBe(false)
  })
})

describe('round summaries', () => {
  it('finds a finished round with each member’s latest good reply', () => {
    const { store, chat, add } = setup()
    const question = add({ id: 'q1', type: 'user', content: '选哪个？', targetRoleIds: ['a', 'b', 'c'], deliveryStatus: { a: 'pending', b: 'received', c: 'error' } })
    add({ id: 'r1', type: 'assistant', content: '旧回复', roleId: 'b', sourceMessageId: 'q1' })
    add({ id: 'r2', type: 'assistant', content: 'A 更稳', roleId: 'a', sourceMessageId: 'q1' })
    add({ id: 'r3', type: 'assistant', content: '新回复', roleId: 'b', sourceMessageId: 'q1' })
    add({ id: 'r4', type: 'assistant', content: 'send_failed', roleId: 'c', sourceMessageId: 'q1', status: 'error' })

    // Someone is still answering.
    expect(readSummarizableRound(store, chat, question)).toBeUndefined()
    question.deliveryStatus = { a: 'received', b: 'received', c: 'error' }
    const round = readSummarizableRound(store, chat, question)
    expect(round?.replies.map(reply => [reply.role.name, reply.message.content])).toEqual([['工程师', 'A 更稳'], ['设计师', '新回复']])

    // One good reply is not a round to summarize.
    store.messagesById.r3.status = 'error'
    store.messagesById.r1.status = 'error'
    expect(readSummarizableRound(store, chat, question)).toBeUndefined()
  })

  it('leaves out a reply that was cut off, kept with its note, until it is read again in full', () => {
    const { store, chat, add } = setup()
    // The OpenTeam page was closed while 设计师 and 产品 were writing: their replies were ended.
    const question = add({ id: 'q1', type: 'user', content: '选哪个？', targetRoleIds: ['a', 'b', 'c'], deliveryStatus: { a: 'received', b: 'error', c: 'error' } })
    add({ id: 'r1', type: 'assistant', content: 'A 更稳', roleId: 'a', sourceMessageId: 'q1' })
    add({ id: 'r2', type: 'assistant', content: '写到一半\n\n⚠️ 这条回复还没有读完', roleId: 'b', sourceMessageId: 'q1' })
    add({ id: 'r3', type: 'assistant', content: '⚠️ 这条回复还没有读完', roleId: 'c', sourceMessageId: 'q1' })

    expect(readSummarizableRound(store, chat, question)).toBeUndefined()

    // 设计师's reply is read again in full.
    store.messagesById.r2.content = 'B 更省'
    question.deliveryStatus = { a: 'received', b: 'received', c: 'error' }
    expect(readSummarizableRound(store, chat, question)?.replies.map(reply => reply.message.content)).toEqual(['A 更稳', 'B 更省'])
  })

  it('picks an API member first, then whoever answered first', () => {
    const { store, chat, add } = setup()
    add({ id: 'q1', type: 'user', content: '?', targetRoleIds: ['a', 'b'], deliveryStatus: { a: 'received', b: 'received' } })
    add({ id: 'r1', type: 'assistant', content: 'B', roleId: 'b', sourceMessageId: 'q1' })
    add({ id: 'r2', type: 'assistant', content: 'A', roleId: 'a', sourceMessageId: 'q1' })
    const round = readSummarizableRound(store, chat, store.messagesById.q1)!
    const roles = chat.roleIds.map(id => store.rolesById[id])

    expect(pickSummarizer(roles, round, () => true)?.id).toBe('b')
    expect(pickSummarizer(roles, round, member => member.id !== 'b')?.id).toBe('a')
    store.rolesById.c.modelSource = 'external'
    expect(pickSummarizer(roles, round, () => true)?.id).toBe('c')
    expect(pickSummarizer(roles, round, () => false)).toBeUndefined()
  })

  it('writes a summary request with the question, every reply (trimmed to fit) and the format', () => {
    const { store, chat, add } = setup()
    add({ id: 'q1', type: 'user', content: '选哪个方案？', targetRoleIds: ['a', 'b'], deliveryStatus: { a: 'received', b: 'received' } })
    add({ id: 'r1', type: 'assistant', content: '方案 A', roleId: 'a', sourceMessageId: 'q1' })
    add({ id: 'r2', type: 'assistant', content: '长'.repeat(5000), roleId: 'b', sourceMessageId: 'q1' })
    const round = readSummarizableRound(store, chat, store.messagesById.q1)!

    const prompt = buildRoundSummaryPrompt({ round, summarizer: store.rolesById.c, language: 'zh-CN', maxReplyChars: 2000 })
    expect(prompt).toContain('你是「产品」，这次请你担任本轮讨论的汇总人。')
    expect(prompt).toContain('用户的问题：\n选哪个方案？')
    expect(prompt).toContain('【工程师】\n方案 A')
    expect(prompt).toContain(`【设计师】\n${'长'.repeat(1000)}\n［……其余部分已省略］`)
    expect(prompt).toContain('**分歧**')
    expect(buildRoundSummaryPrompt({ round, summarizer: store.rolesById.c, language: 'en' })).toContain('**Disagreements**')
  })

  it('keeps summary requests and summaries out of what members are sent as context', () => {
    const { store, chat, add } = setup()
    add({ id: 'q1', type: 'user', content: '选哪个？', targetRoleIds: ['a', 'b'], deliveryStatus: { a: 'received', b: 'received' } })
    add({ id: 'r1', type: 'assistant', content: 'A 好', roleId: 'a', roleName: '工程师', sourceMessageId: 'q1' })
    add({ id: 'r2', type: 'assistant', content: 'B 好', roleId: 'b', roleName: '设计师', sourceMessageId: 'q1' })
    const request = add({ id: 's1', type: 'user', content: '汇总本轮回复', targetRoleIds: ['a'], roundSummaryOf: 'q1' })
    const summary = add({ id: 's2', type: 'assistant', content: '**共识**', roleId: 'a', roleName: '工程师', sourceMessageId: 's1' })
    const next = add({ id: 'q2', type: 'user', content: '继续', targetRoleIds: ['b', 'c'] })

    const lookup = (id: string) => store.messagesById[id]
    expect(isRoundSummaryMessage(request, lookup)).toBe(true)
    expect(isRoundSummaryMessage(summary, lookup)).toBe(true)
    expect(isRoundSummaryMessage(store.messagesById.r1, lookup)).toBe(false)
    expect(hasRoundSummary(store, chat, 'q1')).toBe(true)

    const messages = chat.messageIds.map(id => store.messagesById[id])
    // 产品 was not asked the first question; 设计师 was, and sees everything but the summary.
    expect(getUnsyncedMessagesForRole(chat, store.rolesById.c, messages, next).map(message => message.id)).toEqual(['r1', 'r2'])
    expect(getUnsyncedMessagesForRole(chat, store.rolesById.b, messages, next).map(message => message.id)).toEqual(['q1', 'r1'])
  })
})
