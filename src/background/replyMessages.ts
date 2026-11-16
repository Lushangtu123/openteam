// Finding, adding and changing the messages of a round in a group: a member's reply to a prompt,
// the one it failed with, and whether a reply is still the one being waited for.
import { isOpenTeamRequest } from '../group/roundSummary'
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { getChatMessages } from './storeAccess'
import type { MessageHandlersDependencies } from './messageHandlerDeps'

export function getRoleReplyHistory(store: OpenTeamStore, chat: GroupChat, roleId: string, limit = 100): string[] {
  return getChatMessages(store, chat)
    .filter(message => message.type === 'assistant' && message.roleId === roleId && message.content.trim())
    .slice(-limit)
    .map(message => message.content)
}

export function staleReplyReason(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string | undefined, replyAttemptId?: string): string | undefined {
  if (!promptMessageId) return 'missing-prompt-message-id'
  if (role.lastPromptMessageId !== promptMessageId) return 'prompt-message-mismatch'
  if (replyAttemptId && role.replyAttemptId && role.replyAttemptId !== replyAttemptId) return 'reply-attempt-mismatch'

  const userMessage = store.messagesById[promptMessageId]
  if (!userMessage || userMessage.chatId !== chat.id || userMessage.type !== 'user') return 'prompt-message-not-found'

  const deliveryStatus = userMessage.deliveryStatus?.[role.id]
  if (deliveryStatus !== 'pending' && deliveryStatus !== 'sent') return `delivery-already-${deliveryStatus ?? 'missing'}`

  return undefined
}

export function markChatHasNewMessage(store: OpenTeamStore, chat: GroupChat): void {
  if (store.currentChatId === chat.id) return
  store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
  store.viewState.chatHasNewMessageById ??= {}
  store.viewState.chatHasNewMessageById[chat.id] = true
}

export function hasCrossReview(store: OpenTeamStore, chat: GroupChat, questionId: string): boolean {
  return chat.messageIds.some(id => store.messagesById[id]?.crossReviewOf === questionId)
}

// The user has written again since the message (their own message, not one of OpenTeam's requests).
export function userMovedOnFrom(store: OpenTeamStore, chat: GroupChat, message: GroupMessage): boolean {
  return chat.messageIds.some(id => {
    const later = store.messagesById[id]
    return Boolean(later && later.seq > message.seq && later.type === 'user' && !isOpenTeamRequest(later))
  })
}

export function hasAssistantReplyAfterPrompt(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): boolean {
  const promptIndex = chat.messageIds.indexOf(promptMessageId)
  if (promptIndex < 0) return false
  for (let index = promptIndex + 1; index < chat.messageIds.length; index += 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isAssistantMessageForRole(message, chat, role) && (message.status === 'received' || Boolean(message.content.trim()))) return true
  }
  return false
}

// Stopping a web member keeps what it had written as its reply, like an API member's.
export function keepLiveReplyAsMessage(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  promptMessageId: string,
  timestamp: number,
  newId: MessageHandlersDependencies['newId'],
): boolean {
  const live = role.liveReply
  delete role.liveReply
  if (!live || live.promptMessageId !== promptMessageId || !live.content.trim()) return false

  const reply: AssistantGroupMessage = {
    id: newId('msg'),
    chatId: chat.id,
    seq: chat.nextMessageSeq,
    type: 'assistant',
    content: live.content,
    ...(live.contentFormat ? { contentFormat: live.contentFormat } : {}),
    roleId: role.id,
    roleName: role.name,
    sourceMessageId: promptMessageId,
    createdAt: timestamp,
    status: 'received',
  }
  store.messagesById[reply.id] = reply
  chat.messageIds.push(reply.id)
  chat.nextMessageSeq += 1

  const userMessage = store.messagesById[promptMessageId]
  if (userMessage?.deliveryStatus?.[role.id]) {
    userMessage.deliveryStatus[role.id] = 'received'
    updateUserMessageDeliveryStatus(userMessage)
  }

  role.status = 'stopped'
  role.lastReplyAt = timestamp
  delete role.lastPromptMessageId
  delete role.replyAttemptId
  return true
}

