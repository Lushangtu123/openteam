import { CHAT_SITE_INFO, chatSiteForUrl, isChatSite } from '../group/chatSites'
import { extractSupportedConversationId, getDefaultChatSiteUrlForRole, normalizeSupportedChatConversationUrl } from '../group/conversationUrl'
import { readMessageUploads, type MessageUpload } from '../group/messageUploads'
import { hasRoundSummary, isOpenTeamRequest, pickSummarizer, readSummarizableRound, roundSummaryRequestText } from '../group/roundSummary'
import { crossReviewRequestText, wantsCrossReview } from '../group/collaboration'
import { misreadReplyReason } from '../group/misreadReply'
import { isProjectActive } from '../group/project'
import { REPLY_STUCK_AFTER_MS } from '../group/replyTiming'
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import { settleInterruptedReplies, textReadBeforeInterruption, type InterruptedReplyScope } from './interruptedReplies'
import { createProjectRunner } from './projectRunner'
import { chooseNextSpeaker, discussionMaxTurns, discussionTranscript, discussionTurnRequestText, DISCUSSION_MAX_FAILED_TURNS, isDiscussionRunning, startsDiscussion, turnCountsOf } from '../group/discussion'
import type { LoadedUpload, UploadedImage } from './imageAttachments'
import { normalizeMessageHighlightColor } from '../group/highlightColors'
import { defaultMentionTargetForMessage, parseGroupMentions, roleMentionLabelOptionsFromSettings } from '../group/mentionParser'
import { mapRuntimeRoleStatus } from '../group/runtimeProtocol'
import type { BackgroundToRoleMessage } from '../group/runtimeProtocol'
import type { ChatSite, DiscussionRun, GroupChat, GroupMessage, GroupRole, MessageAttachment, MessageImageAttachment, MessageReference, OpenTeamStore, OrchestrationFlow, ReplyImageSource, RoleSiteHealthReason, RoleSiteHealthStatus, RuntimeFrameBinding, MessageTokenUsage } from '../group/types'
import { createExternalModelClient, type ExternalModelClient, type ExternalModelCompletionInput } from './externalModelClient'
import type { BackgroundMessageRoute } from './messageRouter'
import type { PromptDelivery, PromptSender } from './promptDelivery'
import { DEFAULT_PROMPT_DELIVERY_RETRY_DELAYS_MS, sendPromptDeliveryWithRetry } from './promptDeliveryRetry'
import { getExternalModelForRole, isExternalModelRole, prepareRolePromptDelivery, type ExternalPromptDelivery, type PreparedRolePromptDelivery } from './rolePromptDelivery'
import { messageTabId, rememberHost, senderFrameId, senderTabId, type RuntimeMessage } from './runtimeClient'
import type { RuntimeFrameRegistry } from './runtimeFrames'
import type { SitePromptDeliveryLimiter } from './sitePromptDeliveryLimiter'
import { getChatMessages, getChatRoles, mutateStore, requireChat, requireRole } from './storeAccess'
import { markOrchestrationRoleError, maybeAdvanceOrchestrationRun, startOrchestrationRun } from './orchestrationRuntime'

const STALE_THINKING_MS = REPLY_STUCK_AFTER_MS
const DEFAULT_EXTERNAL_MODEL_RETRY_DELAYS_MS = [2_000, 2_000, 4_000, 8_000, 15_000] as const
// API members of one model replying at the same time.
const EXTERNAL_MODEL_CONCURRENCY = 2
// How often a reply being written is saved and sent to the page. Each time writes the store and sends
// all of it, so a few times a second is enough (the page reveals the text smoothly in between), even
// with several replies streaming at once into a long chat.
const STREAM_UPDATE_INTERVAL_MS = 150
const DEFAULT_ROLE_ERROR_RETRY_DELAYS_MS = [2_000, 8_000] as const

interface ExternalModelRunRegistry {
  register(chatId: string, roleId: string, replyAttemptId: string, controller: AbortController): void
  abort(chatId: string, roleId: string, replyAttemptId?: string): void
  unregister(chatId: string, roleId: string, replyAttemptId: string): void
}

// A live reply longer than this is cut; the finished reply always arrives in full.
const LIVE_REPLY_MAX_CHARS = 60_000
// A round's summary is asked for a moment after its last reply, once that member's page is idle.
const ROUND_SUMMARY_DELAY_MS = 1500

export const MESSAGE_ROUTE_TYPES = [
  'GROUP_ROLE_RETRY_REPLY',
  'GROUP_ROLE_STOP_REPLY',
  'GROUP_NOTE_SAVE',
  'GROUP_MESSAGE_HIGHLIGHT_CREATE',
  'GROUP_MESSAGE_RESYNC_REPLY',
  'GROUP_MESSAGE_SEND',
  'GROUP_ROUND_SUMMARY_REQUEST',
  'GROUP_DISCUSSION_STOP',
  'GROUP_DISCUSSION_CONTINUE',
  'GROUP_PROJECT_START',
  'GROUP_PROJECT_APPROVE',
  'GROUP_PROJECT_REPLAN',
  'GROUP_PROJECT_SET_OWNER',
  'GROUP_PROJECT_STOP',
  'GROUP_PROJECT_CONTINUE',
  'TEAM_FRAME_ROLE_READY',
  'TEAM_ROLE_CONVERSATION_UPDATED',
  'TEAM_SEND_ACK',
  'TEAM_ROLE_STATUS',
  'TEAM_SITE_STATUS_UPDATE',
  'TEAM_ROLE_REPLY',
  'TEAM_ROLE_REPLY_PROGRESS',
  'TEAM_ROLE_REPLY_RESYNC',
  'TEAM_ROLE_ERROR',
  // From the background itself: see interruptedReplies.ts.
  'GROUP_REPLIES_INTERRUPTED',
] as const

// A request OpenTeam sent one member, with its prepared delivery.
export interface OpenTeamRequest {
  request: GroupMessage
  prepared: PreparedRolePromptDelivery
}

export interface MessageHandlersDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
  // Told when a member finished with a message (replied or failed for good), to notify the user
  // once every member it went to has.
  onPromptSettled?(store: OpenTeamStore, chatId: string, promptMessageId: string): Promise<unknown> | void
  getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status']
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  newId(prefix: string): string
  now(): number
  runtimeFrames: Pick<RuntimeFrameRegistry, 'bind' | 'getByAddress' | 'getByRole'>
  sendRoleMessage(tabId: number, frameId: number, message: BackgroundToRoleMessage): Promise<unknown>
  sendError(reason: string): Promise<void> | void
  sendPrompt: PromptSender
  promptDeliveryLimiter?: SitePromptDeliveryLimiter
  externalModelClient?: ExternalModelClient
  externalModelRuns?: ExternalModelRunRegistry
  imageAttachments?: {
    captureReplyImages(input: { chatId: string; messageId: string; images: ReplyImageSource[] }): Promise<MessageImageAttachment[]>
    deleteByIds(ids: string[]): Promise<void>
    saveUploads?(input: { chatId: string; messageId: string; images: UploadedImage[] }): Promise<void>
    loadUploads?(ids: string[]): Promise<LoadedUpload[]>
  }
  deliveryRetryDelaysMs?: readonly number[]
  externalModelRetryDelaysMs?: readonly number[]
  roleErrorRetryDelaysMs?: readonly number[]
  requestRoleRecovery?(chatId: string, roleId: string, reason?: string): Promise<boolean>
  waitForRetry?(ms: number): Promise<void>
}

