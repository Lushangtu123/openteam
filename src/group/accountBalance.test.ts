import { describe, expect, it } from 'vitest'
import { balanceEndpointFor, readBalanceResponse, recordBalance, spentInRange, type AccountBalance } from './accountBalance'
import type { ExternalModelConfig } from './types'

const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime()
const model = (baseUrl: string, fields: Partial<ExternalModelConfig> = {}): ExternalModelConfig => ({ id: 'm', name: 'M', format: 'openai', baseUrl, apiKey: 'sk-1', modelName: 'x', createdAt: 0, updatedAt: 0, ...fields })

describe('where an API model\'s account balance is read', () => {
  it('is the provider\'s balance address, for DeepSeek and Kimi (Moonshot)', () => {
    expect(balanceEndpointFor(model('https://api.deepseek.com/v1'))).toEqual({ provider: 'deepseek', url: 'https://api.deepseek.com/user/balance' })
    expect(balanceEndpointFor(model('https://api.deepseek.com'))).toEqual({ provider: 'deepseek', url: 'https://api.deepseek.com/user/balance' })
    expect(balanceEndpointFor(model('https://api.moonshot.cn/v1'))).toEqual({ provider: 'moonshot', url: 'https://api.moonshot.cn/v1/users/me/balance' })
    expect(balanceEndpointFor(model('https://api.moonshot.ai/v1'))).toEqual({ provider: 'moonshot', url: 'https://api.moonshot.ai/v1/users/me/balance' })
  })

  it('is none for other providers, local agents and models without a key', () => {
    expect(balanceEndpointFor(model('https://api.openai.com/v1'))).toBeUndefined()
    expect(balanceEndpointFor(model('https://api.deepseek.com', { format: 'local-agent' }))).toBeUndefined()
    expect(balanceEndpointFor(model('https://api.deepseek.com', { apiKey: ' ' }))).toBeUndefined()
  })
})

describe('a balance answer', () => {
  it('is read as an amount and its currency', () => {
    expect(readBalanceResponse('deepseek', { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] })).toEqual({ amount: 110, currency: 'CNY' })
    expect(readBalanceResponse('moonshot', { code: 0, status: true, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 } })).toEqual({ amount: 49.58, currency: 'CNY' })
  })

  it('is refused when it holds no balance', () => {
    expect(() => readBalanceResponse('deepseek', { balance_infos: [] })).toThrow('没有读到余额')
    expect(() => readBalanceResponse('moonshot', { error: { message: 'Invalid Authentication' } })).toThrow('没有读到余额')
  })
})

describe('an account\'s spend, from its balance over time', () => {
  it('adds each drop in the balance to that day, ignores top-ups, and starts each day at 0', () => {
    let account: AccountBalance | undefined
    account = recordBalance(account, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 110, currency: 'CNY' }, at(18, 9))
    expect(account).toMatchObject({ balance: 110, spentByDay: { '2026-11-18': 0 } })
    account = recordBalance(account, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 108.5, currency: 'CNY' }, at(18, 12))
    // A top-up: the balance rises; nothing is spent by it.
    account = recordBalance(account, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 158.5, currency: 'CNY' }, at(18, 13))
    account = recordBalance(account, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 158, currency: 'CNY' }, at(18, 20))
    account = recordBalance(account, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 157, currency: 'CNY' }, at(19, 9))
    expect(account.spentByDay).toEqual({ '2026-11-18': 2, '2026-11-19': 1 })
    expect(account).toMatchObject({ balance: 157, checkedAt: at(19, 9) })
  })

  it('keeps 60 days, and sums the days of a range', () => {
    let account: AccountBalance | undefined
    for (let day = 1; day <= 19; day += 1) account = recordBalance(account, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 100 - day, currency: 'CNY' }, at(day))
    expect(spentInRange(account!, at(17, 0), at(19, 20))).toBe(3)
    expect(Object.keys(account!.spentByDay)).toHaveLength(19)
    const old = { ...account!, spentByDay: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`2026-0${index < 35 ? 8 : 9}-${String((index % 28) + 1).padStart(2, '0')}`, 1])) }
    expect(Object.keys(recordBalance(old, { key: 'k', provider: 'deepseek', label: 'DeepSeek', amount: 80, currency: 'CNY' }, at(19, 21)).spentByDay).length).toBeLessThanOrEqual(60)
  })
})
