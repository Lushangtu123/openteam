// Making a round of replies easier to read: members start long replies with a few key points, and
// once everyone in a round has answered, one member writes a short summary of the round.
import { PROMPT_I18N, normalizeLanguage } from '../shared/i18n'
import { describeAttachments } from './messageUploads'
import { discussionTranscript } from './discussion'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamSettings, OpenTeamStore } from './types'

// Key points

const KEY_POINTS_HEADINGS = new Set(['要点', '核心要点', '关键要点', '摘要', 'key points', 'key takeaways', 'tl;dr', 'tldr'])

// The heading of a key-points block, as the reply's first line reads once rendered ("要点", "要点：",
// "Key points:").
export function isKeyPointsHeading(text: string): boolean {
  const normalized = text.trim().replace(/[:：]$/, '').trim().toLowerCase()
  return KEY_POINTS_HEADINGS.has(normalized)
}

export function keyPointsInstruction(languageInput: OpenTeamLanguage | undefined): string {
  return normalizeLanguage(languageInput) === 'en'
    ? 'Start your reply with a line "**Key points**" followed by 1–3 short bullet points with your main conclusions (each under 25 words). Then leave a blank line and give the details.'
    : '回复开头先单独写一行「**要点**」，下面用 1–3 条短句列出你的核心结论（每条不超过 40 字），空一行后再写详细内容。'
}

// Members are asked for key points when a message goes to two or more of them, so the round is
// easy to scan. Orchestration steps, team invitations and summary requests keep their own formats.
export function wantsKeyPoints(settings: Pick<OpenTeamSettings, 'replyKeyPoints'>, chat: GroupChat | undefined, message: GroupMessage): boolean {
  if (settings.replyKeyPoints === false) return false
  if (message.type !== 'user' || message.orchestrationKind || message.roundSummaryOf || message.crossReviewOf) return false
  if (chat?.teamFormation?.invitationIds.includes(message.id)) return false
  return (message.targetRoleIds?.length ?? 0) >= 2
}

// Round summaries

export interface RoundReply {
  role: GroupRole
  message: GroupMessage
  // In a discussion, the turn this reply was.
  turn?: number
}

export interface SummarizableRound {
  question: GroupMessage
  // The latest good reply of each member, in the order they arrived; in a discussion, every turn.
  replies: RoundReply[]
  discussion?: boolean
  // A review round (互相审): the user's message whose answers were reviewed.
  reviewOf?: GroupMessage
}

export const ROUND_SUMMARY_MIN_REPLIES = 2
// The replies quoted in a summary request, at most; each gets an equal share.
export const ROUND_SUMMARY_MAX_REPLY_CHARS = 60_000

export function isRoundSummaryRequest(message: GroupMessage | undefined): boolean {
  return message?.type === 'user' && Boolean(message.roundSummaryOf)
}

// What OpenTeam itself asks members (a summary, a discussion turn, a project step, a review round);
// members do not get these as context, and the user did not write them.
export function isOpenTeamRequest(message: GroupMessage | undefined): boolean {
  return message?.type === 'user' && Boolean(message.roundSummaryOf || message.discussionTurnOf || message.projectRequest || message.crossReviewOf)
}

// A summary request, or the summary written in answer to one.
export function isRoundSummaryMessage(message: GroupMessage, messageById: (id: string) => GroupMessage | undefined): boolean {
  if (isRoundSummaryRequest(message)) return true
  return message.type === 'assistant' && Boolean(message.sourceMessageId) && isRoundSummaryRequest(messageById(message.sourceMessageId!))
}

// The round a message started, once every member it went to is done and at least two answered.
export function readSummarizableRound(store: OpenTeamStore, chat: GroupChat, question: GroupMessage | undefined): SummarizableRound | undefined {
  if (!question || question.chatId !== chat.id || question.type !== 'user') return undefined
  if (question.discussionTopic) return readSummarizableDiscussion(store, chat, question)
  if (question.roundSummaryOf || question.orchestrationKind || chat.teamFormation?.invitationIds.includes(question.id)) return undefined
  const statuses = Object.values(question.deliveryStatus ?? {})
  if (statuses.some(status => status !== 'received' && status !== 'error')) return undefined

  const latestByRole = new Map<string, GroupMessage>()
  for (const id of chat.messageIds) {
    const message = store.messagesById[id]
    if (!message || message.type !== 'assistant' || message.sourceMessageId !== question.id || !message.roleId) continue
    if (message.status !== 'received' || !message.content.trim()) continue
    const previous = latestByRole.get(message.roleId)
    if (!previous || message.seq > previous.seq) latestByRole.set(message.roleId, message)
  }
  const replies = [...latestByRole.values()]
    .sort((left, right) => left.seq - right.seq)
    .flatMap(message => {
      const role = store.rolesById[message.roleId!]
      return role ? [{ role, message }] : []
    })
  const reviewOf = question.crossReviewOf ? store.messagesById[question.crossReviewOf] : undefined
  return replies.length >= ROUND_SUMMARY_MIN_REPLIES ? { question, replies, ...(reviewOf ? { reviewOf } : {}) } : undefined
}