export function createMessageHandlers(baseDeps: MessageHandlersDependencies): BackgroundMessageRoute[] {
  // A finished round is also when its summary is asked for.
  const deps: MessageHandlersDependencies = {
    ...baseDeps,
    onPromptSettled: (store, chatId, promptMessageId) => {
      const settled = store.messagesById[promptMessageId]
      if (settled?.projectRequest) projectRunner.onSettled(chatId, promptMessageId)
      else if (settled?.discussionTurnOf) scheduleDiscussionAdvance(chatId, promptMessageId)
      else scheduleAfterRound(store, chatId, promptMessageId)
      return baseDeps.onPromptSettled?.(store, chatId, promptMessageId)
    },
  }
  const externalModelClient = deps.externalModelClient ?? createExternalModelClient()
  const externalModelRuns = deps.externalModelRuns ?? createExternalModelRunRegistry()
  const roleErrorRetryCounts = new Map<string, number>()

  // A local agent's run can take many minutes and waits on the user's approvals, so the request that
  // started it does not wait for it; its reply arrives through store updates like any other.
  async function deliverExternal(delivery: ExternalPromptDelivery): Promise<OpenTeamStore | undefined> {
    const run = sendExternalModelDelivery(deps, externalModelClient, externalModelRuns, delivery)
    if (delivery.model.format !== 'local-agent') return run
    void run.catch(error => deps.log.warn('local-agent:delivery-failed', { chatId: delivery.chatId, roleId: delivery.roleId, error: error instanceof Error ? error.message : String(error) }))
    return undefined
  }

  // API members answer at the same time, at most EXTERNAL_MODEL_CONCURRENCY at once on one model (its
  // rate limits); the rest of a model's members wait their turn (排队中). Resolves to the store as the
  // last of them left it, so the page never gets one older than what was broadcast.
  async function deliverExternalTogether(deliveries: ExternalPromptDelivery[]): Promise<OpenTeamStore | undefined> {
    const queues = new Map<string, ExternalPromptDelivery[]>()
    for (const delivery of deliveries) queues.set(delivery.model.id, [...(queues.get(delivery.model.id) ?? []), delivery])
    let latest: OpenTeamStore | undefined
    await Promise.all([...queues.values()].map(queue => Promise.all(
      Array.from({ length: Math.min(EXTERNAL_MODEL_CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          try {
            latest = await deliverExternal(next) ?? latest
          } catch (error) {
            deps.log.warn('external-model:delivery-failed', { chatId: next.chatId, roleId: next.roleId, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }),
    )))
    return latest
  }

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

  // Asks one member to summarize a round: an API member if there is one, else whoever answered
  // first. `auto` requests (when a round finishes) give up quietly when there is nothing to do.
  const requestRoundSummary = async (chatId: string, questionId: string, options: { roleId?: string; auto?: boolean } = {}) => {
    const timestamp = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const question = store.messagesById[questionId]
      if (options.auto && (store.settings.roundSummary === false || (question?.targetRoleIds?.length ?? 0) < 2)) return undefined
      const round = readSummarizableRound(store, chat, question)
      if (!round) {
        if (options.auto) return undefined
        throw new Error('这一轮还不能汇总：需要至少两位成员回复完成')
      }
      if (options.auto && hasRoundSummary(store, chat, round.question.id)) return undefined

      const roles = getChatRoles(store, chat)
      const isAvailable = (role: GroupRole) => role.status !== 'thinking' && (isExternalModelRole(role)
        ? Boolean(getExternalModelForRole(store, role))
        : isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp))
      const summarizer = options.roleId ? roles.find(role => role.id === options.roleId) : pickSummarizer(roles, round, isAvailable)
      if (!summarizer || !isAvailable(summarizer)) {
        if (options.auto) return undefined
        throw new Error('现在没有空闲的成员可以汇总，请稍后再试')
      }

      const request: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'user',
        content: roundSummaryRequestText(store.settings.language),
        targetRoleIds: [summarizer.id],
        mentionedRoleIds: [summarizer.id],
        roundSummaryOf: round.question.id,
        createdAt: timestamp,
        status: 'pending',
        deliveryStatus: { [summarizer.id]: 'pending' },
      }
      store.messagesById[request.id] = request
      chat.messageIds.push(request.id)
      chat.nextMessageSeq += 1
      chat.updatedAt = timestamp
      chat.status = 'running'

      const prepared = prepareRolePromptDelivery({ store, chat, role: summarizer, userMessage: request, roles, messages: getChatMessages(store, chat), timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })
      recoverDeliverableRoleStatus(summarizer, timestamp, deps.log)
      summarizer.status = 'thinking'
      summarizer.lastPromptMessageId = request.id
      summarizer.replyAttemptId = prepared.replyAttemptId
      summarizer.updatedAt = timestamp
      return { request, prepared }
    })
    if (!result) return { ok: true, skipped: true }

    deps.log.info('round-summary:requested', { chatId, questionId, messageId: result.request.id, roleId: result.request.targetRoleIds?.[0], auto: Boolean(options.auto) })
    await deps.broadcastStoreUpdated(store)
    if (result.prepared.delivery) await sendPromptDeliveries(deps, chatId, result.request.id, [result.prepared.delivery])
    let responseStore = store
    if (result.prepared.externalDelivery) responseStore = await deliverExternal(result.prepared.externalDelivery) ?? responseStore
    return { ok: true, message: result.request, store: responseStore }
  }

  // A round that has everyone's answers: in a 互相审 group they review each other's answers first,
  // and the summary is of the reviews; otherwise the round is summarized now.
  function scheduleAfterRound(store: OpenTeamStore, chatId: string, questionId: string): void {
    const chat = store.chatsById[chatId]
    const question = store.messagesById[questionId]
    if (!chat || !wantsCrossReview(chat, question) || !readSummarizableRound(store, chat, question) || hasCrossReview(store, chat, questionId)) {
      scheduleRoundSummary(store, chatId, questionId)
      return
    }
    void (async () => {
      await waitForRetryDelay(deps, ROUND_SUMMARY_DELAY_MS)
      // Members that cannot review (fewer than two free, or the user has moved on): summarize as before.
      if (!await requestCrossReview(chatId, questionId)) await requestRoundSummary(chatId, questionId, { auto: true })
    })().catch(error => deps.log.warn('cross-review:failed', { chatId, questionId, error: error instanceof Error ? error.message : String(error) }))
  }

  // One request to every member that answered; each gets the others' answers in its own prompt.
  // Returns false when no review was started.
  async function requestCrossReview(chatId: string, questionId: string): Promise<boolean> {
    const timestamp = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = store.chatsById[chatId]
      const question = store.messagesById[questionId]
      if (!chat || !question || !wantsCrossReview(chat, question) || hasCrossReview(store, chat, questionId)) return undefined
      if (userMovedOnFrom(store, chat, question)) return undefined
      const round = readSummarizableRound(store, chat, question)
      if (!round) return undefined
      const roles = getChatRoles(store, chat)
      const reviewers = round.replies
        .map(reply => roles.find(role => role.id === reply.role.id))
        .filter((role): role is GroupRole => Boolean(role) && role!.status !== 'thinking' && (isExternalModelRole(role!)
          ? Boolean(getExternalModelForRole(store, role!))
          : isRoleDeliverable(role!, deps.runtimeFrames.getByRole(chat.id, role!.id), timestamp)))
      if (reviewers.length < 2) return undefined

      const request: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'user',
        content: crossReviewRequestText(store.settings.language),
        targetRoleIds: reviewers.map(role => role.id),
        mentionedRoleIds: reviewers.map(role => role.id),
        crossReviewOf: question.id,
        createdAt: timestamp,
        status: 'pending',
        deliveryStatus: Object.fromEntries(reviewers.map(role => [role.id, 'pending' as const])),
      }
      store.messagesById[request.id] = request
      chat.messageIds.push(request.id)
      chat.nextMessageSeq += 1
      chat.updatedAt = timestamp
      chat.status = 'running'

      const messages = getChatMessages(store, chat)
      const prepared = reviewers.map(reviewer => {
        const delivery = prepareRolePromptDelivery({ store, chat, role: reviewer, userMessage: request, roles, messages, timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })
        recoverDeliverableRoleStatus(reviewer, timestamp, deps.log)
        reviewer.status = 'thinking'
        reviewer.lastPromptMessageId = request.id
        reviewer.replyAttemptId = delivery.replyAttemptId
        reviewer.updatedAt = timestamp
        return delivery
      })
      return { request, prepared }
    })
    if (!result) return false

    deps.log.info('cross-review:requested', { chatId, questionId, messageId: result.request.id, reviewers: result.request.targetRoleIds })
    await deps.broadcastStoreUpdated(store)
    await sendPromptDeliveries(deps, chatId, result.request.id, result.prepared.flatMap(item => item.delivery ? [item.delivery] : []))
    await deliverExternalTogether(result.prepared.flatMap(item => item.externalDelivery ? [item.externalDelivery] : []))
    return true
  }

  function scheduleRoundSummary(store: OpenTeamStore, chatId: string, questionId: string): void {
    const chat = store.chatsById[chatId]
    const question = store.messagesById[questionId]
    if (!chat || store.settings.roundSummary === false || (question?.targetRoleIds?.length ?? 0) < 2) return
    if (!readSummarizableRound(store, chat, question) || hasRoundSummary(store, chat, questionId)) return
    void (async () => {
      await waitForRetryDelay(deps, ROUND_SUMMARY_DELAY_MS)
      await requestRoundSummary(chatId, questionId, { auto: true })
    })().catch(error => deps.log.warn('round-summary:failed', { chatId, questionId, error: error instanceof Error ? error.message : String(error) }))
  }

  // Starts a discussion inside the send mutation: the user's message is the topic, and the first
  // member who can speak gets the first turn.
  function startDiscussion(
    store: OpenTeamStore,
    chat: GroupChat,
    parsed: { content: string; mentionedRoleIds: string[]; mentionsAll?: boolean },
    participantIds: string[],
    uploads: Array<{ id: string; upload: MessageUpload }>,
    refreshPersona: boolean,
    timestamp: number,
  ) {
    const roles = getChatRoles(store, chat)
    const topic: GroupMessage = {
      id: deps.newId('msg'),
      chatId: chat.id,
      seq: chat.nextMessageSeq,
      type: 'user',
      content: parsed.content,
      targetRoleIds: participantIds,
      mentionedRoleIds: parsed.mentionedRoleIds,
      mentionsAll: parsed.mentionsAll,
      discussionTopic: true,
      ...(uploads.length > 0 ? { attachments: uploads.map(({ id, upload }) => uploadAttachment(id, upload)) } : {}),
      ...(refreshPersona ? { refreshPersona: true } : {}),
      createdAt: timestamp,
      status: 'received',
    }
    store.messagesById[topic.id] = topic
    chat.messageIds.push(topic.id)
    chat.nextMessageSeq += 1
    chat.updatedAt = timestamp
    const run: DiscussionRun = {
      id: deps.newId('discussion'),
      topicMessageId: topic.id,
      roleIds: participantIds,
      maxTurns: discussionMaxTurns(participantIds.length),
      turn: 0,
      status: 'running',
      failedTurns: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
    }
    chat.discussion = run
    const first = participantIds.map(id => roles.find(role => role.id === id)).find((role): role is GroupRole => Boolean(role && canTakeTurn(store, chat, role, timestamp)))
    if (!first) {
      run.status = 'stopped'
      run.stopReason = 'unavailable'
      throw new Error('参加讨论的成员都不可用，请等待或恢复后再试')
    }
    const turn = startDiscussionTurn(store, chat, run, first, undefined, timestamp)
    deps.log.info('discussion:started', { chatId: chat.id, topicId: topic.id, participants: participantIds.length, maxTurns: run.maxTurns })
    return {
      message: topic,
      deliveryMessageId: turn.request.id,
      deliveries: turn.prepared.delivery ? [turn.prepared.delivery] : [],
      externalDeliveries: turn.prepared.externalDelivery ? [turn.prepared.externalDelivery] : [],
    }
  }

  function canTakeTurn(store: OpenTeamStore, chat: GroupChat, role: GroupRole, timestamp: number): boolean {
    if (role.status === 'thinking' && !isStaleThinkingRole(role, timestamp)) return false
    return isExternalModelRole(role)
      ? Boolean(getExternalModelForRole(store, role))
      : isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp)
  }

  // Sends one member a request from OpenTeam itself (a discussion turn, a project step), inside a
  // store mutation: the request message, its prepared delivery, and the member marked as replying.
  function startOpenTeamRequest(store: OpenTeamStore, chat: GroupChat, role: GroupRole, fields: Pick<GroupMessage, 'content'> & Partial<GroupMessage>, timestamp: number) {
    const request: GroupMessage = {
      id: deps.newId('msg'),
      chatId: chat.id,
      seq: chat.nextMessageSeq,
      type: 'user',
      targetRoleIds: [role.id],
      mentionedRoleIds: [role.id],
      createdAt: timestamp,
      status: 'pending',
      deliveryStatus: { [role.id]: 'pending' },
      ...fields,
    }
    store.messagesById[request.id] = request
    chat.messageIds.push(request.id)
    chat.nextMessageSeq += 1
    chat.updatedAt = timestamp
    chat.status = 'running'

    const prepared = prepareRolePromptDelivery({ store, chat, role, userMessage: request, roles: getChatRoles(store, chat), messages: getChatMessages(store, chat), timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })
    recoverDeliverableRoleStatus(role, timestamp, deps.log)
    role.status = 'thinking'
    role.lastPromptMessageId = request.id
    role.replyAttemptId = prepared.replyAttemptId
    delete role.liveReply
    role.updatedAt = timestamp
    return { request, prepared }
  }

  async function deliverOpenTeamRequest(chatId: string, sent: OpenTeamRequest): Promise<OpenTeamStore | undefined> {
    if (sent.prepared.delivery) await sendPromptDeliveries(deps, chatId, sent.request.id, [sent.prepared.delivery])
    if (sent.prepared.externalDelivery) return deliverExternal(sent.prepared.externalDelivery)
    return undefined
  }

  // Asks one member for the next turn (inside a store mutation).
  function startDiscussionTurn(store: OpenTeamStore, chat: GroupChat, run: DiscussionRun, role: GroupRole, handoffFrom: string | undefined, timestamp: number) {
    run.turn += 1
    const handoffName = handoffFrom ? store.rolesById[handoffFrom]?.name : undefined
    const sent = startOpenTeamRequest(store, chat, role, {
      content: discussionTurnRequestText(run.turn, run.maxTurns, role.name, handoffName, store.settings.language),
      discussionTurnOf: run.topicMessageId,
      discussionTurn: run.turn,
      ...(handoffFrom ? { discussionHandoffFrom: handoffFrom } : {}),
    }, timestamp)
    run.currentRoleId = role.id
    run.currentMessageId = sent.request.id
    run.updatedAt = timestamp
    return sent
  }

  async function deliverDiscussionTurn(chatId: string, turn: OpenTeamRequest): Promise<OpenTeamStore | undefined> {
    return deliverOpenTeamRequest(chatId, turn)
  }

  // After a turn: the next member speaks (the one @-mentioned, or whoever spoke least), until the
  // turns run out, the user stops it, or turns keep failing. A finished discussion is summarized.
  const advanceDiscussion = async (chatId: string, requestId: string) => {
    const timestamp = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = store.chatsById[chatId]
      const run = chat?.discussion
      if (!chat || !run || run.status !== 'running' || run.currentMessageId !== requestId) return undefined
      const transcript = discussionTranscript(store, chat, run.topicMessageId)
      const reply = [...transcript].reverse().find(entry => entry.kind === 'turn' && entry.message.sourceMessageId === requestId)
      run.failedTurns = reply ? 0 : run.failedTurns + 1
      const finish = (status: DiscussionRun['status'], stopReason?: DiscussionRun['stopReason']) => {
        run.status = status
        if (stopReason) run.stopReason = stopReason
        delete run.currentMessageId
        run.updatedAt = timestamp
        chat.updatedAt = timestamp
        return { finished: status, topicId: run.topicMessageId }
      }
      if (run.failedTurns >= DISCUSSION_MAX_FAILED_TURNS) return finish('stopped', 'failed')
      if (run.turn >= run.maxTurns) return finish('done')
      const next = chooseNextSpeaker({ run, roles: getChatRoles(store, chat), turnCounts: turnCountsOf(transcript), lastReply: reply?.message.content, isAvailable: role => canTakeTurn(store, chat, role, timestamp) })
      if (!next) return finish('stopped', 'unavailable')
      return { turn: startDiscussionTurn(store, chat, run, next.role, next.handoffFrom, timestamp) }
    })
    if (!result) return
    await deps.broadcastStoreUpdated(store)
    if ('turn' in result) {
      deps.log.info('discussion:turn', { chatId, turn: result.turn.request.discussionTurn, roleId: result.turn.request.targetRoleIds?.[0], handoff: Boolean(result.turn.request.discussionHandoffFrom) })
      await deliverDiscussionTurn(chatId, result.turn)
      return
    }
    deps.log.info('discussion:finished', { chatId, status: result.finished })
    // A discussion that ran its course is settled like a round: summarized, and notified.
    if (result.finished === 'done') reportPromptSettled(deps, store, chatId, result.topicId)
  }

  function scheduleDiscussionAdvance(chatId: string, requestId: string): void {
    void (async () => {
      await waitForRetryDelay(deps, ROUND_SUMMARY_DELAY_MS)
      await advanceDiscussion(chatId, requestId)
    })().catch(error => deps.log.warn('discussion:advance-failed', { chatId, requestId, error: error instanceof Error ? error.message : String(error) }))
  }

  // Stops a discussion: the member speaking finishes, and nobody speaks after.
  const handleDiscussionStop = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const timestamp = deps.now()
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const run = chat.discussion
      if (!run || run.status !== 'running') return
      run.status = 'stopped'
      run.stopReason = 'user'
      delete run.currentMessageId
      run.updatedAt = timestamp
      chat.updatedAt = timestamp
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  // One more turn for each member of a finished discussion.
  const handleDiscussionContinue = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const timestamp = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const run = chat.discussion
      if (!run || run.status === 'running') throw new Error('没有可以继续的讨论')
      if (!store.messagesById[run.topicMessageId]) throw new Error('找不到讨论的话题，可能已被删除')
      const transcript = discussionTranscript(store, chat, run.topicMessageId)
      run.status = 'running'
      delete run.stopReason
      run.failedTurns = 0
      run.maxTurns = run.turn + run.roleIds.length
      const lastTurn = [...transcript].reverse().find(entry => entry.kind === 'turn')
      const next = chooseNextSpeaker({ run, roles: getChatRoles(store, chat), turnCounts: turnCountsOf(transcript), lastReply: lastTurn?.message.content, isAvailable: role => canTakeTurn(store, chat, role, timestamp) })
      if (!next) {
        run.status = 'stopped'
        run.stopReason = 'unavailable'
        throw new Error('参加讨论的成员都不可用，请等待或恢复后再试')
      }
      return startDiscussionTurn(store, chat, run, next.role, next.handoffFrom, timestamp)
    })
    await deps.broadcastStoreUpdated(store)
    const responseStore = await deliverDiscussionTurn(chatId, result) ?? store
    return { ok: true, message: result.request, store: responseStore }
  }

  const projectRunner = createProjectRunner({
    now: () => deps.now(),
    newId: prefix => deps.newId(prefix),
    log: deps.log,
    broadcastStoreUpdated: store => deps.broadcastStoreUpdated(store),
    waitForStep: ms => waitForRetryDelay(deps, ms),
    canTakeTurn,
    startRequest: (store, chat, role, fields, timestamp) => startOpenTeamRequest(store, chat, role, fields, timestamp),
    deliverRequest: (chatId, sent) => deliverOpenTeamRequest(chatId, sent as OpenTeamRequest),
    reportMilestone: (store, chatId, goalMessageId) => {
      try {
        Promise.resolve(baseDeps.onPromptSettled?.(store, chatId, goalMessageId)).catch(error => deps.log.warn('project:milestone-failed', { error: error instanceof Error ? error.message : String(error) }))
      } catch (error) {
        deps.log.warn('project:milestone-failed', { error: error instanceof Error ? error.message : String(error) })
      }
    },
    attachmentsFor: uploads => uploads.map(upload => uploadAttachment(deps.newId('attachment'), upload)),
  })

  const handleProjectStart = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const uploadCheck = readMessageUploads(message.uploads)
    if (!uploadCheck.ok) throw new Error(uploadCheck.error)
    if (uploadCheck.uploads.some(upload => upload.kind === 'image')) throw new Error('项目暂不支持图片附件，可以附上 PDF、Word 或文本文件')
    return projectRunner.start({
      chatId,
      goal: requireString(message.goal, '请写下项目目标'),
      coordinatorRoleId: readOptionalString(message.coordinatorRoleId),
      maxSteps: typeof message.maxSteps === 'number' ? message.maxSteps : undefined,
      uploads: uploadCheck.uploads,
    })
  }

  const projectRoute = (run: (chatId: string, message: RuntimeMessage) => Promise<unknown>) => async (message: RuntimeMessage) => run(requireString(message.chatId, '缺少群聊 ID'), message)

  const handleRoundSummaryRequest = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const questionId = requireString(message.messageId, '缺少消息 ID')
    return requestRoundSummary(chatId, questionId, { roleId: readOptionalString(message.roleId) })
  }

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

  const handleFrameRoleReady = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const tabId = messageTabId(message, sender)
    if (tabId === undefined) throw new Error('缺少 sender tab')

    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少成员 ID')
    const frameId = senderFrameId(sender)
    const timestamp = deps.now()
    deps.log.info('frame-ready:received', {
      chatId,
      roleId,
      tabId,
      frameId,
      senderTabId: senderTabId(sender),
      hostTabId: message.hostTabId,
      senderUrl: sender.url,
      conversationId: message.conversationId,
      conversationUrl: message.conversationUrl,
    })

    // Validate the chat and role before trusting this frame as their host.
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      if (role.status !== 'thinking') {
        role.status = 'ready'
        role.updatedAt = timestamp
      }
      updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return { role, replyHistory: getRoleReplyHistory(store, chat, role.id) }
    })
    rememberHost(sender, tabId)
    deps.runtimeFrames.bind({ chatId, roleId, tabId, frameId, ready: true, lastSeenAt: timestamp })

    deps.log.info('frame-ready:store-updated', { chatId, roleId, roleName: result.role.name, status: result.role.status, replyHistoryCount: result.replyHistory.length, binding: deps.runtimeFrames.getByRole(chatId, roleId) })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result.role, replyHistory: result.replyHistory, store }
  }

  const handleConversationUpdated = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      const conversationUrl = readOptionalString(message.conversationUrl)
      const lostConversationUrl = conversationLeftFor(role, conversationUrl, store.settings.defaultChatSite)
      if (lostConversationUrl) {
        // The site could not open the member's conversation (or a new chat was started in its
        // window): it is in a new chat now. Its next prompt carries the chat so far again.
        delete role.geminiConversationUrl
        delete role.geminiConversationId
        role.contextCursor = 0
      } else {
        updateConversation(role, conversationUrl, readOptionalString(message.conversationId))
      }
      const timestamp = deps.now()
      // Where the page is says nothing about a reply the member is waiting for (see isStaleThinkingRole).
      if (role.status !== 'thinking') role.updatedAt = timestamp
      chat.updatedAt = timestamp
      return { role, lostConversationUrl }
    })
    if (result.lostConversationUrl) deps.log.warn('conversation:lost', { ...identity, lostConversationUrl: result.lostConversationUrl, pageUrl: readOptionalString(message.conversationUrl) })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result.role, store }
  }

  const handleSendAck = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const messageId = requireString(message.messageId, '缺少消息 ID')
    deps.log.info('send-ack:received', { ...identity, messageId, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      const userMessage = store.messagesById[messageId]
      if (userMessage?.deliveryStatus?.[role.id] === 'pending') {
        userMessage.deliveryStatus[role.id] = 'sent'
        updateUserMessageDeliveryStatus(userMessage)
      }
      if (userMessage) role.contextCursor = Math.max(role.contextCursor, userMessage.seq)
      role.updatedAt = deps.now()
      chat.updatedAt = role.updatedAt
    })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store }
  }

  const handleRoleStatus = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const mappedStatus = mapRuntimeRoleStatus(message.status)
    if (!mappedStatus) return { ok: false, error: '未知成员状态' }

    const identity = readIdentityOptional(deps, message, sender)
    if (!identity) {
      deps.log.warn('role-status:missing-identity', {
        runtimeStatus: message.status,
        mappedStatus,
        error: message.error,
        senderUrl: sender.url,
        tabId: messageTabId(message, sender),
        frameId: senderFrameId(sender),
      })
      return { ok: false, error: '缺少 chatId/roleId，已忽略状态更新' }
    }

    const timestamp = deps.now()
    deps.log.info('role-status:received', {
      ...identity,
      runtimeStatus: message.status,
      mappedStatus,
      error: message.error,
      senderUrl: sender.url,
      tabId: messageTabId(message, sender),
      frameId: senderFrameId(sender),
    })

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      const keepActivePromptError = mappedStatus === 'error' && Boolean(role.lastPromptMessageId)
      role.status = keepActivePromptError ? 'thinking' : mappedStatus
      if (role.status !== 'thinking') delete role.liveReply
      role.updatedAt = timestamp
      if (mappedStatus === 'ready' || (mappedStatus === 'error' && !keepActivePromptError)) delete role.lastPromptMessageId
      if (mappedStatus === 'ready' || (mappedStatus === 'error' && !keepActivePromptError)) delete role.replyAttemptId
      if (mappedStatus === 'stopped') role.replyAttemptId = deps.newId('stopped')
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return role
    })

    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result, store }
  }

  const handleSiteStatusUpdate = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const siteId = readSiteId(message.siteId)
    const status = readSiteHealthStatus(message.status)
    if (!siteId || !status) return { ok: false, error: '未知页面健康状态' }

    const identity = readIdentityOptional(deps, message, sender)
    if (!identity) {
      deps.log.warn('site-status:missing-identity', {
        siteId,
        status,
        detail: readOptionalString(message.detail),
        senderUrl: sender.url,
        tabId: messageTabId(message, sender),
        frameId: senderFrameId(sender),
      })
      return { ok: false, error: '缺少 chatId/roleId，已忽略页面健康状态' }
    }

    const timestamp = deps.now()
    const detail = readOptionalString(message.detail)
    const reason = readSiteHealthReason(message.reason)
    deps.log.info('site-status:received', { ...identity, siteId, status, reason, detail, senderUrl: sender.url })
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      role.siteHealth = {
        siteId,
        status,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
        updatedAt: timestamp,
      }
      // For a member waiting for a reply, only a page that is generating is a sign of that reply
      // (see isStaleThinkingRole); a page that loaded, or is blocked, is not.
      if (role.status !== 'thinking' || status === 'generating') role.updatedAt = timestamp
      chat.updatedAt = timestamp
      return role
    })

    await deps.broadcastStoreUpdated(store)
    return { ok: true, role: result, store }
  }

  const handleRoleReply = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const content = readReplyContent(message.content)
    const images = readReplyImageSources(message.images)
    if (!content && images.length === 0) throw new Error('回复内容不能为空')
    if (images.length > 0 && !isBoundImageSender(deps, identity, message, sender)) throw new Error('图片回复只能来自已绑定的 ChatGPT、Gemini、Grok 或 Qwen 页面')
    const contentFormat = message.contentFormat === 'markdown' ? 'markdown' : undefined
    const promptMessageId = readOptionalString(message.messageId)
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    const timestamp = deps.now()
    const replyMessageId = deps.newId('msg')
    const attachments = images.length > 0
      ? await requireImageAttachmentService(deps).captureReplyImages({ chatId: identity.chatId, messageId: replyMessageId, images })
      : undefined
    deps.log.info('role-reply:received', { ...identity, promptMessageId, replyAttemptId, contentLength: content.length, imageCount: images.length, senderUrl: sender.url })

    let mutation: Awaited<ReturnType<typeof mutateStore<{ ignored: true; reason: string; roleId: string; promptMessageId: string | undefined; misread?: string } | { ignored: false; reply: GroupMessage }>>>
    try {
      mutation = await mutateStore(store => {
        const chat = requireChat(store, identity.chatId)
        const role = requireRole(store, chat.id, identity.roleId)
        const staleReason = staleReplyReason(store, chat, role, promptMessageId, replyAttemptId)
        if (staleReason) {
          return { ignored: true as const, reason: staleReason, roleId: role.id, promptMessageId }
        }

        // Read from the wrong place on the page: not taken as the reply, which fails instead, so it
        // can be synced again.
        const previousReply = [...chat.messageIds].reverse().map(id => store.messagesById[id]).find(item => item?.type === 'assistant' && item.roleId === role.id && item.status === 'received')
        const misread = promptMessageId && images.length === 0 ? misreadReplyReason(content, previousReply?.content) : undefined
        if (misread && promptMessageId) {
          const reason = `没有读到它真正的回复（${misread}），可以点「重新同步完整回复」再读一次`
          upsertFailedAssistantAfterPrompt(store, chat, role, promptMessageId, reason, timestamp, deps.newId)
          const userMessage = store.messagesById[promptMessageId]
          if (userMessage?.deliveryStatus?.[role.id]) {
            userMessage.deliveryStatus[role.id] = 'error'
            updateUserMessageDeliveryStatus(userMessage)
          }
          role.status = 'ready'
          role.updatedAt = timestamp
          delete role.liveReply
          if (role.lastPromptMessageId === promptMessageId) delete role.lastPromptMessageId
          delete role.replyAttemptId
          chat.status = deps.getChatStatusFromRoles(store, chat)
          chat.updatedAt = timestamp
          return { ignored: true as const, reason, roleId: role.id, promptMessageId, misread }
        }

        updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))

        const reply: GroupMessage = {
          id: replyMessageId,
          chatId: chat.id,
          seq: chat.nextMessageSeq,
          type: 'assistant',
          content,
          contentFormat,
          ...(attachments?.length ? { attachments } : {}),
          roleId: role.id,
          roleName: role.name,
          sourceMessageId: promptMessageId,
          createdAt: timestamp,
          status: 'received',
        }
        store.messagesById[reply.id] = reply
        chat.messageIds.push(reply.id)
        chat.nextMessageSeq += 1
        markChatHasNewMessage(store, chat)

        if (promptMessageId) {
          const userMessage = store.messagesById[promptMessageId]
          if (userMessage?.deliveryStatus?.[role.id]) {
            userMessage.deliveryStatus[role.id] = 'received'
            updateUserMessageDeliveryStatus(userMessage)
          }
        }

        role.status = 'ready'
        role.lastReplyAt = timestamp
        role.updatedAt = timestamp
        delete role.liveReply
        if (!promptMessageId || role.lastPromptMessageId === promptMessageId) delete role.lastPromptMessageId
        if (!replyAttemptId || role.replyAttemptId === replyAttemptId) delete role.replyAttemptId
        chat.status = deps.getChatStatusFromRoles(store, chat)
        chat.updatedAt = timestamp
        return { ignored: false as const, reply }
      })
    } catch (error) {
      await deleteReadyAttachmentsBestEffort(deps, attachments, 'role-reply:attachment-cleanup-failed')
      throw error
    }
    const { store, result } = mutation

    if (result.ignored) {
      await deleteReadyAttachmentsBestEffort(deps, attachments, 'role-reply:attachment-cleanup-failed')
      if (result.misread && promptMessageId) {
        deps.log.warn('role-reply:misread', { ...identity, promptMessageId, misread: result.misread, contentLength: content.length })
        await deps.broadcastStoreUpdated(store)
        reportPromptSettled(deps, store, identity.chatId, promptMessageId)
        await deps.promptDeliveryLimiter?.complete(identity.chatId, promptMessageId, identity.roleId)
        return { ok: true, ignored: true, reason: result.reason, store }
      }
      deps.log.warn('role-reply:ignored-stale', { ...identity, promptMessageId: result.promptMessageId, reason: result.reason })
      return { ok: true, ignored: true, reason: result.reason, store }
    }

    deps.log.info('role-reply:stored', { chatId: result.reply.chatId, roleId: result.reply.roleId, replyMessageId: result.reply.id })
    await deps.broadcastStoreUpdated(store)
    if (promptMessageId) reportPromptSettled(deps, store, identity.chatId, promptMessageId)
    if (promptMessageId) clearRoleErrorRetryCount(roleErrorRetryCounts, identity.chatId, identity.roleId, promptMessageId)
    if (promptMessageId) await deps.promptDeliveryLimiter?.complete(identity.chatId, promptMessageId, identity.roleId)
    if (promptMessageId) await maybeAdvanceOrchestrationRun(deps, { chatId: identity.chatId, roleId: identity.roleId, promptMessageId, replyMessage: result.reply })
    return { ok: true, message: result.reply, store }
  }

  // What a web member has written so far. It lives on the role until the finished reply arrives,
  // so the chat can show it without adding a message.
  const handleRoleReplyProgress = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const content = readReplyContent(message.content).slice(0, LIVE_REPLY_MAX_CHARS)
    const promptMessageId = readOptionalString(message.messageId)
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    if (!content || !promptMessageId) return { ok: true, ignored: true, reason: 'empty-progress' }
    const contentFormat = message.contentFormat === 'markdown' ? 'markdown' : undefined
    const timestamp = deps.now()

    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      if (role.status !== 'thinking') return { ignored: true as const, reason: 'role-not-replying' }
      const staleReason = staleReplyReason(store, chat, role, promptMessageId, replyAttemptId)
      if (staleReason) return { ignored: true as const, reason: staleReason }
      if (role.liveReply?.promptMessageId === promptMessageId && role.liveReply.content === content) return { ignored: true as const, reason: 'unchanged' }
      role.liveReply = {
        promptMessageId,
        ...(replyAttemptId ? { replyAttemptId } : {}),
        content,
        ...(contentFormat ? { contentFormat } : {}),
        updatedAt: timestamp,
      }
      // Text still arriving shows the member is alive, like a status heartbeat.
      role.updatedAt = timestamp
      return { ignored: false as const }
    })

    if (result.ignored) return { ok: true, ignored: true, reason: result.reason }
    await deps.broadcastStoreUpdated(store)
    return { ok: true }
  }

  const handleRoleReplyResync = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const messageId = requireString(message.messageId, '缺少消息 ID')
    const content = readReplyContent(message.content)
    const images = readReplyImageSources(message.images)
    if (!content && images.length === 0) throw new Error('回复内容不能为空')
    if (images.length > 0 && !isBoundImageSender(deps, identity, message, sender)) throw new Error('图片回复只能来自已绑定的 ChatGPT、Gemini、Grok 或 Qwen 页面')
    const contentFormat = message.contentFormat === 'markdown' ? 'markdown' : undefined
    const timestamp = deps.now()
    const attachments = images.length > 0
      ? await requireImageAttachmentService(deps).captureReplyImages({ chatId: identity.chatId, messageId, images })
      : []
    deps.log.info('role-reply-resync:received', { ...identity, messageId, contentLength: content.length, imageCount: images.length, senderUrl: sender.url })

    let mutation: Awaited<ReturnType<typeof mutateStore<{ message: GroupMessage; previousAttachmentIds: string[] }>>>
    try {
      mutation = await mutateStore(store => {
        const chat = requireChat(store, identity.chatId)
        const role = requireRole(store, chat.id, identity.roleId)
        const assistantMessage = store.messagesById[messageId]
        if (!isAssistantMessageForRole(assistantMessage, chat, role)) throw new Error('该回复不属于这位成员')

        const previousAttachmentIds = readyAttachmentIds(assistantMessage.attachments)
        updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
        assistantMessage.content = content
        assistantMessage.contentFormat = contentFormat
        assistantMessage.attachments = attachments.length > 0 ? attachments : undefined
        assistantMessage.status = 'received'
        // A reply that had not been read (it was interrupted) counts as received once read in full.
        const question = assistantMessage.sourceMessageId ? store.messagesById[assistantMessage.sourceMessageId] : undefined
        if (question?.deliveryStatus?.[role.id] === 'error') {
          question.deliveryStatus[role.id] = 'received'
          updateUserMessageDeliveryStatus(question)
        }
        chat.updatedAt = timestamp
        return { message: assistantMessage, previousAttachmentIds }
      })
    } catch (error) {
      await deleteReadyAttachmentsBestEffort(deps, attachments, 'role-reply-resync:attachment-cleanup-failed')
      throw error
    }
    const { store, result } = mutation
    await deleteAttachmentIdsBestEffort(deps, result.previousAttachmentIds, 'role-reply-resync:previous-attachment-cleanup-failed')

    deps.log.info('role-reply-resync:stored', { chatId: result.message.chatId, roleId: result.message.roleId, replyMessageId: result.message.id })
    await deps.broadcastStoreUpdated(store)
    return { ok: true, message: result.message, store }
  }

  // Ends the replies their members can no longer give (see interruptedReplies.ts), and lets what
  // waits for them go on, as when a member reports that its reply failed.
  const handleRepliesInterrupted = async (message: RuntimeMessage) => {
    const scope: InterruptedReplyScope = {
      siteMembers: message.siteMembers === true,
      apiMembers: message.apiMembers === true,
      ...(typeof message.quietSince === 'number' ? { quietSince: message.quietSince } : {}),
    }
    const { store, result: settled } = await mutateStore(store => settleInterruptedReplies(store, { ...scope, timestamp: deps.now(), newId: deps.newId, getChatStatusFromRoles: deps.getChatStatusFromRoles }))
    if (settled.length === 0) return { ok: true, settled }

    deps.log.warn('replies-interrupted', { scope, settled })
    await deps.broadcastStoreUpdated(store)
    for (const { chatId, roleId, promptMessageId } of settled) {
      if (!promptMessageId) continue
      reportPromptSettled(deps, store, chatId, promptMessageId)
      clearRoleErrorRetryCount(roleErrorRetryCounts, chatId, roleId, promptMessageId)
      await deps.promptDeliveryLimiter?.complete(chatId, promptMessageId, roleId)
      await markOrchestrationRoleError(deps, { chatId, roleId, promptMessageId, error: '回复中断' })
    }
    return { ok: true, settled }
  }

  const handleRoleError = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const reason = readOptionalString(message.reason) ?? readOptionalString(message.error) ?? '人员执行失败'
    const promptMessageId = readOptionalString(message.messageId)
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    deps.log.warn('role-error:received', { ...identity, promptMessageId, replyAttemptId, reason, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })

    const retry = promptMessageId
      ? await prepareRoleErrorRetry(deps, roleErrorRetryCounts, identity.chatId, identity.roleId, promptMessageId, replyAttemptId, reason)
      : undefined
    if (retry) {
      await deps.broadcastStoreUpdated(retry.store)
      deps.log.warn('role-error:retry-scheduled', {
        chatId: identity.chatId,
        roleId: identity.roleId,
        messageId: promptMessageId,
        retryCount: retry.retryCount,
        delayMs: retry.delayMs,
        reason,
      })
      await waitForRetryDelay(deps, retry.delayMs)
      if (retry.externalDelivery) {
        const responseStore = await deliverExternal(retry.externalDelivery) ?? retry.store
        return { ok: true, retried: true, store: responseStore }
      }
      await enqueuePromptDelivery(deps, identity.chatId, promptMessageId!, retry.delivery)
      return { ok: true, retried: true, store: retry.store }
    }

    const timestamp = deps.now()
    const { store } = await mutateStore(store => {
      const chat = requireChat(store, identity.chatId)
      const role = requireRole(store, chat.id, identity.roleId)
      role.status = 'error'
      role.updatedAt = timestamp
      delete role.liveReply
      if (!promptMessageId || role.lastPromptMessageId === promptMessageId) delete role.lastPromptMessageId
      if (!replyAttemptId || role.replyAttemptId === replyAttemptId) delete role.replyAttemptId

      if (promptMessageId) {
        const userMessage = store.messagesById[promptMessageId]
        if (userMessage?.deliveryStatus?.[role.id]) {
          userMessage.deliveryStatus[role.id] = 'error'
          updateUserMessageDeliveryStatus(userMessage)
        }
        if (isUserMessageForRole(userMessage, chat, role)) {
          upsertFailedAssistantAfterPrompt(store, chat, role, promptMessageId, reason, timestamp, deps.newId)
        }
      }
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = role.updatedAt
    })

    await deps.broadcastStoreUpdated(store)
    if (promptMessageId) reportPromptSettled(deps, store, identity.chatId, promptMessageId)
    await deps.sendError(reason)
    if (promptMessageId) clearRoleErrorRetryCount(roleErrorRetryCounts, identity.chatId, identity.roleId, promptMessageId)
    if (promptMessageId) await deps.promptDeliveryLimiter?.complete(identity.chatId, promptMessageId, identity.roleId)
    if (promptMessageId) await markOrchestrationRoleError(deps, { chatId: identity.chatId, roleId: identity.roleId, promptMessageId, error: reason })
    return { ok: true, store }
  }

  return [
    { type: 'GROUP_ROLE_RETRY_REPLY', handler: handleRoleRetryReply },
    { type: 'GROUP_ROLE_STOP_REPLY', handler: handleRoleStopReply },
    { type: 'GROUP_NOTE_SAVE', handler: handleNoteSave },
    { type: 'GROUP_MESSAGE_HIGHLIGHT_CREATE', handler: handleMessageHighlightCreate },
    { type: 'GROUP_MESSAGE_RESYNC_REPLY', handler: handleMessageResyncReply },
    { type: 'GROUP_MESSAGE_SEND', handler: handleMessageSend },
    { type: 'GROUP_ROUND_SUMMARY_REQUEST', handler: handleRoundSummaryRequest },
    { type: 'GROUP_DISCUSSION_STOP', handler: handleDiscussionStop },
    { type: 'GROUP_DISCUSSION_CONTINUE', handler: handleDiscussionContinue },
    { type: 'GROUP_PROJECT_START', handler: handleProjectStart },
    { type: 'GROUP_PROJECT_APPROVE', handler: projectRoute(chatId => projectRunner.approve(chatId)) },
    { type: 'GROUP_PROJECT_REPLAN', handler: projectRoute(chatId => projectRunner.replan(chatId)) },
    { type: 'GROUP_PROJECT_SET_OWNER', handler: projectRoute((chatId, message) => projectRunner.setTaskOwner(chatId, requireString(message.taskId, '缺少任务 ID'), requireString(message.roleId, '缺少成员 ID'))) },
    { type: 'GROUP_PROJECT_STOP', handler: projectRoute(chatId => projectRunner.stop(chatId)) },
    { type: 'GROUP_PROJECT_CONTINUE', handler: projectRoute(chatId => projectRunner.resume(chatId)) },
    {
      type: 'TEAM_FRAME_ROLE_READY',
      handler: (message, sender) => readOptionalString(message.chatId) ? handleFrameRoleReady(message, sender) : { ok: false, error: 'TEAM_FRAME_ROLE_READY 缺少 chatId' },
    },
    { type: 'TEAM_ROLE_CONVERSATION_UPDATED', handler: handleConversationUpdated },
    { type: 'TEAM_SEND_ACK', handler: handleSendAck },
    { type: 'TEAM_ROLE_STATUS', handler: handleRoleStatus },
    { type: 'TEAM_SITE_STATUS_UPDATE', handler: handleSiteStatusUpdate },
    { type: 'TEAM_ROLE_REPLY', handler: handleRoleReply },
    { type: 'TEAM_ROLE_REPLY_PROGRESS', handler: handleRoleReplyProgress },
    { type: 'TEAM_ROLE_REPLY_RESYNC', handler: handleRoleReplyResync },
    { type: 'TEAM_ROLE_ERROR', handler: handleRoleError },
    { type: 'GROUP_REPLIES_INTERRUPTED', handler: handleRepliesInterrupted },
  ]
}

