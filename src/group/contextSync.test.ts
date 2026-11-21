import { describe, expect, it } from 'vitest'
import { buildUnsyncedContext } from './contextSync'
import type { GroupChat, GroupMessage, GroupRole } from './types'

describe('what a web member\'s site is told when it comes back', () => {
  // 研究员's site last took message 1; then Kimi could not take prompts and its backup answered 2.
  const role: GroupRole = { id: 'r', chatId: 'c', name: '研究员', chatSite: 'kimi', backupModelId: 'api', status: 'ready', contextCursor: 1, createdAt: 1, updatedAt: 1 }
  const messages: GroupMessage[] = [
    { id: 'm1', chatId: 'c', seq: 1, type: 'user', content: '样本有多大？', targetRoleIds: ['r'], createdAt: 1, status: 'received' },
    { id: 'a1', chatId: 'c', seq: 2, type: 'assistant', roleId: 'r', roleName: '研究员', content: '已经读到的回答', createdAt: 2, status: 'received' },
    { id: 'm2', chatId: 'c', seq: 3, type: 'user', content: '结论还能用吗？', targetRoleIds: ['r', 'e'], createdAt: 3, status: 'received' },
    { id: 'b1', chatId: 'c', seq: 4, type: 'assistant', roleId: 'r', roleName: '研究员', content: '只能当参考。', answeredByFallback: 'DeepSeek API', createdAt: 4, status: 'received' },
    { id: 'e1', chatId: 'c', seq: 5, type: 'assistant', roleId: 'e', roleName: '工程师', content: '同意。', createdAt: 5, status: 'received' },
    { id: 'm3', chatId: 'c', seq: 6, type: 'user', content: '下一步做什么？', targetRoleIds: ['r'], createdAt: 6, status: 'pending' },
  ]
  const chat: GroupChat = { id: 'c', name: '调研', mode: 'collaborative', roleIds: ['r', 'e'], messageIds: messages.map(message => message.id), nextMessageSeq: 7, status: 'ready', createdAt: 1, updatedAt: 1 }

  it('includes what its backup answered for it, saying so, but not its own answers the site has', () => {
    const context = buildUnsyncedContext(chat, role, messages, messages[5], 6000, 'zh-CN')
    expect(context.messages.map(message => message.id)).toEqual(['m2', 'b1', 'e1'])
    expect(context.contextText).toContain('你（网页接不了消息时，由备用模型「DeepSeek API」代你回答）：只能当参考。')
    expect(context.contextText).toContain('工程师：同意。')
    expect(context.contextText).not.toContain('已经读到的回答')
  })

  it('says so in English too', () => {
    const context = buildUnsyncedContext(chat, role, messages, messages[5], 6000, 'en')
    expect(context.contextText).toContain('You (answered for you by the backup model "DeepSeek API" while your page could not take messages): 只能当参考。')
  })
})

describe('a web member\'s context in a group made 协作 later', () => {
  it('leaves out what others said before the switch, even after its page started over', () => {
    const role: GroupRole = { id: 'r', chatId: 'c', name: '研究员', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
    const messages: GroupMessage[] = [
      { id: 'm1', chatId: 'c', seq: 1, type: 'user', content: '工程师先看', targetRoleIds: ['e'], createdAt: 1, status: 'received' },
      { id: 'e1', chatId: 'c', seq: 2, type: 'assistant', roleId: 'e', roleName: '工程师', content: '切换前的独立回答', createdAt: 2, status: 'received' },
      { id: 'n1', chatId: 'c', seq: 3, type: 'user', content: '切换前只记在群里', targetRoleIds: [], createdAt: 3, status: 'received' },
      { id: 'e2', chatId: 'c', seq: 4, type: 'assistant', roleId: 'e', roleName: '工程师', content: '切换后的发言', createdAt: 4, status: 'received' },
      { id: 'm2', chatId: 'c', seq: 5, type: 'user', content: '一起讨论', targetRoleIds: ['r', 'e'], createdAt: 5, status: 'pending' },
    ]
    const chat: GroupChat = { id: 'c', name: '调研', mode: 'collaborative', roleIds: ['r', 'e'], messageIds: messages.map(message => message.id), nextMessageSeq: 6, status: 'ready', sharedFromSeq: 3, createdAt: 1, updatedAt: 1 }
    expect(buildUnsyncedContext(chat, role, messages, messages[4], 6000, 'zh-CN').messages.map(message => message.id)).toEqual(['e2'])
  })
})
