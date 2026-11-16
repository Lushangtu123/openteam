// Sending prompts to web members' pages, one site at a time, and what happens when one cannot be sent.
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import type { OpenTeamStore } from '../group/types'
import type { PromptDelivery } from './promptDelivery'
import { DEFAULT_PROMPT_DELIVERY_RETRY_DELAYS_MS, sendPromptDeliveryWithRetry } from './promptDeliveryRetry'
import { mutateStore, requireChat, requireRole } from './storeAccess'
import type { MessageHandlersDependencies } from './messageHandlerDeps'
import { hasAssistantReplyAfterPrompt, staleReplyReason } from './replyMessages'

export async function markDeliveryError(deps: MessageHandlersDependencies, chatId: string, roleId: string, messageId: string, reason: string): Promise<OpenTeamStore> {
  deps.log.warn('delivery:error', { chatId, roleId, messageId, reason })
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    role.status = 'error'
    role.updatedAt = deps.now()
    if (role.lastPromptMessageId === messageId) delete role.lastPromptMessageId
    delete role.replyAttemptId

    const userMessage = store.messagesById[messageId]
    if (userMessage?.deliveryStatus) {
      userMessage.deliveryStatus[roleId] = 'error'
      updateUserMessageDeliveryStatus(userMessage)
    }
    chat.status = deps.getChatStatusFromRoles(store, chat)
    chat.updatedAt = role.updatedAt
  })
  await deps.broadcastStoreUpdated(store)
  await deps.sendError(reason)
  // The member is done with this message (it never got it), like a member that failed to reply.
  reportPromptSettled(deps, store, chatId, messageId)
  return store
}

export async function isPromptDeliveryStillActive(
  chatId: string,
  roleId: string,
  messageId: string,
  replyAttemptId: string | undefined,
): Promise<boolean> {
  const { result } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, roleId)
    if (role.status === 'stopped') return false
    if (staleReplyReason(store, chat, role, messageId, replyAttemptId)) return false
    if (hasAssistantReplyAfterPrompt(store, chat, role, messageId)) return false
    return true
  })
  return result
}

export async function sendPromptDeliveries(deps: MessageHandlersDependencies, chatId: string, messageId: string, deliveries: PromptDelivery[]): Promise<void> {
  await Promise.all(deliveries.map(delivery => enqueuePromptDelivery(deps, chatId, messageId, delivery)))
}

export async function enqueuePromptDelivery(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery): Promise<void> {
  const send = () => sendPromptDelivery(deps, chatId, messageId, delivery)
  if (!deps.promptDeliveryLimiter) {
    await send()
    return
  }
  await deps.promptDeliveryLimiter.enqueue({
    chatId,
    messageId,
    roleId: delivery.roleId,
    chatSite: delivery.chatSite,
    send,
  })
}

export async function sendPromptDelivery(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery): Promise<boolean> {
  return sendPromptDeliveryWithRetry({
    log: deps.log,
    sendPrompt: deps.sendPrompt,
    getLatestBinding: (targetChatId, roleId) => deps.runtimeFrames.getByRole(targetChatId, roleId),
    isDeliveryStillActive: isPromptDeliveryStillActive,
    markDeliveryError: async (targetChatId, roleId, targetMessageId, reason) => { await markDeliveryError(deps, targetChatId, roleId, targetMessageId, reason) },
    requestRoleRecovery: deps.requestRoleRecovery,
    waitForRetry: deps.waitForRetry,
  }, {
    chatId,
    messageId,
    delivery,
    retryDelaysMs: deps.deliveryRetryDelaysMs ?? DEFAULT_PROMPT_DELIVERY_RETRY_DELAYS_MS,
  })
}

export function reportPromptSettled(deps: MessageHandlersDependencies, store: OpenTeamStore, chatId: string, promptMessageId: string): void {
  try {
    Promise.resolve(deps.onPromptSettled?.(store, chatId, promptMessageId)).catch(error => deps.log.warn('prompt-settled:failed', { error: error instanceof Error ? error.message : String(error) }))
  } catch (error) {
    deps.log.warn('prompt-settled:failed', { error: error instanceof Error ? error.message : String(error) })
  }
}
