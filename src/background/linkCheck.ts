// Opens a reply's source links (要来源, src/group/sources.ts) to see whether they hold up. Without
// access to a site, a request still tells whether the site responds at all (a made-up domain does
// not), but not the page's status or title; with access, granted site by site from the page's
// 细查链接, it does. Cookies are never sent.
import type { LinkCheck } from '../group/types'

export const LINK_CHECK_TIMEOUT_MS = 8_000
const TITLE_BYTES = 150_000
const CONCURRENCY = 4

export interface LinkCheckDependencies {
  fetch(url: string, init: RequestInit): Promise<Response>
  // Whether OpenTeam may reach this match pattern (https://host/*).
  hasAccess(pattern: string): Promise<boolean>
  now(): number
  timeoutMs?: number
}

export function linkAccessPattern(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname ? `https://${parsed.hostname}/*` : undefined
  } catch {
    return undefined
  }
}

export async function checkLink(url: string, deps: LinkCheckDependencies): Promise<LinkCheck> {
  const checkedAt = () => deps.now()
  const pattern = linkAccessPattern(url)
  if (!pattern) return { status: 'unchecked', checkedAt: checkedAt() }
  const fine = await deps.hasAccess(pattern).catch(() => false)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LINK_CHECK_TIMEOUT_MS)
  try {
    if (!fine) {
      await deps.fetch(url, { mode: 'no-cors', credentials: 'omit', redirect: 'follow', signal: controller.signal })
      return { status: 'reachable', checkedAt: checkedAt() }
    }
    const response = await deps.fetch(url, { credentials: 'omit', redirect: 'follow', signal: controller.signal })
    const httpStatus = response.status
    if (httpStatus >= 200 && httpStatus < 400) {
      const title = /html/i.test(response.headers.get('content-type') ?? '') ? await readTitle(response) : undefined
      return { status: 'ok', httpStatus, ...(title ? { title } : {}), checkedAt: checkedAt() }
    }
    void response.body?.cancel().catch(() => undefined)
    if (httpStatus === 404 || httpStatus === 410) return { status: 'missing', httpStatus, checkedAt: checkedAt() }
    if ([401, 403, 429, 451].includes(httpStatus)) return { status: 'refused', httpStatus, checkedAt: checkedAt() }
    return { status: 'error', httpStatus, checkedAt: checkedAt() }
  } catch {
    return { status: 'unreachable', checkedAt: checkedAt() }
  } finally {
    clearTimeout(timer)
  }
}

export async function checkLinks(urls: string[], deps: LinkCheckDependencies): Promise<Record<string, LinkCheck>> {
  const results: Record<string, LinkCheck> = {}
  const queue = [...new Set(urls)]
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) results[url] = await checkLink(url, deps)
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  return results
}

// The page's <title>, from its first bytes.
async function readTitle(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < TITLE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      if (match) return decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 120) || undefined
    }
    return undefined
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}
