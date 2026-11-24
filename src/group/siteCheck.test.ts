import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import { SITE_CHECK_SITES, SITE_CHECK_TIMEOUT_MS, siteCheckDeadline, siteCheckExplanation, siteCheckGroupInUse, siteCheckQuestionIds, siteCheckResults, siteCheckRetries, siteCheckSummary } from './siteCheck'
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

describe('a site asked a second time', () => {
  it('is waiting while its page loads again, then reports that try, saying so', () => {
    const { store, chat, reply } = checkStore(['gemini', 'kimi'])
    reply('gemini', 'error', '回复失败：RESPONSE_NOT_FOUND')
    reply('kimi', 'received', 'OK')
    expect(siteCheckResults(store, chat, START + 5000).map(result => result.outcome)).toEqual(['failed', 'ok'])
    expect(siteCheckRetries('failed')).toBe(true)
    expect(siteCheckRetries('login')).toBe(false)

    chat.siteCheck!.retry = { roleIds: ['role-gemini'] }
    const loading = siteCheckResults(store, chat, START + 6000)[0]
    expect(loading).toMatchObject({ outcome: 'waiting', retried: true })
    expect(siteCheckExplanation(loading, false)).toBe('第一次没成功，已重新打开页面，正在再问一次。')

    const again: GroupMessage = { id: 'msg-again', chatId: chat.id, seq: 9, type: 'user', content: '@Gemini OK', createdAt: START + 60_000, status: 'sent', deliveryStatus: { 'role-gemini': 'sent' } }
    store.messagesById[again.id] = again
    chat.messageIds.push(again.id)
    chat.siteCheck!.retry.messageId = again.id
    expect(siteCheckResults(store, chat, START + 61_000)[0]).toMatchObject({ outcome: 'waiting', retried: true })
    // Its time is the second question's.
    expect(siteCheckDeadline(store, chat)).toBe(START + 60_000 + SITE_CHECK_TIMEOUT_MS)
    const failedAgain = siteCheckResults(store, chat, START + 60_000 + SITE_CHECK_TIMEOUT_MS + 1)[0]
    expect(failedAgain).toMatchObject({ outcome: 'no-reply', retried: true })
    expect(siteCheckExplanation(failedAgain, false)).toBe('提问已送进页面，但 5 分钟内没读到回复，网站可能改版了。重新打开页面再问了一次，还是这样。')
    expect(siteCheckExplanation(failedAgain, true)).toContain('Same on a second try with the page loaded again.')

    // Answered the second time: working.
    const ok: GroupMessage = { id: 'msg-ok', chatId: chat.id, seq: 10, type: 'assistant', roleId: 'role-gemini', sourceMessageId: again.id, content: 'OK', createdAt: START + 70_000, status: 'received' }
    store.messagesById[ok.id] = ok
    chat.messageIds.push(ok.id)
    expect(siteCheckResults(store, chat, START + 70_000)[0]).toMatchObject({ outcome: 'ok', retried: true })
    expect(siteCheckExplanation(siteCheckResults(store, chat, START + 70_000)[0], false)).toBe('能发送，也能读到回复。')
  })

  it('keeps its first result when the second try could not be asked', () => {
    const { store, chat, reply } = checkStore(['gemini'])
    reply('gemini', 'error', '回复失败：RESPONSE_NOT_FOUND')
    chat.siteCheck!.retry = { roleIds: ['role-gemini'], error: '重新打开的网站页面都没有加载好' }
    expect(siteCheckResults(store, chat, START + 5000)[0]).toEqual(expect.objectContaining({ outcome: 'failed' }))
    expect(siteCheckResults(store, chat, START + 5000)[0].retried).toBeUndefined()
  })
})

describe('a check group asked again', () => {
  it('reads this check\'s question, and is waiting until it is asked', () => {
    const { store, chat, reply } = checkStore(['gemini'])
    reply('gemini', 'received', 'OK')
    // The next check: the earlier question is one of the group's, not this check's.
    chat.siteCheck = { startedAt: START + 100_000, questionIds: ['msg-q'] }
    expect(siteCheckResults(store, chat, START + 100_001)[0].outcome).toBe('waiting')
    expect(siteCheckDeadline(store, chat)).toBeUndefined()
    const next: GroupMessage = { id: 'msg-q2', chatId: chat.id, seq: 9, type: 'user', content: '@all OK', createdAt: START + 100_500, status: 'sent', deliveryStatus: { 'role-gemini': 'sent' } }
    store.messagesById[next.id] = next
    chat.messageIds.push(next.id)
    chat.siteCheck = { ...chat.siteCheck, questionId: next.id, questionIds: ['msg-q', next.id] }
    expect(siteCheckResults(store, chat, START + 100_600)[0].outcome).toBe('waiting')
    expect(siteCheckQuestionIds(store, chat)).toEqual(['msg-q', 'msg-q2'])
    // Every check's questions are the checks', not the user's.
    expect(siteCheckGroupInUse(store, chat)).toBe(false)
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
    // What OpenTeam asked by itself is not the user's: a summary of the check's round (checks from
    // before had one), and a check's question.
    const summary: GroupMessage = { ...message('sum', 'user'), roundSummaryOf: 'q' }
    const asked: GroupMessage = { ...message('again', 'user'), siteCheckQuestion: true }
    expect(siteCheckGroupInUse({ messagesById: { ...messagesById, sum: summary, again: asked } }, chat(['q', 'a', 'sum', 'again']))).toBe(false)
  })
})
