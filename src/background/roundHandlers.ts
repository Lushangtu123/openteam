// What follows a round of answers: its summary and the members' review of each other; a discussion
// in turns; and a project's steps. The requests OpenTeam sends members itself start here.
import { canBeAskedNow } from './memberBackup'
import { type MessageUpload, readMessageUploads } from '../group/messageUploads'
import { hasRoundSummary, pickSummarizer, readSummarizableRound, roundSummaryRequestText } from '../group/roundSummary'
import { crossReviewRequestText, wantsCrossReview } from '../group/collaboration'
import { factCheckRequestText, hasFactCheck, readCheckableRound, readReplySources } from '../group/sources'
import { createProjectRunner } from './projectRunner'
import { chooseNextSpeaker, DISCUSSION_MAX_FAILED_TURNS, discussionMaxTurns, discussionTranscript, discussionTurnRequestText, turnCountsOf } from '../group/discussion'
import type { DiscussionRun, GroupChat, GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { getExternalModelForRole, isExternalModelRole, prepareRolePromptDelivery } from './rolePromptDelivery'
import type { RuntimeMessage } from './runtimeClient'
import { getChatMessages, getChatRoles, mutateStore, requireChat } from './storeAccess'
import type { MessageHandlerContext, OpenTeamRequest } from './messageHandlerDeps'
import { hasCrossReview, userMovedOnFrom } from './replyMessages'
import { waitForRetryDelay } from './replyRetry'
import { reportPromptSettled, sendPromptDeliveries } from './siteDeliveries'
import { isRoleDeliverable, isStaleThinkingRole, recoverDeliverableRoleStatus } from './roleState'
import { readOptionalString, requireString } from './messageInput'
import { uploadAttachment } from './messageAttachments'

// A round's summary is asked for a moment after its last reply, once that member's page is idle.
const ROUND_SUMMARY_DELAY_MS = 1500

export function createRoundHandlers(ctx: MessageHandlerContext) {
  const { baseDeps, deps, deliverExternal, deliverExternalTogether } = ctx

  // Asks one member to summarize a round: an API member if there is one, else whoever answered
  // first. `auto` requests (when a round finishes) give up quietly when there is nothing to do.
  const requestRoundSummary = async (chatId: string, questionId: string, options: { roleId?: string; auto?: boolean } = {}) => {
    const timestamp = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      const question = store.messagesById[questionId]
      // A vote is always summed up; other rounds when the user has summaries on.
      if (options.auto && ((store.settings.roundSummary === false && !question?.poll) || (question?.targetRoleIds?.length ?? 0) < 2)) return undefined
      const round = readSummarizableRound(store, chat, question)
      if (!round) {
        if (options.auto) return undefined
        throw new Error('这一轮还不能汇总：需要至少两位成员回复完成')
      }
      if (options.auto && hasRoundSummary(store, chat, round.question.id)) return undefined

      const roles = getChatRoles(store, chat)
      // A web member whose site cannot take a prompt or is limiting, with no backup to answer for it, is
      // passed over.
      const isAvailable = (role: GroupRole) => role.status !== 'thinking' && canBeAskedNow(store, role, timestamp) && (isExternalModelRole(role)
        ? Boolean(getExternalModelForRole(store, role))
        : isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp))
      const summarizer = options.roleId ? roles.find(role => role.id === options.roleId) : pickSummarizer(roles, round, isAvailable, store.settings.defaultChatSite)
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
    // A site check's question is answered OK, and that is all.
    if (question?.siteCheckQuestion) return
    // Asked with sources: its links are checked, then one member checks the facts (no summary).
    if (question?.wantsSources) {
      if (chat && readCheckableRound(store, chat, question) && !hasFactCheck(store, chat, questionId)) scheduleSourcesCheck(chatId, questionId)
      return
    }
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

  // 要来源 (src/group/sources.ts): the round's source links are opened, then one member is asked to
  // check the facts, given the answers, the link checks and the claims without a source.
  const sourcesChecks = new Set<string>()
  function scheduleSourcesCheck(chatId: string, questionId: string): void {
    if (sourcesChecks.has(questionId)) return
    sourcesChecks.add(questionId)
    void (async () => {
      await checkReplyLinks(chatId, questionId)
      await waitForRetryDelay(deps, ROUND_SUMMARY_DELAY_MS)
      await requestFactCheck(chatId, questionId)
    })()
      .catch(error => deps.log.warn('fact-check:failed', { chatId, questionId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => sourcesChecks.delete(questionId))
  }

  // Opens the links of the round's answers (or of one answer) that have not been checked, or all of
  // them again when `again` (access to their sites was just granted).
  async function checkReplyLinks(chatId: string, questionId: string, options: { replyId?: string; again?: boolean } = {}): Promise<OpenTeamStore | undefined> {
    if (!deps.checkLinks) return undefined
    const { result: wanted } = await mutateStore(store => {
      const chat = store.chatsById[chatId]
      const round = chat ? readCheckableRound(store, chat, store.messagesById[questionId]) : undefined
      return (round?.replies ?? [])
        .filter(reply => !options.replyId || reply.message.id === options.replyId)
        .map(reply => ({ id: reply.message.id, urls: readReplySources(reply.message.content).links.map(link => link.url).filter(url => options.again || !reply.message.linkChecks?.[url]) }))
        .filter(item => item.urls.length > 0)
    })
    if (wanted.length === 0) return undefined
    const results = await deps.checkLinks(wanted.flatMap(item => item.urls))
    const { store } = await mutateStore(store => {
      for (const item of wanted) {
        const reply = store.messagesById[item.id]
        if (!reply) continue
        reply.linkChecks = { ...reply.linkChecks, ...Object.fromEntries(item.urls.flatMap(url => results[url] ? [[url, results[url]]] : [])) }
      }
    })
    deps.log.info('fact-check:links-checked', { chatId, questionId, links: Object.keys(results).length })
    await deps.broadcastStoreUpdated(store)
    return store
  }

  async function requestFactCheck(chatId: string, questionId: string) {
    const timestamp = deps.now()
    const { store, result } = await mutateStore(store => {
      const chat = store.chatsById[chatId]
      const question = store.messagesById[questionId]
      const round = chat ? readCheckableRound(store, chat, question) : undefined
      if (!chat || !round || hasFactCheck(store, chat, questionId)) return undefined
      const roles = getChatRoles(store, chat)
      const isAvailable = (role: GroupRole) => role.status !== 'thinking' && canBeAskedNow(store, role, timestamp) && (isExternalModelRole(role)
        ? Boolean(getExternalModelForRole(store, role))
        : isRoleDeliverable(role, deps.runtimeFrames.getByRole(chat.id, role.id), timestamp))
      // Someone who sat the round out, on another model if there is one, as for a summary.
      const checker = pickSummarizer(roles, round, isAvailable, store.settings.defaultChatSite)
      if (!checker) return undefined
      const request: GroupMessage = {
        id: deps.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'user',
        content: factCheckRequestText(store.settings.language),
        targetRoleIds: [checker.id],
        mentionedRoleIds: [checker.id],
        factCheckOf: round.question.id,
        createdAt: timestamp,
        status: 'pending',
        deliveryStatus: { [checker.id]: 'pending' },
      }
      store.messagesById[request.id] = request
      chat.messageIds.push(request.id)
      chat.nextMessageSeq += 1
      chat.updatedAt = timestamp
      chat.status = 'running'
      const prepared = prepareRolePromptDelivery({ store, chat, role: checker, userMessage: request, roles, messages: getChatMessages(store, chat), timestamp, newId: deps.newId, runtimeFrames: deps.runtimeFrames })
      recoverDeliverableRoleStatus(checker, timestamp, deps.log)
      checker.status = 'thinking'
      checker.lastPromptMessageId = request.id
      checker.replyAttemptId = prepared.replyAttemptId
      checker.updatedAt = timestamp
      return { request, prepared }
    })
    if (!result) return
    deps.log.info('fact-check:requested', { chatId, questionId, messageId: result.request.id, roleId: result.request.targetRoleIds?.[0] })
    await deps.broadcastStoreUpdated(store)
    if (result.prepared.delivery) await sendPromptDeliveries(deps, chatId, result.request.id, [result.prepared.delivery])
    if (result.prepared.externalDelivery) await deliverExternal(result.prepared.externalDelivery)
  }

  // 细查链接: the page was just granted access to these sites; the answer's links are checked again.
  const handleLinksCheck = async (message: RuntimeMessage) => {
    const chatId = requireString(message.chatId, '缺少群聊 ID')
    const replyId = requireString(message.messageId, '缺少消息 ID')
    const { result: questionId } = await mutateStore(store => store.messagesById[replyId]?.sourceMessageId)
    if (!questionId) throw new Error('找不到这条回答')
    const store = await checkReplyLinks(chatId, questionId, { replyId, again: true })
    return { ok: true, ...(store ? { store } : {}) }
  }

  function scheduleRoundSummary(store: OpenTeamStore, chatId: string, questionId: string): void {
    const chat = store.chatsById[chatId]
    const question = store.messagesById[questionId]
    if (!chat || (store.settings.roundSummary === false && !question?.poll) || (question?.targetRoleIds?.length ?? 0) < 2) return
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
    // Its site cannot take a prompt and nothing answers for it: the turn goes to the next member.
    if (!canBeAskedNow(store, role, timestamp)) return false
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

  return { scheduleAfterRound, startDiscussion, scheduleDiscussionAdvance, handleDiscussionStop, handleDiscussionContinue, projectRunner, handleProjectStart, projectRoute, handleRoundSummaryRequest, handleLinksCheck }
}

export type RoundHandlers = ReturnType<typeof createRoundHandlers>
