import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from './types'
import { pollInstruction, pollMessageText, pollTallyText, readPollInput, readVote, tallyPoll } from './poll'

describe('what the user sets up for a vote', () => {
  it('is a question and two to six options, trimmed, empty ones dropped', () => {
    expect(readPollInput({ question: '  选哪个方案？ ', options: [' 方案一 ', '', '方案二', '  '] })).toEqual({ question: '选哪个方案？', options: ['方案一', '方案二'] })
    expect(readPollInput({ question: 'q', options: ['a', 'b'], of: 'msg-1' })).toEqual({ question: 'q', options: ['a', 'b'], of: 'msg-1' })
  })

  it('is refused without a question, with fewer than two or more than six options, or with the same option twice', () => {
    expect(() => readPollInput({ question: ' ', options: ['a', 'b'] })).toThrow('写下要投票的问题')
    expect(() => readPollInput({ question: 'q', options: ['a'] })).toThrow('至少要两个选项')
    expect(() => readPollInput({ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] })).toThrow('最多 6 个选项')
    expect(() => readPollInput({ question: 'q', options: ['a', ' a '] })).toThrow('选项不能重复')
    expect(() => readPollInput('x')).toThrow('写下要投票的问题')
  })

  it('reads in the chat as the question and its lettered options', () => {
    expect(pollMessageText({ question: '选哪个方案？', options: ['方案一', '方案二'], round: 1 }, false)).toBe('投票：选哪个方案？\nA. 方案一\nB. 方案二')
    expect(pollMessageText({ question: '选哪个方案？', options: ['方案一', '方案二'], round: 2, of: 'm' }, false)).toBe('再投一轮：选哪个方案？\nA. 方案一\nB. 方案二')
    expect(pollMessageText({ question: 'Which plan?', options: ['One', 'Two'], round: 1 }, true)).toBe('Vote: Which plan?\nA. One\nB. Two')
  })
})

describe('a member\'s vote, read from its reply', () => {
  it('is the letter after 投票： or Vote:, with the reason after it', () => {
    expect(readVote('投票：B\n理由：成本更低，上线更快。', 3)).toEqual({ choice: 1, reason: '成本更低，上线更快。' })
    expect(readVote('**投票：** C\n\n**理由：** 风险最小', 3)).toEqual({ choice: 2, reason: '风险最小' })
    expect(readVote('Vote: a\nReason: cheapest.', 2)).toEqual({ choice: 0, reason: 'cheapest.' })
    expect(readVote('投票: 选项 B（方案二）\n因为它更稳。', 2)).toEqual({ choice: 1, reason: '因为它更稳。' })
  })

  it('is a lone letter on the first line, when the member wrote no 投票', () => {
    expect(readVote('B\n它更稳。', 2)).toEqual({ choice: 1, reason: '它更稳。' })
    expect(readVote('B. 方案二\n它更稳。', 2)).toEqual({ choice: 1, reason: '它更稳。' })
  })

  it('is none for a letter past the options, or a reply that picks none', () => {
    expect(readVote('投票：D\n理由：都不好', 3).choice).toBeUndefined()
    expect(readVote('两个方案各有优劣，看你的需求。', 2).choice).toBeUndefined()
    expect(readVote('Based on this, I think A is fine.', 2).choice).toBeUndefined()
  })
})

