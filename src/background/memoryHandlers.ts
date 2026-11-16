// The memory store's writes, from the team page: saving an item (from a message, or new), editing,
// pinning or switching one off, and deleting one. Nothing else writes memory items: no reply is
// ever saved on its own (docs/MEMORY_STORE.zh-CN.md, section 6).
import { MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_ITEMS, MAX_MEMORY_TAGS, addMemoryItem, deleteMemoryItem, updateMemoryItem, type MemoryItemPatch, type MemoryWriteError } from '../group/memoryStore'
import { resolveMemoryProposal } from '../group/memoryProposals'
import type { MemoryKind, MemoryScope, MemorySource, OpenTeamStore } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export const MEMORY_ROUTE_TYPES = ['GROUP_MEMORY_ADD', 'GROUP_MEMORY_UPDATE', 'GROUP_MEMORY_DELETE', 'GROUP_MEMORY_PROPOSAL_DISMISS'] as const

export interface MemoryHandlersDependencies {
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  log: { info(event: string, details?: Record<string, unknown>): void }
  now(): number
}

const WRITE_ERRORS: Record<MemoryWriteError, string> = {
  empty: '记忆内容不能为空',
  'too-long': `记忆内容不能超过 ${MAX_MEMORY_CONTENT_CHARS} 字`,
  invalid: '这条记忆的类型或出处不对',
  scope: '找不到这条记忆所属的群聊或成员',
  tags: `标签最多 ${MAX_MEMORY_TAGS} 个，每个不能太长`,
  limit: `记忆库已经有 ${MAX_MEMORY_ITEMS} 条，请先删除一些再保存`,
  'not-found': '找不到这条记忆',
}

export function createMemoryHandlers(deps: MemoryHandlersDependencies): BackgroundMessageRoute[] {
  const handleAdd = async (message: RuntimeMessage) => {
    const input = isRecord(message.item) ? message.item : undefined
    if (!input) throw new Error('缺少记忆内容')
    const { store, result } = await mutateStore(store => {
      const saved = addMemoryItem(store, {
        scope: input.scope as MemoryScope,
        ...(typeof input.scopeId === 'string' ? { scopeId: input.scopeId } : {}),
        kind: input.kind as MemoryKind,
        content: typeof input.content === 'string' ? input.content : '',
        ...(Array.isArray(input.tags) ? { tags: input.tags as string[] } : {}),
        ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {}),
        source: sourceOf(store, input.messageId),
      }, deps.now())
      if (!saved.ok) throw new Error(WRITE_ERRORS[saved.error])
      // Saved from a member's proposal: the proposal is answered and leaves its message.
      if (typeof input.proposalId === 'string' && typeof input.messageId === 'string') resolveMemoryProposal(store.messagesById[input.messageId], input.proposalId)
      return saved.item
    })
    deps.log.info('memory:added', { itemId: result.id, scope: result.scope, kind: result.kind, origin: result.source.origin })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, item: result, store }
  }

  const handleUpdate = async (message: RuntimeMessage) => {
    const itemId = typeof message.itemId === 'string' ? message.itemId : ''
    const patch = isRecord(message.patch) ? message.patch as MemoryItemPatch : {}
    const { store, result } = await mutateStore(store => {
      const saved = updateMemoryItem(store, itemId, patch, deps.now())
      if (!saved.ok) throw new Error(WRITE_ERRORS[saved.error])
      return saved.item
    })
    deps.log.info('memory:updated', { itemId, patchKeys: Object.keys(patch) })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, item: result, store }
  }

  const handleDelete = async (message: RuntimeMessage) => {
    const itemId = typeof message.itemId === 'string' ? message.itemId : ''
    const { store } = await mutateStore(store => {
      if (!deleteMemoryItem(store, itemId)) throw new Error(WRITE_ERRORS['not-found'])
    })
    deps.log.info('memory:deleted', { itemId })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  // The user does not want what a member proposed: it leaves the message and nothing is saved.
  const handleProposalDismiss = async (message: RuntimeMessage) => {
    const messageId = typeof message.messageId === 'string' ? message.messageId : ''
    const proposalId = typeof message.proposalId === 'string' ? message.proposalId : ''
    const { store } = await mutateStore(store => {
      if (!resolveMemoryProposal(store.messagesById[messageId], proposalId)) throw new Error('找不到这条记忆提议，可能已经处理过')
    })
    deps.log.info('memory:proposal-dismissed', { messageId, proposalId })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  return [
    { type: 'GROUP_MEMORY_ADD', handler: handleAdd },
    { type: 'GROUP_MEMORY_UPDATE', handler: handleUpdate },
    { type: 'GROUP_MEMORY_DELETE', handler: handleDelete },
    { type: 'GROUP_MEMORY_PROPOSAL_DISMISS', handler: handleProposalDismiss },
  ]
}

// Who wrote the text: read from the message the item is saved from, not taken from the page's
// word, since it decides which members of an 独立 group may read the item. An item that comes
// from no message is the user's own.
function sourceOf(store: OpenTeamStore, messageId: unknown): MemorySource {
  if (typeof messageId !== 'string' || !messageId) return { origin: 'user' }
  const message = store.messagesById[messageId]
  if (!message) throw new Error('找不到这条消息，可能已被删除')
  if (message.type === 'assistant') return { origin: 'member', ...(message.roleId ? { roleId: message.roleId } : {}), chatId: message.chatId, messageId }
  return { origin: 'user', chatId: message.chatId, messageId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
