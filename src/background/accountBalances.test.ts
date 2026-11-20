import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

async function setup(respond: (url: string, init: RequestInit) => Promise<Response>) {
  vi.resetModules()
  const store: OpenTeamStore = createDefaultStore()
  const model = (id: string, name: string, baseUrl: string, apiKey: string) => ({ id, name, format: 'openai' as const, baseUrl, apiKey, modelName: 'x', createdAt: 0, updatedAt: 0 })
  store.settings.externalModelsById = {
    a: model('a', 'DeepSeek Chat', 'https://api.deepseek.com/v1', 'sk-ds'),
    b: model('b', 'DeepSeek Reasoner', 'https://api.deepseek.com/v1', 'sk-ds'),
    c: model('c', 'Kimi', 'https://api.moonshot.cn/v1', 'sk-kimi'),
    d: model('d', 'OpenAI', 'https://api.openai.com/v1', 'sk-openai'),
  }
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const { createAccountBalances } = await import('./accountBalances')
  let clock = new Date(2026, 10, 19, 9).getTime()
  const fetch = vi.fn(respond)
  const broadcastStoreUpdated = vi.fn()
  const balances = createAccountBalances({ fetch, hash: async text => `len${text.length}`, broadcastStoreUpdated, now: () => clock, log: { info: vi.fn(), warn: vi.fn() } })
  const run = () => balances.routes[0].handler({ type: 'USAGE_BALANCES_REFRESH' }, {}) as Promise<{ checked: number; errors: Array<{ label: string; error: string }> }>
  return { store, fetch, run, broadcastStoreUpdated, later: (hours: number) => { clock += hours * 3_600_000 } }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

describe('reading the API accounts\' balances', () => {
  it('reads each DeepSeek or Kimi account once, with its own key, and records its spend', async () => {
    let deepseek = 110
    const { store, fetch, run, broadcastStoreUpdated, later } = await setup(async url => url.includes('deepseek')
      ? json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: String(deepseek) }] })
      : json({ code: 0, data: { available_balance: 49.5 } }))
    expect(await run()).toEqual({ ok: true, checked: 2, errors: [] })
    expect(fetch.mock.calls.map(([url, init]) => [url, (init.headers as Record<string, string>).Authorization, init.credentials])).toEqual([
      ['https://api.deepseek.com/user/balance', 'Bearer sk-ds', 'omit'],
      ['https://api.moonshot.cn/v1/users/me/balance', 'Bearer sk-kimi', 'omit'],
    ])
    expect(store.accountBalancesById!['deepseek-len5']).toMatchObject({ label: 'DeepSeek Chat、DeepSeek Reasoner', balance: 110, currency: 'CNY' })
    // No key is kept in what is recorded.
    expect(JSON.stringify(store.accountBalancesById)).not.toContain('sk-')
    deepseek = 107.25
    later(2)
    await run()
    expect(store.accountBalancesById!['deepseek-len5'].spentByDay).toEqual({ '2026-11-19': 2.75 })
    expect(broadcastStoreUpdated).toHaveBeenCalledTimes(2)
  })

  it('says which account could not be read, and keeps its last reading', async () => {
    let fail = false
    const { store, run } = await setup(async url => {
      if (fail && url.includes('moonshot')) return new Response('{"error":{"message":"Invalid Authentication"}}', { status: 401 })
      return url.includes('deepseek') ? json({ balance_infos: [{ currency: 'CNY', total_balance: '5' }] }) : json({ data: { available_balance: 9 } })
    })
    await run()
    fail = true
    expect(await run()).toEqual({ ok: true, checked: 1, errors: [{ label: 'Kimi', error: 'HTTP 401' }] })
    expect(store.accountBalancesById!['moonshot-len7']).toMatchObject({ balance: 9, error: 'HTTP 401' })
  })
})
