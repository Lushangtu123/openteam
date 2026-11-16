// The user's message to the group: who it goes to, what each member is sent, and starting a
// discussion, a project or a workflow from it.
import { readMessageUploads } from '../group/messageUploads'
import { isProjectActive } from '../group/project'
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import { isDiscussionRunning, startsDiscussion } from '../group/discussion'
import { defaultMentionTargetForMessage, parseGroupMentions, roleMentionLabelOptionsFromSettings } from '../group/mentionParser'
import type { GroupMessage, GroupRole } from '../group/types'
import type { PromptDelivery } from './promptDelivery'
import { type ExternalPromptDelivery, getExternalModelForRole, isExternalModelRole, prepareRolePromptDelivery } from './rolePromptDelivery'
import type { RuntimeMessage } from './runtimeClient'
import { getChatMessages, getChatRoles, mutateStore, requireChat } from './storeAccess'
import { startOrchestrationRun } from './orchestrationRuntime'
import { sendPromptDeliveries } from './siteDeliveries'
import { isRoleDeliverable, isStaleThinkingRole, readPersonaLength, recoverDeliverableRoleStatus } from './roleState'
import { requireString, resolveOrchestrationMentionFlow, resolveReference } from './messageInput'
import { uploadAttachment, uploadsCopiedFrom } from './messageAttachments'
import type { MessageHandlerContext } from './messageHandlerDeps'
import type { RoundHandlers } from './roundHandlers'

