// API members and local agents: the request to the model, its reply streamed into the group, retries
// after a failed request, and stopping a reply.
import { isReceiverGoneError } from '../shared/connectionErrors'
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import { takeMemoryProposals } from '../group/memoryProposals'
import type { GroupChat, GroupMessage, GroupRole, MessageTokenUsage, OpenTeamStore } from '../group/types'
import type { ExternalModelClient, ExternalModelCompletionInput } from './externalModelClient'
import { QUOTA_EXHAUSTED_CODE } from './externalModelClient'
import type { ExternalPromptDelivery } from './rolePromptDelivery'
import { mutateStore, requireChat, requireRole } from './storeAccess'
import type { ExternalModelRunRegistry, MessageHandlersDependencies } from './messageHandlerDeps'
import { findPendingAssistantAfterPrompt, isAssistantMessageForRole, markChatHasNewMessage, staleReplyReason, upsertFailedAssistantAfterPrompt } from './replyMessages'
import { waitForRetryDelay } from './replyRetry'
import { isPromptDeliveryStillActive, markDeliveryError, reportPromptSettled } from './siteDeliveries'

export const DEFAULT_EXTERNAL_MODEL_RETRY_DELAYS_MS = [2_000, 2_000, 4_000, 8_000, 15_000] as const
// How often a reply being written is saved and sent to the page. Each time writes the store and sends
// all of it, so a few times a second is enough (the page reveals the text smoothly in between), even
// with several replies streaming at once into a long chat.
export const STREAM_UPDATE_INTERVAL_MS = 150
export async function sendExternalModelDelivery(deps: MessageHandlersDependencies, client: ExternalModelClient, runs: ExternalModelRunRegistry, delivery: ExternalPromptDelivery): Promise<OpenTeamStore | undefined> {
  const controller = new AbortController()
  runs.register(delivery.chatId, delivery.roleId, delivery.replyAttemptId, controller)
  let replyMessageId: string | undefined
  let content = ''
  let usage: MessageTokenUsage | undefined
  const onUsage = (value: MessageTokenUsage) => { usage = value }
  let answeredByFallback: string | undefined
  const onFallback = (modelName: string) => { answeredByFallback = modelName }
  try {
    deps.log.info('external-model:send:start', {
      chatId: delivery.chatId,
      roleId: delivery.roleId,
      messageId: delivery.messageId,
      modelId: delivery.model.id,
      format: delivery.model.format,
      promptLength: delivery.prompt.length,
    })

    const initialized = await createExternalAssistantPlaceholder(deps, delivery)
    if (initialized.ignored) {
      deps.log.warn('external-model:reply:ignored-stale', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason: initialized.reason })
      return initialized.store
    }
    replyMessageId = initialized.replyMessageId
    await deps.broadcastStoreUpdated(initialized.store)

    const imageIds = delivery.imageAttachmentIds ?? []
    if (imageIds.length > 0 && !deps.imageAttachments?.loadUploads) throw new Error('当前环境不支持发送图片')
    const images = imageIds.length > 0 && deps.imageAttachments?.loadUploads
      ? (await deps.imageAttachments.loadUploads(imageIds)).map(upload => ({ bytes: upload.bytes, mimeType: upload.mimeType }))
      : undefined
    // A local agent is never sent the same task again on its own: what it did cannot be undone.
    const retryDelays = delivery.model.format === 'local-agent' ? [] : deps.externalModelRetryDelaysMs ?? DEFAULT_EXTERNAL_MODEL_RETRY_DELAYS_MS
    const context = { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, roleName: delivery.roleName }
    for (let attemptIndex = 0; attemptIndex <= retryDelays.length; attemptIndex += 1) {
      try {
        content = ''
        usage = undefined
        answeredByFallback = undefined
        let updatedAt = Number.NEGATIVE_INFINITY
        const stream = typeof client.stream === 'function'
          ? client.stream({ model: delivery.model, prompt: delivery.prompt, images, abortSignal: controller.signal, onUsage, onFallback, context })
          : streamCompleteFallback(client, { model: delivery.model, prompt: delivery.prompt, images, abortSignal: controller.signal, onUsage, context })
        for await (const chunk of abortableChunks(stream, controller.signal)) {
          throwIfAborted(controller.signal)
          if (!chunk) continue
          content += chunk
          // The rest arrives with the next update, or with the finished reply (or the stopped one).
          if (deps.now() - updatedAt < STREAM_UPDATE_INTERVAL_MS) continue
          updatedAt = deps.now()
          const update = await updateExternalAssistantContent(deps, delivery, replyMessageId, content)
          if (update.ignored) {
            deps.log.warn('external-model:stream:ignored-stale', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason: update.reason })
            return update.store
          }
          await deps.broadcastStoreUpdated(update.store)
        }
        throwIfAborted(controller.signal)
        if (!content.trim()) throw new Error('模型没有返回内容')
        break
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) throw error
        if (content.trim()) throw error
        if (isPermanentModelError(error)) throw error
        const reason = error instanceof Error ? error.message : String(error)
        const canRetry = attemptIndex < retryDelays.length && await isPromptDeliveryStillActive(delivery.chatId, delivery.roleId, delivery.messageId, delivery.replyAttemptId)
        if (!canRetry) throw error

        const delayMs = retryDelays[attemptIndex] ?? 0
        // The reply says it is retrying and why, instead of looking like a slow answer.
        const marked = await markExternalAssistantRetrying(deps, delivery, replyMessageId, { attempt: attemptIndex + 1, total: retryDelays.length, reason })
        if (!marked.ignored) await deps.broadcastStoreUpdated(marked.store)
        deps.log.warn('external-model:retry-scheduled', {
          chatId: delivery.chatId,
          roleId: delivery.roleId,
          messageId: delivery.messageId,
          retryCount: attemptIndex + 1,
          delayMs,
          reason,
        })
        await waitForRetryDelay(deps, delayMs)
      }
    }

    // A web member's backup is named on its reply, as is an API model's own backup.
    const finalized = await finishExternalAssistantReply(deps, delivery, replyMessageId, content, usage, answeredByFallback ?? delivery.answeredBy)
    if (finalized.ignored) {
      deps.log.warn('external-model:reply:ignored-stale', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason: finalized.reason })
      return finalized.store
    }
    deps.log.info('external-model:reply:stored', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, replyMessageId })
    await deps.broadcastStoreUpdated(finalized.store)
    reportPromptSettled(deps, finalized.store, delivery.chatId, delivery.messageId)
    return finalized.store
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      deps.log.info('external-model:send:aborted', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, replyMessageId, contentLength: content.length })
      if (replyMessageId) {
        const stopped = await markExternalAssistantStopped(deps, delivery, replyMessageId, content)
        await deps.broadcastStoreUpdated(stopped.store)
        return stopped.store
      }
      return undefined
    }
    const reason = error instanceof Error ? error.message : String(error)
    deps.log.warn('external-model:send:failed', { chatId: delivery.chatId, roleId: delivery.roleId, messageId: delivery.messageId, reason })
    // The reply shown while it was written becomes the failure, instead of waiting forever.
    if (replyMessageId) {
      await mutateStore(store => {
        const chat = store.chatsById[delivery.chatId]
        const role = store.rolesById[delivery.roleId]
        if (chat && role) upsertFailedAssistantAfterPrompt(store, chat, role, delivery.messageId, reason, deps.now(), deps.newId)
      })
    }
    // The latest store: what the caller hands the page must not be older than what was broadcast.
    return markDeliveryError(deps, delivery.chatId, delivery.roleId, delivery.messageId, reason)
  } finally {
    runs.unregister(delivery.chatId, delivery.roleId, delivery.replyAttemptId)
  }
}

