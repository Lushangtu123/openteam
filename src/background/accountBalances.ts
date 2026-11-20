// 用量's real spend (src/group/accountBalance.ts): reads each DeepSeek or Kimi account's balance with
// the key in its model settings, when the 用量 window opens and every hour, and records what the
// account spent. The key goes only to its own provider, the address the model already talks to.
import { balanceEndpointFor, readBalanceResponse, recordBalance, type BalanceProvider } from '../group/accountBalance'
import type { OpenTeamStore } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import { mutateStore } from './storeAccess'

export const ACCOUNT_BALANCE_ALARM = 'openteam-account-balances'
const TIMEOUT_MS = 10_000

export interface AccountBalanceDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>
  // A short, one-way hash of a key, to tell accounts apart without keeping keys elsewhere.
  hash(text: string): Promise<string>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  now(): number
  log: { info(event: string, details?: Record<string, unknown>): void; warn(event: string, details?: Record<string, unknown>): void }
}

export interface BalanceRefreshResult {
  checked: number
  errors: Array<{ label: string; error: string }>
}

export function createAccountBalances(deps: AccountBalanceDependencies) {
  let running: Promise<BalanceRefreshResult> | undefined

  function refresh(): Promise<BalanceRefreshResult> {
    running ??= readAll().finally(() => { running = undefined })
    return running
  }

  async function readAll(): Promise<BalanceRefreshResult> {
    const { result: models } = await mutateStore(store => Object.values(store.settings.externalModelsById).flatMap(model => {
      const endpoint = balanceEndpointFor(model)
      return endpoint ? [{ name: model.name, apiKey: model.apiKey.trim(), ...endpoint }] : []
    }))
    // One read per account: several model settings may share a key.
    const accounts = new Map<string, { provider: BalanceProvider; url: string; apiKey: string; names: string[] }>()
    for (const model of models) {
      const key = `${model.provider}-${await deps.hash(model.apiKey)}`
      const account = accounts.get(key) ?? { provider: model.provider, url: model.url, apiKey: model.apiKey, names: [] }
      account.names.push(model.name)
      accounts.set(key, account)
    }
    const errors: BalanceRefreshResult['errors'] = []
    let checked = 0
    for (const [key, account] of accounts) {
      const label = account.names.join('、')
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        let reading
        try {
          const response = await deps.fetch(account.url, { headers: { Authorization: `Bearer ${account.apiKey}`, Accept: 'application/json' }, credentials: 'omit', signal: controller.signal })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          reading = readBalanceResponse(account.provider, await response.json())
        } finally {
          clearTimeout(timer)
        }
        const now = deps.now()
        await mutateStore(store => {
          store.accountBalancesById ??= {}
          store.accountBalancesById[key] = recordBalance(store.accountBalancesById[key], { key, provider: account.provider, label, ...reading }, now)
        })
        checked += 1
      } catch (error) {
        const message = error instanceof Error ? (error.name === 'AbortError' ? '超时' : error.message) : String(error)
        errors.push({ label, error: message })
        await mutateStore(store => {
          const previous = store.accountBalancesById?.[key]
          if (previous) previous.error = message
        })
        deps.log.warn('account-balance:failed', { provider: account.provider, error: message })
      }
    }
    if (accounts.size > 0) {
      const { store } = await mutateStore(() => undefined)
      await deps.broadcastStoreUpdated(store)
    }
    return { checked, errors }
  }

  const routes: BackgroundMessageRoute[] = [
    { type: 'USAGE_BALANCES_REFRESH', handler: async () => ({ ok: true, ...(await refresh()) }) },
  ]
  return { refresh, routes }
}
