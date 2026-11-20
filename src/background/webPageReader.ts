// 读网页: an API member reads a page while it answers (the read_web_page tool, externalModelClient.ts).
// A site the user allowed before is read at once; for a new one the member's reply waits on a card in
// the chat, and the browser asks for the site when the user clicks 允许 (approvalCard.ts), so
// OpenTeam never holds every site. Pages are fetched without the user's cookies, so a member never
// reads what the user is signed in to, and never from this computer or the local network. At most
// MAX_PAGES_PER_REPLY pages a reply. What the member gets back is always text, a refusal included, so
// it can go on answering.
import type { PendingApproval } from '../group/types'
import { hostAccessPattern } from '../shared/hostAccess'
import { checkReadableUrl, htmlToText, pageTextForModel } from '../shared/webPageText'

export const MAX_PAGES_PER_REPLY = 3
const FETCH_TIMEOUT_MS = 15_000
const ASK_TIMEOUT_MS = 2 * 60_000
const MAX_BODY_CHARS = 2_000_000

export interface WebPageReaderDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>
  hasAccess(pattern: string): Promise<boolean>
  // Shows the question on the member and waits for the answer (localAgentApprovals.ts); undefined
  // when it is taken down.
  ask(context: { chatId: string; roleId: string }, question: Omit<PendingApproval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<string | undefined>
  askTimeoutMs?: number
  log: { warn(event: string, details?: Record<string, unknown>): void }
}

export interface ReadPage {
  url: string
  title: string
}

export function createWebPageReader(deps: WebPageReaderDependencies) {
  // A reader for one reply: it counts the pages and remembers the sites the user declined.
  function forReply(context: { chatId: string; roleId: string; roleName: string }, options: { english: boolean; signal?: AbortSignal; onRead?(page: ReadPage): void }) {
    let fetched = 0
    const declined = new Set<string>()

    return async function readWebPage(raw: string): Promise<string> {
      let target: { url: string; host: string }
      try {
        target = checkReadableUrl(raw)
      } catch (error) {
        return `没有读：${error instanceof Error ? error.message : String(error)}`
      }
      if (fetched >= MAX_PAGES_PER_REPLY) return `这次回答最多读 ${MAX_PAGES_PER_REPLY} 个网页，没有再读 ${target.url}。`
      const site = hostAccessPattern(target.url)!
      const refusal = (late: boolean) => `用户没有允许读 ${target.host} 的网页${late ? '（一直没有回应）' : ''}。请不用这个网页继续回答。`
      if (declined.has(target.host)) return refusal(false)
      if (!await deps.hasAccess(site)) {
        const asked = await askFor(target, site)
        if (asked !== 'allow' || !await deps.hasAccess(site)) {
          declined.add(target.host)
          return refusal(asked === 'timeout')
        }
      }
      fetched += 1
      return read(target)
    }

    async function askFor(target: { url: string; host: string }, site: string): Promise<string | undefined> {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, deps.askTimeoutMs ?? ASK_TIMEOUT_MS)
      const stop = () => controller.abort()
      options.signal?.addEventListener('abort', stop, { once: true })
      try {
        const answer = await deps.ask({ chatId: context.chatId, roleId: context.roleId }, {
          kind: 'web-page',
          title: `「${context.roleName}」想读 ${target.host} 的网页`,
          detail: target.url,
          site,
          options: [{ id: 'allow', label: '允许', kind: 'allow_always' }, { id: 'deny', label: '不读', kind: 'reject_once' }],
        }, controller.signal)
        return timedOut ? 'timeout' : answer
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', stop)
      }
    }

    async function read(target: { url: string; host: string }): Promise<string> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const stop = () => controller.abort()
      options.signal?.addEventListener('abort', stop, { once: true })
      try {
        const response = await deps.fetch(target.url, { credentials: 'omit', redirect: 'follow', signal: controller.signal })
        if (!response.ok) return `没有读到：HTTP ${response.status}`
        const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        const html = type === '' || type === 'text/html' || type === 'application/xhtml+xml'
        if (!html && !type.startsWith('text/') && type !== 'application/json') return `没有读：这是 ${type} 文件，只能读网页`
        const body = (await response.text()).slice(0, MAX_BODY_CHARS)
        const url = response.url || target.url
        const page = html ? { url, ...htmlToText(body) } : { url, title: '', text: body.trim() }
        if (!page.text) return '网页里没有读到文字（可能要登录，或是靠脚本显示的）'
        options.onRead?.({ url, title: page.title || target.host })
        return pageTextForModel(page, options.english)
      } catch (error) {
        if (options.signal?.aborted) throw error
        deps.log.warn('web-page:read-failed', { host: target.host, error: error instanceof Error ? error.message : String(error) })
        return `没有读到：${controller.signal.aborted ? '15 秒内没有打开' : error instanceof Error ? error.message : String(error)}`
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', stop)
      }
    }
  }

  return { forReply }
}

export type WebPageReader = ReturnType<typeof createWebPageReader>