export async function createExternalAssistantPlaceholder(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; replyMessageId: string; store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
    if (staleReason) return { ignored: true as const, reason: staleReason }

    const reply: GroupMessage = {
      id: deps.newId('msg'),
      chatId: chat.id,
      seq: chat.nextMessageSeq,
      type: 'assistant',
      content: '',
      contentFormat: 'markdown',
      roleId: role.id,
      roleName: role.name,
      sourceMessageId: delivery.messageId,
      createdAt: timestamp,
      status: 'pending',
    }
    store.messagesById[reply.id] = reply
    chat.messageIds.push(reply.id)
    chat.nextMessageSeq += 1

    const userMessage = store.messagesById[delivery.messageId]
    if (userMessage?.deliveryStatus?.[role.id] === 'pending') {
      userMessage.deliveryStatus[role.id] = 'sent'
      updateUserMessageDeliveryStatus(userMessage)
    }
    role.updatedAt = timestamp
    chat.updatedAt = timestamp
    return { ignored: false as const, replyMessageId: reply.id }
  })
  return result.ignored ? { ...result, store } : { ...result, store }
}

export async function updateExternalAssistantContent(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
    if (staleReason) return { ignored: true as const, reason: staleReason }
    const reply = store.messagesById[replyMessageId]
    if (!isAssistantMessageForRole(reply, chat, role)) return { ignored: true as const, reason: 'reply-message-not-found' }
    reply.content = content
    reply.status = 'pending'
    delete reply.retry
    role.updatedAt = timestamp
    chat.updatedAt = timestamp
    return { ignored: false as const }
  })
  return result.ignored ? { ...result, store } : { ...result, store }
}

