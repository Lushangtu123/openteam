// Turn-taking discussions: instead of every member answering at once, members speak one at a time,
// each seeing what was said before, for a set number of turns. A member can hand the next turn to
// another by @-mentioning them. When it ends, the discussion is summarized like a round.
import { PROMPT_I18N, normalizeLanguage } from '../shared/i18n'
import { formatAttachedFilesForPrompt } from './messageUploads'
import type { DiscussionRun, GroupChat, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore } from './types'

// Each member speaks this many times by default…
export const DISCUSSION_TURNS_PER_MEMBER = 2
// …and a discussion has at most this many turns (one "再讨论一轮" adds one turn per member).
export const DISCUSSION_MAX_TURNS = 12
// A discussion stops after this many turns in a row that got no reply.
export const DISCUSSION_MAX_FAILED_TURNS = 2
// What the turn prompt quotes of the discussion so far, at most; the oldest part is cut first.
export const DISCUSSION_MAX_TRANSCRIPT_CHARS = 30_000
// Each turn is asked to stay about this short.
export const DISCUSSION_TURN_MAX_CHARS = 200

export function discussionMaxTurns(participantCount: number, turnsPerMember = DISCUSSION_TURNS_PER_MEMBER): number {
  return Math.min(DISCUSSION_MAX_TURNS, Math.max(participantCount, participantCount * turnsPerMember))
}

// A message to two or more members of a 协作 group with 轮流讨论 on starts a discussion.
export function startsDiscussion(chat: GroupChat, targetRoleIds: string[]): boolean {
  return chat.mode === 'collaborative' && chat.discussionMode === true && targetRoleIds.length >= 2 && !isDiscussionRunning(chat)
}

export function isDiscussionRunning(chat: GroupChat | undefined): boolean {
  return chat?.discussion?.status === 'running'
}

export function isDiscussionTurnRequest(message: GroupMessage | undefined): boolean {
  return message?.type === 'user' && Boolean(message.discussionTurnOf)
}

// The member whose name follows an "@" first in a reply, other than the speaker. Names are matched
// longest first, so "@产品经理" is not taken for a member called 产品.
export function findHandoffMention(content: string, participants: GroupRole[], speakerId: string): GroupRole | undefined {
  const candidates = participants.filter(role => role.id !== speakerId && role.name.trim()).sort((left, right) => right.name.length - left.name.length)
  for (let index = content.indexOf('@'); index >= 0; index = content.indexOf('@', index + 1)) {
    const after = content.slice(index + 1).replace(/^\s+/, '')
    const role = candidates.find(candidate => after.startsWith(candidate.name))
    if (role) return role
  }
  return undefined
}

// Who speaks next: the member the last speaker @-mentioned, if they can; otherwise whoever has spoken
// least so far, the next in the speaking order winning a tie.
export function chooseNextSpeaker(input: {
  run: DiscussionRun
  roles: GroupRole[]
  turnCounts: Map<string, number>
  lastReply?: string
  isAvailable(role: GroupRole): boolean
}): { role: GroupRole; handoffFrom?: string } | undefined {
  const participants = input.run.roleIds.map(id => input.roles.find(role => role.id === id)).filter((role): role is GroupRole => Boolean(role))
  const current = input.run.currentRoleId
  if (input.lastReply && current) {
    const mentioned = findHandoffMention(input.lastReply, participants, current)
    if (mentioned && input.isAvailable(mentioned)) return { role: mentioned, handoffFrom: current }
  }
  const start = Math.max(0, participants.findIndex(role => role.id === current))
  const inOrderAfterCurrent = participants.map((_, offset) => participants[(start + 1 + offset) % participants.length])
  const others = inOrderAfterCurrent.filter(role => role.id !== current && input.isAvailable(role))
  const pool = others.length > 0 ? others : inOrderAfterCurrent.filter(role => input.isAvailable(role))
  let next: GroupRole | undefined
  for (const role of pool) {
    if (!next || (input.turnCounts.get(role.id) ?? 0) < (input.turnCounts.get(next.id) ?? 0)) next = role
  }
  return next ? { role: next } : undefined
}

export function discussionTurnRequestText(turn: number, maxTurns: number, roleName: string, handoffFromName: string | undefined, languageInput: OpenTeamLanguage | undefined): string {
  if (normalizeLanguage(languageInput) === 'en') {
    return handoffFromName
      ? `Turn ${turn}/${maxTurns}: ${handoffFromName} asked ${roleName} to speak`
      : `Turn ${turn}/${maxTurns}: ${roleName} speaks`
  }
  return handoffFromName
    ? `第 ${turn}/${maxTurns} 轮 · 「${handoffFromName}」请「${roleName}」接着说`
    : `第 ${turn}/${maxTurns} 轮 · 请「${roleName}」发言`
}

