import type { ChatSite, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore } from './types'

export type ComparedReplyStatus = 'replied' | 'replying' | 'failed' | 'waiting'

export interface ComparedReply {
  roleId: string
  roleName: string
  role?: GroupRole
  // The latest reply this person gave to the question, if any.
  message?: GroupMessage
  status: ComparedReplyStatus
}

export interface ReplyComparison {
  question: GroupMessage
  replies: ComparedReply[]
}

// How many people have answered each question with some content, keyed by question id.
export function countRepliesByQuestion(messages: GroupMessage[]): Map<string, number> {
  const repliedRoles = new Map<string, Set<string>>()
  for (const message of messages) {
    if (message.type !== 'assistant' || !message.sourceMessageId || !message.roleId || !message.content.trim()) continue
    if (message.status === 'error') continue
    const roles = repliedRoles.get(message.sourceMessageId) ?? new Set<string>()
    roles.add(message.roleId)
    repliedRoles.set(message.sourceMessageId, roles)
  }
  return new Map([...repliedRoles].map(([questionId, roles]) => [questionId, roles.size]))
}

// Everyone the question went to, in the order it was addressed, with their latest reply.
export function collectReplies(store: OpenTeamStore, question: GroupMessage): ReplyComparison {
  const chat = store.chatsById[question.chatId]
  const latestByRole = new Map<string, GroupMessage>()
  for (const messageId of chat?.messageIds ?? []) {
    const message = store.messagesById[messageId]
    if (!message || message.type !== 'assistant' || message.sourceMessageId !== question.id || !message.roleId) continue
    const previous = latestByRole.get(message.roleId)
    if (!previous || message.seq >= previous.seq) latestByRole.set(message.roleId, message)
  }

  const roleIds = [...new Set([...(question.targetRoleIds ?? []), ...latestByRole.keys()])]
  const replies = roleIds.map((roleId): ComparedReply => {
    const role = store.rolesById[roleId]
    const message = latestByRole.get(roleId)
    return {
      roleId,
      roleName: role?.name ?? message?.roleName ?? roleId,
      ...(role ? { role } : {}),
      ...(message ? { message } : {}),
      status: replyStatus(message, question.deliveryStatus?.[roleId]),
    }
  })
  return { question, replies }
}

function replyStatus(message: GroupMessage | undefined, delivery: GroupMessage['status'] | undefined): ComparedReplyStatus {
  if (message?.status === 'error') return 'failed'
  if (message?.status === 'pending') return 'replying'
  if (message && message.content.trim()) return 'replied'
  return delivery === 'error' ? 'failed' : 'waiting'
}

// The question and every answer as one Markdown document: copied as is, or attached when asking
// someone to summarize where the answers agree and differ.
export function formatComparisonDocument(comparison: ReplyComparison, language: OpenTeamLanguage, describeRole: (reply: ComparedReply) => string): string {
  const english = language === 'en'
  const sections = [
    `# ${english ? 'Question' : '问题'}`,
    comparison.question.content.trim(),
  ]
  for (const reply of comparison.replies) {
    if (reply.status !== 'replied' || !reply.message) continue
    sections.push(`## ${describeRole(reply)}`, reply.message.content.trim())
  }
  return sections.join('\n\n')
}

export function comparisonSummaryRequest(fileName: string, language: OpenTeamLanguage): string {
  return language === 'en'
    ? `The attached ${fileName} has several people's answers to the same question. Compare them: 1. what they agree on; 2. where they disagree, and who holds which view; 3. points only one of them makes; 4. facts or figures that should be checked, including claims they all agree on but none backs with a source. Do not repeat the answers.`
    : `附件 ${fileName} 是几位人员对同一个问题的回答。请对比它们：1. 共识；2. 分歧，以及各自持什么观点；3. 只有某一位提到的观点；4. 需要进一步核实的事实或数据，包括大家都同意、但没有人给出来源的说法。不要复述原文。`
}

// Asks the people who answered to take on each other's answers, but only where they disagree, so a
// second round settles the differences instead of repeating the first.
export function comparisonDiscussionRequest(fileName: string, language: OpenTeamLanguage): string {
  return language === 'en'
    ? `The attached ${fileName} has everyone's answers to the same question, yours included. Respond only to the points where you disagree with someone else: say whose claim you dispute, why, and what evidence would settle it. If another answer has convinced you, say which view you are changing. Skip the points you agree on.`
    : `附件 ${fileName} 是大家对同一个问题的回答，也包括你自己的。请只针对和别人观点不同的地方回应：指出你不同意谁的哪个说法、理由是什么、用什么证据可以判断谁对。如果被别人的回答说服了，请直接说明你改变了哪些看法。观点一致的地方不用重复。`
}

// Who should summarize, so the summary does not lean toward one of the answers: someone who did not
// answer and is on a model none of the answers came from, then anyone who did not answer, then
// anyone ready.
export function pickSummarizer(roles: GroupRole[], comparison: ReplyComparison, defaultChatSite: ChatSite): GroupRole | undefined {
  const answered = comparison.replies.filter(reply => reply.status === 'replied')
  const answerers = new Set(answered.map(reply => reply.roleId))
  const answerModels = new Set(answered.flatMap(reply => reply.role ? [modelKey(reply.role, defaultChatSite)] : []))
  const ready = roles.filter(role => role.status === 'ready')
  const outsiders = ready.filter(role => !answerers.has(role.id))
  return outsiders.find(role => !answerModels.has(modelKey(role, defaultChatSite)))
    ?? outsiders[0]
    ?? ready[0]
    ?? roles[0]
}

export function hasAnswered(comparison: ReplyComparison, roleId: string | undefined): boolean {
  return comparison.replies.some(reply => reply.roleId === roleId && reply.status === 'replied')
}

function modelKey(role: GroupRole, defaultChatSite: ChatSite): string {
  return role.modelSource === 'external' ? `external:${role.externalModelId ?? ''}` : `site:${role.chatSite ?? defaultChatSite}`
}
