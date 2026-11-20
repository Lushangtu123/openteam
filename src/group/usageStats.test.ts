import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from './types'
import { computeUsage, formatCost } from './usageStats'

// Local times. 2026-11-19 is "today".
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime()
const NOW = at(19, 20)

function setup() {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.externalModelsById = {
    ds: { id: 'ds', name: 'DeepSeek API', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', modelName: 'deepseek-chat', fallbackModelName: 'deepseek-lite', pricing: { input: 2, output: 8, currency: 'CNY' }, createdAt: 0, updatedAt: 0 },
    gpt: { id: 'gpt', name: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', modelName: 'gpt-x', pricing: { input: 1, output: 4, currency: 'USD' }, createdAt: 0, updatedAt: 0 },
    free: { id: 'free', name: '本地模型', format: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: 'k', modelName: 'llama', createdAt: 0, updatedAt: 0 },
    agent: { id: 'agent', name: 'Claude Code', format: 'local-agent', baseUrl: '', apiKey: '', modelName: 'claude-code', localAgentId: 'claude-code', workspace: '/x', createdAt: 0, updatedAt: 0 },
  }
  const role = (id: string, chatId: string, name: string, fields: Partial<GroupRole>): GroupRole => ({ id, chatId, name, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...fields })
  const roles = [
    role('analyst', 'a', '分析师', { modelSource: 'external', externalModelId: 'ds' }),
    role('kimi', 'a', '研究员', { modelSource: 'site', chatSite: 'kimi', backupModelId: 'gpt' }),
    role('coder', 'b', '工程师', { modelSource: 'external', externalModelId: 'agent' }),
    role('local', 'b', '本地', { modelSource: 'external', externalModelId: 'free' }),
  ]
  for (const item of roles) store.rolesById[item.id] = item
  const chat = (id: string, name: string): GroupChat => ({ id, name, mode: 'collaborative', roleIds: roles.filter(item => item.chatId === id).map(item => item.id), messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 })
  store.chatsById.a = chat('a', '调研群')
  store.chatsById.b = chat('b', '开发群')
  store.chatOrder = ['a', 'b']
  let n = 0
  const reply = (roleId: string, createdAt: number, fields: Partial<GroupMessage> = {}) => {
    const r = store.rolesById[roleId]
    const message = { id: `m${++n}`, chatId: r.chatId, seq: n, type: 'assistant', roleId, roleName: r.name, content: '答', createdAt, status: 'received', ...fields } as GroupMessage
    store.messagesById[message.id] = message
    store.chatsById[r.chatId].messageIds.push(message.id)
  }
  // Today: two DeepSeek answers (one by its backup model), two Kimi answers (one by its backup), one agent run, one free-model answer.
  reply('analyst', at(19), { modelId: 'ds', usage: { inputTokens: 1_000_000, outputTokens: 250_000 } })
  reply('analyst', at(19, 11), { modelId: 'ds', usage: { inputTokens: 1000, outputTokens: 500 }, answeredByFallback: 'deepseek-lite' })
  reply('kimi', at(19))
  reply('kimi', at(19, 12), { modelId: 'gpt', usage: { inputTokens: 500_000, outputTokens: 100_000 }, answeredByFallback: 'OpenAI' })
  reply('coder', at(19))
  reply('local', at(19), { usage: { inputTokens: 300, outputTokens: 200 } })
  // Three days ago and a month ago; a failed and a pending reply, which do not count.
  reply('analyst', at(16), { usage: { inputTokens: 100_000, outputTokens: 0 } })
  reply('kimi', at(1))
  reply('kimi', at(19), { status: 'error' })
  reply('analyst', at(19), { status: 'pending' })
  store.siteUsageBySite = { kimi: { day: '2026-11-19', sent: 2, limitCount: 15 } }
  return store
}

describe('the usage of a time range', () => {
  it('counts today\'s answers and tokens, and prices them with each model\'s price, in its currency', () => {
    const report = computeUsage(setup(), { range: 'today', now: NOW })
    expect(report.total).toMatchObject({ replies: 6, inputTokens: 1_501_300, outputTokens: 350_700 })
    // DeepSeek ¥2/¥8 per million: 1M in + 250k out = ¥4. The OpenAI backup $1/$4: 500k + 100k = $0.9.
    expect(report.total.cost).toEqual({ CNY: 4, USD: 0.9 })
    // Tokens with no price: the DeepSeek backup model's (1500) and the free model's (500).
    expect(report.total.unpricedTokens).toBe(2000)
  })

  it('has a row per member, with its kind and model, most answers first', () => {
    const members = computeUsage(setup(), { range: 'today', now: NOW }).members
    expect(members.map(row => [row.name, row.chatName, row.kind, row.model, row.replies])).toEqual([
      ['分析师', '调研群', 'api', 'DeepSeek API', 2],
      ['研究员', '调研群', 'web', 'Kimi', 2],
      ['工程师', '开发群', 'agent', 'Claude Code', 1],
      ['本地', '开发群', 'api', '本地模型', 1],
    ])
    expect(members[1]).toMatchObject({ backupReplies: 1, cost: { USD: 0.9 } })
  })

  it('counts each group, each day of the range, and the sites\' own answers with the count they were limited at', () => {
    const report = computeUsage(setup(), { range: '7d', now: NOW })
    expect(report.chats.map(row => [row.name, row.replies])).toEqual([['调研群', 5], ['开发群', 2]])
    expect(report.days.map(row => [row.day, row.replies])).toEqual([
      ['2026-11-13', 0], ['2026-11-14', 0], ['2026-11-15', 0], ['2026-11-16', 1], ['2026-11-17', 0], ['2026-11-18', 0], ['2026-11-19', 6],
    ])
    // Kimi answered itself once today; its backup's answer is the model's, not the site's.
    expect(report.sites).toEqual([{ site: 'kimi', label: 'Kimi', replies: 1, limitCount: 15 }])
  })

  it('narrows to one group, and takes everything for 全部', () => {
    expect(computeUsage(setup(), { range: 'today', chatId: 'b', now: NOW }).total.replies).toBe(2)
    const all = computeUsage(setup(), { range: 'all', now: NOW })
    expect(all.total.replies).toBe(8)
    expect(all.sites[0].replies).toBe(2)
    expect(all.days.map(row => row.day)).toEqual(['2026-11-01', '2026-11-16', '2026-11-19'])
  })

  it('prices a reply from before models were recorded with its member\'s model, and keeps a member that left', () => {
    const store = setup()
    delete store.messagesById.m7.modelId
    delete store.rolesById.analyst
    const report = computeUsage(store, { range: '7d', now: NOW })
    expect(report.members.find(row => row.name === '分析师')).toMatchObject({ removed: true, replies: 3 })
  })
})

describe('a cost as shown', () => {
  it('is in yuan and dollars, small amounts kept readable', () => {
    expect(formatCost({ CNY: 4, USD: 0.9 })).toBe('¥4.00 + $0.90')
    expect(formatCost({ CNY: 0.0034 })).toBe('¥0.0034')
    expect(formatCost({})).toBe('—')
  })
})
