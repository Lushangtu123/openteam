import type { MemoryItem, MemoryKind, MemoryScope, MemorySource, OpenTeamStore } from './types'

export const MAX_MEMORY_ITEMS = 500
export const MAX_MEMORY_CONTENT_CHARS = 500
export const MAX_MEMORY_TAGS = 8
export const MAX_MEMORY_TAG_CHARS = 40

const MAX_ID_CHARS = 100
const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'chat', 'role']
const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'decision', 'preference', 'note']

export interface MemoryState {
  memoryItemsById: Record<string, MemoryItem>
  memoryOrder: string[]
}

export interface NewMemoryItem {
  scope: MemoryScope
  scopeId?: string
  kind: MemoryKind
  content: string
  tags?: string[]
  // Left out, a 'preference' item is pinned: a preference such as "answer in Chinese" shares no
  // words with the questions it applies to, so a search would never find it.
  pinned?: boolean
  source: MemorySource
}

export interface MemoryItemPatch {
  scope?: MemoryScope
  scopeId?: string
  kind?: MemoryKind
  content?: string
  tags?: string[]
  pinned?: boolean
  disabled?: boolean
}

// 'empty' and 'too-long' are about the content, 'scope' is a missing or unknown chat or member,
// 'limit' is a full store (nothing is evicted; the user has to delete items).
export type MemoryWriteError = 'empty' | 'too-long' | 'invalid' | 'scope' | 'tags' | 'limit' | 'not-found'

export type MemoryWriteResult = { ok: true; item: MemoryItem } | { ok: false; error: MemoryWriteError }

// Characters as the user counts them: one for a Chinese character or an emoji.
export function memoryContentLength(content: string): number {
  return [...content].length
}

export function readMemoryItem(raw: unknown): MemoryItem | undefined {
  if (!isRecord(raw)) return undefined
  const id = readId(raw.id)
  const scope = MEMORY_SCOPES.find(value => value === raw.scope)
  const kind = MEMORY_KINDS.find(value => value === raw.kind)
  const content = readContent(raw.content)
  const source = readMemorySource(raw.source)
  if (!id || !scope || !kind || typeof content !== 'string' || !source) return undefined
  const scopeId = scope === 'global' ? undefined : readId(raw.scopeId)
  if (scope !== 'global' && !scopeId) return undefined
  const tags = normalizeMemoryTags(raw.tags).slice(0, MAX_MEMORY_TAGS)
  return {
    id,
    scope,
    ...(scopeId ? { scopeId } : {}),
    kind,
    content,
    ...(tags.length ? { tags } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    source,
    createdAt: readTime(raw.createdAt),
    updatedAt: readTime(raw.updatedAt),
    ...(raw.disabled === true ? { disabled: true } : {}),
  }
}

// Drops items that do not read, repeats of an id, and whatever is past the item limit. `rawOrder`
// decides the order; items it does not name follow it.
export function normalizeMemoryState(rawItemsById: unknown, rawOrder: unknown): MemoryState {
  const itemsById = new Map<string, MemoryItem>()
  if (isRecord(rawItemsById)) {
    for (const value of Object.values(rawItemsById)) {
      const item = readMemoryItem(value)
      if (item && !itemsById.has(item.id)) itemsById.set(item.id, item)
    }
  }
  const named = Array.isArray(rawOrder) ? rawOrder.filter((id): id is string => typeof id === 'string' && itemsById.has(id)) : []
  const memoryOrder = [...new Set([...named, ...itemsById.keys()])].slice(0, MAX_MEMORY_ITEMS)
  return {
    memoryItemsById: Object.fromEntries(memoryOrder.map(id => [id, itemsById.get(id) as MemoryItem])),
    memoryOrder,
  }
}

// The store's items, newest first.
export function listMemoryItems(store: Pick<OpenTeamStore, 'memoryItemsById' | 'memoryOrder'>): MemoryItem[] {
  const itemsById = store.memoryItemsById ?? {}
  const ordered = [...new Set([...(store.memoryOrder ?? []), ...Object.keys(itemsById)])]
  return ordered.flatMap(id => (itemsById[id] ? [itemsById[id]] : []))
}

export function addMemoryItem(store: OpenTeamStore, input: NewMemoryItem, now = Date.now()): MemoryWriteResult {
  const content = checkContent(input.content)
  if (!content.ok) return content
  const scope = checkScope(store, input.scope, input.scopeId)
  if (!scope.ok) return scope
  const tags = checkTags(input.tags)
  if (!tags.ok) return tags
  const source = readMemorySource(input.source)
  if (!MEMORY_KINDS.includes(input.kind) || !source) return { ok: false, error: 'invalid' }
  if (listMemoryItems(store).length >= MAX_MEMORY_ITEMS) return { ok: false, error: 'limit' }

  const item: MemoryItem = {
    id: createMemoryId(),
    scope: input.scope,
    ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
    kind: input.kind,
    content: content.value,
    ...(tags.value.length ? { tags: tags.value } : {}),
    ...((input.pinned ?? input.kind === 'preference') ? { pinned: true } : {}),
    source,
    createdAt: now,
    updatedAt: now,
  }
  store.memoryItemsById = { ...(store.memoryItemsById ?? {}), [item.id]: item }
  store.memoryOrder = [item.id, ...(store.memoryOrder ?? []).filter(id => id !== item.id)]
  return { ok: true, item }
}

// Changes the fields named in `patch`. updatedAt moves only when the content or the kind changes:
// that is the text a member receives, and a web member is sent an item again once its updatedAt is
// later than the one it was sent with. Pinning, switching off or moving an item leaves it alone.
export function updateMemoryItem(store: OpenTeamStore, id: string, patch: MemoryItemPatch, now = Date.now()): MemoryWriteResult {
  const current = store.memoryItemsById?.[id]
  if (!current) return { ok: false, error: 'not-found' }

  const next: MemoryItem = { ...current }
  if (patch.content !== undefined) {
    const content = checkContent(patch.content)
    if (!content.ok) return content
    next.content = content.value
  }
  if (patch.kind !== undefined) {
    if (!MEMORY_KINDS.includes(patch.kind)) return { ok: false, error: 'invalid' }
    next.kind = patch.kind
  }
  if (patch.scope !== undefined || patch.scopeId !== undefined) {
    const nextScope = patch.scope ?? current.scope
    const scope = checkScope(store, nextScope, patch.scopeId ?? (nextScope === current.scope ? current.scopeId : undefined))
    if (!scope.ok) return scope
    next.scope = nextScope
    if (scope.scopeId) next.scopeId = scope.scopeId
    else delete next.scopeId
  }
  if (patch.tags !== undefined) {
    const tags = checkTags(patch.tags)
    if (!tags.ok) return tags
    if (tags.value.length) next.tags = tags.value
    else delete next.tags
  }
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinned = true
    else delete next.pinned
  }
  if (patch.disabled !== undefined) {
    if (patch.disabled) next.disabled = true
    else delete next.disabled
  }
  if (next.content !== current.content || next.kind !== current.kind) next.updatedAt = now

  store.memoryItemsById = { ...store.memoryItemsById, [id]: next }
  return { ok: true, item: next }
}