// 研究员, 校对 and 分析师 vote on two plans.
function setup() {
  const store: OpenTeamStore = createDefaultStore()
  const role = (id: string, name: string): GroupRole => ({ id, chatId: 'c', name, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 })
  for (const item of [role('r1', '研究员'), role('r2', '校对'), role('r3', '分析师')]) store.rolesById[item.id] = item
  const chat: GroupChat = { id: 'c', name: '选型', mode: 'collaborative', roleIds: ['r1', 'r2', 'r3'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatsById.c = chat
  const add = (message: Omit<GroupMessage, 'chatId' | 'seq' | 'createdAt'>) => {
    const full = { chatId: 'c', seq: chat.nextMessageSeq, createdAt: chat.nextMessageSeq, ...message } as GroupMessage
    chat.nextMessageSeq += 1
    store.messagesById[full.id] = full
    chat.messageIds.push(full.id)
    return full
  }
  const vote = (id: string, poll: GroupMessage['poll'], deliveryStatus: Record<string, 'pending' | 'sent' | 'received' | 'error'>) =>
    add({ id, type: 'user', content: pollMessageText(poll!, false), poll, targetRoleIds: Object.keys(deliveryStatus), deliveryStatus, status: 'pending' })
  const reply = (id: string, roleId: string, sourceMessageId: string, content: string, status: GroupMessage['status'] = 'received') =>
    add({ id, type: 'assistant', roleId, roleName: store.rolesById[roleId].name, sourceMessageId, content, status })
  return { store, chat, vote, reply }
}

describe('the count of a vote', () => {
  it('counts each member\'s latest vote, says who did not vote in the format or did not answer, and is done once all have', () => {
    const { store, chat, vote, reply } = setup()
    const poll = vote('p1', { question: '选哪个方案？', options: ['方案一', '方案二'], round: 1 }, { r1: 'received', r2: 'received', r3: 'sent' })
    reply('a1', 'r1', 'p1', '投票：A\n理由：便宜')
    reply('a2', 'r2', 'p1', '两个都行')
    let tally = tallyPoll(store, chat, poll)!
    expect(tally.done).toBe(false)
    expect(tally.waiting.map(item => item.name)).toEqual(['分析师'])

    store.messagesById.p1.deliveryStatus = { r1: 'received', r2: 'received', r3: 'error' }
    reply('a1b', 'r1', 'p1', '投票：B\n理由：改主意了，B 更稳')
    tally = tallyPoll(store, chat, poll)!
    expect(tally.done).toBe(true)
    expect(tally.options.map(option => [option.letter, option.text, option.votes.map(item => item.name)])).toEqual([['A', '方案一', []], ['B', '方案二', ['研究员']]])
    expect(tally.options[1].votes[0].reason).toBe('改主意了，B 更稳')
    expect(tally.invalid.map(item => item.name)).toEqual(['校对'])
    expect(tally.missing.map(item => item.name)).toEqual(['分析师'])
    expect(tally.leaders).toEqual([1])
    expect(tally.voted).toBe(1)
  })

  it('has every option with the most votes as leaders on a tie, and none before any vote', () => {
    const { store, chat, vote, reply } = setup()
    const poll = vote('p1', { question: 'q', options: ['x', 'y', 'z'], round: 1 }, { r1: 'received', r2: 'received' })
    expect(tallyPoll(store, chat, poll)!.leaders).toEqual([])
    reply('a1', 'r1', 'p1', '投票：A')
    reply('a2', 'r2', 'p1', '投票：C')
    expect(tallyPoll(store, chat, poll)!.leaders).toEqual([0, 2])
  })

  it('in a second round, says what each member voted the first time', () => {
    const { store, chat, vote, reply } = setup()
    vote('p1', { question: 'q', options: ['x', 'y'], round: 1 }, { r1: 'received', r2: 'received' })
    reply('a1', 'r1', 'p1', '投票：A')
    reply('a2', 'r2', 'p1', '投票：B')
    const second = vote('p2', { question: 'q', options: ['x', 'y'], round: 2, of: 'p1' }, { r1: 'received', r2: 'received' })
    reply('b1', 'r1', 'p2', '投票：B\n理由：被说服了')
    reply('b2', 'r2', 'p2', '投票：B')
    const tally = tallyPoll(store, chat, second)!
    expect(tally.options[1].votes.map(item => [item.name, item.previousChoice])).toEqual([['研究员', 0], ['校对', 1]])
    expect(tally.secondRound).toBeUndefined()
    expect(tallyPoll(store, chat, store.messagesById.p1)!.secondRound?.id).toBe('p2')
  })

  it('is none for a message that is not a vote', () => {
    const { store, chat } = setup()
    expect(tallyPoll(store, chat, { id: 'm', chatId: 'c', seq: 1, type: 'user', content: 'hi', createdAt: 1, status: 'received' })).toBeUndefined()
  })
})

describe('what members are asked', () => {
  it('in the first round: pick one letter, on the first line, with a reason', () => {
    const { store, chat, vote } = setup()
    const poll = vote('p1', { question: '选哪个方案？', options: ['方案一', '方案二'], round: 1 }, { r1: 'pending' })
    const text = pollInstruction(store, chat, poll, false)
    expect(text).toContain('A. 方案一\nB. 方案二')
    expect(text).toContain('第一行写「投票：」加一个字母')
    expect(text).not.toContain('第一轮')
  })

  it('in the second round: also everyone\'s first-round votes and reasons, free to keep or change', () => {
    const { store, chat, vote, reply } = setup()
    vote('p1', { question: 'q', options: ['x', 'y'], round: 1 }, { r1: 'received', r2: 'received', r3: 'received' })
    reply('a1', 'r1', 'p1', '投票：A\n理由：便宜')
    reply('a2', 'r2', 'p1', '投票：B\n理由：稳')
    reply('a3', 'r3', 'p1', '不知道')
    const second = vote('p2', { question: 'q', options: ['x', 'y'], round: 2, of: 'p1' }, { r1: 'pending', r2: 'pending' })
    const text = pollInstruction(store, chat, second, false)
    expect(text).toContain('第一轮的投票：\n- 研究员：A（便宜）\n- 校对：B（稳）\n- 分析师：没有按格式投票')
    expect(text).toContain('可以坚持原来的选择，也可以改投')
    expect(pollInstruction(store, chat, second, true)).toContain('First-round votes:\n- 研究员: A (便宜)')
  })

  it('is summed up for the summarizer as the count with names', () => {
    const { store, chat, vote, reply } = setup()
    const poll = vote('p1', { question: 'q', options: ['x', 'y'], round: 1 }, { r1: 'received', r2: 'received', r3: 'received' })
    reply('a1', 'r1', 'p1', '投票：A')
    reply('a2', 'r2', 'p1', '投票：A')
    reply('a3', 'r3', 'p1', '没想好')
    expect(pollTallyText(tallyPoll(store, chat, poll)!, false)).toBe('A. x：2 票（研究员、校对）\nB. y：0 票\n没有按格式投票：分析师')
  })
})
