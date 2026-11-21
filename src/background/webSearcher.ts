// 联网搜索 (src/shared/webSearch.ts): an API member searches the web through Tavily while it answers
// (the search_web tool, externalModelClient.ts). The user's key goes only to api.tavily.com, which the
// user allowed when saving the key. At most MAX_SEARCHES_PER_REPLY searches a reply; the same search
// in one reply is answered from the first. What the member gets back is always text, a failure
// included, so it can go on answering. Also the settings' commands to save, remove and test the key,
// and Tavily's own count of the account's credits (GET /usage), read again after searches at most
// every ACCOUNT_FRESH_MS and whenever the 联网搜索 or 用量 window opens.
import type { OpenTeamStore } from '../group/types'
import { MAX_SEARCHES_PER_REPLY, readSearchKey, readSearchRequest, readTavilyResults, searchErrorMessage, searchResultsForModel, TAVILY_SEARCH_URL, TAVILY_USAGE_URL, tavilyRequestBody, type WebSearchOptions, type WebSearchResult, type WebSearchSettings } from '../shared/webSearch'
import { monthSearches, readTavilyAccount, recordWebSearch, searchQuotaState, type TavilyAccount } from '../shared/webSearchUsage'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import type { StoreMutationResult } from './storeAccess'

export const WEB_SEARCH_ROUTE_TYPES = ['WEB_SEARCH_SAVE', 'WEB_SEARCH_TEST', 'WEB_SEARCH_ACCOUNT_REFRESH', 'WEB_SEARCH_NOTICE_DISMISS'] as const
export const TAVILY_SITE = 'https://api.tavily.com/*'
const SEARCH_TIMEOUT_MS = 20_000
export const ACCOUNT_FRESH_MS = 5 * 60_000

export interface WebSearcherDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>
  hasAccess(pattern: string): Promise<boolean>
  loadStore(): Promise<OpenTeamStore>
  mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  log: { warn(event: string, details?: Record<string, unknown>): void }
  now?(): number
}

export interface SearchDone {
  query: string
  results: number
}

export type SearchWeb = (query: string, options?: WebSearchOptions) => Promise<string>

