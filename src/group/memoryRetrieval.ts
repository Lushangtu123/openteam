import { contextCharBudgetForRole } from './contextBudget'
import { listMemoryItems } from './memoryStore'
import type { GroupChat, GroupRole, MemoryItem, OpenTeamStore, RoomMode } from './types'

// Starting values; they are expected to change with testing.
export const MEMORY_MAX_RETRIEVED = 5
// A found item must score at least this share of the best one.
export const MEMORY_MIN_SCORE_RATIO = 0.35
// The memory block may take this share of the member's context budget, and never more than the cap.
export const MEMORY_BUDGET_RATIO = 0.15
export const MEMORY_BUDGET_MAX_CHARS = 1200
// What one item costs on top of its content: the bullet, the kind label and the line break.
export const MEMORY_ITEM_OVERHEAD_CHARS = 12

const BM25_K1 = 1.2
const BM25_B = 0.75
// A query word found in an item's tags counts as this many occurrences in its content.
const TAG_TERM_WEIGHT = 3
// A single matching English word is enough when it is at least this long.
const LONG_WORD_CHARS = 4

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_CHAR = /[\p{L}\p{N}]/u
const LETTER = /\p{L}/u

// Words and characters that carry no topic. They are left out of the tokens, so they neither score
// nor count as a match: without this, "with" or "我们的" alone would pass the match threshold.
const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your', 'our', 'their', 'his', 'her', 'them', 'us',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'than', 'then', 'there', 'here',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'can', 'could', 'will', 'would', 'should',
  'shall', 'may', 'might', 'must', 'about', 'into', 'over', 'also', 'just', 'some', 'any', 'all', 'more',
  'most', 'very', 'please', 'thanks', 'thank',
])
// A Chinese bigram is dropped only when both of its characters are in this set (我们, 什么, 可以).
const CHINESE_FUNCTION_CHARS = new Set('的了是我你他她它们这那有在和与及或就都也还不没吗呢吧啊呀么什怎哪个一些要会能可以把被给对让请很而且但为')

export interface ScoredMemoryItem {
  item: MemoryItem
  score: number
}

export interface MemorySelectionInput {
  store: OpenTeamStore
  chat: GroupChat
  role: GroupRole
  // The user's message, plus the message it quotes if any; for a discussion turn, the topic.
  query: string
  // Left out, the chat's own mode. A project runs as 'collaborative'.
  mode?: RoomMode
}

// The mode that decides what a member may read. A project request is handled as 协作.
export function memoryModeForChat(chat: GroupChat, projectRequest = false): RoomMode {
  return projectRequest || chat.mode === 'collaborative' ? 'collaborative' : 'independent'
}

// Whether `role`, a member of `chat`, may read `item`. Isolation in 独立 mode follows who wrote the
// text, not the scope: group items the user wrote are readable, group items that came from a
// member's reply are not. Another member's own items are never readable.
export function isMemoryItemVisible(item: MemoryItem, chat: GroupChat, role: GroupRole, mode: RoomMode = memoryModeForChat(chat)): boolean {
  if (item.disabled || chat.memoryDisabled || role.chatId !== chat.id) return false
  if (item.scope === 'global') return true
  if (item.scope === 'chat') return item.scopeId === chat.id && (mode === 'collaborative' || item.source.origin === 'user')
  return item.scopeId === role.id
}

export function visibleMemoryItems(store: Pick<OpenTeamStore, 'memoryItemsById' | 'memoryOrder'>, chat: GroupChat, role: GroupRole, mode: RoomMode = memoryModeForChat(chat)): MemoryItem[] {
  return listMemoryItems(store).filter(item => isMemoryItemVisible(item, chat, role, mode))
}

// Lower-case tokens: words for text written with spaces, two-character windows for Chinese (and
// Japanese and Korean), which needs no dictionary. A lone Chinese character is its own token.
export function tokenizeMemoryText(text: string): string[] {
  const tokens: string[] = []
  let run = ''
  let runIsCjk = false
  const flush = () => {
    if (!run) return
    if (!runIsCjk) {
      if (!ENGLISH_STOP_WORDS.has(run)) tokens.push(run)
    } else {
      const chars = [...run]
      if (chars.length === 1) {
        if (!CHINESE_FUNCTION_CHARS.has(chars[0])) tokens.push(chars[0])
      } else {
        for (let index = 0; index < chars.length - 1; index += 1) {
          if (CHINESE_FUNCTION_CHARS.has(chars[index]) && CHINESE_FUNCTION_CHARS.has(chars[index + 1])) continue
          tokens.push(chars[index] + chars[index + 1])
        }
      }
    }
    run = ''
  }

  for (const char of text.normalize('NFKC').toLowerCase()) {
    const isCjk = CJK_CHAR.test(char)
    if (!isCjk && !WORD_CHAR.test(char)) {
      flush()
      continue
    }
    if (run && isCjk !== runIsCjk) flush()
    run += char
    runIsCjk = isCjk
  }
  flush()
  return tokens
}

