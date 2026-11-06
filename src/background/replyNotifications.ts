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
  // For a project: the point that needs the user, or its end.
  projectStage?: 'awaiting-approval' | 'waiting-user' | 'done' | 'stopped'
  projectQuestion?: string
}

// The message, once each member it went to has replied or failed; undefined while any is still due.
export function findAnsweredPrompt(store: OpenTeamStore, chatId: string, messageId: string): AnsweredPrompt | undefined {
  const chat = store.chatsById[chatId]
  const message = store.messagesById[messageId]
  if (!chat || !message || message.type !== 'user' || message.chatId !== chatId) return undefined
  // A round's summary and a discussion turn are not questions the user asked.
  if (message.roundSummaryOf || message.discussionTurnOf) return undefined
  // A project tells the user when its plan is ready, when it has a question, and when it ends.
  if (message.projectGoal) {
    const project = chat.project
    const stage = project?.goalMessageId === messageId ? project.status : undefined
    if (stage !== 'awaiting-approval' && stage !== 'waiting-user' && stage !== 'done' && stage !== 'stopped') return undefined
    return { chatId, chatName: chat.name, messageId, repliedNames: [], failedNames: [], projectStage: stage, ...(project?.question ? { projectQuestion: project.question } : {}) }
  }
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
  if (answered.projectStage) return projectNotificationText(answered, en)
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
      if (store.settings.replyNotifications === false) return false
      const answered = findAnsweredPrompt(store, chatId, messageId)
      // Once per message; a project once per point it reaches.
      const key = answered?.projectStage ? `${messageId}:${answered.projectStage}` : messageId
      if (!answered || notified.has(key)) return false
      notified.add(key)
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

function projectNotificationText(answered: AnsweredPrompt, en: boolean): { title: string; message: string } {
  switch (answered.projectStage) {
    case 'awaiting-approval':
      return en
        ? { title: `Project plan ready: ${answered.chatName}`, message: 'Check the tasks and start the work.' }
        : { title: `「${answered.chatName}」的项目计划拟好了`, message: '请确认任务后开始执行。' }
    case 'waiting-user':
      return en
        ? { title: `The project needs you: ${answered.chatName}`, message: answered.projectQuestion ?? 'The coordinator has a question.' }
        : { title: `「${answered.chatName}」的项目需要你决定`, message: answered.projectQuestion ?? '协调员有问题要问你。' }
    case 'done':
      return en
        ? { title: `Project finished: ${answered.chatName}`, message: 'The final deliverable is ready.' }
        : { title: `「${answered.chatName}」的项目完成了`, message: '最终交付已经写好。' }
    default:
      return en
        ? { title: `Project stopped: ${answered.chatName}`, message: 'Open the group to see why and continue.' }
        : { title: `「${answered.chatName}」的项目停了下来`, message: '打开群聊看看原因，可以继续执行。' }
  }
}

// The group a clicked notification belongs to.
export function chatIdFromNotificationId(notificationId: string): string | undefined {
  if (!notificationId.startsWith(REPLY_NOTIFICATION_PREFIX)) return undefined
  return notificationId.slice(REPLY_NOTIFICATION_PREFIX.length).split(':')[0] || undefined
}
