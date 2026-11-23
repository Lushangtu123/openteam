import type { OpenTeamStore } from '../group/types'
import { createExternalModelClient } from './externalModelClient'
import type { BackgroundMessageRoute } from './messageRouter'
import type { ExternalPromptDelivery } from './rolePromptDelivery'
import type { MessageHandlerContext, MessageHandlersDependencies } from './messageHandlerDeps'
import { createExternalModelRunRegistry, sendExternalModelDelivery } from './externalModelReplies'
import { readOptionalString, requireString } from './messageInput'
import { createRoundHandlers } from './roundHandlers'
import { createMessageSendHandler } from './messageSendHandler'
import { createMessageActionHandlers } from './messageActionHandlers'
import { createMemberPageHandlers } from './memberPageHandlers'
export type { MessageHandlersDependencies, OpenTeamRequest } from './messageHandlerDeps'

// API members of one model replying at the same time.
const EXTERNAL_MODEL_CONCURRENCY = 2

export const MESSAGE_ROUTE_TYPES = [
  'GROUP_ROLE_RETRY_REPLY',
  'GROUP_ROLE_STOP_REPLY',
  'GROUP_NOTE_SAVE',
  'GROUP_MESSAGE_HIGHLIGHT_CREATE',
  'GROUP_MESSAGE_RESYNC_REPLY',
  'GROUP_MESSAGE_SEND',
  'GROUP_ROUND_SUMMARY_REQUEST',
  'GROUP_LINKS_CHECK',
  'GROUP_DISCUSSION_STOP',
  'GROUP_DISCUSSION_CONTINUE',
  'GROUP_PROJECT_START',
  'GROUP_PROJECT_APPROVE',
  'GROUP_PROJECT_REPLAN',
  'GROUP_PROJECT_SET_OWNER',
  'GROUP_PROJECT_STOP',
  'GROUP_PROJECT_CONTINUE',
  'GROUP_PROJECT_REVOKE_RUNS',
  'TEAM_FRAME_ROLE_READY',
  'TEAM_ROLE_CONVERSATION_UPDATED',
  'TEAM_SEND_ACK',
  'TEAM_ROLE_STATUS',
  'TEAM_SITE_STATUS_UPDATE',
  'TEAM_ROLE_REPLY',
  'TEAM_ROLE_REPLY_PROGRESS',
  'TEAM_ROLE_REPLY_RESYNC',
  'TEAM_ROLE_RESUME_FAILED',
  'TEAM_ROLE_ERROR',
  // From the background itself: see interruptedReplies.ts.
  'GROUP_REPLIES_INTERRUPTED',
  // Before a member is moved to another model.
  'GROUP_ROLE_REPLY_END',
] as const

export function createMessageHandlers(baseDeps: MessageHandlersDependencies): BackgroundMessageRoute[] {
  // A finished round is also when its summary is asked for.
  const deps: MessageHandlersDependencies = {
    ...baseDeps,
    // A web member's backup answers through the same path as an API member.
    answerForMember: delivery => deliverExternal(delivery),
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

  const ctx: MessageHandlerContext = { baseDeps, deps, externalModelClient, externalModelRuns, roleErrorRetryCounts, deliverExternal, deliverExternalTogether }
  const roundHandlers = createRoundHandlers(ctx)
  const { scheduleAfterRound, scheduleDiscussionAdvance, handleDiscussionStop, handleDiscussionContinue, projectRunner, handleProjectStart, projectRoute, handleRoundSummaryRequest, handleLinksCheck } = roundHandlers
  const { handleMessageSend } = createMessageSendHandler(ctx, roundHandlers)
  const { handleRoleRetryReply, handleRoleStopReply, handleNoteSave, handleMessageHighlightCreate, handleMessageResyncReply } = createMessageActionHandlers(ctx)
  const { handleFrameRoleReady, handleConversationUpdated, handleSendAck, handleRoleStatus, handleSiteStatusUpdate, handleRoleReply, handleRoleReplyProgress, handleRoleReplyResync, handleRepliesInterrupted, handleRoleReplyEnd, handleRoleResumeFailed, handleRoleError } = createMemberPageHandlers(ctx)

  return [
    { type: 'GROUP_ROLE_RETRY_REPLY', handler: handleRoleRetryReply },
    { type: 'GROUP_ROLE_STOP_REPLY', handler: handleRoleStopReply },
    { type: 'GROUP_NOTE_SAVE', handler: handleNoteSave },
    { type: 'GROUP_MESSAGE_HIGHLIGHT_CREATE', handler: handleMessageHighlightCreate },
    { type: 'GROUP_MESSAGE_RESYNC_REPLY', handler: handleMessageResyncReply },
    { type: 'GROUP_MESSAGE_SEND', handler: handleMessageSend },
    { type: 'GROUP_ROUND_SUMMARY_REQUEST', handler: handleRoundSummaryRequest },
    { type: 'GROUP_LINKS_CHECK', handler: handleLinksCheck },
    { type: 'GROUP_DISCUSSION_STOP', handler: handleDiscussionStop },
    { type: 'GROUP_DISCUSSION_CONTINUE', handler: handleDiscussionContinue },
    { type: 'GROUP_PROJECT_START', handler: handleProjectStart },
    { type: 'GROUP_PROJECT_APPROVE', handler: projectRoute(chatId => projectRunner.approve(chatId)) },
    { type: 'GROUP_PROJECT_REPLAN', handler: projectRoute(chatId => projectRunner.replan(chatId)) },
    { type: 'GROUP_PROJECT_SET_OWNER', handler: projectRoute((chatId, message) => projectRunner.setTaskOwner(chatId, requireString(message.taskId, '缺少任务 ID'), requireString(message.roleId, '缺少成员 ID'))) },
    { type: 'GROUP_PROJECT_STOP', handler: projectRoute(chatId => projectRunner.stop(chatId)) },
    { type: 'GROUP_PROJECT_CONTINUE', handler: projectRoute(chatId => projectRunner.resume(chatId)) },
    { type: 'GROUP_PROJECT_REVOKE_RUNS', handler: projectRoute((chatId, message) => projectRunner.revokeRuns(chatId, requireString(message.roleId, '缺少成员 ID'))) },
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
    { type: 'TEAM_ROLE_RESUME_FAILED', handler: handleRoleResumeFailed },
    { type: 'TEAM_ROLE_ERROR', handler: handleRoleError },
    { type: 'GROUP_REPLIES_INTERRUPTED', handler: handleRepliesInterrupted },
    { type: 'GROUP_ROLE_REPLY_END', handler: handleRoleReplyEnd },
  ]
}
