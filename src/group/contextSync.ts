import { normalizeLanguage } from '../shared/i18n'
import { sharedWithRole } from './chatMode'
import { describeAttachments } from './messageUploads'
import { isFailedReply, isOpenTeamRequest, isRoundSummaryMessage } from './roundSummary'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamLanguage } from './types'

export interface UnsyncedContextResult {
  messages: GroupMessage[]
  contextText: string
  omittedEarlyContext: boolean
  latestSeq: number
}

export function getUnsyncedMessagesForRole(
  chat: GroupChat,
  role: GroupRole,
  messages: GroupMessage[],
  userMessage: GroupMessage,
): GroupMessage[] {
  const messageById = new Map(messages.map(message => [message.id, message]))

  return chat.messageIds
    .map(messageId => messageById.get(messageId))
    .filter((message): message is GroupMessage => Boolean(message))
    // The member's own answers are in its site conversation already, except those its backup model
    // wrote while the site could not take prompts (memberBackup.ts): the site is told about those.
    .filter(message => message.seq > role.contextCursor && message.id !== userMessage.id && (message.roleId !== role.id || Boolean(message.answeredByFallback)))
    .filter(message => isMessageVisibleToRole(message, role.id))
    // A group made 协作 later does not share what its members said before (chatMode.ts).
    .filter(message => sharedWithRole(chat, role.id, message))
    // Round summaries are for the user; they repeat what members already said. Discussion turn
    // requests are OpenTeam's own instructions.
    .filter(message => !isRoundSummaryMessage(message, id => messageById.get(id)) && !isOpenTeamRequest(message) && !isFailedReply(message))
    .filter(message => Boolean(message.content.trim()))
}

export function buildUnsyncedContext(
  chat: GroupChat,
  role: GroupRole,
  messages: GroupMessage[],
  userMessage: GroupMessage,
  maxContextChars = 6000,
  languageInput?: OpenTeamLanguage,
): UnsyncedContextResult {
  const unsyncedMessages = getUnsyncedMessagesForRole(chat, role, messages, userMessage)
  const formatted = unsyncedMessages.map(message => formatContextMessage(message, languageInput, role.id)).join('\n\n')
  const truncated = truncateLatest(formatted, maxContextChars)

  return {
    messages: unsyncedMessages,
    contextText: truncated.text,
    omittedEarlyContext: truncated.omitted,
    latestSeq: getLatestMessageSeq(chat, messages),
  }
}

export function getLatestMessageSeq(chat: GroupChat, messages: GroupMessage[]): number {
  const messageById = new Map(messages.map(message => [message.id, message]))
  return chat.messageIds.reduce((latest, messageId) => {
    const message = messageById.get(messageId)
    return message ? Math.max(latest, message.seq) : latest
  }, 0)
}

export function getContextCursorAfterAck(chat: GroupChat, messages?: GroupMessage[]): number {
  return messages ? getLatestMessageSeq(chat, messages) : chat.nextMessageSeq - 1
}

// `selfRoleId`: the member the context is for. Its own answers there are the ones its backup model
// wrote for it, and are said to be.
export function formatContextMessage(message: GroupMessage, languageInput?: OpenTeamLanguage, selfRoleId?: string): string {
  const language = normalizeLanguage(languageInput)
  const backupNote = language === 'en'
    ? `You (answered for you by the backup model "${message.answeredByFallback ?? ''}" while your page could not take messages)`
    : `你（网页接不了消息时，由备用模型「${message.answeredByFallback ?? ''}」代你回答）`
  const speaker = selfRoleId && message.roleId === selfRoleId
    ? backupNote
    : message.type === 'assistant'
      ? message.roleName ?? (language === 'en' ? 'Person' : '人员')
      : message.type === 'user'
        ? (language === 'en' ? 'User' : '用户')
        : (language === 'en' ? 'System' : '系统')
  return `${speaker}${language === 'en' ? ': ' : '：'}${message.content}${describeAttachments(message.attachments, language)}`
}

function isMessageVisibleToRole(message: GroupMessage, roleId: string): boolean {
  if (message.type !== 'user') return true
  if (!message.targetRoleIds?.length) return true
  return message.targetRoleIds.includes(roleId)
}

function truncateLatest(text: string, maxChars: number): { text: string; omitted: boolean } {
  if (maxChars <= 0) return { text: '', omitted: text.length > 0 }
  if (text.length <= maxChars) return { text, omitted: false }
  return { text: text.slice(text.length - maxChars).trimStart(), omitted: true }
}
