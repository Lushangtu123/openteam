import { describe, expect, it } from 'vitest'
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_ITEMS,
  MAX_MEMORY_TAGS,
  addMemoryItem,
  copyMemoryForChat,
  deleteMemoryForChat,
  deleteMemoryForRole,
  deleteMemoryItem,
  importMemoryItems,
  listMemoryItems,
  normalizeMemoryState,
  readMemoryItem,
  updateMemoryItem,
} from './memoryStore'
import type { NewMemoryItem } from './memoryStore'
import { createDefaultStore } from './store'
import type { GroupChat, GroupRole, MemoryItem, OpenTeamStore } from './types'

describe('memory store', () => {
  describe('adding', () => {
    it('adds an item at the front with trimmed content and both timestamps', () => {
      const store = makeStore()
      addMemoryItem(store, newItem({ content: 'first' }), 10)
      const result = addMemoryItem(store, newItem({ content: '  The release is on Friday.  ', tags: [' release ', 'Release', 'plan'] }), 20)

      expect(result).toEqual({
        ok: true,
        item: {
          id: expect.stringMatching(/^memory-/),
          scope: 'global',
          kind: 'fact',
          content: 'The release is on Friday.',
          tags: ['release', 'plan'],
          source: { origin: 'user' },
          createdAt: 20,
          updatedAt: 20,
        },
      })
      expect(listMemoryItems(store).map(item => item.content)).toEqual(['The release is on Friday.', 'first'])
      expect(store.memoryOrder).toHaveLength(2)
    })

    it('pins a preference by default, and leaves it unpinned when asked', () => {
      const store = makeStore()
      const preference = addMemoryItem(store, newItem({ kind: 'preference', content: '用中文回答' }))
      const unpinned = addMemoryItem(store, newItem({ kind: 'preference', content: 'Short answers', pinned: false }))
      const fact = addMemoryItem(store, newItem({ kind: 'fact', content: 'The API is versioned' }))
      const pinnedFact = addMemoryItem(store, newItem({ kind: 'fact', content: 'Budget is 5000', pinned: true }))

      expect(preference.ok && preference.item.pinned).toBe(true)
      expect(unpinned.ok && unpinned.item.pinned).toBeUndefined()
      expect(fact.ok && fact.item.pinned).toBeUndefined()
      expect(pinnedFact.ok && pinnedFact.item.pinned).toBe(true)
    })

    it('accepts content of exactly the limit and refuses one character more', () => {
      const store = makeStore()
      expect(addMemoryItem(store, newItem({ content: '字'.repeat(MAX_MEMORY_CONTENT_CHARS) })).ok).toBe(true)
      expect(addMemoryItem(store, newItem({ content: '字'.repeat(MAX_MEMORY_CONTENT_CHARS + 1) }))).toEqual({ ok: false, error: 'too-long' })
      // An emoji is one character to the user, though two UTF-16 units.
      expect(addMemoryItem(store, newItem({ content: '😀'.repeat(MAX_MEMORY_CONTENT_CHARS) })).ok).toBe(true)
      expect(listMemoryItems(store)).toHaveLength(2)
    })

    it('refuses empty content', () => {
      const store = makeStore()
      expect(addMemoryItem(store, newItem({ content: '   \n ' }))).toEqual({ ok: false, error: 'empty' })
      expect(listMemoryItems(store)).toEqual([])
    })

    it('refuses a new item once the store is full, without evicting any', () => {
      const store = makeStore()
      for (let index = 0; index < MAX_MEMORY_ITEMS; index += 1) {
        expect(addMemoryItem(store, newItem({ content: `fact ${index}` }), index).ok).toBe(true)
      }
      const firstId = store.memoryOrder?.[MAX_MEMORY_ITEMS - 1]

      expect(addMemoryItem(store, newItem({ content: 'one too many' }))).toEqual({ ok: false, error: 'limit' })
      expect(listMemoryItems(store)).toHaveLength(MAX_MEMORY_ITEMS)
      expect(store.memoryItemsById?.[firstId ?? '']?.content).toBe('fact 0')

      expect(deleteMemoryItem(store, firstId ?? '')).toBe(true)
      expect(addMemoryItem(store, newItem({ content: 'fits again' })).ok).toBe(true)
    })

    it('needs an existing chat or member for the chat and role scopes', () => {
      const store = makeStore()
      expect(addMemoryItem(store, newItem({ scope: 'chat' }))).toEqual({ ok: false, error: 'scope' })
      expect(addMemoryItem(store, newItem({ scope: 'chat', scopeId: 'chat-unknown' }))).toEqual({ ok: false, error: 'scope' })
      expect(addMemoryItem(store, newItem({ scope: 'role', scopeId: 'chat-1' }))).toEqual({ ok: false, error: 'scope' })

      const chatItem = addMemoryItem(store, newItem({ scope: 'chat', scopeId: 'chat-1' }))
      const roleItem = addMemoryItem(store, newItem({ scope: 'role', scopeId: 'role-1' }))
      const globalItem = addMemoryItem(store, newItem({ scope: 'global', scopeId: 'chat-1' }))
      expect(chatItem.ok && chatItem.item.scopeId).toBe('chat-1')
      expect(roleItem.ok && roleItem.item.scopeId).toBe('role-1')
      expect(globalItem.ok && 'scopeId' in globalItem.item).toBe(false)
    })

    it('refuses more tags than the limit instead of cutting them', () => {
      const store = makeStore()
      const tags = Array.from({ length: MAX_MEMORY_TAGS + 1 }, (_, index) => `tag-${index}`)
      expect(addMemoryItem(store, newItem({ tags }))).toEqual({ ok: false, error: 'tags' })
      expect(addMemoryItem(store, newItem({ tags: ['x'.repeat(41)] }))).toEqual({ ok: false, error: 'tags' })
      expect(addMemoryItem(store, newItem({ tags: tags.slice(0, MAX_MEMORY_TAGS) })).ok).toBe(true)
    })

    it('records where a member reply came from', () => {
      const store = makeStore()
      const result = addMemoryItem(store, newItem({
        scope: 'chat',
        scopeId: 'chat-1',
        source: { origin: 'member', roleId: 'role-1', chatId: 'chat-1', messageId: 'msg-9' },
      }))
      expect(result.ok && result.item.source).toEqual({ origin: 'member', roleId: 'role-1', chatId: 'chat-1', messageId: 'msg-9' })
    })
  })

  describe('editing', () => {
    it('moves updatedAt when the content or the kind changes', () => {
      const store = makeStore()
      const added = addMemoryItem(store, newItem({ content: 'old' }), 10)
      const id = added.ok ? added.item.id : ''

      const edited = updateMemoryItem(store, id, { content: ' new ' }, 20)
      expect(edited.ok && edited.item).toMatchObject({ content: 'new', createdAt: 10, updatedAt: 20 })
      const retyped = updateMemoryItem(store, id, { kind: 'decision' }, 30)
      expect(retyped.ok && retyped.item).toMatchObject({ kind: 'decision', updatedAt: 30 })
      expect(store.memoryItemsById?.[id]).toMatchObject({ content: 'new', kind: 'decision', updatedAt: 30 })
    })

    it('leaves updatedAt alone when an item is pinned, switched off, tagged or moved', () => {
      const store = makeStore()
      const added = addMemoryItem(store, newItem({ content: 'same text' }), 10)
      const id = added.ok ? added.item.id : ''

      updateMemoryItem(store, id, { pinned: true }, 20)
      updateMemoryItem(store, id, { disabled: true }, 30)
      updateMemoryItem(store, id, { tags: ['a'] }, 40)
      updateMemoryItem(store, id, { scope: 'role', scopeId: 'role-1' }, 50)
      updateMemoryItem(store, id, { content: 'same text' }, 60)
      expect(store.memoryItemsById?.[id]).toEqual({
        id,
        scope: 'role',
        scopeId: 'role-1',
        kind: 'fact',
        content: 'same text',
        tags: ['a'],
        pinned: true,
        disabled: true,
        source: { origin: 'user' },
        createdAt: 10,
        updatedAt: 10,
      })

      updateMemoryItem(store, id, { pinned: false, disabled: false, tags: [], scope: 'global' }, 70)
      expect(store.memoryItemsById?.[id]).toEqual({
        id,
        scope: 'global',
        kind: 'fact',
        content: 'same text',
        source: { origin: 'user' },
        createdAt: 10,
        updatedAt: 10,
      })
    })

    it('does not pin an item whose kind is changed to preference', () => {
      const store = makeStore()
      const added = addMemoryItem(store, newItem({ kind: 'note' }))
      const edited = updateMemoryItem(store, added.ok ? added.item.id : '', { kind: 'preference' })
      expect(edited.ok && edited.item.pinned).toBeUndefined()
    })

    it('refuses an edit that breaks a limit and keeps the item as it was', () => {
      const store = makeStore()
      const added = addMemoryItem(store, newItem({ content: 'kept' }), 10)
      const id = added.ok ? added.item.id : ''

      expect(updateMemoryItem(store, id, { content: 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1) })).toEqual({ ok: false, error: 'too-long' })
      expect(updateMemoryItem(store, id, { content: '' })).toEqual({ ok: false, error: 'empty' })
      expect(updateMemoryItem(store, id, { scope: 'chat' })).toEqual({ ok: false, error: 'scope' })
      expect(updateMemoryItem(store, id, { content: 'changed', scope: 'role', scopeId: 'nobody' })).toEqual({ ok: false, error: 'scope' })
      expect(updateMemoryItem(store, 'memory-unknown', { content: 'x' })).toEqual({ ok: false, error: 'not-found' })
      expect(store.memoryItemsById?.[id]).toMatchObject({ content: 'kept', scope: 'global', updatedAt: 10 })
    })
  })

  describe('deleting', () => {
    it('removes the item and its place in the order', () => {
      const store = makeStore()
      const first = addMemoryItem(store, newItem({ content: 'first' }))
      const second = addMemoryItem(store, newItem({ content: 'second' }))
      const firstId = first.ok ? first.item.id : ''

      expect(deleteMemoryItem(store, firstId)).toBe(true)
      expect(deleteMemoryItem(store, firstId)).toBe(false)
      expect(store.memoryOrder).toEqual([second.ok ? second.item.id : ''])
      expect(Object.keys(store.memoryItemsById ?? {})).toEqual(store.memoryOrder)
    })
  })

  describe('normalizing', () => {
    it('reads a stored item and drops what it does not know', () => {
      expect(readMemoryItem({ ...storedItem('memory-1'), extra: 'x', pinned: 'yes', disabled: false, tags: ['a', 3, ' a ', ''] })).toEqual({
        ...storedItem('memory-1'),
        tags: ['a'],
      })
      expect(readMemoryItem({ ...storedItem('memory-1'), scope: 'global', scopeId: 'chat-1' })).toEqual(storedItem('memory-1'))
    })

    it('refuses items that are not valid', () => {
      expect(readMemoryItem(undefined)).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), id: '' })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), scope: 'team' })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), scope: 'role' })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), kind: 'todo' })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), content: 'x'.repeat(MAX_MEMORY_CONTENT_CHARS + 1) })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), content: 'a\0b' })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), source: { origin: 'system' } })).toBeUndefined()
      expect(readMemoryItem({ ...storedItem('memory-1'), source: undefined })).toBeUndefined()
    })

    it('orders items by the stored order, then the ones it does not name', () => {
      const state = normalizeMemoryState(
        { a: storedItem('a'), b: storedItem('b'), c: storedItem('c'), broken: { id: 'broken' } },
        ['c', 'gone', 'a', 'c', 7, 'broken'],
      )
      expect(state.memoryOrder).toEqual(['c', 'a', 'b'])
      expect(Object.keys(state.memoryItemsById)).toEqual(['c', 'a', 'b'])
    })

    it('returns an empty state for data without memory fields', () => {
      expect(normalizeMemoryState(undefined, undefined)).toEqual({ memoryItemsById: {}, memoryOrder: [] })
      expect(normalizeMemoryState([], 'x')).toEqual({ memoryItemsById: {}, memoryOrder: [] })
    })

    it('keeps the first items in order when there are more than the limit', () => {
      const ids = Array.from({ length: MAX_MEMORY_ITEMS + 3 }, (_, index) => `memory-${index}`)
      const state = normalizeMemoryState(Object.fromEntries(ids.map(id => [id, storedItem(id)])), [...ids].reverse())
      expect(state.memoryOrder).toHaveLength(MAX_MEMORY_ITEMS)
      expect(state.memoryOrder[0]).toBe(`memory-${MAX_MEMORY_ITEMS + 2}`)
      expect(Object.keys(state.memoryItemsById)).toHaveLength(MAX_MEMORY_ITEMS)
      expect(state.memoryItemsById['memory-0']).toBeUndefined()
    })
  })
})