export function findPendingAssistantAfterPrompt(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): AssistantGroupMessage | undefined {
  const promptIndex = chat.messageIds.indexOf(promptMessageId)
  if (promptIndex < 0) return undefined

  for (let index = chat.messageIds.length - 1; index > promptIndex; index -= 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isAssistantMessageForRole(message, chat, role) && message.status === 'pending') return message
  }
  return undefined
}

export function findFailedOrPendingAssistantAfterPrompt(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): AssistantGroupMessage | undefined {
  const promptIndex = chat.messageIds.indexOf(promptMessageId)
  if (promptIndex < 0) return undefined

  for (let index = chat.messageIds.length - 1; index > promptIndex; index -= 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isAssistantMessageForRole(message, chat, role) && (message.status === 'pending' || message.status === 'error')) {
      const previousPrompt = findPromptBeforeAssistant(store, chat, role, message.id)
      if (previousPrompt?.id === promptMessageId) return message
    }
  }
  return undefined
}

export function upsertFailedAssistantAfterPrompt(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  promptMessageId: string,
  reason: string,
  timestamp: number,
  newId: MessageHandlersDependencies['newId'],
): AssistantGroupMessage {
  const content = roleFailureReplyContent(reason)
  const existingReply = findFailedOrPendingAssistantAfterPrompt(store, chat, role, promptMessageId)
  if (existingReply) {
    existingReply.content = content
    existingReply.contentFormat = 'markdown'
    existingReply.status = 'error'
    delete existingReply.retry
    return existingReply
  }

  const reply: AssistantGroupMessage = {
    id: newId('msg'),
    chatId: chat.id,
    seq: chat.nextMessageSeq,
    type: 'assistant',
    content,
    contentFormat: 'markdown',
    roleId: role.id,
    roleName: role.name,
    sourceMessageId: promptMessageId,
    createdAt: timestamp,
    status: 'error',
  }
  store.messagesById[reply.id] = reply
  chat.messageIds.push(reply.id)
  chat.nextMessageSeq += 1
  markChatHasNewMessage(store, chat)
  return reply
}

export function roleFailureReplyContent(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized === 'send_failed') return '⚠️ 发送失败，请检查 AI 窗口是否开启或尝试刷新页面。\n\n可以点击下方的重新回复按钮再试一次。'
  if (normalized === 'response_not_found') return '⚠️ 未检测到回复，可能是 AI 响应过慢或 DOM 结构已变更。\n\n可以点击下方的重新同步完整回复按钮尝试恢复。'
  if (normalized === 'timeout') return '⚠️ 回复超时了。\n\n可以点击下方的重新回复按钮再试一次。'
  if (normalized === 'site_blocked') return '⚠️ 站点阻断，请检查登录状态或处理 Cookie 弹窗。\n\n处理完成后点击重新回复。'
  if (/超时|timeout/i.test(reason)) return '回复超时了。\n\n可以点击下方的重新回复按钮再试一次。'
  return `回复失败：${reason}\n\n可以点击下方的重新回复按钮再试一次。`
}

export type UserGroupMessage = GroupMessage & { type: 'user' }
export type AssistantGroupMessage = GroupMessage & { type: 'assistant' }

export function isUserMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is UserGroupMessage {
  return Boolean(
    message &&
      message.chatId === chat.id &&
      message.type === 'user' &&
      (!message.targetRoleIds || message.targetRoleIds.includes(role.id)),
  )
}

export function isAssistantMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is AssistantGroupMessage {
  return Boolean(message && message.chatId === chat.id && message.type === 'assistant' && message.roleId === role.id)
}

export function findPromptBeforeAssistant(store: OpenTeamStore, chat: GroupChat, role: GroupRole, assistantMessageId: string): GroupMessage | undefined {
  const assistantIndex = chat.messageIds.indexOf(assistantMessageId)
  if (assistantIndex <= 0) return undefined

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isUserMessageForRole(message, chat, role)) return message
  }
  return undefined
}

export function discardMessage(store: OpenTeamStore, chat: GroupChat, messageId: string): void {
  delete store.messagesById[messageId]
  chat.messageIds = chat.messageIds.filter(id => id !== messageId)
  if (store.messageHighlightsById) delete store.messageHighlightsById[messageId]
}