function getRoleReplyHistory(store: OpenTeamStore, chat: GroupChat, roleId: string, limit = 100): string[] {
  return getChatMessages(store, chat)
    .filter(message => message.type === 'assistant' && message.roleId === roleId && message.content.trim())
    .slice(-limit)
    .map(message => message.content)
}

function staleReplyReason(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string | undefined, replyAttemptId?: string): string | undefined {
  if (!promptMessageId) return 'missing-prompt-message-id'
  if (role.lastPromptMessageId !== promptMessageId) return 'prompt-message-mismatch'
  if (replyAttemptId && role.replyAttemptId && role.replyAttemptId !== replyAttemptId) return 'reply-attempt-mismatch'

  const userMessage = store.messagesById[promptMessageId]
  if (!userMessage || userMessage.chatId !== chat.id || userMessage.type !== 'user') return 'prompt-message-not-found'

  const deliveryStatus = userMessage.deliveryStatus?.[role.id]
  if (deliveryStatus !== 'pending' && deliveryStatus !== 'sent') return `delivery-already-${deliveryStatus ?? 'missing'}`

  return undefined
}

function markChatHasNewMessage(store: OpenTeamStore, chat: GroupChat): void {
  if (store.currentChatId === chat.id) return
  store.viewState ??= { chatReadSeqById: {}, chatHasNewMessageById: {} }
  store.viewState.chatHasNewMessageById ??= {}
  store.viewState.chatHasNewMessageById[chat.id] = true
}

