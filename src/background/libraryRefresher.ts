// A group library's web pages read again (src/group/groupLibrary.ts): an alarm wakes the background
// every hour, and the pages due are fetched as an API member reads a page (webPageReader.ts):
// without the user's cookies, never from this computer or the local network, and only from sites
// the user allowed (when the page was added, or with 立即更新). A site that refuses that (bot
// protection answers 401, 403, 429 or 503) or a page whose text a script writes is read in a
// background tab instead (tabPageReader.ts). A page that cannot be read keeps its text, and says why. Also the library's commands to read a page again now, to set how often, and to
// add a page by its address.
import { addLibraryDoc, applyLibraryRefresh, isRefreshablePage, libraryDocsDue, setLibraryDocRefresh, type LibraryRefresh } from '../group/groupLibrary'
import type { OpenTeamStore } from '../group/types'
import { hostAccessPattern } from '../shared/hostAccess'
import { checkReadableUrl, htmlToText } from '../shared/webPageText'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import type { StoreMutationResult } from './storeAccess'

export const LIBRARY_REFRESH_ALARM = 'openteam-library-refresh'
export const LIBRARY_REFRESH_ROUTE_TYPES = ['LIBRARY_ADD_URL', 'LIBRARY_REFRESH', 'LIBRARY_REFRESH_SET'] as const
const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY_CHARS = 2_000_000
// Pages read in one wake; the rest wait for the next.
const MAX_PER_RUN = 10

export interface LibraryRefresherDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>
  hasAccess(pattern: string): Promise<boolean>
  loadStore(): Promise<OpenTeamStore>
  mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  alarms: { create(name: string, info: { periodInMinutes: number }): void | Promise<void> }
  newId(prefix: string): string
  now(): number
  log: { warn(event: string, details?: Record<string, unknown>): void }
  // Reads a page in a tab opened in the background, for a site that refuses the fetch.
  readInTab?(url: string): Promise<{ title: string; url: string; text: string }>
}

// The fetch was refused, or brought no text: a tab may read it. `refusal` says which.
class RefusedFetch extends Error {
  constructor(message: string, readonly refusal: string) {
    super(message)
  }
}

const REFUSED_STATUSES = new Set([401, 403, 429, 503])

export function createLibraryRefresher(deps: LibraryRefresherDependencies) {
  let running: Promise<{ updated: number; same: number; failed: number }> | undefined

  // The page's title and text; throws why it could not be read.
  async function readPage(raw: string): Promise<{ url: string; title: string; text: string }> {
    const target = checkReadableUrl(raw)
    if (!await deps.hasAccess(hostAccessPattern(target.url)!)) throw new Error(`没有访问 ${target.host} 的权限：在资料库里点「立即更新」重新允许`)
    try {
      return await fetchPage(target)
    } catch (error) {
      if (!deps.readInTab || !(error instanceof RefusedFetch)) throw error
      try {
        const page = await deps.readInTab(target.url)
        return { url: target.url, title: page.title || target.host, text: page.text }
      } catch (tabError) {
        throw new Error(`${error.refusal}，在标签页里也没读到：${tabError instanceof Error ? tabError.message : String(tabError)}`)
      }
    }
  }

  async function fetchPage(target: { url: string; host: string }): Promise<{ url: string; title: string; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await deps.fetch(target.url, { credentials: 'omit', redirect: 'follow', signal: controller.signal })
      if (REFUSED_STATUSES.has(response.status)) throw new RefusedFetch(`HTTP ${response.status}`, `网站拒绝了后台读取（HTTP ${response.status}）`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const isHtml = type === '' || type === 'text/html' || type === 'application/xhtml+xml'
      if (!isHtml && !type.startsWith('text/')) throw new Error(`这是 ${type} 文件，只能读网页`)
      const body = (await response.text()).slice(0, MAX_BODY_CHARS)
      const page = isHtml ? htmlToText(body) : { title: '', text: body.trim() }
      if (!page.text) throw new RefusedFetch('网页里没有读到文字（可能要登录，或是靠脚本显示的）', '后台读到的网页没有文字')
      return { url: target.url, title: page.title || target.host, text: page.text }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('20 秒内没有打开')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function refreshOne(chatId: string, docId: string, url: string): Promise<ReturnType<typeof applyLibraryRefresh>> {
    let outcome: { title: string; text: string } | { error: string }
    try {
      outcome = await readPage(url)
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) }
      deps.log.warn('library-refresh:failed', { chatId, docId, error: outcome.error })
    }
    const { result } = await deps.mutateStore(store => applyLibraryRefresh(store, chatId, docId, outcome, deps.now()))
    return result
  }

  // Every page due, one after another; the page is sent the store once at the end.
  function refreshDue(): Promise<{ updated: number; same: number; failed: number }> {
    running ??= (async () => {
      const counts = { updated: 0, same: 0, failed: 0 }
      const due = libraryDocsDue(await deps.loadStore(), deps.now()).slice(0, MAX_PER_RUN)
      for (const item of due) {
        const result = await refreshOne(item.chatId, item.docId, item.url)
        if (result !== 'gone') counts[result] += 1
      }
      if (due.length > 0) await deps.broadcastStoreUpdated(await deps.loadStore())
      return counts
    })().finally(() => { running = undefined })
    return running
  }

  function start(): void {
    void deps.alarms.create(LIBRARY_REFRESH_ALARM, { periodInMinutes: 60 })
  }

  const handleRefresh = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const docId = requireText(message.docId, '缺少资料 ID')
    const doc = (await deps.loadStore()).libraryByChatId?.[chatId]?.find(item => item.id === docId)
    if (!doc) throw new Error('找不到这份资料')
    if (!isRefreshablePage(doc)) throw new Error('只有网页可以更新')
    const outcome = await refreshOne(chatId, docId, doc.source!)
    const store = await deps.loadStore()
    await deps.broadcastStoreUpdated(store)
    return { ok: true, outcome, store }
  }

  const handleRefreshSet = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const docId = requireText(message.docId, '缺少资料 ID')
    const refresh = message.refresh === 'daily' || message.refresh === 'weekly' ? message.refresh as LibraryRefresh : undefined
    const { store } = await deps.mutateStore(store => setLibraryDocRefresh(store, chatId, docId, refresh))
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  // The page asked the browser for the site from the click; this reads it and keeps it.
  const handleAddUrl = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const raw = typeof message.url === 'string' ? message.url : ''
    let page: Awaited<ReturnType<typeof readPage>>
    try {
      page = await readPage(raw)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(/^HTTP |只能读|没有读到文字|秒内/.test(reason) ? `没有读到：${reason}` : reason)
    }
    const { store, result } = await deps.mutateStore(store => {
      if (!store.chatsById[chatId]) throw new Error(`找不到群聊：${chatId}`)
      return addLibraryDoc(store, chatId, { title: page.title, kind: 'page', source: page.url, text: page.text }, deps.now(), deps.newId)
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, docId: result.id, store }
  }

  const routes: BackgroundMessageRoute[] = [
    { type: 'LIBRARY_ADD_URL', handler: handleAddUrl },
    { type: 'LIBRARY_REFRESH', handler: handleRefresh },
    { type: 'LIBRARY_REFRESH_SET', handler: handleRefreshSet },
  ]
  return { start, refreshDue, routes }
}

function requireText(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value) throw new Error(error)
  return value
}
