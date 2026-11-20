// The page's commands for a group's 群资料库 (src/group/groupLibrary.ts): add a document (its text
// read on the page: a file, a note, web pages, an attachment or a reply), remove one, read one's
// text (the page is sent the store without it), and every text for a backup.
import { addLibraryDoc, removeLibraryDoc, type LibraryDocKind } from '../group/groupLibrary'
import type { OpenTeamStore } from '../group/types'
import { loadStore } from '../group/store'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore, requireChat } from './storeAccess'

export const LIBRARY_ROUTE_TYPES = ['LIBRARY_ADD', 'LIBRARY_REMOVE', 'LIBRARY_TEXT_GET', 'LIBRARY_EXPORT'] as const

export interface LibraryHandlerDependencies {
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  newId(prefix: string): string
  now(): number
}

export function createLibraryHandlers(deps: LibraryHandlerDependencies): BackgroundMessageRoute[] {
  const handleAdd = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const input = (message.doc && typeof message.doc === 'object' ? message.doc : {}) as Record<string, unknown>
    const { store, result } = await mutateStore(store => {
      requireChat(store, chatId)
      return addLibraryDoc(store, chatId, {
        title: typeof input.title === 'string' ? input.title : '',
        kind: input.kind as LibraryDocKind,
        ...(typeof input.source === 'string' ? { source: input.source } : {}),
        text: typeof input.text === 'string' ? input.text : '',
      }, deps.now(), deps.newId)
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, docId: result.id, store }
  }

  const handleRemove = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const docId = requireText(message.docId, '缺少资料 ID')
    const { store } = await mutateStore(store => {
      requireChat(store, chatId)
      removeLibraryDoc(store, chatId, docId)
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleTextGet = async (message: RuntimeMessage) => {
    const chatId = requireText(message.chatId, '缺少群聊 ID')
    const docId = requireText(message.docId, '缺少资料 ID')
    const doc = (await loadStore()).libraryByChatId?.[chatId]?.find(item => item.id === docId)
    if (!doc) throw new Error('找不到这份资料')
    return { ok: true, title: doc.title, text: doc.text ?? '' }
  }

  // For a backup: the page's store has the documents without their text.
  const handleExport = async () => ({ ok: true, libraryByChatId: (await loadStore()).libraryByChatId ?? {} })

  return [
    { type: 'LIBRARY_ADD', handler: handleAdd },
    { type: 'LIBRARY_REMOVE', handler: handleRemove },
    { type: 'LIBRARY_TEXT_GET', handler: handleTextGet },
    { type: 'LIBRARY_EXPORT', handler: handleExport },
  ]
}

function requireText(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value) throw new Error(error)
  return value
}