function readIdentity(deps: MessageHandlersDependencies, message: RuntimeMessage, sender: chrome.runtime.MessageSender): { chatId: string; roleId: string } {
  const identity = readIdentityOptional(deps, message, sender)
  if (identity) return identity
  throw new Error('缺少 chatId/roleId')
}

function readIdentityOptional(deps: MessageHandlersDependencies, message: RuntimeMessage, sender: chrome.runtime.MessageSender): { chatId: string; roleId: string } | undefined {
  const chatId = readOptionalString(message.chatId)
  const roleId = readOptionalString(message.roleId)
  if (chatId && roleId) return { chatId, roleId }

  const tabId = messageTabId(message, sender)
  if (tabId !== undefined) {
    const binding = deps.runtimeFrames.getByAddress(tabId, senderFrameId(sender))
    if (binding) return { chatId: binding.chatId, roleId: binding.roleId }
  }

  return undefined
}

function updateConversation(role: GroupRole, conversationUrl: string | undefined, conversationId: string | undefined): void {
  const safeUrl = normalizeSupportedChatConversationUrl(conversationUrl)
  const conversationIdFromUrl = extractSupportedConversationId(safeUrl)
  if (safeUrl && conversationIdFromUrl) {
    role.geminiConversationUrl = safeUrl
    role.geminiConversationId = conversationIdFromUrl
    return
  }

  if (isMeaningfulConversationId(conversationId)) role.geminiConversationId = conversationId
}

