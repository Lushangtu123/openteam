import { describe, expect, it } from 'vitest'
import { MAX_MEMORY_PROPOSALS, extractMemoryProposals, memoryProposalInstruction, resolveMemoryProposal, takeMemoryProposals, wantsMemoryProposals, withMemoryProposalInstruction } from './memoryProposals'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, OpenTeamStore } from './types'

function makeStore(on = true): { store: OpenTeamStore; chat: GroupChat; request: GroupMessage; reply: GroupMessage } {
  const store = createDefaultStore()
  if (on) store.settings.memoryProposals = true
  const chat: GroupChat = { id: 'c1', name: '群', mode: 'collaborative', roleIds: ['r1'], messageIds: ['m1', 'm2'], nextMessageSeq: 3, status: 'ready', createdAt: 1, updatedAt: 1 }
  const request: GroupMessage = { id: 'm1', chatId: 'c1', seq: 1, type: 'user', content: '数据库怎么选？', createdAt: 1, status: 'received' }
  const reply: GroupMessage = { id: 'm2', chatId: 'c1', seq: 2, type: 'assistant', roleId: 'r1', roleName: '后端', sourceMessageId: 'm1', content: '建议用 PostgreSQL。\n\n记忆提议（决定）：数据库用 PostgreSQL 15。', createdAt: 2, status: 'received' }
  store.chatsById.c1 = chat
  store.messagesById = { m1: request, m2: reply }
  return { store, chat, request, reply }
}

const ids = () => {
  let next = 0
  return (prefix: string) => `${prefix}-${next += 1}`
}

describe('reading the proposals a reply ends with', () => {
  it('takes the lines off the end and reads each one\'s kind', () => {
    const result = extractMemoryProposals('建议用 PostgreSQL。\n\n记忆提议（决定）：数据库用 PostgreSQL 15。\n记忆提议（偏好）：回答先给结论。\n')
    expect(result).toEqual({
      content: '建议用 PostgreSQL。',
      proposals: [{ kind: 'decision', content: '数据库用 PostgreSQL 15。' }, { kind: 'preference', content: '回答先给结论。' }],
    })
  })

  it('reads the ways models and sites\' markdown write the line', () => {
    const read = (line: string) => extractMemoryProposals(`正文。\n${line}`).proposals
    expect(read('记忆提议：[事实] 端口是 54329')).toEqual([{ kind: 'fact', content: '端口是 54329' }])
    expect(read('记忆提议\\[决定\\]：用 Go 写后端')).toEqual([{ kind: 'decision', content: '用 Go 写后端' }])
    expect(read('- **记忆提议（备注）**：周五交稿')).toEqual([{ kind: 'note', content: '周五交稿' }])
    expect(read('**记忆提议（偏好）：** 用中文回答')).toEqual([{ kind: 'preference', content: '用中文回答' }])
    expect(read('记忆提议【事实】: 缓存用 `Redis 7`')).toEqual([{ kind: 'fact', content: '缓存用 Redis 7' }])
    expect(read('Memory proposal (decision): Ship on Friday.')).toEqual([{ kind: 'decision', content: 'Ship on Friday.' }])
    expect(read('memory proposal: The API lives under /v2.')).toEqual([{ kind: 'fact', content: 'The API lives under /v2.' }])
    // A kind it does not know is a fact.
    expect(read('记忆提议（结论）：先做登录')).toEqual([{ kind: 'fact', content: '先做登录' }])
  })

  it('leaves alone a reply that does not end with a proposal', () => {
    for (const content of [
      '普通回复。',
      '记忆提议（事实）：写在开头的不算。\n后面还有正文。',
      '我说说什么是记忆提议：它是一行文字。\n然后是结论。',
      '```\n记忆提议（事实）：代码块里的不算\n',
      '',
    ]) expect(extractMemoryProposals(content)).toEqual({ content, proposals: [] })
  })

  it('leaves alone a reply that is nothing but proposals', () => {
    const content = '记忆提议（事实）：只有这一行'
    expect(extractMemoryProposals(content)).toEqual({ content, proposals: [] })
  })

  it('keeps at most three, drops repeats and over-long ones, and still takes the lines off', () => {
    const lines = ['一', '二', '二', '三', '四'].map(text => `记忆提议（事实）：${text}`)
    const result = extractMemoryProposals(`正文\n${lines.join('\n')}\n记忆提议（事实）：${'长'.repeat(501)}`)
    expect(result.content).toBe('正文')
    expect(result.proposals.map(proposal => proposal.content)).toEqual(['一', '二', '三'])
    expect(result.proposals).toHaveLength(MAX_MEMORY_PROPOSALS)
  })

  it('reads proposals after a closed code block, and keeps the reply\'s own line breaks', () => {
    const result = extractMemoryProposals('第一段\r\n\r\n```js\nconst a = 1\n```\r\n\r\n记忆提议（事实）：变量叫 a')
    expect(result).toEqual({ content: '第一段\n\n```js\nconst a = 1\n```', proposals: [{ kind: 'fact', content: '变量叫 a' }] })
  })
})

