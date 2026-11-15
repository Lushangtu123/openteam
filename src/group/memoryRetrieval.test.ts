import { describe, expect, it } from 'vitest'
import {
  MEMORY_BUDGET_MAX_CHARS,
  MEMORY_ITEM_OVERHEAD_CHARS,
  MEMORY_MAX_RETRIEVED,
  fitMemoryBudget,
  isMemoryItemVisible,
  memoryCharBudget,
  memoryModeForChat,
  pinnedMemoryItems,
  searchMemoryItems,
  selectMemoryItems,
  tokenizeMemoryText,
  visibleMemoryItems,
} from './memoryRetrieval'
import { createDefaultStore } from './store'
import type { GroupChat, GroupRole, MemoryItem, OpenTeamStore, RoomMode } from './types'

describe('memory retrieval', () => {
  describe('visibility', () => {
    // One group with Alice and Bob, and another group with Carol.
    const items = [
      makeItem('global-user', { scope: 'global' }),
      makeItem('global-member', { scope: 'global', source: { origin: 'member', roleId: 'bob', chatId: 'chat-1' } }),
      makeItem('chat-user', { scope: 'chat', scopeId: 'chat-1' }),
      makeItem('chat-from-bob', { scope: 'chat', scopeId: 'chat-1', source: { origin: 'member', roleId: 'bob', chatId: 'chat-1' } }),
      makeItem('chat-from-alice', { scope: 'chat', scopeId: 'chat-1', source: { origin: 'member', roleId: 'alice', chatId: 'chat-1' } }),
      makeItem('alice-own', { scope: 'role', scopeId: 'alice' }),
      makeItem('alice-own-from-reply', { scope: 'role', scopeId: 'alice', source: { origin: 'member', roleId: 'alice', chatId: 'chat-1' } }),
      makeItem('bob-own', { scope: 'role', scopeId: 'bob' }),
      makeItem('other-chat', { scope: 'chat', scopeId: 'chat-2' }),
      makeItem('carol-own', { scope: 'role', scopeId: 'carol' }),
    ]

    function visibleIds(mode: RoomMode, roleId: string, chatId = 'chat-1', changeChat: Partial<GroupChat> = {}): string[] {
      const store = makeStore(items, mode)
      const chat = { ...store.chatsById[chatId], ...changeChat }
      return visibleMemoryItems(store, chat, store.rolesById[roleId]).map(item => item.id)
    }

    it('shows a member of an independent group the global items, the group items the user wrote, and its own', () => {
      expect(visibleIds('independent', 'alice')).toEqual(['global-user', 'global-member', 'chat-user', 'alice-own', 'alice-own-from-reply'])
      expect(visibleIds('independent', 'bob')).toEqual(['global-user', 'global-member', 'chat-user', 'bob-own'])
    })

    it('hides group items that came from a member in an independent group', () => {
      const ids = visibleIds('independent', 'alice')
      expect(ids).not.toContain('chat-from-bob')
      // Section 3 lists only the user's group items for 独立 mode, so the member's own reply saved
      // for the group is left out as well.
      expect(ids).not.toContain('chat-from-alice')
    })

    it('shows every group item in a collaborative group', () => {
      expect(visibleIds('collaborative', 'alice')).toEqual([
        'global-user', 'global-member', 'chat-user', 'chat-from-bob', 'chat-from-alice', 'alice-own', 'alice-own-from-reply',
      ])
    })

    it('never shows another member\'s own items, in either mode', () => {
      for (const mode of ['independent', 'collaborative'] as const) {
        expect(visibleIds(mode, 'alice')).not.toContain('bob-own')
        expect(visibleIds(mode, 'bob')).not.toContain('alice-own')
        expect(visibleIds(mode, 'bob')).not.toContain('alice-own-from-reply')
      }
    })

    it('keeps group and member items inside their own group', () => {
      expect(visibleIds('collaborative', 'carol', 'chat-2')).toEqual(['global-user', 'global-member', 'other-chat', 'carol-own'])
      // A member is only ever asked about its own group.
      expect(visibleIds('collaborative', 'carol', 'chat-1')).toEqual([])
    })

    it('treats a project request as collaborative', () => {
      const store = makeStore(items, 'independent')
      const chat = store.chatsById['chat-1']
      expect(memoryModeForChat(chat)).toBe('independent')
      expect(memoryModeForChat(chat, true)).toBe('collaborative')
      expect(memoryModeForChat({ ...chat, mode: 'collaborative' })).toBe('collaborative')
      expect(visibleMemoryItems(store, chat, store.rolesById.alice, memoryModeForChat(chat, true)).map(item => item.id)).toContain('chat-from-bob')
    })

    it('shows nothing in a group with memory switched off, and skips switched-off items', () => {
      expect(visibleIds('collaborative', 'alice', 'chat-1', { memoryDisabled: true })).toEqual([])

      const store = makeStore([makeItem('on'), makeItem('off', { disabled: true }), makeItem('off-pinned', { disabled: true, pinned: true })], 'collaborative')
      const chat = store.chatsById['chat-1']
      expect(visibleMemoryItems(store, chat, store.rolesById.alice).map(item => item.id)).toEqual(['on'])
      expect(isMemoryItemVisible(makeItem('off', { disabled: true }), chat, store.rolesById.alice)).toBe(false)
    })
  })

  describe('tokenizing', () => {
    it('splits English on spaces and punctuation, in lower case', () => {
      expect(tokenizeMemoryText('Deploy the API-gateway to STAGING, v2!')).toEqual(['deploy', 'api', 'gateway', 'staging', 'v2'])
    })

    it('splits Chinese into two-character windows', () => {
      expect(tokenizeMemoryText('数据库迁移')).toEqual(['数据', '据库', '库迁', '迁移'])
      expect(tokenizeMemoryText('猫')).toEqual(['猫'])
    })

    it('handles Chinese and English in one text', () => {
      expect(tokenizeMemoryText('用Redis做缓存，TTL=60秒')).toEqual(['用', 'redis', '做缓', '缓存', 'ttl', '60', '秒'])
    })

    it('reads full-width letters like ordinary ones', () => {
      expect(tokenizeMemoryText('ＡＰＩ　Ｋｅｙ')).toEqual(['api', 'key'])
    })

    it('leaves out words and character pairs that carry no topic', () => {
      expect(tokenizeMemoryText('What is this with the plan?')).toEqual(['plan'])
      expect(tokenizeMemoryText('我们可以怎么做')).toEqual(['么做'])
      expect(tokenizeMemoryText('的')).toEqual([])
      expect(tokenizeMemoryText('  ,.!？ ')).toEqual([])
    })
  })

  describe('searching', () => {
    it('finds the items about the query and ranks the closest first', () => {
      const items = [
        makeItem('db', { content: 'The database migration runs on Friday night' }),
        makeItem('db-twice', { content: 'Database migration: back up the database before any migration' }),
        makeItem('lunch', { content: 'Team lunch is every Wednesday' }),
      ]
      const results = searchMemoryItems(items, 'When is the database migration?')
      expect(results.map(result => result.item.id)).toEqual(['db-twice', 'db'])
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })

    it('finds Chinese items by shared character pairs', () => {
      const items = [
        makeItem('deploy', { content: '部署流程：先在预发环境验证，再发布到生产环境' }),
        makeItem('style', { content: '代码风格遵循团队规范' }),
      ]
      expect(searchMemoryItems(items, '生产环境怎么发布？').map(result => result.item.id)).toEqual(['deploy'])
    })

    it('does not return an item that shares only one common word with the query', () => {
      const items = [
        makeItem('the', { content: 'The cat sat on the mat' }),
        makeItem('with', { content: 'Coffee with milk' }),
        makeItem('new', { content: 'A new key was issued' }),
        makeItem('我们', { content: '我们周五聚餐' }),
      ]
      expect(searchMemoryItems(items, 'What is the plan with this?')).toEqual([])
      // One short word in common ("new") is below the threshold too.
      expect(searchMemoryItems(items, 'Any new ideas?')).toEqual([])
      expect(searchMemoryItems(items, '我们的计划是什么')).toEqual([])
    })

    it('does not return an item that shares a single Chinese character pair', () => {
      const items = [makeItem('weekly', { content: '周报每周五提交' })]
      expect(searchMemoryItems(items, '周报')).toEqual([])
      expect(searchMemoryItems(items, '周报什么时候提交')).toHaveLength(1)
    })

    it('accepts one English word of four letters or more', () => {
      const items = [makeItem('redis', { content: 'Sessions are stored in Redis' })]
      expect(searchMemoryItems(items, 'redis?').map(result => result.item.id)).toEqual(['redis'])
    })

    it('accepts a whole tag found in the query, and ranks a tag match higher', () => {
      const items = [
        makeItem('tagged', { content: '上线前必须跑完回归测试', tags: ['部署'] }),
        makeItem('tagged-en', { content: 'Rotate every ninety days', tags: ['API key'] }),
        makeItem('one-word', { content: 'The key is stored in the vault' }),
        makeItem('in-content', { content: 'The API key for billing is stored in the vault' }),
      ]
      expect(searchMemoryItems(items, '部署').map(result => result.item.id)).toEqual(['tagged'])
      // "key" alone is one short word, but it completes no tag: "API key" needs both words.
      expect(searchMemoryItems(items, 'the key')).toEqual([])
      expect(searchMemoryItems(items, 'Where is the API key?').map(result => result.item.id)).toEqual(['tagged-en', 'in-content'])
    })

    it('drops items that score far below the best one', () => {
      const filler = Array.from({ length: 12 }, (_, index) => makeItem(`filler-${index}`, { content: `Office seating row ${index} near the window` }))
      const items = [
        makeItem('strong', { content: 'Kubernetes cluster upgrade checklist for the payments service' }),
        makeItem('weak', { content: 'The office window checklist covers seating, lighting, heating, plants, desks, chairs, lockers and the payments kiosk' }),
        ...filler,
      ]
      const all = searchMemoryItems(items, 'kubernetes cluster upgrade checklist payments')
      expect(all[0].item.id).toBe('strong')
      expect(all.map(result => result.item.id)).not.toContain('weak')
    })

    it('returns at most five items', () => {
      const items = Array.from({ length: 9 }, (_, index) => makeItem(`item-${index}`, { content: `Release checklist step ${index}` }))
      expect(searchMemoryItems(items, 'release checklist')).toHaveLength(MEMORY_MAX_RETRIEVED)
      expect(searchMemoryItems(items, 'release checklist', 2)).toHaveLength(2)
    })

    it('puts the newer item first when two score the same', () => {
      const items = [
        makeItem('older', { content: 'Release checklist', updatedAt: 10 }),
        makeItem('newer', { content: 'Release checklist', updatedAt: 20 }),
      ]
      expect(searchMemoryItems(items, 'release checklist').map(result => result.item.id)).toEqual(['newer', 'older'])
    })

    it('returns nothing for a query without usable words', () => {
      const items = [makeItem('a', { content: 'Release checklist' })]
      expect(searchMemoryItems(items, '')).toEqual([])
      expect(searchMemoryItems(items, '？？？')).toEqual([])
      expect(searchMemoryItems([], 'release checklist')).toEqual([])
    })
  })

  describe('pinned items', () => {
    it('come without matching the query, newest first', () => {
      const store = makeStore([
        makeItem('pref-old', { kind: 'preference', content: '用中文回答', pinned: true, updatedAt: 5 }),
        makeItem('pref-new', { kind: 'preference', content: 'Keep answers short', pinned: true, updatedAt: 9 }),
        makeItem('unrelated', { content: 'Team lunch is every Wednesday' }),
      ], 'independent')

      const selected = selectMemoryItems({ store, chat: store.chatsById['chat-1'], role: store.rolesById.alice, query: 'How do I rotate the database password?' })
      expect(selected.map(item => item.id)).toEqual(['pref-new', 'pref-old'])
      expect(selectMemoryItems({ store, chat: store.chatsById['chat-1'], role: store.rolesById.alice, query: '' }).map(item => item.id)).toEqual(['pref-new', 'pref-old'])
    })

    it('are placed before found items and are not found a second time', () => {
      const store = makeStore([
        makeItem('found', { content: 'The database password rotates monthly' }),
        makeItem('pinned-match', { content: 'Database password policy: 16 characters', pinned: true }),
      ], 'independent')

      const selected = selectMemoryItems({ store, chat: store.chatsById['chat-1'], role: store.rolesById.alice, query: 'database password' })
      expect(selected.map(item => item.id)).toEqual(['pinned-match', 'found'])
      expect(pinnedMemoryItems(Object.values(store.memoryItemsById ?? {})).map(item => item.id)).toEqual(['pinned-match'])
    })

    it('respect visibility like any other item', () => {
      const store = makeStore([
        makeItem('bob-pinned', { scope: 'role', scopeId: 'bob', pinned: true }),
        makeItem('from-bob-pinned', { scope: 'chat', scopeId: 'chat-1', pinned: true, source: { origin: 'member', roleId: 'bob' } }),
      ], 'independent')
      expect(selectMemoryItems({ store, chat: store.chatsById['chat-1'], role: store.rolesById.alice, query: 'anything' })).toEqual([])
      expect(selectMemoryItems({ store, chat: store.chatsById['chat-1'], role: store.rolesById.alice, query: 'anything', mode: 'collaborative' }).map(item => item.id)).toEqual(['from-bob-pinned'])
    })
  })

  describe('budget', () => {
    it('is 15% of the context budget, capped at 1200 characters', () => {
      expect(memoryCharBudget(6000)).toBe(900)
      expect(memoryCharBudget(8000)).toBe(MEMORY_BUDGET_MAX_CHARS)
      expect(memoryCharBudget(1_000_000)).toBe(MEMORY_BUDGET_MAX_CHARS)
      expect(memoryCharBudget(0)).toBe(0)
      expect(memoryCharBudget(Number.NaN)).toBe(0)
    })

    it('cuts found items from the lowest score', () => {
      const sized = (id: string) => makeItem(id, { content: 'x'.repeat(100 - MEMORY_ITEM_OVERHEAD_CHARS) })
      const retrieved = [sized('first'), sized('second'), sized('third'), sized('fourth')]
      expect(fitMemoryBudget([], retrieved, 250).map(item => item.id)).toEqual(['first', 'second'])
      expect(fitMemoryBudget([], retrieved, 300).map(item => item.id)).toEqual(['first', 'second', 'third'])
      expect(fitMemoryBudget([], retrieved, 99)).toEqual([])
    })

    it('does not keep a lower-scoring item in place of a higher one that did not fit', () => {
      const retrieved = [
        makeItem('first', { content: 'x'.repeat(40) }),
        makeItem('second-long', { content: 'x'.repeat(200) }),
        makeItem('third-short', { content: 'x'.repeat(10) }),
      ]
      expect(fitMemoryBudget([], retrieved, 120).map(item => item.id)).toEqual(['first'])
    })

    it('places pinned items first and gives found items what is left', () => {
      const pinned = [makeItem('pin-new', { content: 'x'.repeat(88) }), makeItem('pin-old', { content: 'x'.repeat(88) })]
      const retrieved = [makeItem('found-1', { content: 'x'.repeat(38) }), makeItem('found-2', { content: 'x'.repeat(38) })]
      expect(fitMemoryBudget(pinned, retrieved, 250).map(item => item.id)).toEqual(['pin-new', 'pin-old', 'found-1'])
      // The older pinned item is the one dropped; the room left still goes to the best found item.
      expect(fitMemoryBudget(pinned, retrieved, 160).map(item => item.id)).toEqual(['pin-new', 'found-1'])
    })

    it('applies the member\'s own budget when selecting', () => {
      const pinned = Array.from({ length: 4 }, (_, index) => makeItem(`pin-${index}`, { content: 'x'.repeat(388), pinned: true, updatedAt: 100 - index }))
      const store = makeStore([...pinned, makeItem('found', { content: 'The database password rotates monthly' })], 'independent')
      const chat = store.chatsById['chat-1']

      // A web member: 1200 characters. Three pinned items of 400 fit, the oldest and the found one do not.
      const webMember = selectMemoryItems({ store, chat, role: store.rolesById.alice, query: 'database password' })
      expect(webMember.map(item => item.id)).toEqual(['pin-0', 'pin-1', 'pin-2'])

      // An API member on a model with no known size: 15% of the 6000 setting is 900.
      store.settings.externalModelOrder = ['model-1']
      store.settings.externalModelsById['model-1'] = { id: 'model-1', name: 'Local', format: 'openai', baseUrl: 'http://localhost', apiKey: 'k', modelName: 'tiny', createdAt: 1, updatedAt: 1 }
      const apiMember: GroupRole = { ...store.rolesById.alice, modelSource: 'external', externalModelId: 'model-1' }
      const selected = selectMemoryItems({ store, chat, role: apiMember, query: 'database password' })
      expect(selected.map(item => item.id)).toEqual(['pin-0', 'pin-1', 'found'])
    })
  })

  it('selects nothing when the store has no items', () => {
    const store = makeStore([], 'collaborative')
    expect(selectMemoryItems({ store, chat: store.chatsById['chat-1'], role: store.rolesById.alice, query: 'database password' })).toEqual([])
  })
})

function makeStore(items: MemoryItem[], mode: RoomMode): OpenTeamStore {
  const store = createDefaultStore()
  const chats: Array<[string, string[]]> = [['chat-1', ['alice', 'bob']], ['chat-2', ['carol']]]
  for (const [chatId, roleIds] of chats) {
    store.chatOrder.push(chatId)
    store.chatsById[chatId] = { id: chatId, name: chatId, mode, roleIds, messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    for (const roleId of roleIds) {
      store.rolesById[roleId] = { id: roleId, chatId, name: roleId, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
    }
  }
  store.memoryItemsById = Object.fromEntries(items.map(item => [item.id, item]))
  store.memoryOrder = items.map(item => item.id)
  return store
}

function makeItem(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return { id, scope: 'global', kind: 'fact', content: `content of ${id}`, source: { origin: 'user' }, createdAt: 1, updatedAt: 1, ...overrides }
}
