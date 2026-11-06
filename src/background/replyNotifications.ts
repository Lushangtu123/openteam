import { discussionTranscript } from '../group/discussion'
import type { OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'

// A desktop notification when every member a message went to has answered (or failed), while the
// OpenTeam tab is not in front. Clicking it brings that tab and group back.

export interface AnsweredPrompt {
  chatId: string
  chatName: string
  messageId: string
  repliedNames: string[]
  failedNames: string[]
}

// The message, once each member it went to has replied or failed; undefined while any is still due.
export function findAnsweredPrompt(store: OpenTeamStore, chatId: string, messageId: string): AnsweredPrompt | undefined {
  const chat = store.chatsById[chatId]
  const message = store.messagesById[messageId]
  if (!chat || !message || message.type !== 'user' || message.chatId !== chatId) return undefined
  // A round's summary and a discussion turn are not questions the user asked.
  if (message.roundSummaryOf || message.discussionTurnOf) return undefined
  // A discussion is answered once it has finished.
  if (message.discussionTopic) {
    if (chat.discussion?.topicMessageId === messageId && chat.discussion.status === 'running') return undefined
    const speakers = new Set(discussionTranscript(store, chat, messageId).flatMap(entry => entry.kind === 'turn' && entry.message.roleId ? [entry.message.roleId] : []))
    if (speakers.size === 0) return undefined
    return { chatId, chatName: chat.name, messageId, repliedNames: [...speakers].map(roleId => store.rolesById[roleId]?.name ?? roleId), failedNames: [] }
  }
  const statuses = Object.entries(message.deliveryStatus ?? {})
  if (statuses.length === 0 || statuses.some(([, status]) => status !== 'received' && status !== 'error')) return undefined
  const nameOf = (roleId: string) => store.rolesById[roleId]?.name ?? roleId
  return {
    chatId,
    chatName: chat.name,
    messageId,
    repliedNames: statuses.filter(([, status]) => status === 'received').map(([roleId]) => nameOf(roleId)),
    failedNames: statuses.filter(([, status]) => status === 'error').map(([roleId]) => nameOf(roleId)),
  }
}

export function replyNotificationText(answered: AnsweredPrompt, language: unknown): { title: string; message: string } {
  const en = normalizeLanguage(language) === 'en'
  const join = (names: string[]) => names.join(en ? ', ' : '、')
  const parts: string[] = []
  if (answered.repliedNames.length) parts.push(en ? `${join(answered.repliedNames)} replied` : `${join(answered.repliedNames)} 已回复`)
  if (answered.failedNames.length) parts.push(en ? `${join(answered.failedNames)} could not reply` : `${join(answered.failedNames)} 没有回复成功`)
  return {
    title: en ? `All replies are in: ${answered.chatName}` : `「${answered.chatName}」的回复都到了`,
    message: parts.join(en ? '; ' : '；'),
  }
}

export interface ReplyNotifierDependencies {
  create(id: string, options: { type: 'basic'; iconUrl: string; title: string; message: string }): Promise<unknown>
  // True when an OpenTeam tab is the active tab of a focused window, so the user can see the chat.
  isTeamPageInView(): Promise<boolean>
  iconUrl: string
  log: { warn(event: string, details?: Record<string, unknown>): void }
}

export const REPLY_NOTIFICATION_PREFIX = 'openteam-replies:'

export function createReplyNotifier(deps: ReplyNotifierDependencies) {
  const notified = new Set<string>()
  return {
    async notify(store: OpenTeamStore, chatId: string, messageId: string): Promise<boolean> {
      if (store.settings.replyNotifications === false || notified.has(messageId)) return false
      const answered = findAnsweredPrompt(store, chatId, messageId)
      if (!answered) return false
      notified.add(messageId)
      if (await deps.isTeamPageInView()) return false
      const text = replyNotificationText(answered, store.settings.language)
      try {
        await deps.create(`${REPLY_NOTIFICATION_PREFIX}${chatId}:${messageId}`, { type: 'basic', iconUrl: deps.iconUrl, ...text })
        return true
      } catch (error) {
        deps.log.warn('reply-notification:failed', { error: error instanceof Error ? error.message : String(error) })
        return false
      }
    },
  }
}

// The group a clicked notification belongs to.
export function chatIdFromNotificationId(notificationId: string): string | undefined {
  if (!notificationId.startsWith(REPLY_NOTIFICATION_PREFIX)) return undefined
  return notificationId.slice(REPLY_NOTIFICATION_PREFIX.length).split(':')[0] || undefined
}
