// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import type { LibraryDoc } from '../group/groupLibrary'
import { currentLibraryDialog, openLibraryDialog } from './libraryDialog'

afterEach(() => {
  currentLibraryDialog()?.close()
  document.body.innerHTML = ''
})

const NOW = new Date(2026, 10, 20, 10).getTime()

function setup(docs: LibraryDoc[] = [], options: { readFile?: (file: File) => Promise<string>; pickPages?: () => Promise<Array<{ title: string; source: string; text: string }> | undefined> } = {}) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatsById.c = { id: 'c', name: '产品群', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['c']
  if (docs.length) store.libraryByChatId = { c: docs }
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const request = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => ({ ok: true, title: '需求文档.md', text: '# 需求\n预算提醒' }) as Record<string, unknown>)
  const requestHostAccess = vi.fn(async (_url: string) => true)
  const previewText = vi.fn()
  const readFile = vi.fn(options.readFile ?? (async (file: File) => `text of ${file.name}`))
  openLibraryDialog('c', { getStore: () => store, runCommand, request, readFile, previewText, pickPages: options.pickPages, requestHostAccess, confirm: () => true, now: () => NOW })
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  return { store, runCommand, request, requestHostAccess, previewText, readFile, q }
}

const doc = (fields: Partial<LibraryDoc>): LibraryDoc => ({ id: 'd1', title: '需求文档.md', kind: 'file', source: '需求文档.md', chars: 23_456, addedAt: NOW - 86_400_000, ...fields })

describe('a group\'s library window', () => {
  it('lists the documents with their kind and size, and says how much there is', () => {
    setup([doc({}), doc({ id: 'd2', title: '周会纪要', kind: 'note', source: undefined, chars: 820 }), doc({ id: 'd3', title: 'IEA 报告', kind: 'page', source: 'https://www.iea.org/r', chars: 5000 })])
    expect(document.querySelector('#library-title')?.textContent).toBe('「产品群」的资料库')
    const rows = [...document.querySelectorAll('.library-doc')]
    expect(rows.map(row => row.querySelector('.library-doc-title')?.textContent)).toEqual(['需求文档.md', '周会纪要', 'IEA 报告'])
    expect(rows.map(row => row.querySelector('.library-doc-meta')?.textContent?.split(' · ').slice(0, 2))).toEqual([['文件', '2.3 万字'], ['文字', '820 字'], ['网页', '5000 字']])
    expect(document.querySelector('.library-summary')?.textContent).toBe('3 份资料，约 2.9 万字')
  })

  it('says when there is nothing yet', () => {
    setup()
    expect(document.querySelector('.library-summary')?.textContent).toBe('还没有资料。上传文件、粘贴文字或附上打开的网页，成员回答时会带上相关片段。')
    expect(document.querySelectorAll('.library-doc')).toHaveLength(0)
  })

  it('opens a document\'s text and deletes one', async () => {
    const { request, previewText, runCommand } = setup([doc({})])
    document.querySelector<HTMLButtonElement>('[data-library-action="view"]')!.click()
    await vi.waitFor(() => expect(previewText).toHaveBeenCalledWith('需求文档.md', '# 需求\n预算提醒'))
    expect(request).toHaveBeenCalledWith('LIBRARY_TEXT_GET', { chatId: 'c', docId: 'd1' })
    document.querySelector<HTMLButtonElement>('[data-library-action="delete"]')!.click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('LIBRARY_REMOVE', { chatId: 'c', docId: 'd1' }))
  })

  it('adds uploaded files one by one, saying which could not be read', async () => {
    const { runCommand, q } = setup([], { readFile: async file => { if (file.name === 'scan.pdf') throw new Error('没有读到文字：scan.pdf（可能是扫描件或图片）'); return `text of ${file.name}` } })
    const input = q<HTMLInputElement>('#library-file-input')
    Object.defineProperty(input, 'files', { value: [new File(['a'], '需求文档.md'), new File(['b'], 'scan.pdf')] })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('已加入 1 份：需求文档.md。没加入：没有读到文字：scan.pdf（可能是扫描件或图片）'))
    expect(runCommand).toHaveBeenCalledWith('LIBRARY_ADD', { chatId: 'c', doc: { title: '需求文档.md', kind: 'file', source: '需求文档.md', text: 'text of 需求文档.md' } })
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('saves pasted text with a title', async () => {
    const { runCommand, q } = setup()
    q<HTMLButtonElement>('[data-library-add="note"]').click()
    expect(q<HTMLElement>('.library-note-form').hidden).toBe(false)
    q<HTMLInputElement>('#library-note-title').value = ' 周会纪要 '
    q<HTMLTextAreaElement>('#library-note-text').value = '预算提醒文案要温和。'
    q<HTMLFormElement>('.library-note-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('LIBRARY_ADD', { chatId: 'c', doc: { title: '周会纪要', kind: 'note', text: '预算提醒文案要温和。' } }))
    await vi.waitFor(() => expect(q<HTMLElement>('.library-note-form').hidden).toBe(true))
  })

  it('adds each web page picked from the open tabs as a document of its own, so it can be read again', async () => {
    const { runCommand, q } = setup([], { pickPages: async () => [{ title: 'IEA 报告', source: 'https://www.iea.org/r', text: '需求增长' }, { title: '价格', source: 'https://example.com/p', text: '每月 10 元' }] })
    q<HTMLButtonElement>('[data-library-add="pages"]').click()
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('已加入 2 个网页：IEA 报告、价格。'))
    expect(runCommand).toHaveBeenCalledWith('LIBRARY_ADD', { chatId: 'c', doc: { title: 'IEA 报告', kind: 'page', source: 'https://www.iea.org/r', text: '需求增长' } })
    expect(runCommand).toHaveBeenCalledWith('LIBRARY_ADD', { chatId: 'c', doc: { title: '价格', kind: 'page', source: 'https://example.com/p', text: '每月 10 元' } })
  })

  it('keeps its list as it is when nothing in it changed, and redraws when a document is added', () => {
    const { store } = setup([doc({})])
    const row = document.querySelector('.library-doc')
    currentLibraryDialog()?.refresh()
    expect(document.querySelector('.library-doc')).toBe(row)
    store.libraryByChatId = { c: [doc({}), doc({ id: 'd2', title: '新资料' })] }
    currentLibraryDialog()?.refresh()
    expect(document.querySelectorAll('.library-doc')).toHaveLength(2)
  })
})