// A 4xx answer other than 408 (timeout) and 429 (too many requests) does not change when asked again:
// a wrong key, a model that does not exist, a request the server refuses.
export function isPermanentModelError(error: unknown): boolean {
  if ((error as { code?: unknown } | undefined)?.code === QUOTA_EXHAUSTED_CODE) return true
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

export async function markExternalAssistantRetrying(
  _deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  retry: NonNullable<GroupMessage['retry']>,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; store: OpenTeamStore }> {
  const { store, result } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
    if (staleReason) return { ignored: true as const, reason: staleReason }
    const reply = store.messagesById[replyMessageId]
    if (!isAssistantMessageForRole(reply, chat, role)) return { ignored: true as const, reason: 'reply-message-not-found' }
    reply.retry = { ...retry, reason: retry.reason.slice(0, 160) }
    return { ignored: false as const }
  })
  return result.ignored ? { ...result, store } : { ...result, store }
}

export async function finishExternalAssistantReply(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
  usage?: MessageTokenUsage,
  answeredByFallback?: string,
): Promise<{ ignored: true; reason: string; store: OpenTeamStore } | { ignored: false; store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, delivery.chatId)
      const role = requireRole(store, chat.id, delivery.roleId)
      const staleReason = staleReplyReason(store, chat, role, delivery.messageId, delivery.replyAttemptId)
      if (staleReason) return { ignored: true as const, reason: staleReason }
      const reply = store.messagesById[replyMessageId]
      if (!isAssistantMessageForRole(reply, chat, role)) return { ignored: true as const, reason: 'reply-message-not-found' }
      reply.content = content
      reply.status = 'received'
      takeMemoryProposals(store, chat, reply, deps.newId)
      delete reply.retry
      if (usage) reply.usage = usage
      if (answeredByFallback) reply.answeredByFallback = answeredByFallback
      else delete reply.answeredByFallback
      markChatHasNewMessage(store, chat)

      const userMessage = store.messagesById[delivery.messageId]
      if (userMessage?.deliveryStatus?.[role.id]) {
        userMessage.deliveryStatus[role.id] = 'received'
        updateUserMessageDeliveryStatus(userMessage)
      }

      role.status = 'ready'
      role.lastReplyAt = timestamp
      role.updatedAt = timestamp
      if (role.lastPromptMessageId === delivery.messageId) delete role.lastPromptMessageId
      if (role.replyAttemptId === delivery.replyAttemptId) delete role.replyAttemptId
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return { ignored: false as const }
    })
  return result.ignored ? { ...result, store } : { ...result, store }
}