// The member's window shows its site's start page (a new chat) although it had a conversation, and
// it is not waiting on a reply (just after a prompt the site is still on its start page). Returns the
// conversation it had. A login page or any other page is not a start page.
function conversationLeftFor(role: GroupRole, pageUrl: string | undefined, defaultChatSite: GroupRole['chatSite']): string | undefined {
  const savedUrl = role.geminiConversationUrl
  if (!savedUrl || !extractSupportedConversationId(savedUrl) || role.status === 'thinking') return undefined
  const safeUrl = normalizeSupportedChatConversationUrl(pageUrl)
  const site = chatSiteForUrl(safeUrl)
  if (!safeUrl || !site || site !== chatSiteForUrl(savedUrl) || extractSupportedConversationId(safeUrl)) return undefined
  const path = (url: string) => new URL(url).pathname.replace(/\/+$/, '')
  const startPaths = new Set(['', path(CHAT_SITE_INFO[site].homeUrl), path(getDefaultChatSiteUrlForRole(role, defaultChatSite))])
  // Gemini's start page is /app.
  if (site === 'gemini') startPaths.add('/app')
  return startPaths.has(path(safeUrl)) ? savedUrl : undefined
}

function hasCrossReview(store: OpenTeamStore, chat: GroupChat, questionId: string): boolean {
  return chat.messageIds.some(id => store.messagesById[id]?.crossReviewOf === questionId)
}