describe('a library\'s web pages, kept up to date', () => {
  const page = (fields: Partial<LibraryDoc> = {}) => doc({ id: 'p1', title: '价格页', kind: 'page', source: 'https://example.com/pricing', chars: 900, refresh: 'weekly', ...fields })

  it('shows how often each page is read again and how the last reading went', () => {
    const { q } = setup([page({ updatedAt: NOW - 3_600_000, checkedAt: NOW - 3_600_000 }), page({ id: 'p2', refresh: undefined }), page({ id: 'p3', refresh: 'daily', checkedAt: NOW, refreshError: 'HTTP 404' }), doc({})])
    const rows = [...document.querySelectorAll('.library-doc')]
    const meta = (index: number) => rows[index].querySelector('.library-doc-meta')?.textContent
    expect(meta(0)).toMatch(/ · \d+\/\d+ 已更新$/)
    expect(meta(1)).not.toContain('更新')
    expect(rows[2].querySelector('.library-doc-error')?.textContent).toBe('最近一次更新失败：HTTP 404，资料还是上次的内容')
    expect(rows.map(row => row.querySelector<HTMLSelectElement>('.library-doc-refresh')?.value ?? null)).toEqual(['weekly', 'never', 'daily', null])
    expect(rows[3].querySelector('[data-library-action="refresh"]')).toBeNull()
    void q
  })

  it('changes how often a page is read again', async () => {
    const { runCommand } = setup([page()])
    const select = document.querySelector<HTMLSelectElement>('.library-doc-refresh')!
    expect([...select.options].map(option => option.textContent)).toEqual(['不更新', '每天更新', '每周更新'])
    select.value = 'daily'
    select.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('LIBRARY_REFRESH_SET', { chatId: 'c', docId: 'p1', refresh: 'daily' }))
  })

  it('reads a page again now, asking for its site from the click, and says how it went', async () => {
    const { request, requestHostAccess, q } = setup([page()])
    request.mockResolvedValueOnce({ ok: true, outcome: 'updated' })
    q<HTMLButtonElement>('[data-library-action="refresh"]').click()
    expect(requestHostAccess).toHaveBeenCalledWith('https://example.com/pricing')
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('「价格页」已更新。'))
    expect(request).toHaveBeenCalledWith('LIBRARY_REFRESH', { chatId: 'c', docId: 'p1' })

    request.mockResolvedValueOnce({ ok: true, outcome: 'same' })
    q<HTMLButtonElement>('[data-library-action="refresh"]').click()
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('「价格页」没有变化。'))

    request.mockResolvedValueOnce({ ok: true, outcome: 'failed' })
    q<HTMLButtonElement>('[data-library-action="refresh"]').click()
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('「价格页」这次没有读到，资料还是上次的内容。'))

    requestHostAccess.mockResolvedValueOnce(false)
    request.mockClear()
    q<HTMLButtonElement>('[data-library-action="refresh"]').click()
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('需要你允许 OpenTeam 访问 example.com，才能读这个网页。'))
    expect(request).not.toHaveBeenCalled()
  })

  it('adds a page by its address', async () => {
    const { runCommand, requestHostAccess, q } = setup()
    q<HTMLButtonElement>('[data-library-add="url"]').click()
    expect(q<HTMLElement>('.library-url-form').hidden).toBe(false)
    const input = q<HTMLInputElement>('#library-url-input')
    input.value = 'not a url'
    q<HTMLFormElement>('.library-url-form').requestSubmit()
    expect(q('.library-status').textContent).toBe('这不是一个网址')
    expect(runCommand).not.toHaveBeenCalled()

    input.value = 'https://example.com/docs'
    q<HTMLFormElement>('.library-url-form').requestSubmit()
    expect(requestHostAccess).toHaveBeenCalledWith('https://example.com/docs')
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('LIBRARY_ADD_URL', { chatId: 'c', url: 'https://example.com/docs' }))
    await vi.waitFor(() => expect(q('.library-status').textContent).toBe('已加入网页，每周会自动更新一次。'))
    expect(q<HTMLElement>('.library-url-form').hidden).toBe(true)
    expect(input.value).toBe('')
  })
})