export function deleteMemoryItem(store: OpenTeamStore, id: string): boolean {
  if (!store.memoryItemsById?.[id]) return false
  const { [id]: _removed, ...rest } = store.memoryItemsById
  store.memoryItemsById = rest
  store.memoryOrder = (store.memoryOrder ?? []).filter(itemId => itemId !== id)
  return true
}

// What happens to items when the group or member they belong to goes or is copied
// (docs/MEMORY_STORE.zh-CN.md, section 7). Items kept for every group are never touched here.

// A deleted group takes its own items and its members' items with it. Returns how many went.
export function deleteMemoryForChat(store: OpenTeamStore, chatId: string, roleIds: Iterable<string>): number {
  return removeMemoryItems(store, belongsToChat(chatId, roleIds))
}

// How many items deleting the group would take with it: said before the user confirms.
export function countMemoryForChat(store: Pick<OpenTeamStore, 'memoryItemsById' | 'memoryOrder'>, chatId: string, roleIds: Iterable<string>): number {
  return listMemoryItems(store).filter(belongsToChat(chatId, roleIds)).length
}

// How many items removing the member would take with it.
export function countMemoryForRole(store: Pick<OpenTeamStore, 'memoryItemsById' | 'memoryOrder'>, roleId: string): number {
  return listMemoryItems(store).filter(item => item.scope === 'role' && item.scopeId === roleId).length
}

function belongsToChat(chatId: string, roleIds: Iterable<string>): (item: MemoryItem) => boolean {
  const members = new Set(roleIds)
  return item => (item.scope === 'chat' && item.scopeId === chatId) || (item.scope === 'role' && members.has(item.scopeId ?? ''))
}

// A deleted member takes its own items with it. What it wrote and the user saved for the group
// or for every group stays.
export function deleteMemoryForRole(store: OpenTeamStore, roleId: string): number {
  return removeMemoryItems(store, item => item.scope === 'role' && item.scopeId === roleId)
}

export interface CopyMemoryForChatInput {
  fromChatId: string
  toChatId: string
  // The source group's member ids, each with the id of its copy.
  roleIds: ReadonlyMap<string, string>
  newId?(): string
  now?: number
}

// A duplicated group gets copies of the group's items and of its members' items, for the new group
// and the new members. An item a member wrote names the copy of that member as its writer, so the
// new group's members are kept apart the same way; the message it came from is not copied, so it
// is not named. Stops at the item limit. Returns how many were copied.
export function copyMemoryForChat(store: OpenTeamStore, input: CopyMemoryForChatInput): number {
  const now = input.now ?? Date.now()
  const copies: MemoryItem[] = []
  for (const item of listMemoryItems(store)) {
    const scopeId = item.scope === 'chat' && item.scopeId === input.fromChatId
      ? input.toChatId
      : item.scope === 'role' && item.scopeId ? input.roleIds.get(item.scopeId) : undefined
    if (!scopeId) continue
    const { messageId: _messageId, ...source } = item.source
    const writer = source.roleId ? input.roleIds.get(source.roleId) : undefined
    copies.push({
      ...item,
      id: input.newId?.() ?? createMemoryId(),
      scopeId,
      ...(item.tags ? { tags: [...item.tags] } : {}),
      source: { ...source, ...(writer ? { roleId: writer } : {}), ...(source.chatId === input.fromChatId ? { chatId: input.toChatId } : {}) },
      createdAt: now,
      updatedAt: now,
    })
  }
  return appendMemoryItems(store, copies)
}