// Pinned items come without a search, newest first.
export function pinnedMemoryItems(items: MemoryItem[]): MemoryItem[] {
  return items.filter(item => item.pinned).sort((left, right) => right.updatedAt - left.updatedAt)
}

// BM25 over `items`, best first. An item is returned only if it shares at least two different
// tokens with the query (or one English word of four letters or more, or a whole tag), and scores
// at least MEMORY_MIN_SCORE_RATIO of the best item. Equal scores go to the newer item.
export function searchMemoryItems(items: MemoryItem[], query: string, limit = MEMORY_MAX_RETRIEVED): ScoredMemoryItem[] {
  const queryTerms = new Set(tokenizeMemoryText(query))
  if (queryTerms.size === 0 || items.length === 0) return []

  const documents = items.map(item => {
    const frequencies = new Map<string, number>()
    const contentTokens = tokenizeMemoryText(item.content)
    for (const token of contentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    const tagTokens = (item.tags ?? []).map(tokenizeMemoryText).filter(tokens => tokens.length > 0)
    for (const token of tagTokens.flat()) frequencies.set(token, (frequencies.get(token) ?? 0) + TAG_TERM_WEIGHT)
    return {
      item,
      frequencies,
      length: contentTokens.length + tagTokens.flat().length,
      tagMatched: tagTokens.some(tokens => tokens.every(token => queryTerms.has(token))),
    }
  })

  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const inverseDocumentFrequency = new Map<string, number>()
  for (const term of queryTerms) {
    const containing = documents.filter(document => document.frequencies.has(term)).length
    inverseDocumentFrequency.set(term, Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5)))
  }

  const matches = documents.flatMap(document => {
    const matched = [...queryTerms].filter(term => document.frequencies.has(term))
    if (matched.length < 2 && !matched.some(isLongWord) && !document.tagMatched) return []
    const score = matched.reduce((sum, term) => {
      const frequency = document.frequencies.get(term) ?? 0
      const saturation = frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * document.length / averageLength))
      return sum + (inverseDocumentFrequency.get(term) ?? 0) * saturation
    }, 0)
    return score > 0 ? [{ item: document.item, score }] : []
  })

  matches.sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt)
  const best = matches[0]?.score ?? 0
  return matches.filter(match => match.score >= best * MEMORY_MIN_SCORE_RATIO).slice(0, Math.max(0, limit))
}

// How many characters of memory a member with this context budget may be sent.
export function memoryCharBudget(contextCharBudget: number): number {
  if (!Number.isFinite(contextCharBudget) || contextCharBudget <= 0) return 0
  return Math.min(MEMORY_BUDGET_MAX_CHARS, Math.floor(contextCharBudget * MEMORY_BUDGET_RATIO))
}

export function memoryItemChars(item: MemoryItem): number {
  return item.content.length + MEMORY_ITEM_OVERHEAD_CHARS
}

// Pinned items first, then found items by score. Each part stops at its first item that does not
// fit, so what is dropped is always the oldest pinned items and the lowest-scoring found ones; a
// pinned item that is dropped does not keep the found items from using the room that is left.
export function fitMemoryBudget(pinned: MemoryItem[], retrieved: MemoryItem[], budget: number): MemoryItem[] {
  const kept: MemoryItem[] = []
  let remaining = budget
  for (const part of [pinned, retrieved]) {
    for (const item of part) {
      const cost = memoryItemChars(item)
      if (cost > remaining) break
      kept.push(item)
      remaining -= cost
    }
  }
  return kept
}

// The items to send to `role` for this request: its visible pinned items, then the visible items
// that match `query`, within the budget. Empty when there is nothing to send.
export function selectMemoryItems(input: MemorySelectionInput): MemoryItem[] {
  const visible = visibleMemoryItems(input.store, input.chat, input.role, input.mode ?? memoryModeForChat(input.chat))
  if (visible.length === 0) return []
  const pinned = pinnedMemoryItems(visible)
  const retrieved = searchMemoryItems(visible.filter(item => !item.pinned), input.query).map(match => match.item)
  return fitMemoryBudget(pinned, retrieved, memoryCharBudget(contextCharBudgetForRole(input.store, input.role)))
}

function isLongWord(token: string): boolean {
  return !CJK_CHAR.test(token) && LETTER.test(token) && [...token].length >= LONG_WORD_CHARS
}