export function createMessageSendHandler(ctx: MessageHandlerContext, roundHandlers: RoundHandlers) {
  const { deps, deliverExternalTogether } = ctx
  const { startDiscussion, projectRunner } = roundHandlers

  const handleMessageSend = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const raw = requireString(message.raw, '消息内容不能为空')
    const timestamp = deps.now()
    const copied = await uploadsCopiedFrom(deps, chatId, message.attachmentsFrom)
    const uploadCheck = readMessageUploads(copied.length > 0 ? [...(Array.isArray(message.uploads) ? message.uploads : []), ...copied] : message.uploads)
    if (!uploadCheck.ok) throw new Error(uploadCheck.error)
    const uploads = uploadCheck.uploads.map(upload => ({ id: deps.newId('attachment'), upload }))
    deps.log.info('message-send:start', { chatId, rawLength: raw.length, uploads: uploads.length })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const roles = getChatRoles(store, chat)
      const parsed = parseGroupMentions(raw, roles, { ...roleMentionLabelOptionsFromSettings(store.settings), defaultTarget: defaultMentionTargetForMessage(raw, chat) })
      if (!parsed.ok) throw new Error(parsed.error)
      if (parsed.orchestrationTarget && uploads.length > 0) throw new Error('编排任务暂不支持附件，请去掉附件后再发送')
      const teamInvitation = message.teamInvitation === true
      const teamRound = typeof message.teamRound === 'number' ? message.teamRound : undefined
      if (teamInvitation && !chat.teamFormation) throw new Error('这个群聊不在组队中')
      // A round is invited once, even when two team pages try at the same time.
      if (teamRound !== undefined && chat.teamFormation?.nextRound !== teamRound) throw new Error('这一轮已经邀请过了')

      if (parsed.orchestrationTarget) {
        const flow = resolveOrchestrationMentionFlow(store, chat, parsed.orchestrationTarget)
        return {
          orchestration: {
            chatId: chat.id,
            flowId: flow.id,
            task: parsed.content,
            maxRounds: flow.maxRounds,
            maxNodeExecutions: flow.maxNodeExecutions,
          },
        }
      }

      let finalTargetRoleIds = parsed.targetRoleIds
      const hasManualRoute = parsed.mentionedRoleIds.length > 0 || Boolean(parsed.mentionsAll) || Boolean(parsed.orchestrationTarget)
      if (chat.requireManualMention && !hasManualRoute) {
        finalTargetRoleIds = []
      }
      deps.log.debug('message-send:parsed-targets', { chatId: chat.id, targetRoleIds: finalTargetRoleIds })

      // While a project runs, what the user sends is a note for its coordinator; an answer to the
      // coordinator's question lets the project go on.
      if (isProjectActive(chat.project)) {
        if (uploads.length > 0) throw new Error('项目进行中，补充的消息暂不支持附件')
        const { note, answered } = projectRunner.addNote(store, chat, raw, timestamp)
        return { message: note, deliveries: [], externalDeliveries: [], resumeProject: answered }
      }
      // While members take turns, what the user sends goes to the next speakers as a note.
      if (isDiscussionRunning(chat) && chat.discussion) {
        if (uploads.length > 0) throw new Error('讨论进行中，补充的消息暂不支持附件')
        const note: GroupMessage = { id: deps.newId('msg'), chatId: chat.id, seq: chat.nextMessageSeq, type: 'user', content: raw, discussionNoteOf: chat.discussion.topicMessageId, targetRoleIds: [], createdAt: timestamp, status: 'received' }
        store.messagesById[note.id] = note
        chat.messageIds.push(note.id)
        chat.nextMessageSeq += 1
        chat.updatedAt = timestamp
        return { message: note, deliveries: [], externalDeliveries: [] }
      }
      if (!teamInvitation && startsDiscussion(chat, finalTargetRoleIds)) {
        return startDiscussion(store, chat, parsed, finalTargetRoleIds, uploads, message.refreshPersona === true, timestamp)
      }

      const targetRoles = finalTargetRoleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
      const unavailable = targetRoles.filter(role => {
        if (isExternalModelRole(role)) return !getExternalModelForRole(store, role)
        return !isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp)
      })
      const deliverableTargetRoles = targetRoles.filter(role => !unavailable.includes(role))

      if (unavailable.length > 0 && deliverableTargetRoles.length === 0) {
        deps.log.warn('message-send:unavailable-targets', {
          chatId: chat.id,
          targets: unavailable.map(role => ({
            id: role.id,
            name: role.name,
            status: role.status,
            updatedAt: role.updatedAt,
            staleThinking: isStaleThinkingRole(role, timestamp),
            binding: isExternalModelRole(role) ? undefined : deps.runtimeFrames.getByRole(chat.id, role.id),
          })),
        })
        throw new Error(`以下成员不可用，请等待或恢复：${unavailable.map(role => role.name).join('、')}`)
      }
      if (unavailable.length > 0) {
        deps.log.warn('message-send:partial-unavailable-targets', {
          chatId: chat.id,
          skippedTargets: unavailable.map(role => ({
            id: role.id,
            name: role.name,
            status: role.status,
            updatedAt: role.updatedAt,
            staleThinking: isStaleThinkingRole(role, timestamp),
            binding: isExternalModelRole(role) ? undefined : deps.runtimeFrames.getByRole(chat.id, role.id),
          })),
          deliverableTargetIds: deliverableTargetRoles.map(role => role.id),
        })
      }

      for (const role of deliverableTargetRoles) recoverDeliverableRoleStatus(role, timestamp, deps.log)

      const reference = resolveReference(store, chat, message.reference ?? (Array.isArray(message.references) ? message.references[0] : undefined), deps.newId)
      const userMessage: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'user',
        content: parsed.content,
        targetRoleIds: finalTargetRoleIds,
        mentionedRoleIds: parsed.mentionedRoleIds,
        mentionsAll: parsed.mentionsAll,
        references: reference ? [reference] : undefined,
        ...(uploads.length > 0 ? { attachments: uploads.map(({ id, upload }) => uploadAttachment(id, upload)) } : {}),
        ...(message.refreshPersona === true ? { refreshPersona: true } : {}),
        createdAt: timestamp,
        status: finalTargetRoleIds.length > 0 ? 'pending' : 'received',
        deliveryStatus: Object.fromEntries(finalTargetRoleIds.map(roleId => [roleId, unavailable.some(role => role.id === roleId) ? 'error' : 'pending'])),
      }
      updateUserMessageDeliveryStatus(userMessage)

      if (teamInvitation && chat.teamFormation) {
        chat.teamFormation.invitationIds.push(userMessage.id)
        chat.teamFormation.status = 'claiming'
        if (teamRound !== undefined) chat.teamFormation.nextRound = teamRound + 1
      }
      store.messagesById[userMessage.id] = userMessage
      chat.messageIds.push(userMessage.id)
      chat.nextMessageSeq += 1
      deps.log.info('message-send:stored', { chatId: chat.id, messageId: userMessage.id, targetCount: parsed.targetRoleIds.length })
      chat.updatedAt = timestamp
      if (finalTargetRoleIds.length === 0) {
        return { message: userMessage, deliveries: [], externalDeliveries: [] }
      }

      chat.status = 'running'

      const messages = getChatMessages(store, chat)
      const deliveries: PromptDelivery[] = []
      const externalDeliveries: ExternalPromptDelivery[] = []
      for (const role of deliverableTargetRoles) {
        const prepared = prepareRolePromptDelivery({ store, chat, role, userMessage, roles, messages, reference, timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })
        if (prepared.delivery) deliveries.push(prepared.delivery)
        if (prepared.externalDelivery) externalDeliveries.push(prepared.externalDelivery)
        if (!prepared.includesPersona && prepared.delivery) {
          deps.log.debug('prompt:persona-skipped', {
            chatId: chat.id,
            roleId: role.id,
            messageId: userMessage.id,
            conversationUrlPresent: Boolean(role.geminiConversationUrl),
            contextCursor: role.contextCursor,
            roleHistoryCount: prepared.roleHistoryCount,
            personaLength: readPersonaLength(role),
          })
        }

        role.status = 'thinking'
        role.lastPromptMessageId = userMessage.id
        role.replyAttemptId = prepared.replyAttemptId
        role.updatedAt = timestamp
      }
      for (const role of unavailable) {
        // A member still waiting for an earlier reply is left as it is, its time too: being skipped
        // must not start that wait over (see isStaleThinkingRole).
        if (role.status === 'thinking' && !isStaleThinkingRole(role, timestamp)) continue
        role.status = 'error'
        role.updatedAt = timestamp
        if (role.lastPromptMessageId === userMessage.id) delete role.lastPromptMessageId
        delete role.replyAttemptId
      }

      return { message: userMessage, deliveries, externalDeliveries }
    })

    const orchestration = 'orchestration' in result ? result.orchestration : undefined
    if (orchestration) {
      deps.log.info('message-send:orchestration-start', { chatId, flowId: orchestration.flowId, taskLength: orchestration.task.length })
      return { ok: true, ...(await startOrchestrationRun(deps, orchestration)) }
    }
    const messageResult = result as { message: GroupMessage; deliveries: PromptDelivery[]; externalDeliveries: ExternalPromptDelivery[]; deliveryMessageId?: string; resumeProject?: boolean }
    if (messageResult.resumeProject) {
      await deps.broadcastStoreUpdated(store)
      const resumed = await projectRunner.resume(chatId)
      return { ok: true, message: messageResult.message, deliveries: [], store: resumed.store }
    }
    // The images must be stored before any delivery reads them.
    const images = uploads.flatMap(({ id, upload }) => upload.kind === 'image' ? [{ id, fileName: upload.fileName, mimeType: upload.mimeType, data: upload.data }] : [])
    if (images.length > 0) {
      if (!deps.imageAttachments?.saveUploads) throw new Error('当前环境不支持图片上传')
      await deps.imageAttachments.saveUploads({ chatId, messageId: messageResult.message.id, images })
    }

    deps.log.info('message-send:deliveries-ready', {
      chatId,
      messageId: messageResult.message.id,
      deliveries: [
        ...messageResult.deliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'site', chatSite: delivery.chatSite, tabId: delivery.tabId, frameId: delivery.frameId, contentLength: delivery.message.content.length })),
        ...messageResult.externalDeliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'external', modelId: delivery.model.id, contentLength: delivery.prompt.length })),
      ],
    })
    await deps.broadcastStoreUpdated(store)

    await sendPromptDeliveries(deps, chatId, messageResult.deliveryMessageId ?? messageResult.message.id, messageResult.deliveries)
    const responseStore = await deliverExternalTogether(messageResult.externalDeliveries) ?? store

    return {
      ok: true,
      message: messageResult.message,
      deliveries: [
        ...messageResult.deliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'site' })),
        ...messageResult.externalDeliveries.map(delivery => ({ roleId: delivery.roleId, modelSource: 'external' })),
      ],
      store: responseStore,
    }
  }

  return { handleMessageSend }
}

export type MessageSendHandler = ReturnType<typeof createMessageSendHandler>