export function createWebSearcher(deps: WebSearcherDependencies) {
  const now = deps.now ?? (() => Date.now())

  // A search that came back is counted (src/shared/webSearchUsage.ts), and Tavily's own count is
  // read again when the last reading is older than ACCOUNT_FRESH_MS.
  async function count(key: string, from: { modelId?: string; chatId?: string; test?: boolean }): Promise<void> {
    const { store } = await deps.mutateStore(store => recordWebSearch(store.webSearchUsage ??= { days: {} }, from, now()))
    const checkedAt = store.webSearchUsage?.account?.checkedAt ?? 0
    if (store.settings.webSearch?.apiKey === key && now() - checkedAt >= ACCOUNT_FRESH_MS) {
      void refreshAccount(key).catch(error => deps.log.warn('web-search:usage-failed', { reason: error instanceof Error ? error.message : String(error) }))
    }
  }

  // Tavily's count of the account's credits, for the key given; throws why it was not read.
  async function readAccount(key: string): Promise<TavilyAccount> {
    if (!await deps.hasAccess(TAVILY_SITE)) throw new Error('OpenTeam 没有访问 api.tavily.com 的权限，请到设置 → 模型 → 联网搜索 重新保存 Key')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    try {
      const response = await deps.fetch(TAVILY_USAGE_URL, { method: 'GET', headers: { authorization: `Bearer ${key}` }, credentials: 'omit', signal: controller.signal })
      const text = await response.text()
      if (!response.ok) throw new Error(searchErrorMessage(response.status, text).replace('搜索失败', '没读到用量'))
      return readTavilyAccount(JSON.parse(text), now())
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Tavily 20 秒内没有给出用量')
      if (error instanceof SyntaxError) throw new Error('Tavily 没有给出用量')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  // Reads the saved key's credits and keeps them, unless the key changed meanwhile.
  async function refreshAccount(key?: string): Promise<TavilyAccount> {
    const apiKey = key ?? (await deps.loadStore()).settings.webSearch?.apiKey
    if (!apiKey) throw new Error('还没有填 Tavily 的 API Key')
    const account = await readAccount(apiKey)
    const { store, result: kept } = await deps.mutateStore(store => {
      if (store.settings.webSearch?.apiKey !== apiKey) return false
      ;(store.webSearchUsage ??= { days: {} }).account = account
      return true
    })
    if (kept) await deps.broadcastStoreUpdated(store)
    return account
  }
  // One search; throws why it did not work.
  async function search(key: string, request: { query: string } & WebSearchOptions, maxResults?: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
    if (!await deps.hasAccess(TAVILY_SITE)) throw new Error('OpenTeam 没有访问 api.tavily.com 的权限，请到设置 → 模型 → 联网搜索 重新保存 Key')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    const stop = () => controller.abort()
    signal?.addEventListener('abort', stop, { once: true })
    try {
      const response = await deps.fetch(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(tavilyRequestBody(request, maxResults)),
        credentials: 'omit',
        signal: controller.signal,
      })
      const text = await response.text()
      if (response.status === 432 || response.status === 433) {
        const account = await refreshAccount(key).catch(() => undefined)
        const usage = (await deps.loadStore()).webSearchUsage
        const quota = account ? searchQuotaState(usage) : undefined
        const counted = quota
          ? `（Tavily 本期已用 ${quota.used} / ${quota.limit} 个额度）`
          : `（本月 OpenTeam 已搜索 ${monthSearches(usage, now())} 次）`
        throw new Error(`${searchErrorMessage(response.status, text)}${counted}`)
      }
      if (!response.ok) throw new Error(searchErrorMessage(response.status, text))
      return readTavilyResults(JSON.parse(text))
    } catch (error) {
      if (signal?.aborted) throw error
      if (controller.signal.aborted) throw new Error('搜索 20 秒内没有回答')
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
  }

  // A search for one reply, or undefined when no key is set.
  function forReply(settings: WebSearchSettings | undefined, options: { english: boolean; signal?: AbortSignal; onSearch?(done: SearchDone): void; chatId?: string; modelId?: string }): SearchWeb | undefined {
    if (!settings?.apiKey) return undefined
    let searched = 0
    const done = new Map<string, string>()
    return async (query, searchOptions) => {
      let request: ReturnType<typeof readSearchRequest>
      try {
        request = readSearchRequest(query, searchOptions)
      } catch (error) {
        return `没有搜：${error instanceof Error ? error.message : String(error)}`
      }
      const key = JSON.stringify(request)
      const again = done.get(key)
      if (again !== undefined) return again
      if (searched >= MAX_SEARCHES_PER_REPLY) return `这次回答最多搜索 ${MAX_SEARCHES_PER_REPLY} 次，没有再搜「${request.query}」。`
      searched += 1
      try {
        const results = await search(settings.apiKey, request, undefined, options.signal)
        await count(settings.apiKey, { ...(options.chatId ? { chatId: options.chatId } : {}), ...(options.modelId ? { modelId: options.modelId } : {}) })
        const text = searchResultsForModel(request.query, results, options.english)
        done.set(key, text)
        options.onSearch?.({ query: request.query, results: results.length })
        return text
      } catch (error) {
        if (options.signal?.aborted) throw error
        const reason = error instanceof Error ? error.message : String(error)
        deps.log.warn('web-search:failed', { reason })
        return `没有搜到：${reason}`
      }
    }
  }

  // A key, or remove: true to take it away. Another key's account is forgotten; the window reads it.
  const handleSave = async (message: RuntimeMessage) => {
    const apiKey = message.remove === true ? undefined : readSearchKey(message.apiKey)
    const { store } = await deps.mutateStore(store => {
      const changed = store.settings.webSearch?.apiKey !== apiKey
      if (apiKey) store.settings.webSearch = { provider: 'tavily', apiKey }
      else delete store.settings.webSearch
      if (changed && store.webSearchUsage) {
        delete store.webSearchUsage.account
        delete store.webSearchUsage.noticeDismissed
      }
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  // The key given (not saved yet) or the saved one, tried with one small search.
  const handleTest = async (message: RuntimeMessage) => {
    const given = typeof message.apiKey === 'string' && message.apiKey.trim() ? readSearchKey(message.apiKey) : undefined
    const apiKey = given ?? (await deps.loadStore()).settings.webSearch?.apiKey
    if (!apiKey) throw new Error('还没有填 Tavily 的 API Key')
    const results = await search(apiKey, { query: 'OpenTeam' }, 1)
    await count(apiKey, { test: true })
    return { ok: true, results: results.length }
  }

  // The account's credits read again, from the 联网搜索 and 用量 windows. Why it was not read is
  // answered, not thrown: the window shows it, and a thrown error would also pop up over the page.
  const handleAccountRefresh = async () => {
    try {
      return { ok: true, account: await refreshAccount() }
    } catch (error) {
      return { ok: true, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // The near-allowance notice put away where it is now (src/shared/webSearchUsage.ts).
  const handleNoticeDismiss = async () => {
    const { store } = await deps.mutateStore(store => {
      const usage = store.webSearchUsage ??= { days: {} }
      const state = searchQuotaState(usage)
      if (state) usage.noticeDismissed = { used: state.used, limit: state.limit, ...(state.reached ? { reached: true as const } : {}) }
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const routes: BackgroundMessageRoute[] = [
    { type: 'WEB_SEARCH_SAVE', handler: handleSave },
    { type: 'WEB_SEARCH_TEST', handler: handleTest },
    { type: 'WEB_SEARCH_ACCOUNT_REFRESH', handler: handleAccountRefresh },
    { type: 'WEB_SEARCH_NOTICE_DISMISS', handler: handleNoticeDismiss },
  ]
  return { forReply, routes }
}

export type WebSearcher = ReturnType<typeof createWebSearcher>
