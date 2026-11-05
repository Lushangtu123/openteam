import type { GroupMessage, OpenTeamStore } from './types'

export const DEFAULT_SEARCH_LIMIT = 100
const SNIPPET_BEFORE = 24
const SNIPPET_LENGTH = 110

export interface SnippetPart {
  text: string
  match: boolean
}

export interface MessageSearchResult {
  chatId: string
  chatName: string
  messageId: string
  message: GroupMessage
  // The excerpt of the message around the first match, with every match marked.
  snippet: SnippetPart[]
}

export interface MessageSearchOptions {
  // Only search this chat.
  chatId?: string
  limit?: number
  speakerName(message: GroupMessage): string
}

export interface MessageSearchOutcome {
  results: MessageSearchResult[]
  // Matches before the limit was applied.
  total: number
}

// Finds the messages that contain every word of the query (case-insensitive) in their text, their
// attachment names or their speaker's name. Newest first.
export function searchMessages(store: OpenTeamStore, query: string, options: MessageSearchOptions): MessageSearchOutcome {
  const terms = searchTerms(query)
  if (terms.length === 0) return { results: [], total: 0 }

  const matches: Array<{ chatId: string; chatName: string; message: GroupMessage; attachmentNames: string }> = []
  const chatIds = options.chatId ? [options.chatId] : store.chatOrder
  for (const chatId of chatIds) {
    const chat = store.chatsById[chatId]
    if (!chat) continue
    for (const messageId of chat.messageIds) {
      const message = store.messagesById[messageId]
      if (!message) continue
      const attachmentNames = (message.attachments ?? []).map(attachment => attachment.fileName ?? '').join(' ')
      const haystack = `${message.content}\n${attachmentNames}\n${options.speakerName(message)}`.toLowerCase()
      if (!terms.every(term => haystack.includes(term))) continue
      matches.push({ chatId, chatName: chat.name, message, attachmentNames })
    }
  }

  matches.sort((left, right) => right.message.createdAt - left.message.createdAt || right.message.seq - left.message.seq)
  // Excerpts only for the results that are shown.
  const results = matches.slice(0, options.limit ?? DEFAULT_SEARCH_LIMIT).map(match => ({
    chatId: match.chatId,
    chatName: match.chatName,
    messageId: match.message.id,
    message: match.message,
    snippet: buildSnippet(match.message.content || match.attachmentNames, terms),
  }))
  return { results, total: matches.length }
}

export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

export function buildSnippet(text: string, terms: string[]): SnippetPart[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const positions = terms.map(term => lower.indexOf(term)).filter(position => position >= 0)
  const first = positions.length > 0 ? Math.min(...positions) : 0
  const start = Math.max(0, first - SNIPPET_BEFORE)
  const end = Math.min(flat.length, start + SNIPPET_LENGTH)
  const window = flat.slice(start, end)

  const parts = markMatches(window, terms)
  if (start > 0) parts.unshift({ text: '…', match: false })
  if (end < flat.length) parts.push({ text: '…', match: false })
  return mergeParts(parts)
}

function markMatches(text: string, terms: string[]): SnippetPart[] {
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    for (let index = lower.indexOf(term); index >= 0; index = lower.indexOf(term, index + term.length)) {
      for (let offset = 0; offset < term.length; offset += 1) marked[index + offset] = true
    }
  }
  const parts: SnippetPart[] = []
  for (let index = 0; index < text.length; index += 1) parts.push({ text: text[index], match: marked[index] })
  return parts
}

function mergeParts(parts: SnippetPart[]): SnippetPart[] {
  const merged: SnippetPart[] = []
  for (const part of parts) {
    const last = merged[merged.length - 1]
    if (last && last.match === part.match) last.text += part.text
    else merged.push({ ...part })
  }
  return merged
}
