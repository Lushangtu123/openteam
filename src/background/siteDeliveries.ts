// Sending prompts to web members' pages, one site at a time, and what happens when one cannot be sent.
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import type { OpenTeamStore } from '../group/types'
import type { PromptDelivery } from './promptDelivery'
import { DEFAULT_PROMPT_DELIVERY_RETRY_DELAYS_MS, sendPromptDeliveryWithRetry } from './promptDeliveryRetry'
import { mutateStore, requireChat, requireRole } from './storeAccess'
import type { MessageHandlersDependencies } from './messageHandlerDeps'
import { hasAssistantReplyAfterPrompt, staleReplyReason } from './replyMessages'
import { backupDeliveryFor, backupModelFor, siteBlocksMember } from './memberBackup'

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

// Sends a web member its prompt. When its site is blocked already, or the prompt cannot be sent at
// all, its backup API model answers instead, if it has one (memberBackup.ts). Resolves to whether the
// site got the prompt.
export async function sendPromptDelivery(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery): Promise<boolean> {
  if (await answerWithBackup(deps, chatId, messageId, delivery, 'site-blocked')) return false
  return sendPromptDeliveryWithRetry({
    log: deps.log,
    sendPrompt: deps.sendPrompt,
    getLatestBinding: (targetChatId, roleId) => deps.runtimeFrames.getByRole(targetChatId, roleId),
    isDeliveryStillActive: isPromptDeliveryStillActive,
    // A site that blocks the prompt (a pop-up, a login page) is not tried again for minutes when a
    // backup can answer now.
    stopRetrying: async (targetChatId, roleId) => delivery.hasBackup === true && deps.answerForMember !== undefined && await blockedWithBackup(targetChatId, roleId),
    markDeliveryError: async (targetChatId, roleId, targetMessageId, reason) => {
      if (await answerWithBackup(deps, targetChatId, targetMessageId, delivery, 'send-failed')) return
      await markDeliveryError(deps, targetChatId, roleId, targetMessageId, reason)
    },
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

async function blockedWithBackup(chatId: string, roleId: string): Promise<boolean> {
  const { result } = await mutateStore(store => {
    const role = requireRole(store, requireChat(store, chatId).id, roleId)
    return siteBlocksMember(role) && Boolean(backupModelFor(store, role))
  })
  return result
}

// The member's backup answers the prompt its site did not get: when the site is blocked already
// ('site-blocked'), or when the prompt could not be sent ('send-failed'). The answer runs on its own;
// this resolves to whether the backup took the prompt.
async function answerWithBackup(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery, why: 'site-blocked' | 'send-failed'): Promise<boolean> {
  const answer = deps.answerForMember
  if (!answer || !delivery.hasBackup) return false
  const { result: backup } = await mutateStore(store => {
    const chat = requireChat(store, chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    if (why === 'site-blocked' && !siteBlocksMember(role)) return undefined
    if (staleReplyReason(store, chat, role, messageId, delivery.message.replyAttemptId)) return undefined
    return backupDeliveryFor(store, role, delivery)
  })
  if (!backup) return false
  deps.log.warn('member-backup:answering', { chatId, roleId: delivery.roleId, messageId, modelId: backup.model.id, why })
  void Promise.resolve(answer(backup)).catch(error => deps.log.warn('member-backup:failed', { chatId, roleId: delivery.roleId, messageId, error: error instanceof Error ? error.message : String(error) }))
  return true
}