// A discussion is summarized once it has stopped, with every turn in order.
function readSummarizableDiscussion(store: OpenTeamStore, chat: GroupChat, topic: GroupMessage): SummarizableRound | undefined {
  if (chat.discussion?.topicMessageId === topic.id && chat.discussion.status === 'running') return undefined
  const replies = discussionTranscript(store, chat, topic.id).flatMap(entry => {
    const role = entry.kind === 'turn' && entry.message.roleId ? store.rolesById[entry.message.roleId] : undefined
    return role ? [{ role, message: entry.message, turn: entry.turn }] : []
  })
  return replies.length >= ROUND_SUMMARY_MIN_REPLIES ? { question: topic, replies, discussion: true } : undefined
}

// True when the round has a summary asked for after its latest reply (a reply retried, or a
// discussion continued, makes the old summary out of date).
export function hasRoundSummary(store: OpenTeamStore, chat: GroupChat, questionId: string): boolean {
  let latestRequestSeq = -1
  let latestReplySeq = -1
  for (const id of chat.messageIds) {
    const message = store.messagesById[id]
    if (!message) continue
    if (message.roundSummaryOf === questionId) latestRequestSeq = Math.max(latestRequestSeq, message.seq)
    else if (message.type === 'assistant' && message.sourceMessageId && (message.sourceMessageId === questionId || store.messagesById[message.sourceMessageId]?.discussionTurnOf === questionId)) {
      latestReplySeq = Math.max(latestReplySeq, message.seq)
    }
  }
  return latestRequestSeq >= 0 && latestRequestSeq > latestReplySeq
}

// Who writes the summary: an API member if there is one (quick, and its page holds no
// conversation), then whoever answered first in the round, then anyone else who is free.
export function pickSummarizer(roles: GroupRole[], round: SummarizableRound, isAvailable: (role: GroupRole) => boolean): GroupRole | undefined {
  const available = roles.filter(isAvailable)
  const api = available.find(role => role.modelSource === 'external')
  if (api) return api
  for (const reply of round.replies) {
    const role = available.find(candidate => candidate.id === reply.role.id)
    if (role) return role
  }
  return available[0]
}

export function roundSummaryRequestText(languageInput: OpenTeamLanguage | undefined): string {
  return normalizeLanguage(languageInput) === 'en' ? 'Summarize this round' : '汇总本轮回复'
}

export function buildRoundSummaryPrompt(input: {
  round: SummarizableRound
  summarizer: GroupRole
  language?: OpenTeamLanguage
  maxReplyChars?: number
}): string {
  const language = normalizeLanguage(input.language)
  const en = language === 'en'
  const { question, replies } = input.round
  const budget = Math.min(input.maxReplyChars ?? ROUND_SUMMARY_MAX_REPLY_CHARS, ROUND_SUMMARY_MAX_REPLY_CHARS)
  const share = Math.max(600, Math.floor(budget / Math.max(1, replies.length)))
  const label = (name: string, turn: number | undefined) => en
    ? `[${name}${turn ? `, turn ${turn}` : ''}]`
    : `【${name}${turn ? ` · 第 ${turn} 轮` : ''}】`
  const quoted = replies.map(({ role, message, turn }) => `${label(role.name, turn)}\n${trimRoundReply(message.content, share, en)}`)
  // A review round is summarized against the user's question it reviewed.
  const asked = input.round.reviewOf ?? question
  const questionText = `${asked.content}${describeAttachments(asked.attachments, language)}`.trim()

  return [
    en ? `You are "${input.summarizer.name}". This time, act as the summarizer of this round of the group discussion.` : `你是「${input.summarizer.name}」，这次请你担任本轮讨论的汇总人。`,
    `${en ? "The user's question:" : '用户的问题：'}\n${questionText}`,
    input.round.discussion
      ? `${en ? 'The discussion, turn by turn:' : '讨论中的发言（按顺序）：'}\n\n${quoted.join('\n\n')}`
      : input.round.reviewOf
        ? `${en ? "Each member's review of the others' answers, with its revised plan:" : '各成员看过彼此的回答后的意见，以及修正后的方案：'}\n\n${quoted.join('\n\n')}`
        : `${en ? "The members' replies:" : '各成员的回复：'}\n\n${quoted.join('\n\n')}`,
    en
      ? [
          'Summarize these replies so the user can see at a glance where things stand (under 200 words), in this format:',
          '**Agreed**',
          '- conclusions everyone shares',
          '**Disagreements**',
          '- who holds which view (write "No clear disagreement" if there is none)',
          '**Open questions**',
          '- what is still unanswered or needs the user to decide (write "None" if there is none)',
          '**Suggested next step**',
          '- one or two concrete suggestions',
          `Summarize only what the replies say; add no new views, and name the member behind each view. ${PROMPT_I18N.en.responseLanguageInstruction}`,
        ].join('\n')
      : [
          '请把以上回复整理成一份简短的汇总，帮用户一眼看清现状（不超过 300 字），格式如下：',
          '**共识**',
          '- 大家都同意的结论',
          '**分歧**',
          '- 谁持什么观点（没有分歧就写「无明显分歧」）',
          '**待定问题**',
          '- 还没有答案、或需要用户决定的事（没有就写「无」）',
          '**建议下一步**',
          '- 一到两条具体建议',
          `只根据以上回复汇总，不要加入新的观点；提到观点时写明是哪位成员的。${PROMPT_I18N['zh-CN'].responseLanguageInstruction}`,
        ].join('\n'),
  ].join('\n\n')
}

export function trimRoundReply(content: string, maxChars: number, en: boolean): string {
  const text = content.trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n${en ? '[…the rest of this reply is omitted]' : '［……其余部分已省略］'}`
}
