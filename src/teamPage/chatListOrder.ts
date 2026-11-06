import type { GroupChat } from '../group/types'

// The search box above the group list appears once there are this many groups (or while it holds
// a query), so short lists stay uncluttered.
export const CHAT_SEARCH_MIN_CHATS = 6

// Pinned groups first, each part in the list's own order; then only those whose name or last
// message contains the query (case and spacing ignored).
export function orderChatsForList(chats: GroupChat[], query: string, summaryOf: (chat: GroupChat) => string): GroupChat[] {
  const ordered = [...chats.filter(chat => chat.pinned), ...chats.filter(chat => !chat.pinned)]
  const needle = normalize(query)
  if (!needle) return ordered
  return ordered.filter(chat => normalize(chat.name).includes(needle) || normalize(summaryOf(chat)).includes(needle))
}

export function shouldShowChatSearch(chatCount: number, query: string): boolean {
  return chatCount >= CHAT_SEARCH_MIN_CHATS || Boolean(query.trim())
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '')
}
