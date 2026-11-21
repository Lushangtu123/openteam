// 联网搜索 (src/shared/webSearch.ts): an API member searches the web through Tavily while it answers
// (the search_web tool, externalModelClient.ts). The user's key goes only to api.tavily.com, which the
// user allowed when saving the key. At most MAX_SEARCHES_PER_REPLY searches a reply; the same search
// in one reply is answered from the first. What the member gets back is always text, a failure
// included, so it can go on answering. Also the settings' commands to save, remove and test the key.
import type { OpenTeamStore } from '../group/types'
import { MAX_SEARCHES_PER_REPLY, readSearchKey, readSearchRequest, readTavilyResults, searchErrorMessage, searchResultsForModel, TAVILY_SEARCH_URL, tavilyRequestBody, type WebSearchOptions, type WebSearchResult, type WebSearchSettings } from '../shared/webSearch'
import { currentMonth, monthSearches, recordWebSearch } from '../shared/webSearchUsage'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import type { StoreMutationResult } from './storeAccess'

export const WEB_SEARCH_ROUTE_TYPES = ['WEB_SEARCH_SAVE', 'WEB_SEARCH_TEST', 'WEB_SEARCH_LIMIT_SET', 'WEB_SEARCH_NOTICE_DISMISS'] as const
export const TAVILY_SITE = 'https://api.tavily.com/*'
const SEARCH_TIMEOUT_MS = 20_000

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

  // A search that came back is counted (src/shared/webSearchUsage.ts).
  async function count(from: { modelId?: string; chatId?: string; test?: boolean }): Promise<void> {
    await deps.mutateStore(store => recordWebSearch(store.webSearchUsage ??= { days: {} }, from, now()))
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
        const used = monthSearches((await deps.loadStore()).webSearchUsage, now())
        throw new Error(`${searchErrorMessage(response.status, text)}（本月 OpenTeam 已搜索 ${used} 次）`)
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
        await count({ ...(options.chatId ? { chatId: options.chatId } : {}), ...(options.modelId ? { modelId: options.modelId } : {}) })
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

  // A key, or remove: true to take it away.
  const handleSave = async (message: RuntimeMessage) => {
    const apiKey = message.remove === true ? undefined : readSearchKey(message.apiKey)
    const { store } = await deps.mutateStore(store => {
      const monthlyLimit = store.settings.webSearch?.monthlyLimit
      if (apiKey) store.settings.webSearch = { provider: 'tavily', apiKey, ...(monthlyLimit ? { monthlyLimit } : {}) }
      else delete store.settings.webSearch
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
    await count({ test: true })
    return { ok: true, results: results.length }
  }

  // The searches the user's plan allows a month; null takes it away.
  const handleLimitSet = async (message: RuntimeMessage) => {
    const value = message.monthlyLimit
    if (value !== null && value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value >= 1)) throw new Error('每月额度要写一个正整数')
    const { store } = await deps.mutateStore(store => {
      const current = store.settings.webSearch
      if (!current) throw new Error('还没有填 Tavily 的 API Key')
      if (typeof value === 'number') current.monthlyLimit = value
      else delete current.monthlyLimit
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  // The near-allowance notice put away until next month.
  const handleNoticeDismiss = async () => {
    const { store } = await deps.mutateStore(store => {
      (store.webSearchUsage ??= { days: {} }).noticeMonth = currentMonth(now())
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const routes: BackgroundMessageRoute[] = [
    { type: 'WEB_SEARCH_SAVE', handler: handleSave },
    { type: 'WEB_SEARCH_TEST', handler: handleTest },
    { type: 'WEB_SEARCH_LIMIT_SET', handler: handleLimitSet },
    { type: 'WEB_SEARCH_NOTICE_DISMISS', handler: handleNoticeDismiss },
  ]
  return { forReply, routes }
}

export type WebSearcher = ReturnType<typeof createWebSearcher>
