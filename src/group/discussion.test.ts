import { describe, expect, it } from 'vitest'
import { buildDiscussionTurnPrompt, chooseNextSpeaker, discussionMaxTurns, discussionTranscript, discussionTurnRequestText, findHandoffMention, startsDiscussion, turnCountsOf } from './discussion'
import { buildRoundSummaryPrompt, hasRoundSummary, readSummarizableRound } from './roundSummary'
import { createDefaultStore } from './store'
import type { DiscussionRun, GroupChat, GroupMessage, GroupRole, OpenTeamStore } from './types'

function role(id: string, name: string): GroupRole {
  return { id, chatId: 'chat-1', name, systemPrompt: `${name}的人设`, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
}

const members = [role('a', '架构师'), role('b', '产品'), role('c', '产品经理')]

function run(extra: Partial<DiscussionRun> = {}): DiscussionRun {
  return { id: 'd1', topicMessageId: 'topic', roleIds: ['a', 'b', 'c'], maxTurns: 6, turn: 1, status: 'running', failedTurns: 0, startedAt: 0, updatedAt: 0, ...extra }
}

function setup(): { store: OpenTeamStore; chat: GroupChat; add(message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>): GroupMessage } {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  const chat: GroupChat = { id: 'chat-1', name: '讨论', mode: 'collaborative', roleIds: ['a', 'b', 'c'], messageIds: [], nextMessageSeq: 1, status: 'ready', discussionMode: true, createdAt: 0, updatedAt: 0 }
  store.chatsById[chat.id] = chat
  for (const member of members) store.rolesById[member.id] = { ...member }
  const add = (message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>) => {
    const full: GroupMessage = { chatId: chat.id, seq: chat.nextMessageSeq, createdAt: chat.nextMessageSeq, status: 'received', ...message }
    chat.nextMessageSeq += 1
    store.messagesById[full.id] = full
    chat.messageIds.push(full.id)
    return full
  }
  return { store, chat, add }
}

describe('discussions', () => {
  it('starts in 协作 groups with the switch on, for two or more members, when none is running', () => {
    const { chat } = setup()
    expect(startsDiscussion(chat, ['a', 'b'])).toBe(true)
    expect(startsDiscussion(chat, ['a'])).toBe(false)
    expect(startsDiscussion({ ...chat, mode: 'independent' }, ['a', 'b'])).toBe(false)
    expect(startsDiscussion({ ...chat, discussionMode: false }, ['a', 'b'])).toBe(false)
    expect(startsDiscussion({ ...chat, discussion: run() }, ['a', 'b'])).toBe(false)
    expect(discussionMaxTurns(2)).toBe(4)
    expect(discussionMaxTurns(3)).toBe(6)
    expect(discussionMaxTurns(8)).toBe(12)
  })

  it('finds the member a reply hands over to, longest name first, never the speaker', () => {
    expect(findHandoffMention('我同意。@产品经理 你怎么看？', members, 'a')?.id).toBe('c')
    expect(findHandoffMention('@产品 补充一下', members, 'a')?.id).toBe('b')
    expect(findHandoffMention('@架构师 我自己再说一句。@ 产品 呢？', members, 'a')?.id).toBe('b')
    expect(findHandoffMention('邮件 a@example.com，没有点名', members, 'a')).toBeUndefined()
  })

  it('lets the mentioned member speak next, otherwise whoever spoke least, next in order on a tie', () => {
    const available = () => true
    expect(chooseNextSpeaker({ run: run({ currentRoleId: 'a' }), roles: members, turnCounts: new Map([['a', 1]]), lastReply: '@产品经理 你来', isAvailable: available })).toEqual({ role: members[2], handoffFrom: 'a' })
    expect(chooseNextSpeaker({ run: run({ currentRoleId: 'a' }), roles: members, turnCounts: new Map([['a', 1]]), lastReply: '没有点名', isAvailable: available })?.role.id).toBe('b')
    expect(chooseNextSpeaker({ run: run({ currentRoleId: 'c' }), roles: members, turnCounts: new Map([['a', 1], ['c', 1]]), isAvailable: available })?.role.id).toBe('b')
    // The mentioned member is busy: the turn goes round as usual.
    expect(chooseNextSpeaker({ run: run({ currentRoleId: 'a' }), roles: members, turnCounts: new Map([['a', 1]]), lastReply: '@产品经理', isAvailable: member => member.id !== 'c' })).toEqual({ role: members[1] })
    // Only the last speaker is free: it speaks again rather than the discussion stalling.
    expect(chooseNextSpeaker({ run: run({ currentRoleId: 'a' }), roles: members, turnCounts: new Map(), isAvailable: member => member.id === 'a' })?.role.id).toBe('a')
    expect(chooseNextSpeaker({ run: run({ currentRoleId: 'a' }), roles: members, turnCounts: new Map(), isAvailable: () => false })).toBeUndefined()
  })

  it('announces each turn', () => {
    expect(discussionTurnRequestText(2, 6, '产品', undefined, 'zh-CN')).toBe('第 2/6 轮 · 请「产品」发言')
    expect(discussionTurnRequestText(3, 6, '产品经理', '架构师', 'zh-CN')).toBe('第 3/6 轮 · 「架构师」请「产品经理」接着说')
    expect(discussionTurnRequestText(3, 6, 'PM', 'Architect', 'en')).toBe('Turn 3/6: Architect asked PM to speak')
  })

  it('gives each speaker the topic, every turn and note so far, and how to hand over', () => {
    const { store, chat, add } = setup()
    add({ id: 'topic', type: 'user', content: '要不要重写登录模块？', targetRoleIds: ['a', 'b'], discussionTopic: true })
    chat.discussion = run({ roleIds: ['a', 'b'], maxTurns: 4 })
    add({ id: 't1', type: 'user', content: '第 1/4 轮', targetRoleIds: ['a'], discussionTurnOf: 'topic', discussionTurn: 1 })
    add({ id: 'r1', type: 'assistant', content: '应该重写。@产品 你觉得呢？', roleId: 'a', roleName: '架构师', sourceMessageId: 't1' })
    add({ id: 'n1', type: 'user', content: '预算只有两周', discussionNoteOf: 'topic', targetRoleIds: [] })
    const request = add({ id: 't2', type: 'user', content: '第 2/4 轮', targetRoleIds: ['b'], discussionTurnOf: 'topic', discussionTurn: 2, status: 'pending' })

    const transcript = discussionTranscript(store, chat, 'topic')
    expect(transcript.map(entry => [entry.kind, entry.message.id, entry.turn])).toEqual([['turn', 'r1', 1], ['note', 'n1', undefined]])
    expect(turnCountsOf(transcript)).toEqual(new Map([['a', 1]]))

    const prompt = buildDiscussionTurnPrompt({ store, chat, request, role: store.rolesById.b, roles: members, includePersona: true, language: 'zh-CN' })
    expect(prompt).toContain('你的身份是「产品」。')
    expect(prompt).toContain('人设：\n产品的人设')
    expect(prompt).toContain('讨论的话题（用户提出）：\n要不要重写登录模块？')
    expect(prompt).toContain('【架构师】\n应该重写。@产品 你觉得呢？')
    expect(prompt).toContain('【用户补充】\n预算只有两周')
    expect(prompt).toContain('现在轮到你发言（第 2/4 轮）')
    expect(prompt).toContain('（@架构师）')
    expect(prompt).not.toContain('第 1/4 轮')
  })

  it('summarizes a discussion once it stops, turn by turn, and again after it continues', () => {
    const { store, chat, add } = setup()
    add({ id: 'topic', type: 'user', content: '要不要重写？', targetRoleIds: ['a', 'b'], discussionTopic: true })
    chat.discussion = run({ roleIds: ['a', 'b'], maxTurns: 2, turn: 2 })
    add({ id: 't1', type: 'user', content: '', targetRoleIds: ['a'], discussionTurnOf: 'topic', discussionTurn: 1 })
    add({ id: 'r1', type: 'assistant', content: '重写', roleId: 'a', roleName: '架构师', sourceMessageId: 't1' })
    add({ id: 't2', type: 'user', content: '', targetRoleIds: ['b'], discussionTurnOf: 'topic', discussionTurn: 2 })
    add({ id: 'r2', type: 'assistant', content: '不重写', roleId: 'b', roleName: '产品', sourceMessageId: 't2' })

    expect(readSummarizableRound(store, chat, store.messagesById.topic)).toBeUndefined()
    chat.discussion.status = 'done'
    const round = readSummarizableRound(store, chat, store.messagesById.topic)!
    expect(round.discussion).toBe(true)
    expect(round.replies.map(reply => [reply.role.id, reply.turn])).toEqual([['a', 1], ['b', 2]])
    const prompt = buildRoundSummaryPrompt({ round, summarizer: store.rolesById.c, language: 'zh-CN' })
    expect(prompt).toContain('讨论中的发言（按顺序）：')
    expect(prompt).toContain('【架构师 · 第 1 轮】\n重写')

    expect(hasRoundSummary(store, chat, 'topic')).toBe(false)
    add({ id: 's1', type: 'user', content: '汇总本轮回复', targetRoleIds: ['c'], roundSummaryOf: 'topic' })
    expect(hasRoundSummary(store, chat, 'topic')).toBe(true)
    // One more round makes that summary out of date.
    add({ id: 't3', type: 'user', content: '', targetRoleIds: ['a'], discussionTurnOf: 'topic', discussionTurn: 3 })
    add({ id: 'r3', type: 'assistant', content: '还是重写', roleId: 'a', roleName: '架构师', sourceMessageId: 't3' })
    expect(hasRoundSummary(store, chat, 'topic')).toBe(false)
  })
})
