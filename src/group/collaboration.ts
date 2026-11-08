// How the members of a 协作 group work together on a message to several of them (CollaborationStyle),
// and the review step of 互相审: once everyone has answered, each member reads the others' answers,
// says what it agrees with, disputes or finds missing, and revises its own.
import { PROMPT_I18N, normalizeLanguage } from '../shared/i18n'
import { describeAttachments } from './messageUploads'
import { ROUND_SUMMARY_MAX_REPLY_CHARS, trimRoundReply, type SummarizableRound } from './roundSummary'
import type { CollaborationStyle, GroupChat, GroupMessage, GroupRole, NewChatCollaboration, OpenTeamLanguage, OpenTeamSettings } from './types'

const COLLABORATION_STYLES: readonly CollaborationStyle[] = ['review', 'turns', 'parallel']

// What a new group starts with until the user picks otherwise: everyone answers and then reviews
// the others' answers, and a message without @ goes to every member.
export const DEFAULT_NEW_CHAT_COLLABORATION: NewChatCollaboration = { style: 'review', replyAll: true }

export function isCollaborationStyle(value: unknown): value is CollaborationStyle {
  return COLLABORATION_STYLES.includes(value as CollaborationStyle)
}

export function readNewChatCollaboration(value: unknown): NewChatCollaboration | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!isCollaborationStyle(record.style)) return undefined
  return { style: record.style, replyAll: record.replyAll === true }
}

// What the next new group is offered: the last choice, or the default.
export function newChatCollaboration(settings: Pick<OpenTeamSettings, 'newChatCollaboration'>): NewChatCollaboration {
  return settings.newChatCollaboration ?? DEFAULT_NEW_CHAT_COLLABORATION
}

export function collaborationStyleOf(chat: Pick<GroupChat, 'crossReview' | 'discussionMode'> | undefined): CollaborationStyle {
  if (chat?.discussionMode) return 'turns'
  if (chat?.crossReview) return 'review'
  return 'parallel'
}

// Sets a group's style; its two flags are never both on.
export function applyCollaborationStyle(chat: GroupChat, style: CollaborationStyle): void {
  if (style === 'turns') chat.discussionMode = true
  else delete chat.discussionMode
  if (style === 'review') chat.crossReview = true
  else delete chat.crossReview
}

// A message that gets a review round once everyone it went to has answered: the user's own message
// to two or more members of a 互相审 group. Not OpenTeam's requests, a discussion, a project, a team's
// invitations or an orchestration step.
export function wantsCrossReview(chat: GroupChat, message: GroupMessage | undefined): boolean {
  if (!message || message.type !== 'user' || chat.mode !== 'collaborative' || !chat.crossReview || chat.discussionMode) return false
  if (message.crossReviewOf || message.roundSummaryOf || message.discussionTurnOf || message.discussionTopic || message.discussionNoteOf) return false
  if (message.projectRequest || message.projectGoal || message.projectNoteOf || message.orchestrationKind) return false
  if (chat.teamFormation?.invitationIds.includes(message.id)) return false
  return (message.targetRoleIds?.length ?? 0) >= 2
}

export function crossReviewRequestText(languageInput: OpenTeamLanguage | undefined): string {
  return normalizeLanguage(languageInput) === 'en' ? "Review each other's answers" : '互相审阅上一轮的回答'
}

// What one member is asked in the review round: the question, its own answer, the others' answers,
// and a reply that agrees, disputes, adds what is missing and gives its revised plan.
export function buildCrossReviewPrompt(input: {
  round: SummarizableRound
  reviewer: GroupRole
  language?: OpenTeamLanguage
  maxReplyChars?: number
}): string {
  const language = normalizeLanguage(input.language)
  const en = language === 'en'
  const { question, replies } = input.round
  const budget = Math.min(input.maxReplyChars ?? ROUND_SUMMARY_MAX_REPLY_CHARS, ROUND_SUMMARY_MAX_REPLY_CHARS)
  const share = Math.max(600, Math.floor(budget / Math.max(1, replies.length)))
  const own = replies.find(reply => reply.role.id === input.reviewer.id)
  const others = replies.filter(reply => reply.role.id !== input.reviewer.id)
  const label = (name: string) => en ? `[${name}]` : `【${name}】`
  const questionText = `${question.content}${describeAttachments(question.attachments, language)}`.trim()

  return [
    en
      ? `You are "${input.reviewer.name}". Everyone has answered the user's question. Now read the other members' answers and review them.`
      : `你是「${input.reviewer.name}」。大家刚才都回答了用户的问题，现在请你看看其他成员的回答，互相审一审。`,
    `${en ? "The user's question:" : '用户的问题：'}\n${questionText}`,
    ...(own ? [`${en ? 'Your answer:' : '你刚才的回答：'}\n${trimRoundReply(own.message.content, share, en)}`] : []),
    `${en ? "The other members' answers:" : '其他成员的回答：'}\n\n${others.map(({ role, message }) => `${label(role.name)}\n${trimRoundReply(message.content, share, en)}`).join('\n\n')}`,
    en
      ? [
          'Reply in this format:',
          '**Agree**',
          '- what others got right (name the member)',
          '**Disagree or concerned**',
          '- what you dispute or see a risk in, and why (name the member)',
          '**Missing**',
          '- what nobody has covered but should be considered',
          '**Revised plan**',
          '- your plan or conclusion now, taking the others into account; say what you changed',
          `Be concise and do not repeat what others already said. ${PROMPT_I18N.en.responseLanguageInstruction}`,
        ].join('\n')
      : [
          '请按下面的格式回复：',
          '**同意**',
          '- 别人说得对、你认同的地方（写明是谁的）',
          '**反对或担心**',
          '- 你不同意或觉得有风险的地方，以及理由（写明是谁的）',
          '**遗漏**',
          '- 大家都没想到、但应该考虑的',
          '**修正后的方案**',
          '- 结合大家的意见，你现在的方案或结论；有改动就说明改了什么',
          `简洁，不要重复别人已经说过的内容。${PROMPT_I18N['zh-CN'].responseLanguageInstruction}`,
        ].join('\n'),
  ].join('\n\n')
}