export async function markExternalAssistantStopped(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
): Promise<{ store: OpenTeamStore }> {
  const timestamp = deps.now()
  const { store } = await mutateStore(store => {
    const chat = requireChat(store, delivery.chatId)
    const role = requireRole(store, chat.id, delivery.roleId)
    const reply = store.messagesById[replyMessageId]
    const hasContent = Boolean(content.trim())
    const replyAlreadyFinalized = isAssistantMessageForRole(reply, chat, role) && reply.status !== 'pending'
    if (isAssistantMessageForRole(reply, chat, role) && !replyAlreadyFinalized) {
      reply.content = content
      reply.status = hasContent ? 'received' : 'error'
    }

    const userMessage = store.messagesById[delivery.messageId]
    if (userMessage?.deliveryStatus?.[role.id] && !replyAlreadyFinalized) {
      userMessage.deliveryStatus[role.id] = hasContent ? 'received' : 'error'
      updateUserMessageDeliveryStatus(userMessage)
    }

    const stoppedSamePrompt = role.lastPromptMessageId === delivery.messageId
    if (stoppedSamePrompt) {
      role.status = 'stopped'
      if (hasContent) delete role.lastPromptMessageId
    }
    if (hasContent && stoppedSamePrompt) delete role.replyAttemptId
    role.updatedAt = timestamp
    chat.status = deps.getChatStatusFromRoles(store, chat)
    chat.updatedAt = timestamp
  })
  return { store }
}

async function* streamCompleteFallback(client: ExternalModelClient, input: ExternalModelCompletionInput): AsyncIterable<string> {
  const result = await client.complete(input)
  yield result.content
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function isReceiverDisconnectedError(error: unknown): boolean {
  return isReceiverGoneError(error instanceof Error ? error.message : String(error))
}

export function finalizeActiveExternalAssistantReply(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): boolean {
  const reply = findPendingAssistantAfterPrompt(store, chat, role, promptMessageId)
  if (!reply) return false

  if (!reply.content.trim()) reply.content = '已停止回复'
  reply.status = 'received'
  delete reply.retry

  const userMessage = store.messagesById[promptMessageId]
  if (userMessage?.deliveryStatus?.[role.id]) {
    userMessage.deliveryStatus[role.id] = 'received'
    updateUserMessageDeliveryStatus(userMessage)
  }

  role.status = 'stopped'
  delete role.lastPromptMessageId
  delete role.replyAttemptId
  return true
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

async function* abortableChunks<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]()
  let abortListener: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) {
      abortListener()
      return
    }
    signal.addEventListener('abort', abortListener, { once: true })
  })

  try {
    while (true) {
      const next = await Promise.race([iterator.next(), abortPromise])
      if (next.done) return
      yield next.value
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener)
    if (signal.aborted) Promise.resolve(iterator.return?.()).catch(() => undefined)
  }
}

export function createExternalModelRunRegistry(): ExternalModelRunRegistry {
  const runs = new Map<string, AbortController>()
  return {
    register(chatId, roleId, replyAttemptId, controller) {
      runs.set(externalModelRunKey(chatId, roleId, replyAttemptId), controller)
    },
    abort(chatId, roleId, replyAttemptId) {
      if (replyAttemptId) {
        runs.get(externalModelRunKey(chatId, roleId, replyAttemptId))?.abort()
        return
      }
      for (const [key, controller] of runs) {
        if (key.startsWith(`${chatId}:${roleId}:`)) controller.abort()
      }
    },
    unregister(chatId, roleId, replyAttemptId) {
      runs.delete(externalModelRunKey(chatId, roleId, replyAttemptId))
    },
  }
}

export function externalModelRunKey(chatId: string, roleId: string, replyAttemptId: string): string {
  return `${chatId}:${roleId}:${replyAttemptId}`
}
