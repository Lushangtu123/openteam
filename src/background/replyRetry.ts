// Trying a member again: on its own after an error that may pass (a few times, spaced out), and when
// the user asks for a reply again (which prompt to send, and what to do with the failed reply).
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import type { PromptDelivery } from './promptDelivery'
import { type ExternalPromptDelivery, isExternalModelRole, type PreparedRolePromptDelivery, prepareRolePromptDelivery } from './rolePromptDelivery'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'
import type { MessageHandlersDependencies } from './messageHandlerDeps'
import { findPromptBeforeAssistant, hasAssistantReplyAfterPrompt, isAssistantMessageForRole, isUserMessageForRole, staleReplyReason } from './replyMessages'

export const DEFAULT_ROLE_ERROR_RETRY_DELAYS_MS = [2_000, 8_000] as const

export type PreparedRoleErrorRetry = {
  store: OpenTeamStore
  retryCount: number
  delayMs: number
} & (
  | { delivery: PromptDelivery; externalDelivery?: undefined }
  | { delivery?: undefined; externalDelivery: ExternalPromptDelivery }
)

export async function prepareRoleErrorRetry(
  deps: MessageHandlersDependencies,
  retryCounts: Map<string, number>,
  chatId: string,
  roleId: string,
  promptMessageId: string,
  replyAttemptId: string | undefined,
  reason: string,
): Promise<PreparedRoleErrorRetry | undefined> {
  if (!isRetryableRoleError(reason)) return undefined
  const retryDelays = deps.roleErrorRetryDelaysMs ?? DEFAULT_ROLE_ERROR_RETRY_DELAYS_MS
  const key = roleErrorRetryKey(chatId, roleId, promptMessageId)
  const usedRetries = retryCounts.get(key) ?? 0
  if (usedRetries >= retryDelays.length) return undefined

  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    const staleReason = staleReplyReason(store, chat, role, promptMessageId, replyAttemptId)
    if (staleReason) return undefined
    const userMessage = store.messagesById[promptMessageId]
    if (!isUserMessageForRole(userMessage, chat, role)) return undefined
    if (userMessage.deliveryStatus?.[role.id] !== 'sent') return undefined
    if (hasAssistantReplyAfterPrompt(store, chat, role, promptMessageId)) return undefined

    const roles = getChatRoles(store, chat)
    const messages = getChatMessages(store, chat)
    const reference = userMessage.references?.[0]
    let prepared: PreparedRolePromptDelivery
    try {
      prepared = prepareRolePromptDelivery({ store, chat, role, userMessage, roles, messages, reference, timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })
    } catch {
      return undefined
    }

    userMessage.deliveryStatus ??= {}
    userMessage.deliveryStatus[role.id] = 'pending'
    updateUserMessageDeliveryStatus(userMessage)
    role.status = 'thinking'
    role.lastPromptMessageId = userMessage.id
    role.replyAttemptId = prepared.replyAttemptId
    delete role.liveReply
    role.updatedAt = timestamp
    chat.status = 'running'
    chat.updatedAt = timestamp
    return prepared
  })

  if (!result) return undefined
  const retryCount = usedRetries + 1
  retryCounts.set(key, retryCount)
  return { ...result, store, retryCount, delayMs: retryDelays[usedRetries] ?? 0 }
}

export function isRetryableRoleError(reason: string): boolean {
  const normalized = reason.toLowerCase()
  const nonRetryablePatterns = [
    'abort',
    'aborted',
    'unauthorized',
    'invalid_api_key',
    'model_not_found',
    '401',
    '403',
    'api key',
    '已停止',
    '停止回复',
    '用户停止',
    '找不到外部模型',
    '模型不存在',
    '密钥',
  ]
  return !nonRetryablePatterns.some(pattern => normalized.includes(pattern))
}

export function clearRoleErrorRetryCount(retryCounts: Map<string, number>, chatId: string, roleId: string, messageId: string): void {
  retryCounts.delete(roleErrorRetryKey(chatId, roleId, messageId))
}

export function roleErrorRetryKey(chatId: string, roleId: string, messageId: string): string {
  return `${chatId}:${roleId}:${messageId}`
}

export async function waitForRetryDelay(deps: MessageHandlersDependencies, delayMs: number): Promise<void> {
  if (delayMs <= 0) return
  if (deps.waitForRetry) {
    await deps.waitForRetry(delayMs)
    return
  }
  await new Promise<void>(resolve => setTimeout(resolve, delayMs))
}

export function isPendingRetryStatus(message: GroupMessage, role: GroupRole): boolean {
  const deliveryStatus = message.deliveryStatus?.[role.id]
  return deliveryStatus === 'pending' || deliveryStatus === 'sent'
}

export function findLatestPendingRetryMessage(store: OpenTeamStore, chat: GroupChat, role: GroupRole): GroupMessage | undefined {
  for (const messageId of [...chat.messageIds].reverse()) {
    const message = store.messagesById[messageId]
    if (isUserMessageForRole(message, chat, role) && isPendingRetryStatus(message, role)) return message
  }
  return undefined
}

export interface RetryTarget {
  userMessage: GroupMessage
  discardMessageId?: string
}

export function resolveRetryTarget(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  requestedMessageId: string | undefined,
  log: MessageHandlersDependencies['log'],
): RetryTarget | undefined {
  if (!requestedMessageId) {
    const userMessage = resolveRetryUserMessage(store, chat, role, undefined, log)
    return userMessage ? { userMessage } : undefined
  }

  const requestedMessage = store.messagesById[requestedMessageId]
  if (isUserMessageForRole(requestedMessage, chat, role)) return { userMessage: requestedMessage }

  if (isAssistantMessageForRole(requestedMessage, chat, role) && (isExternalModelRole(role) || requestedMessage.status === 'error')) {
    const userMessage = findPromptBeforeAssistant(store, chat, role, requestedMessage.id)
    return userMessage ? { userMessage, discardMessageId: requestedMessage.id } : undefined
  }

  return undefined
}

export function resolveRetryUserMessage(
  store: OpenTeamStore,
  chat: GroupChat,
  role: GroupRole,
  requestedMessageId: string | undefined,
  log: MessageHandlersDependencies['log'],
): GroupMessage | undefined {
  if (requestedMessageId) {
    const requestedMessage = store.messagesById[requestedMessageId]
    return isUserMessageForRole(requestedMessage, chat, role) ? requestedMessage : undefined
  }

  const activePromptMessage = role.lastPromptMessageId ? store.messagesById[role.lastPromptMessageId] : undefined
  if (isUserMessageForRole(activePromptMessage, chat, role) && isPendingRetryStatus(activePromptMessage, role)) return activePromptMessage

  const latestPendingMessage = findLatestPendingRetryMessage(store, chat, role)
  if (latestPendingMessage && role.lastPromptMessageId && latestPendingMessage.id !== role.lastPromptMessageId) {
    log.warn('role-retry-reply:stale-prompt-pointer', {
      chatId: chat.id,
      roleId: role.id,
      staleMessageId: role.lastPromptMessageId,
      retryMessageId: latestPendingMessage.id,
    })
  }
  return latestPendingMessage
}
