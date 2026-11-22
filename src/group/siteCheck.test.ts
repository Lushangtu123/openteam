import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import { SITE_CHECK_SITES, SITE_CHECK_TIMEOUT_MS, siteCheckGroupInUse, siteCheckResults, siteCheckSummary } from './siteCheck'
import type { ChatSite, GroupChat, GroupMessage, GroupRole, OpenTeamStore, RoleSiteHealth } from './types'

const START = 1_000_000

function checkStore(sites: ChatSite[]) {
  const store: OpenTeamStore = createDefaultStore()
  const chat: GroupChat = { id: 'chat-check', name: '网站自检', mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: START, updatedAt: START, siteCheck: { startedAt: START } }
  store.chatsById[chat.id] = chat
  for (const site of sites) {
    const role: GroupRole = { id: `role-${site}`, chatId: chat.id, name: site, chatSite: site, modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: START, updatedAt: START } as GroupRole
    store.rolesById[role.id] = role
    chat.roleIds.push(role.id)
  }
  const question: GroupMessage = { id: 'msg-q', chatId: chat.id, seq: 1, type: 'user', content: '@所有人 只回复 OK', createdAt: START + 500, status: 'sent', deliveryStatus: Object.fromEntries(sites.map(site => [`role-${site}`, 'pending'])) }
  store.messagesById[question.id] = question
  chat.messageIds.push(question.id)
  const reply = (site: ChatSite, status: GroupMessage['status'], content: string) => {
    const message: GroupMessage = { id: `msg-${site}`, chatId: chat.id, seq: chat.messageIds.length + 1, type: 'assistant', content, roleId: `role-${site}`, sourceMessageId: question.id, createdAt: START + 1000, status }
    store.messagesById[message.id] = message
    chat.messageIds.push(message.id)
    question.deliveryStatus![`role-${site}`] = status === 'error' ? 'error' : 'received'
  }
  const health = (site: ChatSite, value: Omit<RoleSiteHealth, 'siteId' | 'updatedAt'>) => {
    store.rolesById[`role-${site}`].siteHealth = { siteId: site, updatedAt: START, ...value }
  }
  return { store, chat, question, reply, health }
}

describe('the site check', () => {
  it('checks every AI site OpenTeam opens', () => {
    expect(SITE_CHECK_SITES).toEqual(['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'kimi'])
  })

  it('says how each site did', () => {
    const { store, chat, question, reply, health } = checkStore(['gemini', 'chatgpt', 'deepseek', 'grok', 'qwen', 'kimi'])
    reply('gemini', 'received', 'OK')
    reply('chatgpt', 'error', '回复失败：发送失败：找不到发送按钮\n\n可以点击下方的重新回复按钮再试一次。')
    health('deepseek', { status: 'unauthorized', reason: 'login' })
    health('grok', { status: 'blocked', reason: 'verification' })
    question.deliveryStatus!['role-qwen'] = 'sent'
    // kimi: nothing yet.

    const early = siteCheckResults(store, chat, START + 10_000)
    expect(early.map(result => [result.site, result.outcome])).toEqual([
      ['gemini', 'ok'],
      ['chatgpt', 'failed'],
      ['deepseek', 'login'],
      ['grok', 'page-problem'],
      ['qwen', 'waiting'],
      ['kimi', 'waiting'],
    ])
    expect(early.find(result => result.site === 'chatgpt')?.detail).toBe('发送失败：找不到发送按钮')
    expect(early.find(result => result.site === 'grok')?.detail).toBe('verification')

    const late = siteCheckResults(store, chat, START + 500 + SITE_CHECK_TIMEOUT_MS + 1)
    expect(late.find(result => result.site === 'qwen')?.outcome).toBe('no-reply')
    expect(late.find(result => result.site === 'kimi')?.outcome).toBe('not-sent')
  })

  it('counts a reply as working even when its words are not exactly OK', () => {
    const { store, chat, reply } = checkStore(['gemini'])
    reply('gemini', 'received', '好的，OK！')
    expect(siteCheckResults(store, chat, START + 5000)[0].outcome).toBe('ok')
  })

  it('trusts a reply over a stale health report', () => {
    const { store, chat, reply, health } = checkStore(['grok'])
    health('grok', { status: 'blocked', reason: 'overlay' })
    reply('grok', 'received', 'OK')
    expect(siteCheckResults(store, chat, START + 5000)[0].outcome).toBe('ok')
  })

  it('is waiting while the question has not been sent', () => {
    const { store, chat } = checkStore(['gemini'])
    chat.messageIds = []
    expect(siteCheckResults(store, chat, START + 5000)[0].outcome).toBe('waiting')
  })

  it('sums the results up, and says when it is still running', () => {
    const { store, chat, reply, health } = checkStore(['gemini', 'chatgpt', 'deepseek'])
    reply('gemini', 'received', 'OK')
    health('deepseek', { status: 'unauthorized', reason: 'login' })
    expect(siteCheckSummary(siteCheckResults(store, chat, START + 5000), 'zh-CN')).toBe('检查中：1 个正常，1 个需要处理，1 个等待中')
    reply('chatgpt', 'received', 'OK')
    expect(siteCheckSummary(siteCheckResults(store, chat, START + 5000), 'zh-CN')).toBe('检查完成：2 个正常，1 个需要处理')
    expect(siteCheckSummary(siteCheckResults(store, chat, START + 5000), 'en')).toBe('Check finished: 2 working, 1 needs attention')
  })
})

describe('a 网站自检 group the user went on using', () => {
  it('is one changed in its settings, or with a message of the user\'s own besides the check\'s question', () => {
    const message = (id: string, type: 'user' | 'assistant'): GroupMessage => ({ id, chatId: 'c', seq: 1, type, content: 'x', createdAt: 1, status: 'received' })
    const messagesById = { q: message('q', 'user'), a: message('a', 'assistant'), mine: message('mine', 'user') }
    const chat = (messageIds: string[], kept?: boolean): GroupChat => ({ id: 'c', name: '网站自检 11-17 13:56', mode: 'independent', roleIds: [], messageIds, nextMessageSeq: 4, status: 'ready', siteCheck: { startedAt: 1, scheduled: true, ...(kept ? { kept } : {}) }, createdAt: 1, updatedAt: 1 })
    expect(siteCheckGroupInUse({ messagesById }, chat(['q', 'a']))).toBe(false)
    expect(siteCheckGroupInUse({ messagesById }, chat(['q', 'a', 'mine']))).toBe(true)
    expect(siteCheckGroupInUse({ messagesById }, chat(['q', 'a'], true))).toBe(true)
  })
})
