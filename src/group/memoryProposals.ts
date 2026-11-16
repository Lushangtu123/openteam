// Memory a member proposes at the end of its reply (docs/MEMORY_STORE.zh-CN.md, section 6, second
// stage). Off unless the user switches it on. With it on, a prompt that carries memory also says
// how to propose; the lines a reply ends with are taken off the reply and kept beside it, for the
// user to save or dismiss. Nothing is saved without the user: a proposal is not a memory item, is
// in no prompt, and is not part of the reply other members read.
import { normalizeLanguage } from '../shared/i18n'
import { wantsMemory } from './memoryPrompt'
import { MAX_MEMORY_CONTENT_CHARS, listMemoryItems, memoryContentLength } from './memoryStore'
import type { GroupChat, GroupMessage, MemoryKind, MemoryProposal, OpenTeamLanguage, OpenTeamSettings, OpenTeamStore } from './types'

export const MAX_MEMORY_PROPOSALS = 3

const KIND_WORDS: Record<string, MemoryKind> = {
  事实: 'fact', fact: 'fact',
  决定: 'decision', 决策: 'decision', decision: 'decision',
  偏好: 'preference', preference: 'preference',
  备注: 'note', note: 'note',
}

// "记忆提议（事实）：……", also as models and sites' markdown vary it: a list marker or bold around
// it, square or full-width brackets (escaped or not), the kind after the colon, "Memory proposal".
const KIND = String.raw`\\?[\[(（【]\s*([^\])）】\\]{1,12}?)\s*\\?[\])）】]`
const PROPOSAL_LINE = new RegExp(String.raw`^\s*(?:[-*+>]\s+)?(?:\*\*|__)?\s*(?:记忆提议|memory proposal)\s*(?:${KIND})?\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(?:${KIND}\s*)?(.+?)\s*$`, 'i')

// Whether this request's prompt says how to propose, and its reply is read for proposals.
export function wantsMemoryProposals(settings: Pick<OpenTeamSettings, 'memoryProposals'>, chat: GroupChat, message: GroupMessage): boolean {
  return settings.memoryProposals === true && wantsMemory(chat, message)
}

export function memoryProposalInstruction(languageInput: OpenTeamLanguage | undefined): string {
  return normalizeLanguage(languageInput) === 'en'
    ? `If this reply reaches something worth keeping for later work (a fact, a decision, or a preference of the user's), you may end the reply with a line of its own: "Memory proposal (fact): one sentence". The kind is fact, decision, preference or note; at most ${MAX_MEMORY_PROPOSALS} such lines, each under 60 words. The user decides whether to save it. Do not propose what the memory store already holds, and write none when there is nothing worth keeping.`
    : `如果这次回复里有值得长期记住的内容（事实、决定，或用户的偏好），可以在回复的最后另起一行写「记忆提议（事实）：一句话内容」。类型写 事实、决定、偏好 或 备注；最多 ${MAX_MEMORY_PROPOSALS} 行，每行不超过 100 字。是否保存由用户决定。记忆库里已经有的不要再提；没有值得记的就不要写。`
}

export function withMemoryProposalInstruction(prompt: string, wanted: boolean, language: OpenTeamLanguage | undefined): string {
  return wanted ? `${prompt}\n\n${memoryProposalInstruction(language)}` : prompt
}

export interface ExtractedMemoryProposals {
  // The reply without the proposal lines.
  content: string
  proposals: Array<Pick<MemoryProposal, 'kind' | 'content'>>
}

// The proposal lines a reply ends with. Lines elsewhere in the reply, or inside a code block, are
// text. A reply that is nothing but proposals is left as it is.
export function extractMemoryProposals(content: string): ExtractedMemoryProposals {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const found: Array<Pick<MemoryProposal, 'kind' | 'content'>> = []
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end -= 1
  let start = end
  for (let index = end - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.trim()) continue
    const match = PROPOSAL_LINE.exec(line)
    if (!match) break
    start = index
    const text = stripMarkdown(match[3])
    const length = memoryContentLength(text)
    if (length > 0 && length <= MAX_MEMORY_CONTENT_CHARS) found.unshift({ kind: KIND_WORDS[(match[1] ?? match[2] ?? '').trim().toLowerCase()] ?? 'fact', content: text })
  }
  if (start === end) return { content, proposals: [] }
  const before = lines.slice(0, start)
  if (before.filter(line => /^\s*```/.test(line)).length % 2 === 1) return { content, proposals: [] }
  const body = before.join('\n').trimEnd()
  if (!body.trim()) return { content, proposals: [] }
  const seen = new Set<string>()
  const proposals = found.filter(proposal => !seen.has(proposal.content) && Boolean(seen.add(proposal.content))).slice(0, MAX_MEMORY_PROPOSALS)
  return { content: body, proposals }
}

// Takes the proposals off a finished reply and keeps them on the message, when the request it
// answers asked for them. What the store already holds word for word is not proposed again.
// Returns how many were kept.
export function takeMemoryProposals(store: OpenTeamStore, chat: GroupChat, reply: GroupMessage, newId: (prefix: string) => string): number {
  const request = reply.sourceMessageId ? store.messagesById[reply.sourceMessageId] : undefined
  delete reply.memoryProposals
  if (reply.type !== 'assistant' || !request || !wantsMemoryProposals(store.settings, chat, request)) return 0
  const extracted = extractMemoryProposals(reply.content)
  if (extracted.content === reply.content) return 0
  reply.content = extracted.content
  const known = new Set(listMemoryItems(store).map(item => item.content))
  const proposals = extracted.proposals.filter(proposal => !known.has(proposal.content)).map(proposal => ({ id: newId('proposal'), ...proposal }))
  if (proposals.length > 0) reply.memoryProposals = proposals
  return proposals.length
}

// Removes one proposal from its message, once the user saved or dismissed it.
export function resolveMemoryProposal(message: GroupMessage | undefined, proposalId: string): MemoryProposal | undefined {
  const proposal = message?.memoryProposals?.find(candidate => candidate.id === proposalId)
  if (!message || !proposal) return undefined
  const rest = message.memoryProposals?.filter(candidate => candidate.id !== proposalId) ?? []
  if (rest.length > 0) message.memoryProposals = rest
  else delete message.memoryProposals
  return proposal
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\\([\[\]()*_`])/g, '$1').trim()
}