describe('memory items and the groups and members they belong to', () => {
  // Group chat-1 with alice and bob, and another group with carol.
  function withItems(): OpenTeamStore {
    const store = createDefaultStore()
    const items: MemoryItem[] = [
      { ...storedItem('everywhere'), scope: 'global' },
      { ...storedItem('group'), scope: 'chat', scopeId: 'chat-1' },
      { ...storedItem('group-from-bob'), scope: 'chat', scopeId: 'chat-1', pinned: true, tags: ['plan'], source: { origin: 'member', roleId: 'bob', chatId: 'chat-1', messageId: 'm9' } },
      { ...storedItem('alice-own'), scope: 'role', scopeId: 'alice' },
      { ...storedItem('bob-own'), scope: 'role', scopeId: 'bob' },
      { ...storedItem('other-group'), scope: 'chat', scopeId: 'chat-2' },
      { ...storedItem('carol-own'), scope: 'role', scopeId: 'carol' },
    ]
    store.memoryItemsById = Object.fromEntries(items.map(item => [item.id, item]))
    store.memoryOrder = items.map(item => item.id)
    return store
  }

  it('removes a deleted group\'s items and its members\' items, and nothing else', () => {
    const store = withItems()

    expect(deleteMemoryForChat(store, 'chat-1', ['alice', 'bob'])).toBe(4)
    expect(store.memoryOrder).toEqual(['everywhere', 'other-group', 'carol-own'])
    expect(Object.keys(store.memoryItemsById ?? {}).sort()).toEqual(['carol-own', 'everywhere', 'other-group'])
    // A group that has none.
    expect(deleteMemoryForChat(store, 'chat-9', [])).toBe(0)
  })

  it('removes a deleted member\'s own items only', () => {
    const store = withItems()

    expect(deleteMemoryForRole(store, 'bob')).toBe(1)
    expect(store.memoryOrder).toEqual(['everywhere', 'group', 'group-from-bob', 'alice-own', 'other-group', 'carol-own'])
    // What bob wrote and the user saved for the group stays the group's.
    expect(store.memoryItemsById?.['group-from-bob']).toBeDefined()
  })

  it('copies a duplicated group\'s items to the new group and its new members', () => {
    const store = withItems()
    let next = 0
    const copied = copyMemoryForChat(store, { fromChatId: 'chat-1', toChatId: 'chat-1b', roleIds: new Map([['alice', 'alice-b'], ['bob', 'bob-b']]), newId: () => `copy-${next += 1}`, now: 50 })

    expect(copied).toBe(4)
    expect(listMemoryItems(store)).toHaveLength(11)
    const copies = listMemoryItems(store).filter(item => item.id.startsWith('copy-'))
    expect(copies.map(item => [item.scope, item.scopeId, item.content])).toEqual([
      ['chat', 'chat-1b', 'content of group'],
      ['chat', 'chat-1b', 'content of group-from-bob'],
      ['role', 'alice-b', 'content of alice-own'],
      ['role', 'bob-b', 'content of bob-own'],
    ])
    // Who wrote it is the new group's member of the same place; the message was not copied.
    expect(copies[1]).toMatchObject({ pinned: true, tags: ['plan'], source: { origin: 'member', roleId: 'bob-b', chatId: 'chat-1b' }, createdAt: 50, updatedAt: 50 })
    expect(copies[1].source.messageId).toBeUndefined()
    // The originals are as they were.
    expect(store.memoryItemsById?.group).toMatchObject({ scopeId: 'chat-1', updatedAt: 2 })
  })

  it('copies what fits when the store is nearly full', () => {
    const store = withItems()
    for (let index = 0; index < MAX_MEMORY_ITEMS - 9; index += 1) {
      const filler = storedItem(`filler-${index}`)
      store.memoryItemsById![filler.id] = filler
      store.memoryOrder!.push(filler.id)
    }
    let next = 0

    expect(copyMemoryForChat(store, { fromChatId: 'chat-1', toChatId: 'chat-1b', roleIds: new Map([['alice', 'alice-b'], ['bob', 'bob-b']]), newId: () => `copy-${next += 1}`, now: 50 })).toBe(2)
    expect(listMemoryItems(store)).toHaveLength(MAX_MEMORY_ITEMS)
  })

  it('takes in items from a backup: not the ones already here, not past the limit', () => {
    const store = withItems()
    const incoming: MemoryItem[] = [
      { ...storedItem('group'), content: 'a newer text in the backup' },
      { ...storedItem('from-backup'), scope: 'chat', scopeId: 'chat-3' },
      { id: 'broken' } as MemoryItem,
    ]

    expect(importMemoryItems(store, incoming)).toEqual({ added: 1, skipped: 2 })
    expect(store.memoryOrder?.slice(-1)).toEqual(['from-backup'])
    // The item already here keeps its text.
    expect(store.memoryItemsById?.group.content).toBe('content of group')

    for (let index = 0; index < MAX_MEMORY_ITEMS; index += 1) importMemoryItems(store, [storedItem(`more-${index}`)])
    expect(listMemoryItems(store)).toHaveLength(MAX_MEMORY_ITEMS)
    expect(importMemoryItems(store, [storedItem('one-too-many')])).toEqual({ added: 0, skipped: 1 })
  })
})

function makeStore(): OpenTeamStore {
  const store = createDefaultStore()
  const chat: GroupChat = {
    id: 'chat-1',
    name: 'Planning',
    mode: 'independent',
    roleIds: ['role-1'],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
  const role: GroupRole = { id: 'role-1', chatId: 'chat-1', name: 'Reviewer', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[role.id] = role
  return store
}

function newItem(overrides: Partial<NewMemoryItem> = {}): NewMemoryItem {
  return { scope: 'global', kind: 'fact', content: 'A fact', source: { origin: 'user' }, ...overrides }
}

function storedItem(id: string): MemoryItem {
  return { id, scope: 'global', kind: 'fact', content: `content of ${id}`, source: { origin: 'user' }, createdAt: 1, updatedAt: 2 }
}
