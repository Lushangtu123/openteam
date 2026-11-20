// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { currentUsageDialog, openUsageDialog } from './usageDialog'

afterEach(() => {
  currentUsageDialog()?.close()
  document.body.innerHTML = ''
})

const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime()
const NOW = at(19, 20)

function setup() {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.externalModelsById = { ds: { id: 'ds', name: 'DeepSeek API', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', modelName: 'deepseek-chat', pricing: { input: 2, output: 8, currency: 'CNY' }, createdAt: 0, updatedAt: 0 } }
  const role = (id: string, chatId: string, name: string, fields: Partial<GroupRole>): GroupRole => ({ id, chatId, name, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...fields })
  store.rolesById.analyst = role('analyst', 'a', '分析师', { modelSource: 'external', externalModelId: 'ds' })
  store.rolesById.kimi = role('kimi', 'b', '研究员', { modelSource: 'site', chatSite: 'kimi' })
  store.chatsById.a = { id: 'a', name: '调研群', mode: 'collaborative', roleIds: ['analyst'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatsById.b = { id: 'b', name: '开发群', mode: 'collaborative', roleIds: ['kimi'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['a', 'b']
  let n = 0
  const reply = (roleId: string, createdAt: number, fields: Partial<GroupMessage> = {}) => {
    const r = store.rolesById[roleId]
    const message = { id: `m${++n}`, chatId: r.chatId, seq: n, type: 'assistant', roleId, roleName: r.name, content: '答', createdAt, status: 'received', ...fields } as GroupMessage
    store.messagesById[message.id] = message
    store.chatsById[r.chatId].messageIds.push(message.id)
  }
  reply('analyst', at(19), { modelId: 'ds', usage: { inputTokens: 1_000_000, outputTokens: 250_000 } })
  reply('analyst', at(17), { modelId: 'ds', usage: { inputTokens: 10_000, outputTokens: 0 } })
  reply('kimi', at(19))
  reply('kimi', at(1))
  openUsageDialog({ getStore: () => store, now: () => NOW })
  const q = (selector: string) => document.querySelector(selector)
  const cells = (className: string) => [...document.querySelectorAll(`.${className} tbody tr`)].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
  const tiles = () => [...document.querySelectorAll('.usage-tile')].map(node => [node.querySelector('.usage-tile-label')?.textContent, node.querySelector('.usage-tile-value')?.textContent])
  return { store, q, cells, tiles }
}

describe('the usage window', () => {
  it('shows the last 7 days by default: totals, answers per day, and members, groups and sites', () => {
    const { q, cells, tiles } = setup()
    expect(q('[data-range="7d"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(tiles()).toEqual([['回答', '3'], ['输入 token', '1,010,000'], ['输出 token', '250,000'], ['估算费用', '¥4.02']])
    expect(document.querySelectorAll('.usage-bar')).toHaveLength(7)
    expect([...document.querySelectorAll('.usage-bar-count')].map(node => node.textContent).filter(Boolean)).toEqual(['1', '2'])
    expect(cells('usage-members')).toEqual([
      ['分析师', '调研群', 'DeepSeek API', '2', '1,010,000', '250,000', '¥4.02'],
      ['研究员', '开发群', 'Kimi · 网页', '1', '0', '0', '—'],
    ])
    expect(cells('usage-chats')).toEqual([['调研群', '2', '1,010,000', '250,000', '¥4.02'], ['开发群', '1', '0', '0', '—']])
    expect(cells('usage-sites')).toEqual([['Kimi', '1', '—']])
  })

  it('switches the time range and the group', () => {
    const { q, cells, tiles } = setup()
    ;(q('[data-range="all"]') as HTMLButtonElement).click()
    expect(tiles()[0]).toEqual(['回答', '4'])
    const scope = q('.usage-scope') as HTMLSelectElement
    expect([...scope.options].map(option => option.textContent)).toEqual(['全部群聊', '调研群', '开发群'])
    scope.value = 'b'
    scope.dispatchEvent(new Event('change'))
    expect(tiles()[0]).toEqual(['回答', '2'])
    expect(q('.usage-chats')).toBeNull()
    expect(cells('usage-sites')).toEqual([['Kimi', '2', '—']])
  })

  it('says when nobody answered, notes tokens without a price, and closes on Esc', () => {
    const { store, q } = setup()
    ;(q('[data-range="today"]') as HTMLButtonElement).click()
    delete store.settings.externalModelsById.ds.pricing
    currentUsageDialog()?.refresh()
    expect(q('.usage-tile-note')?.textContent).toBe('另有 1,250,000 token 没有单价')
    for (const id of Object.keys(store.messagesById)) store.messagesById[id].createdAt = at(1)
    currentUsageDialog()?.refresh()
    expect(q('.usage-empty')?.textContent).toBe('这段时间里还没有成员回答过。')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(q('.usage-modal')).toBeNull()
  })
})

describe('the provider accounts in the usage window', () => {
  it('reads the balances when it opens, and shows each account\'s balance and real spend today and in the range', async () => {
    const store: OpenTeamStore = createDefaultStore()
    store.settings.language = 'zh-CN'
    store.accountBalancesById = {
      'deepseek-ab': { key: 'deepseek-ab', provider: 'deepseek', label: 'DeepSeek API', currency: 'CNY', balance: 107.25, checkedAt: at(19, 9), spentByDay: { '2026-11-15': 1, '2026-11-18': 0.5, '2026-11-19': 2.75 } },
    }
    let finish: (value: { errors: Array<{ label: string; error: string }> }) => void = () => undefined
    const refreshBalances = vi.fn(() => new Promise<{ errors: Array<{ label: string; error: string }> }>(resolve => { finish = resolve }))
    openUsageDialog({ getStore: () => store, now: () => NOW, refreshBalances })
    expect(refreshBalances).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.usage-refresh')?.textContent).toBe('读取中…')
    const rows = [...document.querySelectorAll('.usage-account-table tbody tr')].map(row => [...row.querySelectorAll('td')].slice(0, 4).map(cell => cell.textContent))
    expect(rows).toEqual([['DeepSeek · DeepSeek API', '¥107.25', '¥2.75', '¥4.25']])
    finish({ errors: [{ label: 'Kimi', error: 'HTTP 401' }] })
    await vi.waitFor(() => expect(document.querySelector('.usage-account-error')?.textContent).toBe('没读到「Kimi」的余额：HTTP 401'))
    expect(document.querySelector('.usage-refresh')?.textContent).toBe('刷新余额')
    expect(document.querySelector('.usage-account-note')?.textContent).toContain('也包括 OpenTeam 以外')
  })
})
