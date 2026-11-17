// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupRole, MemoryItem, OpenTeamStore } from '../group/types'
import { memoryScopeLabel, memorySourceLabel, openMemoryPanel } from './memoryPanel'

afterEach(() => {
  document.body.replaceChildren()
})

function makeStore(language: 'zh-CN' | 'en' = 'zh-CN'): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = language
  const role = (id: string, chatId: string, name: string, chatSite: GroupRole['chatSite']): GroupRole => ({ id, chatId, name, chatSite, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 })
  store.rolesById = { r1: role('r1', 'c1', 'DeepSeek', 'deepseek'), r2: role('r2', 'c1', 'Kimi', 'kimi'), r3: role('r3', 'c2', 'Qwen', 'qwen') }
  store.chatsById.c1 = { id: 'c1', name: '选型群', mode: 'collaborative', roleIds: ['r1', 'r2'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.chatsById.c2 = { id: 'c2', name: '写作群', mode: 'collaborative', roleIds: ['r3'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  const item = (id: string, patch: Partial<MemoryItem>): MemoryItem => ({ id, scope: 'global', kind: 'fact', content: id, source: { origin: 'user' }, createdAt: 1, updatedAt: 1, ...patch })
  store.memoryItemsById = {
    a: item('a', { kind: 'preference', content: '回答用中文', pinned: true }),
    b: item('b', { scope: 'chat', scopeId: 'c1', kind: 'decision', content: '数据库用 Postgres', tags: ['数据库'] }),
    c: item('c', { scope: 'role', scopeId: 'r2', content: '主键用 UUID', source: { origin: 'member', roleId: 'r2', chatId: 'c1', messageId: 'm2' } }),
    d: item('d', { scope: 'chat', scopeId: 'c2', kind: 'note', content: '稿子周五交', disabled: true }),
  }
  store.memoryOrder = ['a', 'b', 'c', 'd']
  return store
}

function open(store = makeStore(), options: { chatId?: string; confirm?: boolean; fail?: string } = { chatId: 'c1' }) {
  // Applies the command to the store, as the background would, so the list redraws from it.
  const runCommand = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (options.fail) throw new Error(options.fail)
    const id = payload.itemId as string
    if (type === 'GROUP_MEMORY_DELETE') {
      const { [id]: _gone, ...rest } = store.memoryItemsById ?? {}
      store.memoryItemsById = rest
      store.memoryOrder = (store.memoryOrder ?? []).filter(itemId => itemId !== id)
    }
    if (type === 'GROUP_MEMORY_UPDATE') {
      const patch = payload.patch as Partial<MemoryItem>
      store.memoryItemsById = { ...store.memoryItemsById, [id]: { ...store.memoryItemsById![id], ...patch } }
    }
  })
  const confirm = vi.fn(() => options.confirm ?? true)
  const onClose = vi.fn()
  openMemoryPanel({ getStore: () => store, runCommand, getCurrentChatId: () => options.chatId, confirm, onClose })
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const rows = () => [...document.querySelectorAll<HTMLElement>('.memory-panel-item')].map(row => row.dataset.memoryItem)
  const action = (id: string, name: string) => $<HTMLButtonElement>(`[data-memory-item="${id}"] [data-memory-action="${name}"]`)
  return { store, runCommand, confirm, onClose, $, rows, action }
}

describe('where a memory item applies and whose words it holds', () => {
  it('names the group, or the member and its group', () => {
    const store = makeStore()
    expect(memoryScopeLabel(store, store.memoryItemsById!.a, false)).toBe('全部群聊')
    expect(memoryScopeLabel(store, store.memoryItemsById!.b, false)).toBe('群聊「选型群」')
    expect(memoryScopeLabel(store, store.memoryItemsById!.c, false)).toBe('「选型群」里的「Kimi」')
    expect(memoryScopeLabel(store, store.memoryItemsById!.c, true)).toBe('"Kimi" in "选型群"')
  })

  it('says who wrote it, also once that member is gone', () => {
    const store = makeStore()
    expect(memorySourceLabel(store, store.memoryItemsById!.a, false)).toBe('你写的')
    expect(memorySourceLabel(store, store.memoryItemsById!.c, false)).toBe('出自「Kimi」的回复')
    delete store.rolesById.r2
    expect(memorySourceLabel(store, store.memoryItemsById!.c, false)).toBe('出自一位成员的回复')
    expect(memoryScopeLabel(store, store.memoryItemsById!.c, false)).toBe('已移除的成员')
  })
})

describe('memory panel', () => {
  it('lists every item, newest first, with its kind, scope, marks and source', () => {
    const { $, rows } = open()
    expect($('.memory-panel').getAttribute('aria-labelledby')).toBe('memory-panel-title')
    expect($('#memory-panel-title').textContent).toBe('记忆库')
    expect($('.memory-panel-count').textContent).toContain('4 / 500 条')
    expect(document.activeElement).toBe($('.memory-panel-search'))
    expect(rows()).toEqual(['a', 'b', 'c', 'd'])
    expect($('[data-memory-item="a"] .memory-panel-meta').textContent).toBe('偏好全部群聊常驻你写的')
    expect($('[data-memory-item="c"] .memory-panel-meta').textContent).toBe('事实「选型群」里的「Kimi」出自「Kimi」的回复')
    expect($('[data-memory-item="d"]').classList.contains('is-disabled')).toBe(true)
    expect($('[data-memory-item="d"] .memory-panel-off').textContent).toBe('已停用')
    expect($('[data-memory-item="b"] .memory-panel-tags').textContent).toBe('标签：数据库')
    expect($<HTMLElement>('.memory-panel-empty').hidden).toBe(true)
  })

  it('narrows the list by words, also in tags, and by scope', () => {
    const { $, rows } = open()
    const search = $<HTMLInputElement>('.memory-panel-search')
    search.value = 'postgres'
    search.dispatchEvent(new Event('input'))
    expect(rows()).toEqual(['b'])
    search.value = '数据库'
    search.dispatchEvent(new Event('input'))
    expect(rows()).toEqual(['b'])
    search.value = '没有这个词'
    search.dispatchEvent(new Event('input'))
    expect(rows()).toEqual([])
    expect($('.memory-panel-empty').textContent).toBe('没有符合的记忆。')
    search.value = ''
    search.dispatchEvent(new Event('input'))

    const filter = $<HTMLSelectElement>('.memory-panel-filter')
    const pick = (value: string) => {
      filter.value = value
      filter.dispatchEvent(new Event('change'))
    }
    pick('global')
    expect(rows()).toEqual(['a'])
    pick('chat')
    expect(rows()).toEqual(['b', 'c'])
    pick('disabled')
    expect(rows()).toEqual(['d'])
  })

  it('leaves out the this-group filter when no group is on screen', () => {
    open(makeStore(), {})
    expect([...document.querySelectorAll<HTMLOptionElement>('.memory-panel-filter option')].map(option => option.value)).toEqual(['all', 'global', 'disabled'])
  })

  it('pins and unpins, switches off and on, and keeps the focus on the button', async () => {
    const { action, runCommand, $ } = open()
    expect(action('a', 'pin').textContent).toBe('取消常驻')
    action('a', 'pin').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_UPDATE', { itemId: 'a', patch: { pinned: false } }))
    await vi.waitFor(() => expect(action('a', 'pin').textContent).toBe('设为常驻'))
    expect(document.activeElement).toBe(action('a', 'pin'))

    expect(action('d', 'toggle').textContent).toBe('启用')
    action('d', 'toggle').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_UPDATE', { itemId: 'd', patch: { disabled: false } }))
    await vi.waitFor(() => expect($('[data-memory-item="d"]').classList.contains('is-disabled')).toBe(false))
    expect(action('d', 'toggle').textContent).toBe('停用')
  })

  it('deletes only after a yes, then moves the focus to the search box', async () => {
    const refused = open(makeStore(), { chatId: 'c1', confirm: false })
    refused.action('b', 'delete').click()
    expect(refused.confirm).toHaveBeenCalledWith('确定删除这条记忆吗？删除后无法恢复。')
    expect(refused.runCommand).not.toHaveBeenCalled()

    const { action, runCommand, rows, $ } = open()
    action('b', 'delete').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_DELETE', { itemId: 'b' }))
    await vi.waitFor(() => expect(rows()).toEqual(['a', 'c', 'd']))
    expect($('.memory-panel-count').textContent).toContain('3 / 500 条')
    expect(document.activeElement).toBe($('.memory-panel-search'))
  })

  it('shows what the background refused', async () => {
    const { action, $ } = open(makeStore(), { chatId: 'c1', fail: '找不到这条记忆' })
    action('a', 'toggle').click()
    await vi.waitFor(() => expect($('.team-form-error').textContent).toBe('找不到这条记忆'))
  })

  it('tells the rows\' buttons apart for a screen reader', () => {
    const { action } = open()
    expect(action('b', 'delete').getAttribute('aria-label')).toBe('删除：数据库用 Postgres')
    expect(action('a', 'edit').getAttribute('aria-label')).toBe('编辑：回答用中文')
  })

  it('opens the save window for a new item and for an edit; Escape closes that window first', () => {
    const { $, action, onClose } = open()
    $<HTMLButtonElement>('.memory-panel-add').click()
    expect($('#memory-dialog-title').textContent).toBe('保存到记忆库')
    expect($<HTMLInputElement>('input[name="memory-scope"]:checked').value).toBe('chat')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.memory-dialog-modal')).toBeNull()
    expect(document.querySelector('.memory-panel-modal')).not.toBeNull()
    expect(document.activeElement).toBe($('.memory-panel-add'))

    action('c', 'edit').click()
    expect($('#memory-dialog-title').textContent).toBe('编辑记忆')
    expect($<HTMLTextAreaElement>('#memory-content').value).toBe('主键用 UUID')
    expect($<HTMLInputElement>('input[name="memory-scope"]:checked').value).toBe('role')
    expect($<HTMLSelectElement>('.memory-dialog-member').value).toBe('r2')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.activeElement).toBe(action('c', 'edit'))

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.memory-panel-modal')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks an item nobody reads any more, and says why', () => {
    const store = makeStore()
    store.chatsById.c1.mode = 'independent'
    // c came from Kimi's reply; Kimi has left the group.
    store.memoryItemsById!.c = { ...store.memoryItemsById!.c, scope: 'chat', scopeId: 'c1' }
    store.chatsById.c1.roleIds = ['r1']
    const { $ } = open(store, { chatId: 'c1' })
    expect($('[data-memory-item="c"] .memory-panel-meta').textContent).toContain('无人可读')
    expect($('[data-memory-item="c"] .memory-panel-tags').textContent).toContain('已移出的成员')
    expect($('[data-memory-item="b"] .memory-panel-meta').textContent).not.toContain('无人可读')
  })

  it('says how to start when nothing is saved, in English too', () => {
    const store = makeStore('en')
    store.memoryItemsById = {}
    store.memoryOrder = []
    const { $ } = open(store, {})
    expect($<HTMLElement>('.memory-panel-list').hidden).toBe(true)
    expect($('.memory-panel-empty').textContent).toBe('Nothing saved yet. Use "Remember this" under a message, or add an item here.')
    expect($('.memory-panel')?.textContent).not.toMatch(/[一-鿿]/)
  })
})
