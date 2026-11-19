import { describe, expect, it, vi } from 'vitest'
import { checkLink, checkLinks, linkAccessPattern } from './linkCheck'

function deps(options: { access?: boolean; respond?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const fetch = vi.fn(options.respond ?? (async () => new Response('<html><head><title>Global EV Outlook &amp; more</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } })))
  return { fetch, hasAccess: vi.fn(async () => options.access ?? false), now: () => 42, timeoutMs: 50 }
}

describe('checking a source link', () => {
  it('without access to the site, says only whether it responds, sending no cookies', async () => {
    const d = deps()
    expect(await checkLink('https://www.iea.org/report', d)).toEqual({ status: 'reachable', checkedAt: 42 })
    expect(d.hasAccess).toHaveBeenCalledWith('https://www.iea.org/*')
    expect(d.fetch).toHaveBeenCalledWith('https://www.iea.org/report', expect.objectContaining({ mode: 'no-cors', credentials: 'omit' }))
    // Not proof the site is missing: a bot check's answer is blocked the same way (seen live with iea.org).
    expect(await checkLink('https://www.iea.org/x', deps({ respond: async () => { throw new TypeError('Failed to fetch') } }))).toEqual({ status: 'no-response', checkedAt: 42 })
    expect(await checkLink('https://made-up.example/x', deps({ access: true, respond: async () => { throw new TypeError('Failed to fetch') } }))).toEqual({ status: 'unreachable', checkedAt: 42 })
  })

  it('with access, reads the status and the page title', async () => {
    expect(await checkLink('https://www.iea.org/report', deps({ access: true }))).toEqual({ status: 'ok', httpStatus: 200, title: 'Global EV Outlook & more', checkedAt: 42 })
    const status = (code: number) => deps({ access: true, respond: async () => new Response('', { status: code }) })
    expect(await checkLink('https://a.example/x', status(404))).toEqual({ status: 'missing', httpStatus: 404, checkedAt: 42 })
    expect(await checkLink('https://a.example/x', status(403))).toEqual({ status: 'refused', httpStatus: 403, checkedAt: 42 })
    expect(await checkLink('https://a.example/x', status(503))).toEqual({ status: 'error', httpStatus: 503, checkedAt: 42 })
  })

  it('gives up on a site that does not answer in time', async () => {
    const hanging = deps({ respond: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) })
    expect(await checkLink('https://slow.example/x', hanging)).toEqual({ status: 'slow', checkedAt: 42 })
    // Also with access: a slow site is not a missing one (seen live: autohome.com.cn took 9 s).
    const hangingWithAccess = deps({ access: true, respond: (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) })
    expect(await checkLink('https://slow.example/x', hangingWithAccess)).toEqual({ status: 'slow', checkedAt: 42 })
  })

  it('does not check links that are not https', async () => {
    const d = deps()
    expect(await checkLink('http://old.example/x', d)).toEqual({ status: 'unchecked', checkedAt: 42 })
    expect(await checkLink('not a link', d)).toEqual({ status: 'unchecked', checkedAt: 42 })
    expect(d.fetch).not.toHaveBeenCalled()
    expect(linkAccessPattern('https://sub.example.org/a?b')).toBe('https://sub.example.org/*')
  })

  it('checks several links once each', async () => {
    const d = deps()
    const results = await checkLinks(['https://a.example/1', 'https://b.example/2', 'https://a.example/1'], d)
    expect(Object.keys(results)).toEqual(expect.arrayContaining(['https://a.example/1', 'https://b.example/2']))
    expect(d.fetch).toHaveBeenCalledTimes(2)
  })
})
