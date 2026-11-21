import { describe, expect, it, vi } from 'vitest'
import { addLibraryDoc, LIBRARY_REFRESH_MS } from '../group/groupLibrary'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createLibraryRefresher, LIBRARY_REFRESH_ALARM, LIBRARY_REFRESH_ROUTE_TYPES } from './libraryRefresher'

const NOW = new Date(2026, 10, 21, 9).getTime()
const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><nav>菜单</nav><main><p>${body}</p></main></body></html>`

function setup(options: { pages?: Record<string, Response | (() => Response)>; access?: boolean } = {}) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatsById.c = { id: 'c', name: '产品群', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['c']
  let clock = NOW
  let seq = 0
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    const page = options.pages?.[url]
    if (!page) return new Response('missing', { status: 404 })
    return typeof page === 'function' ? page() : page.clone()
  })
  const hasAccess = vi.fn(async (_pattern: string) => options.access ?? true)
  const broadcastStoreUpdated = vi.fn()
  const alarms = { create: vi.fn() }
  const refresher = createLibraryRefresher({
    fetch,
    hasAccess,
    loadStore: async () => store,
    mutateStore: async mutator => ({ store, result: await mutator(store) }),
    broadcastStoreUpdated,
    alarms,
    newId: prefix => `${prefix}-${++seq}`,
    now: () => clock,
    log: { warn: vi.fn() },
  })
  const run = (type: string, fields: Record<string, unknown> = {}) => Promise.resolve(refresher.routes.find(route => route.type === type)!.handler({ type, ...fields }, {}))
  const addPage = (url: string, text = '旧内容', refresh?: 'daily' | 'weekly' | 'never') => addLibraryDoc(store, 'c', { title: '页面', kind: 'page', source: url, text, ...(refresh ? { refresh } : {}) }, NOW, prefix => `${prefix}-${++seq}`)
  return { store, fetch, hasAccess, broadcastStoreUpdated, alarms, refresher, run, addPage, setClock: (value: number) => { clock = value } }
}

const doc = (store: OpenTeamStore, id: string) => store.libraryByChatId!.c.find(item => item.id === id)!

describe('reading a library\'s web pages again', () => {
  it('reads the pages due, without the user\'s cookies, and keeps what changed', async () => {
    const ctx = setup({ pages: {
      'https://example.com/pricing': new Response(html('价格', '基础版每月 12 元。'), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'https://example.com/same': new Response(html('不变', '旧内容'), { headers: { 'content-type': 'text/html' } }),
    } })
    const changed = ctx.addPage('https://example.com/pricing')
    const same = ctx.addPage('https://example.com/same')
    const notDue = ctx.addPage('https://example.com/later', '旧内容', 'never')
    ctx.setClock(NOW + LIBRARY_REFRESH_MS.weekly)
    expect(await ctx.refresher.refreshDue()).toEqual({ updated: 1, same: 1, failed: 0 })
    expect(doc(ctx.store, changed.id)).toMatchObject({ text: '基础版每月 12 元。', updatedAt: NOW + LIBRARY_REFRESH_MS.weekly })
    expect(doc(ctx.store, same.id)).toMatchObject({ text: '旧内容', checkedAt: NOW + LIBRARY_REFRESH_MS.weekly })
    expect(doc(ctx.store, notDue.id).checkedAt).toBeUndefined()
    expect(ctx.fetch).toHaveBeenCalledTimes(2)
    expect(ctx.fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit' })
    expect(ctx.broadcastStoreUpdated).toHaveBeenCalledTimes(1)
    // Nothing due: nothing read, nothing sent to the page.
    expect(await ctx.refresher.refreshDue()).toEqual({ updated: 0, same: 0, failed: 0 })
    expect(ctx.broadcastStoreUpdated).toHaveBeenCalledTimes(1)
  })

  it('keeps the old text and says why when a page cannot be read', async () => {
    const ctx = setup({ pages: {
      'https://example.com/pdf': new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
      'https://example.com/empty': new Response('<html><body><script>app()</script></body></html>', { headers: { 'content-type': 'text/html' } }),
    } })
    const gone = ctx.addPage('https://example.com/gone')
    const pdf = ctx.addPage('https://example.com/pdf')
    const empty = ctx.addPage('https://example.com/empty')
    ctx.setClock(NOW + LIBRARY_REFRESH_MS.weekly)
    expect(await ctx.refresher.refreshDue()).toEqual({ updated: 0, same: 0, failed: 3 })
    expect(doc(ctx.store, gone.id)).toMatchObject({ text: '旧内容', refreshError: 'HTTP 404' })
    expect(doc(ctx.store, pdf.id).refreshError).toBe('这是 application/pdf 文件，只能读网页')
    expect(doc(ctx.store, empty.id).refreshError).toBe('网页里没有读到文字（可能要登录，或是靠脚本显示的）')
  })

  it('says when OpenTeam may not reach the site', async () => {
    const ctx = setup({ access: false })
    const page = ctx.addPage('https://example.com/a')
    ctx.setClock(NOW + LIBRARY_REFRESH_MS.weekly)
    await ctx.refresher.refreshDue()
    expect(doc(ctx.store, page.id).refreshError).toBe('没有访问 example.com 的权限：在资料库里点「立即更新」重新允许')
    expect(ctx.fetch).not.toHaveBeenCalled()
  })

  it('wakes every hour to look for pages due', async () => {
    const ctx = setup()
    ctx.refresher.start()
    expect(LIBRARY_REFRESH_ROUTE_TYPES).toEqual(['LIBRARY_ADD_URL', 'LIBRARY_REFRESH', 'LIBRARY_REFRESH_SET'])
    expect(ctx.alarms.create).toHaveBeenCalledWith(LIBRARY_REFRESH_ALARM, { periodInMinutes: 60 })
  })
})

describe('the library\'s commands for web pages', () => {
  it('reads a page again now, and says how it went', async () => {
    const ctx = setup({ pages: { 'https://example.com/a': new Response(html('A', '新内容'), { headers: { 'content-type': 'text/html' } }) } })
    const page = ctx.addPage('https://example.com/a')
    expect(await ctx.run('LIBRARY_REFRESH', { chatId: 'c', docId: page.id })).toMatchObject({ ok: true, outcome: 'updated' })
    expect(await ctx.run('LIBRARY_REFRESH', { chatId: 'c', docId: page.id })).toMatchObject({ ok: true, outcome: 'same' })
    const file = addLibraryDoc(ctx.store, 'c', { title: 'f', kind: 'file', text: 'x' }, NOW, () => 'file-1')
    await expect(ctx.run('LIBRARY_REFRESH', { chatId: 'c', docId: file.id })).rejects.toThrow('只有网页可以更新')
  })

  it('sets how often a page is read again', async () => {
    const ctx = setup()
    const page = ctx.addPage('https://example.com/a')
    await ctx.run('LIBRARY_REFRESH_SET', { chatId: 'c', docId: page.id, refresh: 'daily' })
    expect(doc(ctx.store, page.id).refresh).toBe('daily')
    await ctx.run('LIBRARY_REFRESH_SET', { chatId: 'c', docId: page.id, refresh: 'never' })
    expect(doc(ctx.store, page.id).refresh).toBeUndefined()
  })

  it('adds a page by its address, refreshed weekly, and refuses what it cannot read', async () => {
    const ctx = setup({ pages: { 'https://example.com/docs': new Response(html('使用文档', '第一步：安装。'), { headers: { 'content-type': 'text/html' } }) } })
    const added = await ctx.run('LIBRARY_ADD_URL', { chatId: 'c', url: ' https://example.com/docs#intro ' }) as { docId: string }
    expect(doc(ctx.store, added.docId)).toMatchObject({ title: '使用文档', kind: 'page', source: 'https://example.com/docs', text: '第一步：安装。', refresh: 'weekly' })
    await expect(ctx.run('LIBRARY_ADD_URL', { chatId: 'c', url: 'http://192.168.1.2/' })).rejects.toThrow('不能读本机或局域网里的地址')
    await expect(ctx.run('LIBRARY_ADD_URL', { chatId: 'c', url: 'https://example.com/missing' })).rejects.toThrow('没有读到：HTTP 404')
  })
})
