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

function setup(docs: LibraryDoc[] = [], options: { readFile?: (file: File) => Promise<string>; pickPages?: () => Promise<{ title: string; source: string; text: string } | undefined> } = {}) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatsById.c = { id: 'c', name: '产品群', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatOrder = ['c']
  if (docs.length) store.libraryByChatId = { c: docs }
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const request = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => ({ ok: true, title: '需求文档.md', text: '# 需求\n预算提醒' }))
  const previewText = vi.fn()
  const readFile = vi.fn(options.readFile ?? (async (file: File) => `text of ${file.name}`))
  openLibraryDialog('c', { getStore: () => store, runCommand, request, readFile, previewText, pickPages: options.pickPages, confirm: () => true, now: () => NOW })
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  return { store, runCommand, request, previewText, readFile, q }
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

  it('adds the web pages picked from the open tabs', async () => {
    const { runCommand, q } = setup([], { pickPages: async () => ({ title: '网页：IEA 报告', source: 'https://www.iea.org/r', text: '# IEA\n需求增长' }) })
    q<HTMLButtonElement>('[data-library-add="pages"]').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('LIBRARY_ADD', { chatId: 'c', doc: { title: '网页：IEA 报告', kind: 'page', source: 'https://www.iea.org/r', text: '# IEA\n需求增长' } }))
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
