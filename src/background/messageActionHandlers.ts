// What the user does to messages already in a group: ask a member to reply again, stop a reply, read a
// reply from its page again, save a note, mark a passage.
import { textReadBeforeInterruption } from './interruptedReplies'
import { normalizeMessageHighlightColor } from '../group/highlightColors'
import type { OpenTeamStore } from '../group/types'
import { isExternalModelRole, prepareRolePromptDelivery } from './rolePromptDelivery'
import type { RuntimeMessage } from './runtimeClient'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'
import { discardMessage, isAssistantMessageForRole, keepLiveReplyAsMessage } from './replyMessages'
import { resolveRetryTarget } from './replyRetry'
import { enqueuePromptDelivery } from './siteDeliveries'
import { finalizeActiveExternalAssistantReply, isReceiverDisconnectedError } from './externalModelReplies'
import { isRecord, readOptionalString, requireNoteContent, requireNumber, requireString } from './messageInput'
import { deleteAttachmentIdsBestEffort, readyAttachmentIds } from './messageAttachments'
import type { MessageHandlerContext } from './messageHandlerDeps'

export function createMessageActionHandlers(ctx: MessageHandlerContext) {
  const { deps, externalModelRuns, deliverExternal } = ctx

  const handleRoleRetryReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少成员 ID')
    const timestamp = deps.now()
    let discardedAttachmentIds: string[] = []

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      const requestedMessageId = readOptionalString(message.messageId)
      const retryTarget = resolveRetryTarget(store, chat, role, requestedMessageId, deps.log)
      const userMessage = retryTarget?.userMessage
      if (!userMessage) throw new Error(requestedMessageId ? '该消息没有发送给这位成员' : '找不到可重试的用户消息')
      if (retryTarget?.discardMessageId) {
        discardedAttachmentIds = readyAttachmentIds(store.messagesById[retryTarget.discardMessageId]?.attachments)
        discardMessage(store, chat, retryTarget.discardMessageId)
      }

      const roles = getChatRoles(store, chat)
      const messages = getChatMessages(store, chat)
      const reference = userMessage.references?.[0]
      const prepared = prepareRolePromptDelivery({ store, chat, role, userMessage, roles, messages, reference, timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })

      userMessage.deliveryStatus ??= {}
      userMessage.deliveryStatus[role.id] = 'pending'
      userMessage.status = 'pending'
      role.status = 'thinking'
      role.lastPromptMessageId = userMessage.id
      role.replyAttemptId = prepared.replyAttemptId
      delete role.liveReply
      role.updatedAt = timestamp
      chat.status = 'running'
      chat.updatedAt = timestamp
      return prepared
    })

    await deleteAttachmentIdsBestEffort(deps, discardedAttachmentIds, 'role-retry-reply:attachment-cleanup-failed')
    await deps.broadcastStoreUpdated(store)
    const externalDelivery = 'externalDelivery' in result ? result.externalDelivery : undefined
    if (externalDelivery) {
      deps.log.info('role-retry-reply:deliver-external', {
        chatId,
        roleId,
        messageId: externalDelivery.messageId,
        replyAttemptId: externalDelivery.replyAttemptId,
        modelId: externalDelivery.model.id,
      })
      const responseStore = await deliverExternal(externalDelivery) ?? store
      return { ok: true, store: responseStore, messageId: externalDelivery.messageId }
    }
    const delivery = 'delivery' in result ? result.delivery : undefined
    if (!delivery) throw new Error('重试投递生成失败')
    deps.log.info('role-retry-reply:deliver', {
      chatId,
      roleId,
      messageId: delivery.message.messageId,
      replyAttemptId: delivery.message.replyAttemptId,
      tabId: delivery.tabId,
      frameId: delivery.frameId,
    })
    await enqueuePromptDelivery(deps, chatId, delivery.message.messageId, delivery)
    return { ok: true, store, messageId: delivery.message.messageId }
  }

  const handleRoleStopReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少成员 ID')

    const { result: active } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      if (role.status !== 'thinking' || !role.lastPromptMessageId) throw new Error('该人员当前没有正在回复的任务')
      return {
        messageId: role.lastPromptMessageId,
        replyAttemptId: role.replyAttemptId,
        isExternal: isExternalModelRole(role),
      }
    })

    if (active.isExternal) {
      externalModelRuns.abort(chatId, roleId, active.replyAttemptId)
    } else {
      const binding = deps.runtimeFrames.getByRole(chatId, roleId)
      if (!binding?.ready) throw new Error('成员 iframe 尚未就绪，无法停止回复')
      try {
        const response = await deps.sendRoleMessage(binding.tabId, binding.frameId, {
          type: 'TEAM_STOP_GENERATION',
          chatId,
          roleId,
          messageId: active.messageId,
          replyAttemptId: active.replyAttemptId,
        })
        if (isRecord(response) && response.ok === false) throw new Error(readOptionalString(response.error) ?? '停止回复失败')
      } catch (error) {
        if (!isReceiverDisconnectedError(error)) throw error
        deps.log.warn('role-stop-reply:receiver-disconnected', {
          chatId,
          roleId,
          messageId: active.messageId,
          replyAttemptId: active.replyAttemptId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const timestamp = deps.now()
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      if (role.lastPromptMessageId !== active.messageId) return
      const finalizedVisibleReply = active.isExternal
        ? finalizeActiveExternalAssistantReply(store, chat, role, active.messageId)
        : keepLiveReplyAsMessage(store, chat, role, active.messageId, timestamp, deps.newId)
      if (!finalizedVisibleReply) {
        role.status = 'stopped'
        role.replyAttemptId = deps.newId('stopped')
      }
      role.updatedAt = timestamp
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
    })
    deps.log.info('role-stop-reply:stopped', { chatId, roleId, messageId: active.messageId, modelSource: active.isExternal ? 'external' : 'site' })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store, messageId: active.messageId }
  }

  const handleNoteSave = async (message: RuntimeMessage) => {
    const scope = readOptionalString(message.scope)
    if (scope !== 'global' && scope !== 'chat') throw new Error('未知笔记范围')
    const content = requireNoteContent(message.content)

    const { store } = await mutateStore(store => {
      if (scope === 'global') {
        store.globalNote = content
        return
      }

      const chatId = requireString(message.chatId, '缺少群聊 ID')
      requireChat(store, chatId)
      store.chatNotesById ??= {}
      store.chatNotesById[chatId] = content
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleMessageHighlightCreate = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const messageId = requireString(message.messageId, '缺少消息 ID')
    const text = requireString(message.text, '高亮内容不能为空')
    const startOffset = requireNumber(message.startOffset, '缺少高亮起点')
    const endOffset = requireNumber(message.endOffset, '缺少高亮终点')
    const color = normalizeMessageHighlightColor(message.color)
    if (endOffset <= startOffset) throw new Error('高亮范围无效')
    const timestamp = deps.now()

    const { store } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const target = store.messagesById[messageId]
      if (!target || target.chatId !== chat.id) throw new Error('找不到消息')
      if (startOffset < 0 || endOffset > target.content.length || target.content.slice(startOffset, endOffset) !== text) throw new Error('高亮范围与消息内容不匹配')

      store.messageHighlightsById ??= {}
      store.messageHighlightsById[messageId] ??= []
      store.messageHighlightsById[messageId].push({
        id: deps.newId('highlight'),
        messageId,
        text,
        startOffset,
        endOffset,
        color,
        createdAt: timestamp,
      })
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleMessageResyncReply = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少成员 ID')
    const messageId = requireString(message.messageId, '缺少消息 ID')
    const binding = deps.runtimeFrames.getByRole(chatId, roleId)
    if (!binding?.ready) throw new Error('成员 iframe 尚未就绪，请先恢复成员')

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      const assistantMessage = store.messagesById[messageId]
      if (!isAssistantMessageForRole(assistantMessage, chat, role)) throw new Error('该回复不属于这位成员')
      return { currentContent: textReadBeforeInterruption(assistantMessage.content) }
    })

    deps.log.warn('message-resync-reply:request', { chatId, roleId, messageId, tabId: binding.tabId, frameId: binding.frameId, currentContentLength: result.currentContent.length })
    const response = await deps.sendRoleMessage(binding.tabId, binding.frameId, {
      type: 'TEAM_RESYNC_REPLY',
      chatId,
      roleId,
      messageId,
      currentContent: result.currentContent,
    })
    if (isRecord(response) && response.ok === false) throw new Error(readOptionalString(response.error) ?? '重新同步回复失败')
    if (isRecord(response) && isRecord(response.store)) {
      const updatedMessage = isRecord(response.message) ? response.message : undefined
      deps.log.warn('message-resync-reply:updated-store', {
        chatId,
        roleId,
        messageId,
        updatedContentLength: typeof updatedMessage?.content === 'string' ? updatedMessage.content.length : undefined,
      })
      return { ok: true, store: response.store as unknown as OpenTeamStore, message: response.message, messageId }
    }
    deps.log.warn('message-resync-reply:no-updated-store', { chatId, roleId, messageId, response })
    return { ok: true, store, messageId }
  }

  return { handleRoleRetryReply, handleRoleStopReply, handleNoteSave, handleMessageHighlightCreate, handleMessageResyncReply }
}

export type MessageActionHandlers = ReturnType<typeof createMessageActionHandlers>