export interface DiscussionEntry {
  message: GroupMessage
  // A member's turn, or a note the user added while the discussion ran.
  kind: 'turn' | 'note'
  turn?: number
}

// What has been said since the topic: each member's turn, and the user's notes in between.
export function discussionTranscript(store: OpenTeamStore, chat: GroupChat, topicId: string): DiscussionEntry[] {
  const topic = store.messagesById[topicId]
  if (!topic) return []
  const entries: DiscussionEntry[] = []
  for (const id of chat.messageIds) {
    const message = store.messagesById[id]
    if (!message || message.seq <= topic.seq) continue
    if (message.type === 'user' && message.discussionNoteOf === topicId && message.content.trim()) {
      entries.push({ message, kind: 'note' })
      continue
    }
    if (message.type !== 'assistant' || !message.sourceMessageId || message.status !== 'received' || !message.content.trim()) continue
    const request = store.messagesById[message.sourceMessageId]
    if (request?.discussionTurnOf === topicId) entries.push({ message, kind: 'turn', turn: request.discussionTurn })
  }
  return entries
}

export function turnCountsOf(entries: DiscussionEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind === 'turn' && entry.message.roleId) counts.set(entry.message.roleId, (counts.get(entry.message.roleId) ?? 0) + 1)
  }
  return counts
}

export function buildDiscussionTurnPrompt(input: {
  store: OpenTeamStore
  chat: GroupChat
  request: GroupMessage
  role: GroupRole
  roles: GroupRole[]
  includePersona: boolean
  language?: OpenTeamLanguage
}): string {
  const language = normalizeLanguage(input.language)
  const en = language === 'en'
  const topic = input.store.messagesById[input.request.discussionTurnOf ?? '']
  if (!topic) throw new Error('找不到讨论的话题，可能已被删除')
  const run = input.chat.discussion
  const participants = (run?.roleIds ?? []).map(id => input.store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
  const others = participants.filter(role => role.id !== input.role.id).map(role => `@${role.name}`).join(en ? ', ' : '、')

  const transcript = discussionTranscript(input.store, input.chat, topic.id)
    .filter(entry => entry.message.seq < input.request.seq)
    .map(entry => entry.kind === 'note'
      ? `${en ? '[User adds]' : '【用户补充】'}\n${entry.message.content}`
      : `${en ? `[${entry.message.roleName ?? 'Member'}]` : `【${entry.message.roleName ?? '成员'}】`}\n${entry.message.content}`)
  const transcriptText = trimFromStart(transcript.join('\n\n'), DISCUSSION_MAX_TRANSCRIPT_CHARS, en)
  const turnLabel = `${input.request.discussionTurn ?? 1}/${run?.maxTurns ?? '?'}`

  return [
    en ? 'You are taking part in a turn-by-turn discussion in an AI group chat.' : '你正在一个 AI 群聊里参加轮流讨论。',
    `${en ? 'Members in this discussion:' : '参加讨论的成员：'}\n${participants.map(role => `- ${role.name}${role.description ? `${en ? ': ' : '：'}${role.description}` : ''}`).join('\n')}`,
    en ? `Your identity is "${input.role.name}".` : `你的身份是「${input.role.name}」。`,
    input.role.description ? `${en ? 'Your responsibility:' : '你的职责：'}\n${input.role.description}` : '',
    input.includePersona && input.role.systemPrompt ? `${en ? 'Persona:' : '人设：'}\n${input.role.systemPrompt}` : '',
    `${en ? 'The topic (from the user):' : '讨论的话题（用户提出）：'}\n${topic.content}`,
    formatAttachedFilesForPrompt(topic, language),
    transcriptText
      ? `${en ? 'What has been said so far:' : '目前的发言：'}\n\n${transcriptText}`
      : (en ? 'Nobody has spoken yet; you open the discussion.' : '还没有人发言，由你开场。'),
    en
      ? `It is your turn (turn ${turnLabel}). Respond to what was said: what you agree with, what you disagree with, and what is missing; do not repeat points already made. Keep it short, under ${DISCUSSION_TURN_MAX_CHARS} words. If you want a particular member to answer next, @-mention them in your reply (${others}). ${PROMPT_I18N.en.responseLanguageInstruction}`
      : `现在轮到你发言（第 ${turnLabel} 轮）。请直接回应前面的发言：同意什么、反对什么、还缺什么，不要重复别人说过的。发言简洁，不超过 ${DISCUSSION_TURN_MAX_CHARS} 字。如果想请某位成员接着回应，在发言里 @TA 的名字（${others}）。${PROMPT_I18N['zh-CN'].responseLanguageInstruction}`,
  ].filter(section => section.trim()).join('\n\n')
}

function trimFromStart(text: string, maxChars: number, en: boolean): string {
  if (text.length <= maxChars) return text
  return `${en ? '[Earlier turns omitted]' : '［更早的发言已省略］'}\n${text.slice(text.length - maxChars).trimStart()}`
}
