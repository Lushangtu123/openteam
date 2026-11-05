import type { GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore } from './types'

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
    ? `The attached ${fileName} has several people's answers to the same question. Compare them: 1. what they agree on; 2. where they disagree, and who holds which view; 3. points only one of them makes; 4. facts or figures that should be checked. Do not repeat the answers.`
    : `附件 ${fileName} 是几位人员对同一个问题的回答。请对比它们：1. 共识；2. 分歧，以及各自持什么观点；3. 只有某一位提到的观点；4. 需要进一步核实的事实或数据。不要复述原文。`
}
