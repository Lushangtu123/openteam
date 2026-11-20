// 用量's real spend, the way dsh-whale-widget reads it: an API provider's account balance, read with
// the model's own key now and then. Each drop in the balance is money spent that day; a rise is a
// top-up and spends nothing. Only DeepSeek and Kimi (Moonshot) say their balance this way. It is the
// whole account's spend, use outside OpenTeam (DSH, other apps) included.
import type { ExternalModelConfig } from './types'

export type BalanceProvider = 'deepseek' | 'moonshot'

export interface AccountBalance {
  // The provider and a hash of the key: the same account behind several model settings is one.
  key: string
  provider: BalanceProvider
  // The model settings' names it was read with.
  label: string
  currency: 'CNY' | 'USD'
  balance: number
  checkedAt: number
  // Spent per local day (YYYY-MM-DD), the last KEEP_DAYS days.
  spentByDay: Record<string, number>
  // Why the last read failed, if it did.
  error?: string
}

export interface BalanceReading {
  key: string
  provider: BalanceProvider
  label: string
  amount: number
  currency: 'CNY' | 'USD'
}

const KEEP_DAYS = 60

export function balanceEndpointFor(model: ExternalModelConfig): { provider: BalanceProvider; url: string } | undefined {
  if (model.format === 'local-agent' || !model.apiKey?.trim()) return undefined
  let url: URL
  try {
    url = new URL(model.baseUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  if (url.hostname === 'api.deepseek.com') return { provider: 'deepseek', url: 'https://api.deepseek.com/user/balance' }
  if (url.hostname === 'api.moonshot.cn' || url.hostname === 'api.moonshot.ai') return { provider: 'moonshot', url: `https://${url.hostname}/v1/users/me/balance` }
  return undefined
}

export function readBalanceResponse(provider: BalanceProvider, json: unknown): { amount: number; currency: 'CNY' | 'USD' } {
  const value = json as Record<string, unknown> | undefined
  if (provider === 'deepseek') {
    const infos = Array.isArray(value?.balance_infos) ? value!.balance_infos as Array<Record<string, unknown>> : []
    const info = infos.find(item => item.currency === 'CNY') ?? infos[0]
    const amount = Number(info?.total_balance)
    if (info && Number.isFinite(amount)) return { amount, currency: info.currency === 'USD' ? 'USD' : 'CNY' }
  } else {
    const data = value?.data as Record<string, unknown> | undefined
    const amount = Number(data?.available_balance)
    if (data && Number.isFinite(amount)) return { amount, currency: 'CNY' }
  }
  throw new Error('没有读到余额')
}

// The account after a new reading: today's spend grows by any drop since the last reading.
export function recordBalance(previous: AccountBalance | undefined, reading: BalanceReading, now: number): AccountBalance {
  const day = localDay(now)
  const spentByDay = { ...(previous?.spentByDay ?? {}) }
  spentByDay[day] ??= 0
  if (previous && previous.currency === reading.currency && reading.amount < previous.balance) {
    spentByDay[day] = round(spentByDay[day] + previous.balance - reading.amount)
  }
  const kept = Object.keys(spentByDay).sort().reverse().slice(0, KEEP_DAYS)
  return {
    key: reading.key,
    provider: reading.provider,
    label: reading.label,
    currency: reading.currency,
    balance: reading.amount,
    checkedAt: now,
    spentByDay: Object.fromEntries(kept.sort().map(key => [key, spentByDay[key]])),
  }
}

// What the account spent on the days from `start` to `end`.
export function spentInRange(account: AccountBalance, start: number, end: number): number {
  const first = localDay(start)
  const last = localDay(end)
  return round(Object.entries(account.spentByDay).reduce((sum, [day, spent]) => day >= first && day <= last ? sum + spent : sum, 0))
}

export function normalizeAccountBalances(raw: unknown): Record<string, AccountBalance> {
  const result: Record<string, AccountBalance> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = value as Record<string, unknown>
    if (!item || typeof item !== 'object') continue
    if ((item.provider !== 'deepseek' && item.provider !== 'moonshot') || typeof item.balance !== 'number' || typeof item.checkedAt !== 'number') continue
    const spentByDay: Record<string, number> = {}
    if (item.spentByDay && typeof item.spentByDay === 'object') {
      for (const [day, spent] of Object.entries(item.spentByDay as Record<string, unknown>)) if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof spent === 'number' && spent >= 0) spentByDay[day] = spent
    }
    result[key] = {
      key,
      provider: item.provider,
      label: typeof item.label === 'string' ? item.label : '',
      currency: item.currency === 'USD' ? 'USD' : 'CNY',
      balance: item.balance,
      checkedAt: item.checkedAt,
      spentByDay,
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
    }
  }
  return result
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
