// What members' pages report: that they are ready, that a prompt went out, their state and health,
// the reply as it is written and when it is done, and errors. Also replies cut off when pages closed.
import { confirmLibrarySent, forgetLibrarySent } from '../group/groupLibrary'
import { misreadReplyReason } from '../group/misreadReply'
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import { confirmMemorySent, forgetMemorySent } from '../group/memoryPrompt'
import { extractMemoryProposals, takeMemoryProposals } from '../group/memoryProposals'
import { type InterruptedReply, type InterruptedReplyScope, settleInterruptedReplies } from './interruptedReplies'
import { mapRuntimeRoleStatus } from '../group/runtimeProtocol'
import type { GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import type { ResumeReply } from '../group/runtimeProtocol'
import { isExternalModelRole } from './rolePromptDelivery'
import { backupModelFor, memberSite, noteMemberSiteLimit } from './memberBackup'
import { isSiteLimitMessage, noteSiteTried, recordSiteSent, takeSiteRecovery } from '../group/siteUsage'
import { clearSiteFault, layoutFaultStep, recordSiteFault } from '../group/siteFaults'
import { messageTabId, rememberHost, type RuntimeMessage, senderFrameId, senderTabId } from './runtimeClient'
import { mutateStore, requireChat, requireRole } from './storeAccess'
import { markOrchestrationRoleError, maybeAdvanceOrchestrationRun } from './orchestrationRuntime'
import { getRoleReplyHistory, isAssistantMessageForRole, isUserMessageForRole, markChatHasNewMessage, staleReplyReason, upsertFailedAssistantAfterPrompt } from './replyMessages'
import { clearRoleErrorRetryCount, prepareRoleErrorRetry, waitForRetryDelay } from './replyRetry'
import { enqueuePromptDelivery, reportPromptSettled } from './siteDeliveries'
import { conversationLeftFor, updateConversation } from './roleState'
import { isBoundImageSender, readIdentity, readIdentityOptional, readOptionalString, readReplyContent, readReplyImageSources, readSiteHealthReason, readSiteHealthStatus, readSiteId, requireString } from './messageInput'
import { deleteAttachmentIdsBestEffort, deleteReadyAttachmentsBestEffort, readyAttachmentIds, requireImageAttachmentService } from './messageAttachments'
import type { MessageHandlerContext } from './messageHandlerDeps'

// A live reply longer than this is cut; the finished reply always arrives in full.
const LIVE_REPLY_MAX_CHARS = 60_000

export function createMemberPageHandlers(ctx: MessageHandlerContext) {
  const { deps, roleErrorRetryCounts, deliverExternal, externalModelRuns } = ctx

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

    // A member whose page was loaded again while it read a reply: the side panel was opened or
    // closed, the OpenTeam page was refreshed, or its frame reloaded. The site most often goes on
    // writing the reply, so the new page is asked to read it there, going on from what had been read
    // (resumeReply). A prompt that had not reached the site has no reply there: that reply is ended
    // now, as when its page is closed, instead of the member showing as replying until it counts as
    // stuck. The same page reporting again (the OpenTeam page asks until it hears back) leaves it as
    // it is. A member with no page on record had its page closed (the side panel's go with it).
    const previous = deps.runtimeFrames.getByRole(chatId, roleId)
    const documentId = sender.documentId
    const pageLoadedAgain = Boolean(previous?.documentId && documentId && previous.documentId !== documentId)
    const pageClosedBefore = !previous && Boolean(documentId)
    // Its page closed while this background ran: a reply whose prompt had reached the site and cannot
    // be read on is over. A prompt still waiting to go out goes to the new page as usual.
    const pageLost = !previous && deps.runtimeFrames.lostPage?.(chatId, roleId) === true

    // Validate the chat and role before trusting this frame as their host.
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const role = requireRole(store, chat.id, roleId)
      const resumeReply = (pageLoadedAgain || pageClosedBefore) && role.status === 'thinking' ? replyToResume(store, role) : undefined
      if (resumeReply) role.updatedAt = timestamp
      const settled = (pageLoadedAgain || (pageLost && promptReachedSite(store, role))) && role.status === 'thinking' && !resumeReply
        ? settleInterruptedReplies(store, { siteMembers: true, apiMembers: false, onlyRole: { chatId, roleId }, timestamp, newId: deps.newId, getChatStatusFromRoles: deps.getChatStatusFromRoles })
        : []
      if (role.status !== 'thinking') {
        role.status = 'ready'
        role.updatedAt = timestamp
      }
      updateConversation(role, readOptionalString(message.conversationUrl), readOptionalString(message.conversationId))
      chat.status = deps.getChatStatusFromRoles(store, chat)
      chat.updatedAt = timestamp
      return { role, replyHistory: getRoleReplyHistory(store, chat, role.id), settled, resumeReply }
    })
    rememberHost(sender, tabId)
    deps.runtimeFrames.bind({ chatId, roleId, tabId, frameId, ready: true, lastSeenAt: timestamp, ...(documentId ? { documentId } : {}) })
    if (result.settled.length > 0) deps.log.warn('frame-ready:reply-interrupted', { chatId, roleId, settled: result.settled })
    if (result.resumeReply) deps.log.warn('frame-ready:resume-reply', { chatId, roleId, messageId: result.resumeReply.messageId, readSoFarLength: result.resumeReply.readSoFar.length })

    deps.log.info('frame-ready:store-updated', { chatId, roleId, roleName: result.role.name, status: result.role.status, replyHistoryCount: result.replyHistory.length, binding: deps.runtimeFrames.getByRole(chatId, roleId) })
    await deps.broadcastStoreUpdated(store)
    await afterRepliesInterrupted(store, result.settled)
    return { ok: true, role: result.role, replyHistory: result.replyHistory, ...(result.resumeReply ? { resumeReply: result.resumeReply } : {}), store }
  }

  // The reply a member page loaded again goes on reading, when its prompt reached the site (the site
  // confirmed it, or the reply had begun to arrive) in a conversation the page opens again. A prompt
  // that began a new chat which the site had not yet given an address has its reply where the new
  // page cannot go: it opens a new chat.
  function replyToResume(store: OpenTeamStore, role: GroupRole): ResumeReply | undefined {
    if (isExternalModelRole(role) || !role.geminiConversationUrl) return undefined
    const promptMessageId = role.lastPromptMessageId
    const prompt = promptMessageId ? store.messagesById[promptMessageId] : undefined
    if (!promptMessageId || prompt?.type !== 'user' || prompt.chatId !== role.chatId) return undefined
    if (!promptReachedSite(store, role)) return undefined
    const live = role.liveReply?.promptMessageId === promptMessageId ? role.liveReply.content : ''
    return { messageId: promptMessageId, ...(role.replyAttemptId ? { replyAttemptId: role.replyAttemptId } : {}), readSoFar: live }
  }

  // The site confirmed the member's prompt, or its reply had begun to arrive.
  function promptReachedSite(store: OpenTeamStore, role: GroupRole): boolean {
    const promptMessageId = role.lastPromptMessageId
    const prompt = promptMessageId ? store.messagesById[promptMessageId] : undefined
    if (!promptMessageId || prompt?.type !== 'user') return false
    const delivered = prompt.deliveryStatus?.[role.id]
    return delivered === 'sent' || delivered === 'received' || role.liveReply?.promptMessageId === promptMessageId
  }

  // The page asked to go on reading a reply did not find it on the site: the reply is ended, keeping
  // what had arrived, as when no page was there to read it.
  const handleRoleResumeFailed = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const promptMessageId = requireString(message.messageId, '缺少消息 ID')
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    const reason = readOptionalString(message.reason) ?? ''
    const { store, result: settled } = await mutateStore(store => {
      const role = requireRole(store, requireChat(store, identity.chatId).id, identity.roleId)
      const current = role.status === 'thinking' && role.lastPromptMessageId === promptMessageId && (!replyAttemptId || !role.replyAttemptId || role.replyAttemptId === replyAttemptId)
      if (!current) return []
      const timestamp = deps.now()
      const settled = settleInterruptedReplies(store, { siteMembers: true, apiMembers: false, onlyRole: { chatId: identity.chatId, roleId: identity.roleId }, timestamp, newId: deps.newId, getChatStatusFromRoles: deps.getChatStatusFromRoles })
      // Its page is there, and can take the next prompt.
      role.status = 'ready'
      const chat = requireChat(store, identity.chatId)
      chat.status = deps.getChatStatusFromRoles(store, chat)
      return settled
    })
    deps.log.warn('role-resume:failed', { ...identity, promptMessageId, reason, settled })
    if (settled.length === 0) return { ok: true, settled }
    await deps.broadcastStoreUpdated(store)
    await afterRepliesInterrupted(store, settled)
    return { ok: true, settled }
  }

  // What waited for the ended replies (a round, a discussion, a project, a workflow) goes on.
  async function afterRepliesInterrupted(store: OpenTeamStore, settled: InterruptedReply[]): Promise<void> {
    for (const { chatId, roleId, promptMessageId } of settled) {
      if (!promptMessageId) continue
      reportPromptSettled(deps, store, chatId, promptMessageId)
      clearRoleErrorRetryCount(roleErrorRetryCounts, chatId, roleId, promptMessageId)
      await deps.promptDeliveryLimiter?.complete(chatId, promptMessageId, roleId)
      await markOrchestrationRoleError(deps, { chatId, roleId, promptMessageId, error: '回复中断' })
    }
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
        role.conversationStartedAfterSeq = chat.nextMessageSeq - 1
        forgetMemorySent(role)
        forgetLibrarySent(role)
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
        // The site took a prompt: counted for 网站额度提醒, and, while it is marked as limiting (the
        // user sent it again by hand), a reply to it will mean it recovered.
        const site = memberSite(store, role)
        if (site) {
          recordSiteSent(store, site, deps.now())
          noteSiteTried(store, site, role.id, deps.now())
        }
      }
      if (userMessage) role.contextCursor = Math.max(role.contextCursor, userMessage.seq)
      // The site has the prompt, and with it the memory items it carried.
      confirmMemorySent(role, messageId)
      confirmLibrarySent(role, messageId)
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
      // 网站失效提醒 (src/group/siteFaults.ts): a page with no input box, counted when it comes to that.
      const site = memberSite(store, role)
      const wasNoEditor = role.siteHealth?.status === 'error' && role.siteHealth.reason === 'no-editor'
      if (site && status === 'error' && reason === 'no-editor' && !wasNoEditor) {
        if (recordSiteFault(store, site, { key: `${role.id}:no-editor:${timestamp}:${store.siteFaultsBySite?.[site]?.count ?? 0}`, step: 'input', now: timestamp })) deps.log.warn('site-fault:noticed', { ...identity, site, step: 'input' })
      }
      role.siteHealth = {
        siteId,
        status,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
        updatedAt: timestamp,
      }
      // A page that cannot be used and says the site is limiting marks the site.
      if (status === 'error' || status === 'blocked') {
        if (noteMemberSiteLimit(store, role, detail, timestamp)) deps.log.warn('site-limit:noted', { ...identity, siteId, detail })
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
        // The previous reply is kept without its memory proposals, so the text is compared that way too.
        const misread = promptMessageId && images.length === 0
          ? misreadReplyReason(content, previousReply?.content) ?? misreadReplyReason(extractMemoryProposals(content).content, previousReply?.content)
          : undefined
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
          ...(message.stalledWhileGenerating === true ? { stalledWhileGenerating: true } : {}),
        }
        store.messagesById[reply.id] = reply
        // What the member proposed to remember leaves the reply's text and waits beside it.
        takeMemoryProposals(store, chat, reply, deps.newId)
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
        // A reply to a prompt the site took while marked as limiting: it recovered.
        const site = memberSite(store, role)
        if (site && takeSiteRecovery(store, site, role.id)) deps.log.info('site-limit:recovered', { ...identity, site })
        // It replied: whatever failed before, the site still works.
        if (site && clearSiteFault(store, site)) deps.log.info('site-fault:cleared', { ...identity, site })
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
        takeMemoryProposals(store, chat, assistantMessage, deps.newId)
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

  // Ends the reply of a member the user is moving to another model: the reply cannot be read from
  // the old model any more. What arrived is kept; its question no longer waits for it.
  const handleRoleReplyEnd = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const roleId = requireString(message.roleId, '缺少成员 ID')
    const { store, result } = await mutateStore(store => {
      const role = requireRole(store, requireChat(store, chatId).id, roleId)
      const replyAttemptId = role.replyAttemptId
      const settled = settleInterruptedReplies(store, { siteMembers: true, apiMembers: true, onlyRole: { chatId, roleId }, cause: 'switched', timestamp: deps.now(), newId: deps.newId, getChatStatusFromRoles: deps.getChatStatusFromRoles })
      return { settled, replyAttemptId }
    })
    if (result.settled.length === 0) return { ok: true, settled: [] }
    // An API member's request still running is stopped.
    externalModelRuns.abort(chatId, roleId, result.replyAttemptId)
    deps.log.info('role-reply:ended-for-switch', { chatId, roleId, settled: result.settled })
    await deps.broadcastStoreUpdated(store)
    await afterRepliesInterrupted(store, result.settled)
    return { ok: true, settled: result.settled, store }
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
    await afterRepliesInterrupted(store, settled)
    return { ok: true, settled }
  }

  const handleRoleError = async (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => {
    const identity = readIdentity(deps, message, sender)
    const reason = readOptionalString(message.reason) ?? readOptionalString(message.error) ?? '人员执行失败'
    const promptMessageId = readOptionalString(message.messageId)
    const replyAttemptId = readOptionalString(message.replyAttemptId)
    deps.log.warn('role-error:received', { ...identity, promptMessageId, replyAttemptId, reason, senderUrl: sender.url, tabId: messageTabId(message, sender), frameId: senderFrameId(sender) })

    // 网站失效提醒: a failure that points at the site's page having changed is counted for the site.
    const faultStep = layoutFaultStep(reason)
    if (faultStep) {
      const { store: faultStore, result: noticed } = await mutateStore(store => {
        const chat = requireChat(store, identity.chatId)
        const role = requireRole(store, chat.id, identity.roleId)
        const site = memberSite(store, role)
        if (!site) return false
        const shown = recordSiteFault(store, site, { key: `${role.id}:${promptMessageId ?? deps.now()}`, step: faultStep, detail: reason, now: deps.now() })
        return shown ? site : false
      })
      if (noticed) {
        deps.log.warn('site-fault:noticed', { ...identity, site: noticed, step: faultStep, reason })
        await deps.broadcastStoreUpdated(faultStore)
      }
    }

    // The site said it is limiting: it is marked, so its members are not sent prompts for a while.
    if (isSiteLimitMessage(reason)) {
      const { store: limitedStore, result: limitNoted } = await mutateStore(store => noteMemberSiteLimit(store, requireRole(store, requireChat(store, identity.chatId).id, identity.roleId), reason, deps.now()))
      if (limitNoted) {
        deps.log.warn('site-limit:noted', { ...identity, reason })
        await deps.broadcastStoreUpdated(limitedStore)
      }
    }

    // The page could not send a prompt that has a backup to answer it: the same refusal reaches the
    // delivery, which hands the prompt to the backup (siteDeliveries.ts). The member is not failed.
    if (promptMessageId && deps.answerForMember) {
      const { result: leftToBackup } = await mutateStore(store => {
        const chat = requireChat(store, identity.chatId)
        const role = requireRole(store, chat.id, identity.roleId)
        if (!backupModelFor(store, role) || staleReplyReason(store, chat, role, promptMessageId, replyAttemptId)) return false
        return store.messagesById[promptMessageId]?.deliveryStatus?.[role.id] === 'pending'
      })
      if (leftToBackup) {
        deps.log.warn('role-error:left-to-backup', { ...identity, promptMessageId, reason })
        return { ok: true, leftToBackup: true }
      }
    }

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

  return { handleFrameRoleReady, handleConversationUpdated, handleSendAck, handleRoleStatus, handleSiteStatusUpdate, handleRoleReply, handleRoleReplyProgress, handleRoleReplyResync, handleRepliesInterrupted, handleRoleReplyEnd, handleRoleResumeFailed, handleRoleError }
}

export type MemberPageHandlers = ReturnType<typeof createMemberPageHandlers>