// The user has written again since the message (their own message, not one of OpenTeam's requests).
function userMovedOnFrom(store: OpenTeamStore, chat: GroupChat, message: GroupMessage): boolean {
  return chat.messageIds.some(id => {
    const later = store.messagesById[id]
    return Boolean(later && later.seq > message.seq && later.type === 'user' && !isOpenTeamRequest(later))
  })
}

function isMeaningfulConversationId(value: string | undefined): value is string {
  return Boolean(value && value !== '__default__')
}

async function markDeliveryError(deps: MessageHandlersDependencies, chatId: string, roleId: string, messageId: string, reason: string): Promise<OpenTeamStore> {
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

type PreparedRoleErrorRetry = {
  store: OpenTeamStore
  retryCount: number
  delayMs: number
} & (
  | { delivery: PromptDelivery; externalDelivery?: undefined }
  | { delivery?: undefined; externalDelivery: ExternalPromptDelivery }
)

async function prepareRoleErrorRetry(
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

function isRetryableRoleError(reason: string): boolean {
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

function clearRoleErrorRetryCount(retryCounts: Map<string, number>, chatId: string, roleId: string, messageId: string): void {
  retryCounts.delete(roleErrorRetryKey(chatId, roleId, messageId))
}

function roleErrorRetryKey(chatId: string, roleId: string, messageId: string): string {
  return `${chatId}:${roleId}:${messageId}`
}

async function isPromptDeliveryStillActive(
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

function hasAssistantReplyAfterPrompt(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): boolean {
  const promptIndex = chat.messageIds.indexOf(promptMessageId)
  if (promptIndex < 0) return false
  for (let index = promptIndex + 1; index < chat.messageIds.length; index += 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isAssistantMessageForRole(message, chat, role) && (message.status === 'received' || Boolean(message.content.trim()))) return true
  }
  return false
}

async function waitForRetryDelay(deps: MessageHandlersDependencies, delayMs: number): Promise<void> {
  if (delayMs <= 0) return
  if (deps.waitForRetry) {
    await deps.waitForRetry(delayMs)
    return
  }
  await new Promise<void>(resolve => setTimeout(resolve, delayMs))
}

async function sendPromptDeliveries(deps: MessageHandlersDependencies, chatId: string, messageId: string, deliveries: PromptDelivery[]): Promise<void> {
  await Promise.all(deliveries.map(delivery => enqueuePromptDelivery(deps, chatId, messageId, delivery)))
}

async function enqueuePromptDelivery(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery): Promise<void> {
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

async function sendPromptDelivery(deps: MessageHandlersDependencies, chatId: string, messageId: string, delivery: PromptDelivery): Promise<boolean> {
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

async function sendExternalModelDelivery(deps: MessageHandlersDependencies, client: ExternalModelClient, runs: ExternalModelRunRegistry, delivery: ExternalPromptDelivery): Promise<OpenTeamStore | undefined> {
  const controller = new AbortController()
  runs.register(delivery.chatId, delivery.roleId, delivery.replyAttemptId, controller)
  let replyMessageId: string | undefined
  let content = ''
  let usage: MessageTokenUsage | undefined
  const onUsage = (value: MessageTokenUsage) => { usage = value }
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
        let updatedAt = Number.NEGATIVE_INFINITY
        const stream = typeof client.stream === 'function'
          ? client.stream({ model: delivery.model, prompt: delivery.prompt, images, abortSignal: controller.signal, onUsage, context })
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

    const finalized = await finishExternalAssistantReply(deps, delivery, replyMessageId, content, usage)
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

async function createExternalAssistantPlaceholder(
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

async function updateExternalAssistantContent(
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
function isPermanentModelError(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

async function markExternalAssistantRetrying(
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

async function finishExternalAssistantReply(
  deps: MessageHandlersDependencies,
  delivery: ExternalPromptDelivery,
  replyMessageId: string,
  content: string,
  usage?: MessageTokenUsage,
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
      delete reply.retry
      if (usage) reply.usage = usage
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

async function markExternalAssistantStopped(
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isReceiverDisconnectedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Could not establish connection') || message.includes('Receiving end does not exist')
}

function finalizeActiveExternalAssistantReply(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): boolean {
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

// Copies of the files attached to another of the user's messages in the chat, for a message that
// should carry them too (each invitation of a team carries the task's files).
async function uploadsCopiedFrom(deps: MessageHandlersDependencies, chatId: string, sourceId: unknown): Promise<unknown[]> {
  const id = readOptionalString(sourceId)
  if (!id) return []
  const { result: attachments } = await mutateStore(store => {
    const source = store.messagesById[id]
    if (!source || source.chatId !== chatId || source.type !== 'user') throw new Error('找不到要附带的资料，可能已被删除')
    return source.attachments ?? []
  })
  const imageIds = attachments.filter(attachment => attachment.type === 'image' && attachment.status === 'ready' && attachment.source === 'user-upload').map(attachment => attachment.id)
  if (imageIds.length > 0 && !deps.imageAttachments?.loadUploads) throw new Error('当前环境不支持附带图片')
  const images = new Map((imageIds.length > 0 ? await deps.imageAttachments!.loadUploads!(imageIds) : []).map((upload, index) => [imageIds[index], upload]))
  return attachments.flatMap((attachment): unknown[] => {
    if (attachment.type === 'file') return [{ kind: 'text', fileName: attachment.fileName, mimeType: attachment.mimeType, text: attachment.text }]
    const image = images.get(attachment.id)
    return image ? [{ kind: 'image', fileName: image.fileName, mimeType: image.mimeType, data: image.data }] : []
  })
}

function reportPromptSettled(deps: MessageHandlersDependencies, store: OpenTeamStore, chatId: string, promptMessageId: string): void {
  try {
    Promise.resolve(deps.onPromptSettled?.(store, chatId, promptMessageId)).catch(error => deps.log.warn('prompt-settled:failed', { error: error instanceof Error ? error.message : String(error) }))
  } catch (error) {
    deps.log.warn('prompt-settled:failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

// Stopping a web member keeps what it had written as its reply, like an API member's.
function keepLiveReplyAsMessage(
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

function findPendingAssistantAfterPrompt(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): AssistantGroupMessage | undefined {
  const promptIndex = chat.messageIds.indexOf(promptMessageId)
  if (promptIndex < 0) return undefined

  for (let index = chat.messageIds.length - 1; index > promptIndex; index -= 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isAssistantMessageForRole(message, chat, role) && message.status === 'pending') return message
  }
  return undefined
}

function findFailedOrPendingAssistantAfterPrompt(store: OpenTeamStore, chat: GroupChat, role: GroupRole, promptMessageId: string): AssistantGroupMessage | undefined {
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

function upsertFailedAssistantAfterPrompt(
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

function roleFailureReplyContent(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized === 'send_failed') return '⚠️ 发送失败，请检查 AI 窗口是否开启或尝试刷新页面。\n\n可以点击下方的重新回复按钮再试一次。'
  if (normalized === 'response_not_found') return '⚠️ 未检测到回复，可能是 AI 响应过慢或 DOM 结构已变更。\n\n可以点击下方的重新同步完整回复按钮尝试恢复。'
  if (normalized === 'timeout') return '⚠️ 回复超时了。\n\n可以点击下方的重新回复按钮再试一次。'
  if (normalized === 'site_blocked') return '⚠️ 站点阻断，请检查登录状态或处理 Cookie 弹窗。\n\n处理完成后点击重新回复。'
  if (/超时|timeout/i.test(reason)) return '回复超时了。\n\n可以点击下方的重新回复按钮再试一次。'
  return `回复失败：${reason}\n\n可以点击下方的重新回复按钮再试一次。`
}

function throwIfAborted(signal: AbortSignal): void {
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

function createExternalModelRunRegistry(): ExternalModelRunRegistry {
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

function externalModelRunKey(chatId: string, roleId: string, replyAttemptId: string): string {
  return `${chatId}:${roleId}:${replyAttemptId}`
}

// A member waiting for a reply counts as stuck once nothing has moved that reply for a while (see
// ../group/replyTiming), and can then be sent to again. role.updatedAt is the clock: while the member waits, only signs
// of the reply set it (the prompt going out, text arriving, the page saying it is generating).
// Other news about the member (its page loaded, the chat was closed, a message skipped it) leaves
// it alone, or a member that never answers would look busy for as long as the group is in use.
function isStaleThinkingRole(role: GroupRole, timestamp: number): boolean {
  return role.status === 'thinking' && timestamp - role.updatedAt >= STALE_THINKING_MS
}

function isRoleDeliverable(role: GroupRole, binding: RuntimeFrameBinding | undefined, timestamp: number): boolean {
  if (!binding?.ready) return false
  return role.status === 'ready' || role.status === 'error' || role.status === 'stopped' || role.status === 'loading' || role.status === 'pending' || isStaleThinkingRole(role, timestamp)
}

function recoverDeliverableRoleStatus(role: GroupRole, timestamp: number, log: MessageHandlersDependencies['log']): void {
  if (role.status === 'ready') return

  log.warn('role:auto-recover-status', { roleId: role.id, roleName: role.name, previousStatus: role.status, lastPromptMessageId: role.lastPromptMessageId })
  role.status = 'ready'
  delete role.lastPromptMessageId
  delete role.replyAttemptId
  role.updatedAt = timestamp
}

function readPersonaLength(role: GroupRole): number {
  return (role.systemPrompt?.trim() || role.description?.trim() || role.name.trim()).length
}

type UserGroupMessage = GroupMessage & { type: 'user' }
type AssistantGroupMessage = GroupMessage & { type: 'assistant' }

function isUserMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is UserGroupMessage {
  return Boolean(
    message &&
      message.chatId === chat.id &&
      message.type === 'user' &&
      (!message.targetRoleIds || message.targetRoleIds.includes(role.id)),
  )
}

function isAssistantMessageForRole(message: GroupMessage | undefined, chat: GroupChat, role: GroupRole): message is AssistantGroupMessage {
  return Boolean(message && message.chatId === chat.id && message.type === 'assistant' && message.roleId === role.id)
}

function isPendingRetryStatus(message: GroupMessage, role: GroupRole): boolean {
  const deliveryStatus = message.deliveryStatus?.[role.id]
  return deliveryStatus === 'pending' || deliveryStatus === 'sent'
}

function findLatestPendingRetryMessage(store: OpenTeamStore, chat: GroupChat, role: GroupRole): GroupMessage | undefined {
  for (const messageId of [...chat.messageIds].reverse()) {
    const message = store.messagesById[messageId]
    if (isUserMessageForRole(message, chat, role) && isPendingRetryStatus(message, role)) return message
  }
  return undefined
}

interface RetryTarget {
  userMessage: GroupMessage
  discardMessageId?: string
}

function resolveRetryTarget(
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

function findPromptBeforeAssistant(store: OpenTeamStore, chat: GroupChat, role: GroupRole, assistantMessageId: string): GroupMessage | undefined {
  const assistantIndex = chat.messageIds.indexOf(assistantMessageId)
  if (assistantIndex <= 0) return undefined

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (isUserMessageForRole(message, chat, role)) return message
  }
  return undefined
}

function discardMessage(store: OpenTeamStore, chat: GroupChat, messageId: string): void {
  delete store.messagesById[messageId]
  chat.messageIds = chat.messageIds.filter(id => id !== messageId)
  if (store.messageHighlightsById) delete store.messageHighlightsById[messageId]
}

function resolveRetryUserMessage(
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

function resolveReference(store: OpenTeamStore, chat: GroupChat, raw: unknown, newId: (prefix: string) => string): MessageReference | undefined {
  if (!isRecord(raw)) return undefined

  const messageId = readOptionalString(raw.messageId)
  if (messageId) {
    const message = store.messagesById[messageId]
    if (message && message.chatId === chat.id) {
      return {
        messageId: message.id,
        roleId: message.roleId,
        roleName: message.roleName,
        contentSnapshot: message.content,
      }
    }
  }

  const contentSnapshot = readOptionalString(raw.contentSnapshot)
  if (!contentSnapshot) return undefined
  return {
    messageId: messageId ?? newId('ref'),
    roleId: readOptionalString(raw.roleId),
    roleName: readOptionalString(raw.roleName),
    contentSnapshot,
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function resolveOrchestrationMentionFlow(
  store: OpenTeamStore,
  chat: GroupChat,
  target: 'default' | { name: string },
): OrchestrationFlow {
  const orderedFlows = (store.orchestrationFlowOrderByChatId[chat.id] ?? [])
    .map(flowId => store.orchestrationFlowsById[flowId])
    .filter((flow): flow is OrchestrationFlow => Boolean(flow && flow.chatId === chat.id))
  const extraFlows = Object.values(store.orchestrationFlowsById)
    .filter((flow): flow is OrchestrationFlow => Boolean(flow && flow.chatId === chat.id && !orderedFlows.some(ordered => ordered.id === flow.id)))
  const flows = [...orderedFlows, ...extraFlows]

  if (target === 'default') {
    const flow = flows[0]
    if (!flow) throw new Error('当前群聊还没有编排流程，请先创建或保存一个编排流程')
    return flow
  }

  const name = target.name.trim()
  const flow = flows.find(candidate => candidate.name.trim() === name)
  if (!flow) throw new Error(`找不到名为“${name}”的编排流程，请先创建或保存`)
  return flow
}

function readReplyContent(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// Image bytes read inside the page (for blob: sources), capped per image and per reply.
const MAX_REPLY_IMAGE_DATA_CHARS = Math.ceil((25 * 1024 * 1024) / 3) * 4
const MAX_REPLY_IMAGES_DATA_CHARS = 4 * MAX_REPLY_IMAGE_DATA_CHARS

function readReplyImageSources(value: unknown): ReplyImageSource[] {
  if (!Array.isArray(value)) return []
  let dataChars = 0
  return value.slice(0, 20).flatMap(item => {
    if (!isRecord(item) || typeof item.sourceUrl !== 'string' || !item.sourceUrl.trim()) return []
    const width = readOptionalImageDimension(item.width)
    const height = readOptionalImageDimension(item.height)
    const data = readReplyImageData(item.data)
    const withData = data !== undefined && dataChars + data.length <= MAX_REPLY_IMAGES_DATA_CHARS
    if (withData) dataChars += data.length
    return [{
      sourceUrl: item.sourceUrl.trim(),
      ...(typeof item.alt === 'string' && item.alt.trim() ? { alt: item.alt.trim().slice(0, 500) } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(withData ? { data } : {}),
      ...(withData && typeof item.mimeType === 'string' ? { mimeType: item.mimeType.slice(0, 40) } : {}),
    }]
  })
}

function readReplyImageData(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_REPLY_IMAGE_DATA_CHARS) return undefined
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined
}

function readOptionalImageDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 20_000 ? value : undefined
}

function readSiteId(value: unknown): ChatSite | undefined {
  return isChatSite(value) ? value : undefined
}

function readSiteHealthStatus(value: unknown): RoleSiteHealthStatus | undefined {
  if (value === 'ready' || value === 'generating' || value === 'loading' || value === 'error' || value === 'blocked' || value === 'unauthorized') return value
  return undefined
}

function readSiteHealthReason(value: unknown): RoleSiteHealthReason | undefined {
  if (value === 'verification' || value === 'http-error' || value === 'overlay' || value === 'embed-blocked' || value === 'login' || value === 'guest' || value === 'no-editor' || value === 'site-error') return value
  return undefined
}

function isTrustedImageSenderUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      url.hostname === 'chatgpt.com' ||
      url.hostname === 'chat.openai.com' ||
      url.hostname === 'gemini.google.com' ||
      url.hostname === 'grok.com' ||
      url.hostname === 'chat.qwen.ai'
    )
  } catch {
    return false
  }
}

function isBoundImageSender(
  deps: MessageHandlersDependencies,
  identity: { chatId: string; roleId: string },
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): boolean {
  if (!isTrustedImageSenderUrl(sender.url)) return false
  const tabId = messageTabId(message, sender)
  if (tabId === undefined) return false
  const binding = deps.runtimeFrames.getByAddress(tabId, senderFrameId(sender))
  return Boolean(binding?.ready && binding.chatId === identity.chatId && binding.roleId === identity.roleId)
}

function requireImageAttachmentService(deps: MessageHandlersDependencies): NonNullable<MessageHandlersDependencies['imageAttachments']> {
  if (!deps.imageAttachments) throw new Error('图片存储尚未初始化')
  return deps.imageAttachments
}

function uploadAttachment(id: string, upload: MessageUpload): MessageAttachment {
  return upload.kind === 'image'
    ? { id, type: 'image', status: 'ready', source: 'user-upload', mimeType: upload.mimeType, size: upload.size, fileName: upload.fileName }
    : { id, type: 'file', status: 'ready', fileName: upload.fileName, mimeType: upload.mimeType, size: upload.size, text: upload.text }
}

// Ids of the stored image blobs behind these attachments (text files have none).
function readyAttachmentIds(attachments: MessageAttachment[] | undefined): string[] {
  return (attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.status === 'ready').map(attachment => attachment.id)
}

async function deleteReadyAttachmentsBestEffort(
  deps: MessageHandlersDependencies,
  attachments: MessageAttachment[] | undefined,
  event: string,
): Promise<void> {
  await deleteAttachmentIdsBestEffort(deps, readyAttachmentIds(attachments), event)
}

async function deleteAttachmentIdsBestEffort(
  deps: MessageHandlersDependencies,
  ids: string[],
  event: string,
): Promise<void> {
  if (ids.length === 0 || !deps.imageAttachments) return
  try {
    await deps.imageAttachments.deleteByIds(ids)
  } catch (error) {
    deps.log.warn(event, {
      attachmentCount: ids.length,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function requireString(value: unknown, error: string): string {
  const result = readOptionalString(value)
  if (!result) throw new Error(error)
  return result
}

function requireNumber(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(error)
  return value
}

function requireNoteContent(value: unknown): NonNullable<OpenTeamStore['globalNote']> {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('笔记内容格式无效')
  return value as NonNullable<OpenTeamStore['globalNote']>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