// Items from a backup, with the ids they have there. An id already here keeps what is here; an
// item that does not read, or does not fit under the limit, is left out.
export function importMemoryItems(store: OpenTeamStore, items: Iterable<unknown>): { added: number; skipped: number } {
  const readable: MemoryItem[] = []
  let offered = 0
  for (const raw of items) {
    offered += 1
    const item = readMemoryItem(raw)
    if (item && !store.memoryItemsById?.[item.id] && !readable.some(other => other.id === item.id)) readable.push(item)
  }
  const added = appendMemoryItems(store, readable)
  return { added, skipped: offered - added }
}

function removeMemoryItems(store: OpenTeamStore, shouldRemove: (item: MemoryItem) => boolean): number {
  const removed = new Set(listMemoryItems(store).filter(shouldRemove).map(item => item.id))
  if (removed.size === 0) return 0
  store.memoryItemsById = Object.fromEntries(Object.entries(store.memoryItemsById ?? {}).filter(([id]) => !removed.has(id)))
  store.memoryOrder = (store.memoryOrder ?? []).filter(id => !removed.has(id))
  return removed.size
}

// Added after the items already here, as many as fit under the limit.
function appendMemoryItems(store: OpenTeamStore, items: MemoryItem[]): number {
  const current = listMemoryItems(store)
  const fitting = items.slice(0, Math.max(0, MAX_MEMORY_ITEMS - current.length))
  if (fitting.length === 0) return 0
  store.memoryItemsById = { ...(store.memoryItemsById ?? {}), ...Object.fromEntries(fitting.map(item => [item.id, item])) }
  store.memoryOrder = [...current.map(item => item.id), ...fitting.map(item => item.id)]
  return fitting.length
}

// Trimmed tags without repeats (compared without case). Tags that are too long are dropped.
export function normalizeMemoryTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap(value => {
    const tag = typeof value === 'string' ? value.trim() : ''
    const key = tag.toLowerCase()
    if (!tag || tag.includes('\0') || memoryContentLength(tag) > MAX_MEMORY_TAG_CHARS || seen.has(key)) return []
    seen.add(key)
    return [tag]
  })
}

function readMemorySource(raw: unknown): MemorySource | undefined {
  if (!isRecord(raw) || (raw.origin !== 'user' && raw.origin !== 'member')) return undefined
  const roleId = readId(raw.roleId)
  const chatId = readId(raw.chatId)
  const messageId = readId(raw.messageId)
  return {
    origin: raw.origin,
    ...(roleId ? { roleId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(messageId ? { messageId } : {}),
  }
}

function checkContent(raw: string): { ok: true; value: string } | { ok: false; error: MemoryWriteError } {
  if (typeof raw !== 'string' || raw.includes('\0')) return { ok: false, error: 'invalid' }
  const value = raw.trim()
  if (!value) return { ok: false, error: 'empty' }
  if (memoryContentLength(value) > MAX_MEMORY_CONTENT_CHARS) return { ok: false, error: 'too-long' }
  return { ok: true, value }
}

function checkScope(store: OpenTeamStore, scope: MemoryScope, rawScopeId: string | undefined): { ok: true; scopeId?: string } | { ok: false; error: MemoryWriteError } {
  if (scope === 'global') return { ok: true }
  const scopeId = readId(rawScopeId)
  const known = scope === 'chat' ? store.chatsById : scope === 'role' ? store.rolesById : undefined
  if (!scopeId || !known?.[scopeId]) return { ok: false, error: 'scope' }
  return { ok: true, scopeId }
}

function checkTags(raw: string[] | undefined): { ok: true; value: string[] } | { ok: false; error: MemoryWriteError } {
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'tags' }
  const value = normalizeMemoryTags(raw)
  // A tag that is too long, or more tags than fit, is an error rather than a silent cut.
  const tooLong = raw.some(tag => typeof tag === 'string' && memoryContentLength(tag.trim()) > MAX_MEMORY_TAG_CHARS)
  if (tooLong || value.length > MAX_MEMORY_TAGS) return { ok: false, error: 'tags' }
  return { ok: true, value }
}

function readContent(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.includes('\0')) return undefined
  const content = raw.trim()
  return content && memoryContentLength(content) <= MAX_MEMORY_CONTENT_CHARS ? content : undefined
}

function readId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const id = raw.trim()
  return id && id.length <= MAX_ID_CHARS ? id : undefined
}

function readTime(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

function createMemoryId(): string {
  return `memory-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