describe('which requests ask for proposals', () => {
  it('asks only when the user switched it on, and only where memory goes', () => {
    const { store, chat, request } = makeStore()
    expect(wantsMemoryProposals(store.settings, chat, request)).toBe(true)
    expect(wantsMemoryProposals({}, chat, request)).toBe(false)
    expect(wantsMemoryProposals(store.settings, { ...chat, memoryDisabled: true }, request)).toBe(false)
    // A round's summary answers in a set form.
    expect(wantsMemoryProposals(store.settings, chat, { ...request, roundSummaryOf: 'm0' })).toBe(false)
  })

  it('adds the instruction to the end of the prompt, in the page\'s language', () => {
    expect(withMemoryProposalInstruction('提示词', false, 'zh-CN')).toBe('提示词')
    expect(withMemoryProposalInstruction('提示词', true, 'zh-CN')).toBe(`提示词\n\n${memoryProposalInstruction('zh-CN')}`)
    expect(memoryProposalInstruction('zh-CN')).toContain('记忆提议（事实）：')
    expect(memoryProposalInstruction('en')).toContain('Memory proposal (fact):')
    // What the instruction shows is what the reader accepts.
    expect(extractMemoryProposals('ok\n记忆提议（事实）：一句话内容').proposals).toHaveLength(1)
    expect(extractMemoryProposals('ok\nMemory proposal (fact): one sentence').proposals).toHaveLength(1)
  })
})

describe('taking proposals off a finished reply', () => {
  it('moves them from the reply\'s text to the message', () => {
    const { store, chat, reply } = makeStore()
    expect(takeMemoryProposals(store, chat, reply, ids())).toBe(1)
    expect(reply.content).toBe('建议用 PostgreSQL。')
    expect(reply.memoryProposals).toEqual([{ id: 'proposal-1', kind: 'decision', content: '数据库用 PostgreSQL 15。' }])
  })

  it('reads nothing while the setting is off, or for a request that did not ask', () => {
    const off = makeStore(false)
    expect(takeMemoryProposals(off.store, off.chat, off.reply, ids())).toBe(0)
    expect(off.reply.content).toContain('记忆提议')
    expect(off.reply.memoryProposals).toBeUndefined()

    const summary = makeStore()
    summary.request.roundSummaryOf = 'm0'
    expect(takeMemoryProposals(summary.store, summary.chat, summary.reply, ids())).toBe(0)
    expect(summary.reply.content).toContain('记忆提议')
  })

  it('does not propose what the store already holds, but still takes the line off', () => {
    const { store, chat, reply } = makeStore()
    store.memoryItemsById = { known: { id: 'known', scope: 'global', kind: 'decision', content: '数据库用 PostgreSQL 15。', source: { origin: 'user' }, createdAt: 1, updatedAt: 1 } }
    store.memoryOrder = ['known']
    expect(takeMemoryProposals(store, chat, reply, ids())).toBe(0)
    expect(reply.content).toBe('建议用 PostgreSQL。')
    expect(reply.memoryProposals).toBeUndefined()
  })

  it('reads a reply again from scratch when it is read in full a second time', () => {
    const { store, chat, reply } = makeStore()
    takeMemoryProposals(store, chat, reply, ids())
    reply.content = '重新读回来的回复，没有提议。'
    expect(takeMemoryProposals(store, chat, reply, ids())).toBe(0)
    expect(reply.memoryProposals).toBeUndefined()
  })
})

describe('saving or dismissing a proposal', () => {
  it('removes that one from its message and returns it', () => {
    const { reply } = makeStore()
    reply.memoryProposals = [{ id: 'p1', kind: 'fact', content: '一' }, { id: 'p2', kind: 'note', content: '二' }]
    expect(resolveMemoryProposal(reply, 'p1')).toEqual({ id: 'p1', kind: 'fact', content: '一' })
    expect(reply.memoryProposals).toEqual([{ id: 'p2', kind: 'note', content: '二' }])
    expect(resolveMemoryProposal(reply, 'p2')?.content).toBe('二')
    expect('memoryProposals' in reply).toBe(false)
    expect(resolveMemoryProposal(reply, 'p2')).toBeUndefined()
    expect(resolveMemoryProposal(undefined, 'p1')).toBeUndefined()
  })
})
