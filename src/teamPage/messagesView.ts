import { createStreamingReveal } from './streamingReveal'
import { createIcon } from './icons'
import { createApprovalCards } from './approvalCard'
import { extractReplyChoices, type ReplyChoice } from '../group/replyChoices'
import { normalizeLanguage } from '../shared/i18n'
import { applyHighlightsToBody } from './messageHighlights'
import { registerSelectionMarkMenu } from './selectionMarkMenu'
import { roleMentionLabel, roleMentionLabelOptionsFromSettings, roleModelLabel } from '../group/mentionParser'
import type { GroupChat, GroupMessage, GroupRole, MemoryProposal, MessageReference, OpenTeamStore } from '../group/types'
import { findReviewResultForMessage, renderOrchestrationMessageLabel, renderOrchestrationReviewSummary } from './orchestrationMessageLabels'
import type { ChatSite } from '../group/chatSites'
import { createStartCards } from './startCards'
import { MEMORY_KIND_LABELS } from './memoryDialog'
import { createMessageAttachmentsView } from './messageAttachmentsView'
import { paintRoleAvatar, roleAvatarSignature } from './viewHelpers'
import { renderMarkdownInto } from './markdownRender'
import { countRepliesByQuestion } from '../group/replyComparison'
import { hasRoundSummary, isOpenTeamRequest } from '../group/roundSummary'
import { foldToKeyPoints } from './keyPointsFold'
import type { ImageAttachmentBlobRecord } from '../shared/imageAttachmentRepository'
import type { TeamPageState } from './appState'
import { buildChatRenderItems, getChatStartupNotice, getStoppedReplyRoles, getVisibleThinkingRoles, THINKING_TIMEOUT_MS } from './chatExperience'

type MessageActionIcon = 'copy' | 'quote' | 'jump' | 'check' | 'stop' | 'retry' | 'download' | 'edit' | 'memory'

const MAX_CACHED_MESSAGE_NODES = 400
const COPY_FEEDBACK_MS = 1200
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48


export interface MessagesViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  messagesEl: HTMLElement
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getCurrentMessages(): GroupMessage[]
  emptyCard(title: string, body: string): HTMLElement
  openAddPersonDialog(): void
  // Starts a group: forming a team around a task, from a template, or blank.
  startNewChat?(kind: 'team' | 'template' | 'blank'): void
  // For someone with no group yet: open an AI site in a new tab to sign in, and run 网站自检.
  openSiteLogin?(site: ChatSite): void
  startSiteCheck?(): void
  messageTitle(message: GroupMessage): string
  focusRoleFrame(chatId: string, roleId: string | undefined): void
  insertMention(role: GroupRole): void
  setReference(message: GroupMessage): void
  // Puts one of the user's messages back in the input box to be sent again.
  editAndResend?(message: GroupMessage): void
  // Opens the window that saves a message's text to the memory store.
  rememberMessage?(message: GroupMessage, opener: HTMLElement): void
  // Opens that window on something the member proposed to remember at the end of this reply.
  rememberProposal?(message: GroupMessage, proposal: MemoryProposal, opener: HTMLElement): void
  // Opens that window on a round summary's agreed points, to keep them as the user's decision.
  adoptSummary?(message: GroupMessage, opener: HTMLElement): void
  // Answers a choice at the end of a member's reply.
  answerChoice?(role: GroupRole, choice: ReplyChoice): void
  insertTextIntoActiveNote?(text: string): void
  resyncMessageReply(message: GroupMessage): Promise<void>
  retryRoleReply(role: GroupRole, messageId?: string): Promise<void>
  stopRoleReply(role: GroupRole): Promise<void>
  loadImageAttachment?(id: string): Promise<ImageAttachmentBlobRecord | undefined>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  render(): void
  // Opens the side-by-side view of the replies to a question.
  openReplyComparison?(questionId: string): void
  // The notice at the top of a group whose members are choosing positions, and the card that shows them.
  renderTeamFormationStatus?(chat: GroupChat): HTMLElement | undefined
  isTeamInvitation?(chat: GroupChat, messageId: string): boolean
  openTeamCard?(chatId: string): void
  // A reply to a team invitation shown as the position it claims, instead of its raw JSON.
  renderTeamClaim?(message: GroupMessage): HTMLElement | undefined
  showError(message: string): void
  showSuccess(message: string): void
  renderOrchestrationStatus?(): HTMLElement | undefined
  // The project's task board, at the end of the chat.
  renderProjectBoard?(chat: GroupChat, messages: GroupMessage[]): HTMLElement | undefined
  // A 网站自检 group's result, at the end of the chat.
  renderSiteCheck?(chat: GroupChat): HTMLElement | undefined
  log: {
    warn(event: string, details?: Record<string, unknown>): void
  }
}

export interface MessagesView {
  renderMessages(): void
}

function getDiagnosticText(reason: string): string {
  const normalized = reason.toLowerCase()
  if (normalized === 'send_failed') return '⚠️ 发送失败，请检查 AI 窗口是否开启或尝试刷新页面。'
  if (normalized === 'response_not_found') return '⚠️ 未检测到回复，可能是 AI 响应过慢或 DOM 结构已变更。'
  if (normalized === 'timeout') return '⚠️ 回复超时了，请尝试重新发送。'
  if (normalized === 'site_blocked') return '⚠️ 站点阻断，请检查登录状态或处理 Cookie 弹窗。'
  return `回复失败：${reason}`
}

function isStructuredFailureReason(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'send_failed' || normalized === 'response_not_found' || normalized === 'timeout' || normalized === 'site_blocked'
}

export function createMessagesView(deps: MessagesViewDependencies): MessagesView {
  // What the chat area shows with no group open.
  const startCards = createStartCards(deps)
  // While the pointer is on a message's buttons, the list does not scroll to follow a reply coming
  // in, which would move the buttons from under it; it follows again once the pointer leaves.
  let pointerOnTools = false
  let followWhenFree = false
  deps.messagesEl.addEventListener('pointerover', event => {
    pointerOnTools = Boolean((event.target as Element | null)?.closest?.('.message-tools'))
  })
  deps.messagesEl.addEventListener('pointerleave', () => {
    pointerOnTools = false
  })
  // The cards of members replying (正在回复中 and the text so far), kept while only their text
  // changes, so their 停止 button is not replaced under the pointer as the reply comes in.
  const replyCards = new Map<string, { signature: string; node: HTMLElement }>()
  // Image tiles and file chips under a message.
  const attachmentsView = createMessageAttachmentsView({
    loadImageAttachment: deps.loadImageAttachment,
    showError: deps.showError,
    resync: message => handleResyncMessage(message),
    iconButton: (label, icon, onClick) => createMessageIconButton(label, icon, onClick),
  })
  let timeDividers = new Map<string, HTMLElement>()
  // People who answered each question in the chat on screen, counted once per render.
  let replyCounts = new Map<string, number>()
  // Choices are offered only on replies newer than the user's latest message.
  let latestUserSeq = 0
  // Questions whose round has a summary (or one on the way), and the summary requests by id.
  let summarizedQuestionIds = new Set<string>()
  let summaryRequestsById = new Map<string, GroupMessage>()
  // Questions whose answers the members are reviewing (互相审).
  let reviewedQuestionIds = new Set<string>()
  // Folded replies the user opened, until the page is reloaded.
  const expandedReplyIds = new Set<string>()
  // The discussion bar, kept while its state is the same so a click is not lost to a re-render.
  let discussionBarCache: { key: string; node: HTMLElement } | undefined
  // What local agent members wait on.
  const approvalCards = createApprovalCards({ runCommand: (type, payload) => deps.runCommand(type, payload), showError: message => deps.showError(message) })
  // Replies still being written flow in smoothly instead of jumping in bursts. While the user is
  // at the bottom of the chat, it stays there as the text grows.
  const reveal = createStreamingReveal({
    render: (body, text) => {
      const follow = isScrolledNearBottom(deps.messagesEl)
      body.replaceChildren()
      if (text) renderMarkdownMessageBody(body, text)
      if (follow) deps.messagesEl.scrollTop = deps.messagesEl.scrollHeight
    },
  })

  function renderMessages(): void {
    const chat = deps.getCurrentChat()
    const messages = deps.getCurrentMessages()
    replyCounts = countRepliesByQuestion(messages)
    summaryRequestsById = new Map(messages.filter(message => message.type === 'user' && message.roundSummaryOf).map(message => [message.id, message]))
    summarizedQuestionIds = new Set([...summaryRequestsById.values()].map(message => message.roundSummaryOf!))
    reviewedQuestionIds = new Set(messages.flatMap(message => message.crossReviewOf ? [message.crossReviewOf] : []))
    // OpenTeam's own requests (summaries, discussion turns) are not the user speaking, so they leave
    // the round's choices open.
    latestUserSeq = messages.reduce((latest, message) => message.type === 'user' && !isOpenTeamRequest(message) ? Math.max(latest, message.seq) : latest, 0)
    attachmentsView.releaseUnused(messages)
    const preserveScroll = deps.state.preserveNextMessageScroll
    const previousScrollTop = deps.messagesEl.scrollTop
    const nearBottom = isScrolledNearBottom(deps.messagesEl) || followWhenFree
    const holdStill = pointerOnTools
    followWhenFree = holdStill && nearBottom
    const shouldFollowNewReplies = nearBottom && !holdStill

    if (!chat) {
      reconcileChildren(deps.messagesEl, [startCards.noChatCard()])
      return
    }

    const nodes: Node[] = []
    const orchestrationStatus = deps.renderOrchestrationStatus?.()
    if (orchestrationStatus) nodes.push(orchestrationStatus)
    const teamStatus = deps.renderTeamFormationStatus?.(chat)
    if (teamStatus) nodes.push(teamStatus)

    if (messages.length === 0) {
      const roles = deps.getCurrentRoles()
      const startupNotice = getChatStartupNotice(chat, roles)
      if (roles.length === 0) {
        nodes.push(emptyChatPeopleCard('暂无成员', '先添加成员，再开始群聊协作。'))
      } else {
        nodes.push(startupNotice ? deps.emptyCard(startupNotice.title, startupNotice.body) : deps.emptyCard('等待第一条消息', '直接发送会记录消息；@ 成员或 @所有人 后触发回复。'))
      }
    }

    const nextTimeDividers = new Map<string, HTMLElement>()
    for (const item of buildChatRenderItems(messages, deps.getCurrentRoles())) {
      if (item.type === 'time') {
        const key = `${item.id}:${item.label}`
        let divider = timeDividers.get(key)
        if (!divider) {
          divider = document.createElement('div')
          divider.className = 'message-time-divider'
          divider.textContent = item.label
        }
        nextTimeDividers.set(key, divider)
        nodes.push(divider)
        continue
      }
      nodes.push(renderMessageNode(item.message, item.showName, item.showAvatar))
    }
    timeDividers = nextTimeDividers

    const streamingRoleIds = new Set(messages
      .filter(message => message.type === 'assistant' && message.status === 'pending' && message.roleId)
      .map(message => message.roleId!))
    for (const role of getVisibleThinkingRoles(deps.getCurrentRoles()).filter(role => !streamingRoleIds.has(role.id))) {
      nodes.push(replyControlBubble(role))
    }
    for (const role of getStoppedReplyRoles(deps.getCurrentRoles())) {
      nodes.push(replyControlBubble(role))
    }
    nodes.push(...approvalCards.cardsByRole(chat.id, deps.getCurrentRoles()).values())
    const discussion = discussionBar(chat, messages)
    if (discussion) nodes.push(discussion)
    const projectBoard = deps.renderProjectBoard?.(chat, messages)
    if (projectBoard) nodes.push(projectBoard)
    const siteCheck = deps.renderSiteCheck?.(chat)
    if (siteCheck) nodes.push(siteCheck)
    reconcileChildren(deps.messagesEl, nodes)
    reveal.retain(new Set([
      ...messages.filter(message => message.type === 'assistant' && message.status === 'pending').map(message => streamingRevealKey(message)),
      ...getVisibleThinkingRoles(deps.getCurrentRoles()).map(role => liveRevealKey(role)),
    ]))
    pruneMessageNodeCache(messages)
    scheduleThinkingTimeouts()
    if (preserveScroll || !shouldFollowNewReplies) {
      deps.messagesEl.scrollTop = previousScrollTop
    } else {
      deps.messagesEl.scrollTop = deps.messagesEl.scrollHeight
    }
  }

  function isScrolledNearBottom(element: HTMLElement): boolean {
    const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop
    return distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
  }

  function renderMessageNode(message: GroupMessage, showName = true, showAvatar = true): HTMLElement {
    const signature = messageSignature(message, showName, showAvatar)
    const cached = deps.state.messageNodeCache.get(message.id)
    if (cached?.signature === signature) return cached.node
    const streamingSignature = streamingMessageSignature(message, showName, showAvatar)
    if (cached?.streamingSignature && streamingSignature && cached.streamingSignature === streamingSignature && patchStreamingMessageNode(cached.node, message)) {
      cacheMessageNode(message.id, signature, cached.node, streamingSignature)
      return cached.node
    }

    const article = document.createElement('article')
    article.className = `message-row message ${message.type}${showName ? '' : ' compact'}${showAvatar ? '' : ' no-avatar'}`
    article.dataset.messageId = message.id

    if (message.type === 'user' && (message.discussionTurnOf || message.projectRequest)) {
      article.className = `message-row message system ${message.projectRequest ? 'project-request' : 'discussion-turn-request'}`
      const pill = document.createElement('div')
      pill.className = 'message-system-pill'
      pill.textContent = message.content
      article.append(pill)
      cacheMessageNode(message.id, signature, article, streamingSignature)
      return article
    }

    // 互相审: the members who answered are reviewing each other's answers.
    if (message.type === 'user' && message.crossReviewOf) {
      article.className = 'message-row message system cross-review-request'
      const pill = document.createElement('div')
      pill.className = 'message-system-pill'
      const names = (message.targetRoleIds ?? []).map(id => deps.getStore().rolesById[id]?.name).filter(Boolean)
      pill.textContent = `已请${names.map(name => `「${name}」`).join('')}互相审阅回答`
      article.append(pill)
      cacheMessageNode(message.id, signature, article, streamingSignature)
      return article
    }

    if (message.type === 'user' && message.roundSummaryOf) {
      article.className = 'message-row message system round-summary-request'
      const pill = document.createElement('div')
      pill.className = 'message-system-pill'
      const summarizer = message.targetRoleIds?.[0] ? deps.getStore().rolesById[message.targetRoleIds[0]] : undefined
      pill.textContent = summarizer ? `已请「${summarizer.name}」汇总本轮回复` : '正在汇总本轮回复'
      article.append(pill)
      cacheMessageNode(message.id, signature, article, streamingSignature)
      return article
    }

    if (message.type === 'system') {
      const pill = document.createElement('div')
      pill.className = 'message-system-pill'
      const orchestrationLabel = renderOrchestrationMessageLabel(message)
      if (orchestrationLabel) pill.append(orchestrationLabel)
      pill.append(document.createTextNode(message.content))
      article.append(pill)
      cacheMessageNode(message.id, signature, article, streamingSignature)
      return article
    }

    const inner = document.createElement('div')
    inner.className = 'message-inner'

    const avatar = document.createElement('div')
    paintMessageAvatar(avatar, message)
    avatar.hidden = !showAvatar
    wireMentionShortcut(avatar, roleForMessage(message))

    const stack = document.createElement('div')
    stack.className = 'message-stack'

    const isSummary = isRoundSummaryReply(message)
    const projectRequest = message.type === 'assistant' && message.sourceMessageId ? deps.getStore().messagesById[message.sourceMessageId]?.projectRequest : undefined
    const isFinal = projectRequest?.kind === 'final'
    if (isSummary || isFinal) article.classList.add('round-summary')
    if (isFinal) article.classList.add('project-final')
    if (message.type === 'assistant' && (showName || isSummary || isFinal)) {
      const name = document.createElement('div')
      name.className = 'message-name'
      if (isSummary || isFinal) {
        const label = document.createElement('span')
        label.className = 'round-summary-label'
        label.textContent = isFinal ? '最终交付' : '本轮汇总'
        name.append(label)
      }
      const title = document.createElement('span')
      title.className = 'message-name-text'
      // A member still in the chat goes by the name it has now.
      const role = roleForMessage(message)
      title.textContent = role?.name ?? deps.messageTitle(message)
      name.append(title)
      if (role) {
        name.append(siteBadge(role))
        const jumpButton = siteJumpButton(message.chatId, role)
        if (jumpButton) name.append(jumpButton)
      }
      const usage = usageLabel(message)
      if (usage) name.append(usage)
      const fallback = fallbackLabel(message)
      if (fallback) name.append(fallback)
      const stalled = stalledLabel(message)
      if (stalled) name.append(stalled)
      wireMentionShortcut(name, role)
      stack.append(name)
    }

    const bubble = document.createElement('div')
    bubble.className = 'message-bubble'
    const orchestrationLabel = renderOrchestrationMessageLabel(message)
    if (orchestrationLabel) bubble.append(orchestrationLabel)
    const bubbleLabel = message.scheduledTaskId ? '定时任务发出'
      : message.discussionTopic ? '轮流讨论'
      : message.discussionNoteOf ? '补充给下一位发言的成员'
        : message.projectGoal ? '项目目标'
          : message.projectNoteOf ? '补充给协调员'
            : projectRequest?.kind === 'task' ? projectTaskLabel(message, projectRequest.taskId)
              : undefined
    if (bubbleLabel) {
      const label = document.createElement('div')
      label.className = 'discussion-message-label'
      label.textContent = bubbleLabel
      bubble.append(label)
    }
    const body = document.createElement('div')
    body.className = 'message-body'
    if (message.type === 'assistant' && message.status === 'pending') body.classList.add('thinking-dots')
    if (message.type === 'user') {
      const mentions = renderMessageMentions(message)
      if (mentions) appendMentionsToBody(body, mentions)
    }
    if (message.type === 'assistant' && message.status === 'pending' && !message.content.trim()) {
      setPendingText(body, message)
    } else if (message.type === 'assistant' && message.status === 'error' && isStructuredFailureReason(message.content)) {
      renderPlainMessageBody(body, getDiagnosticText(message.content))
    } else if (message.type === 'assistant' && message.status !== 'pending' && renderTeamClaimInto(body, message)) {
      // Shown as the claimed position.
    } else if (message.type === 'assistant' && message.status === 'pending') {
      reveal.show(streamingRevealKey(message), body, message.content)
    } else if (shouldRenderMarkdownMessage(message)) {
      renderMarkdownMessageBody(body, message.content)
    } else {
      renderPlainMessageBody(body, message.content)
    }
    renderSavedHighlights(body, message)
    const hasVisibleTextBody = message.status === 'pending' || Boolean(message.content.trim())
    // A coordinator's plan or check is JSON for OpenTeam: folded under a title, the raw reply a click away.
    if (hasVisibleTextBody && message.status === 'received' && (projectRequest?.kind === 'plan' || projectRequest?.kind === 'review')) {
      const details = document.createElement('details')
      details.className = 'project-coordinator-reply'
      const summary = document.createElement('summary')
      summary.textContent = projectRequest.kind === 'plan' ? '协调员的任务计划（看板里有整理好的版本）' : '协调员的检查结果（看板里有整理好的版本）'
      details.append(summary, body)
      bubble.append(details)
    } else if (hasVisibleTextBody) bubble.append(body)
    const foldToggle = message.type === 'assistant' && message.status === 'received' ? foldToKeyPoints(body, message.id, expandedReplyIds) : undefined
    if (foldToggle) bubble.append(foldToggle)
    const imageGrid = attachmentsView.renderImageGrid(message)
    if (imageGrid) bubble.append(imageGrid)
    const fileList = attachmentsView.renderFileList(message)
    if (fileList) bubble.append(fileList)
    const reviewSummary = renderOrchestrationReviewSummary(deps.getStore(), message)
    if (reviewSummary) bubble.append(reviewSummary)
    if (message.references?.length) bubble.append(referenceBox(message.references[0]))

    if (message.type === 'assistant') {
      const tools = document.createElement('div')
      tools.className = 'message-tools'
      const role = roleForMessage(message)
      if (message.roleId && message.status === 'pending' && role) {
        tools.append(createMessageIconButton('停止回复', 'stop', () => deps.stopRoleReply(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))), { activateOnPointerDown: true, text: '停止' }))
      } else if (message.roleId && message.status === 'error' && role) {
        tools.append(createMessageIconButton('重新回复', 'retry', () => deps.retryRoleReply(role, message.id).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))))
      } else if (message.roleId && role?.modelSource === 'external') {
        tools.append(createMessageIconButton('重新回复', 'retry', () => deps.retryRoleReply(role, message.id).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))))
      } else if (message.roleId) {
        tools.append(createMessageIconButton('跳转到原始窗口', 'jump', () => deps.focusRoleFrame(message.chatId, message.roleId)))
        tools.append(createMessageIconButton('重新同步完整回复', 'retry', () => handleResyncMessage(message)))
      }
      if (message.content.trim()) {
        tools.append(createMessageIconButton('引用回复', 'quote', () => deps.setReference(message)))
        tools.append(createMessageIconButton('复制回复', 'copy', button => handleCopyMessage(button, message)))
        // A finished reply only: one still being written or one that failed is not worth keeping.
        if (deps.rememberMessage && message.status === 'received') tools.append(createMessageIconButton('记住这条', 'memory', button => deps.rememberMessage?.(message, button)))
        // A round's summary can be kept as a decision every member of the group gets.
        if (deps.adoptSummary && message.status === 'received' && isRoundSummaryReply(message)) {
          tools.append(createMessageIconButton('采纳为决定', 'check', button => deps.adoptSummary?.(message, button), { text: '采纳' }))
        }
      }
      bubble.append(tools)
    }

    if (message.type === 'user' && !message.orchestrationKind && message.content.trim() && (deps.editAndResend || deps.rememberMessage)) {
      const tools = document.createElement('div')
      tools.className = 'message-tools'
      if (deps.editAndResend) tools.append(createMessageIconButton('编辑后重新发送', 'edit', () => deps.editAndResend?.(message)))
      if (deps.rememberMessage) tools.append(createMessageIconButton('记住这条', 'memory', button => deps.rememberMessage?.(message, button)))
      bubble.append(tools)
    }

    stack.append(bubble)
    const compare = compareButton(message)
    const summarize = summarizeButton(message)
    if (compare || summarize) {
      const actions = document.createElement('div')
      actions.className = 'message-round-actions'
      if (compare) actions.append(compare)
      if (summarize) actions.append(summarize)
      stack.append(actions)
    }
    const choices = replyChoicesBlock(message)
    if (choices) stack.append(choices)
    const proposals = memoryProposalsBlock(message)
    if (proposals) stack.append(proposals)
    inner.append(avatar, stack)
    article.append(inner)
    cacheMessageNode(message.id, signature, article, streamingSignature)
    return article
  }

  // "任务 t2 · 写方案" over a member's answer to a project task.
  function projectTaskLabel(message: GroupMessage, taskId: string | undefined): string {
    const task = deps.getStore().chatsById[message.chatId]?.project?.tasks.find(candidate => candidate.id === taskId)
    return task ? `任务 ${task.id} · ${task.title}` : `任务 ${taskId ?? ''}`
  }

  function isRoundSummaryReply(message: GroupMessage): boolean {
    return message.type === 'assistant' && Boolean(message.sourceMessageId && summaryRequestsById.has(message.sourceMessageId))
  }

  // The group's discussion while it runs (turn, speaker, stop), and once it ends (one more round,
  // summarize), until the user starts something else.
  function discussionBar(chat: GroupChat, messages: GroupMessage[]): HTMLElement | undefined {
    const run = chat.discussion
    if (!run) return undefined
    const running = run.status === 'running'
    if (!running) {
      const latestOwn = [...messages].reverse().find(message => message.type === 'user' && !isOpenTeamRequest(message))
      if (!latestOwn || (latestOwn.id !== run.topicMessageId && latestOwn.discussionNoteOf !== run.topicMessageId)) return undefined
    }
    const store = deps.getStore()
    const summarized = !running && hasRoundSummary(store, chat, run.topicMessageId)
    const key = JSON.stringify([chat.id, run.id, run.status, run.turn, run.maxTurns, run.currentRoleId, run.stopReason, summarized, run.currentRoleId ? store.rolesById[run.currentRoleId]?.name : undefined])
    if (discussionBarCache?.key === key) return discussionBarCache.node
    const bar = document.createElement('div')
    bar.className = `discussion-bar${running ? ' running' : ''}`
    bar.setAttribute('role', 'status')
    const text = document.createElement('div')
    text.className = 'discussion-bar-text'
    const title = document.createElement('strong')
    const detail = document.createElement('span')
    if (running) {
      const speaker = run.currentRoleId ? store.rolesById[run.currentRoleId]?.name : undefined
      title.textContent = `轮流讨论中 · 第 ${run.turn}/${run.maxTurns} 轮`
      detail.textContent = speaker ? `「${speaker}」正在发言。你现在发的消息会作为补充，给下一位发言的成员看。` : '你现在发的消息会作为补充，给下一位发言的成员看。'
    } else {
      title.textContent = run.status === 'done' ? `讨论结束 · 共 ${run.turn} 轮` : `讨论已停止 · 共 ${run.turn} 轮`
      detail.textContent = run.stopReason === 'failed'
        ? '连续两位成员没有回复，讨论停了下来。'
        : run.stopReason === 'unavailable' ? '没有可以发言的成员了。' : ''
    }
    text.append(title)
    if (detail.textContent) text.append(detail)
    bar.append(text)

    const actions = document.createElement('div')
    actions.className = 'discussion-bar-actions'
    const command = (label: string, type: string, primary = false) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `btn btn-small${primary ? ' btn-primary' : ''}`
      button.textContent = label
      button.addEventListener('click', () => {
        button.disabled = true
        deps.runCommand(type, { chatId: chat.id, ...(type === 'GROUP_ROUND_SUMMARY_REQUEST' ? { messageId: run.topicMessageId } : {}) })
          .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
          .finally(() => { button.disabled = false })
      })
      actions.append(button)
    }
    if (running) {
      command('停止讨论', 'GROUP_DISCUSSION_STOP')
    } else {
      command('再讨论一轮', 'GROUP_DISCUSSION_CONTINUE', true)
      if (!summarized) command('汇总讨论', 'GROUP_ROUND_SUMMARY_REQUEST')
    }
    bar.append(actions)
    discussionBarCache = { key, node: bar }
    return bar
  }

  // Asks a member to summarize a round that has no summary yet.
  function summarizeButton(message: GroupMessage): HTMLButtonElement | undefined {
    if (message.type !== 'user' || message.roundSummaryOf || message.orchestrationKind || message.status === 'pending') return undefined
    // Answers being reviewed (互相审) are summarized after the reviews, on their own.
    if (reviewedQuestionIds.has(message.id)) return undefined
    if ((replyCounts.get(message.id) ?? 0) < 2 || summarizedQuestionIds.has(message.id)) return undefined
    const chat = deps.getCurrentChat()
    if (chat && deps.isTeamInvitation?.(chat, message.id)) return undefined
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-compare-btn message-summary-btn'
    button.replaceChildren(createIcon('summary'), document.createTextNode('汇总本轮'))
    button.addEventListener('click', event => {
      event.stopPropagation()
      button.disabled = true
      deps.runCommand('GROUP_ROUND_SUMMARY_REQUEST', { chatId: message.chatId, messageId: message.id })
        .catch(error => {
          button.disabled = false
          deps.showError(error instanceof Error ? error.message : String(error))
        })
    })
    return button
  }

  function choicesOpen(message: GroupMessage): boolean {
    return message.type === 'assistant' && message.status === 'received' && message.seq > latestUserSeq && Boolean(deps.answerChoice)
  }

  // The options a reply ends with, as buttons that answer that member.
  function replyChoicesBlock(message: GroupMessage): HTMLElement | undefined {
    if (!choicesOpen(message)) return undefined
    const role = roleForMessage(message)
    const choices = role ? extractReplyChoices(message.content) : undefined
    if (!role || !choices) return undefined
    const block = document.createElement('div')
    block.className = 'reply-choices'
    block.setAttribute('role', 'group')
    block.setAttribute('aria-label', '回复选项')
    for (const choice of choices) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'reply-choice'
      const label = document.createElement('span')
      label.className = 'reply-choice-label'
      label.textContent = choice.label
      const text = document.createElement('span')
      text.className = 'reply-choice-text'
      text.textContent = choice.text
      button.append(label, text)
      button.addEventListener('click', () => deps.answerChoice?.(role, choice))
      block.append(button)
    }
    return block
  }

  // What the member proposed to remember at the end of this reply. Nothing is saved until the user
  // says so: each one is saved (through the save window, where it can be changed) or dismissed.
  function memoryProposalsBlock(message: GroupMessage): HTMLElement | undefined {
    const proposals = message.type === 'assistant' ? message.memoryProposals : undefined
    if (!proposals?.length || !deps.rememberProposal) return undefined
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    const block = document.createElement('div')
    block.className = 'memory-proposals'
    block.setAttribute('role', 'group')
    block.setAttribute('aria-label', en ? 'Save to memory?' : '保存到记忆库？')
    const title = document.createElement('p')
    title.className = 'memory-proposals-title'
    const titleText = document.createElement('span')
    titleText.textContent = en ? 'Save to memory?' : '保存到记忆库？'
    title.append(createIcon('memory'), titleText)
    block.append(title)
    for (const proposal of proposals) {
      const row = document.createElement('div')
      row.className = 'memory-proposal'
      row.dataset.memoryProposal = proposal.id
      const kind = document.createElement('span')
      kind.className = 'memory-proposal-kind'
      kind.textContent = MEMORY_KIND_LABELS[proposal.kind][en ? 1 : 0]
      const text = document.createElement('span')
      text.className = 'memory-proposal-text'
      text.textContent = proposal.content
      const actions = document.createElement('span')
      actions.className = 'memory-proposal-actions'
      const save = document.createElement('button')
      save.type = 'button'
      save.className = 'btn btn-small btn-primary'
      save.textContent = en ? 'Save…' : '保存…'
      save.setAttribute('aria-label', `${en ? 'Save to memory: ' : '保存到记忆库：'}${proposal.content}`)
      save.addEventListener('click', () => deps.rememberProposal?.(message, proposal, save))
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'btn btn-small'
      dismiss.textContent = en ? 'Dismiss' : '忽略'
      dismiss.setAttribute('aria-label', `${en ? 'Dismiss: ' : '忽略：'}${proposal.content}`)
      dismiss.addEventListener('click', () => {
        dismiss.disabled = true
        deps.runCommand('GROUP_MEMORY_PROPOSAL_DISMISS', { messageId: message.id, proposalId: proposal.id })
          .catch(error => {
            dismiss.disabled = false
            deps.showError(error instanceof Error ? error.message : String(error))
          })
      })
      actions.append(save, dismiss)
      row.append(kind, text, actions)
      block.append(row)
    }
    return block
  }

  // The backup model that wrote an API reply its main model could not.
  function fallbackLabel(message: GroupMessage): HTMLElement | undefined {
    const modelName = message.answeredByFallback
    if (!modelName) return undefined
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    const label = document.createElement('span')
    label.className = 'message-usage message-fallback'
    label.textContent = `${en ? 'Backup' : '备用'} ${modelName}`
    // A web member's backup answers when its site cannot take the prompt (memberBackup.ts).
    const web = roleForMessage(message)?.modelSource !== 'external'
    label.title = web
      ? (en ? `Its web page could not take the prompt this time; the backup API model ${modelName} answered` : `网页这次接不了提问，由备用 API 模型 ${modelName} 代答`)
      : (en ? `The main model could not answer this time; the backup model ${modelName} did` : `主模型这次没能回答，由备用模型 ${modelName} 回答`)
    return label
  }

  // A web reply taken while its site still said it was writing (src/content/replyObserver.ts).
  function stalledLabel(message: GroupMessage): HTMLElement | undefined {
    if (!message.stalledWhileGenerating) return undefined
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    const label = document.createElement('span')
    label.className = 'message-usage message-stalled'
    label.textContent = en ? 'Taken as it stood' : '按现有内容收尾'
    label.title = en
      ? 'The site kept showing it was still writing, with no new text for 3 minutes, so OpenTeam took the reply as it stood and stopped the site'
      : '网站一直显示还在生成，3 分钟没有新内容，OpenTeam 按现有内容收尾，并停止了网站的生成'
    return label
  }

  // How many tokens an API reply used, with the input/output split on hover.
  function usageLabel(message: GroupMessage): HTMLElement | undefined {
    const total = message.usage?.totalTokens
    if (total === undefined) return undefined
    const label = document.createElement('span')
    label.className = 'message-usage'
    label.textContent = `${total.toLocaleString('en-US')} tokens`
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    const parts = [
      message.usage?.inputTokens !== undefined ? `${en ? 'Input' : '输入'} ${message.usage.inputTokens.toLocaleString('en-US')}` : '',
      message.usage?.outputTokens !== undefined ? `${en ? 'Output' : '输出'} ${message.usage.outputTokens.toLocaleString('en-US')}` : '',
    ].filter(Boolean)
    if (parts.length) label.title = `${parts.join(' · ')} tokens`
    return label
  }

  function cacheMessageNode(messageId: string, signature: string, node: HTMLElement, streamingSignature?: string): void {
    deps.state.messageNodeCache.set(messageId, { signature, node, streamingSignature })
  }

  // Evicts the oldest cached nodes, but never those of the chat on screen: evicting those would
  // rebuild (and re-render the Markdown of) every older message on each update of a long chat.
  function pruneMessageNodeCache(visibleMessages: GroupMessage[]): void {
    const cache = deps.state.messageNodeCache
    if (cache.size <= MAX_CACHED_MESSAGE_NODES) return
    const visibleIds = new Set(visibleMessages.map(message => message.id))
    for (const messageId of cache.keys()) {
      if (cache.size <= MAX_CACHED_MESSAGE_NODES) return
      if (!visibleIds.has(messageId)) cache.delete(messageId)
    }
  }

  // Puts `nodes` into `parent` in order while leaving nodes that are already in place untouched,
  // so an update does not detach, restyle and re-lay-out every message in the list.
  // Old nodes that are gone are dropped as the walk reaches them: left in place, a replaced message
  // would make every node after it move in front of it, re-laying out the whole of a long chat.
  function reconcileChildren(parent: HTMLElement, nodes: Node[]): void {
    const kept = new Set(nodes)
    let cursor = parent.firstChild
    for (const node of nodes) {
      while (cursor && !kept.has(cursor)) {
        const gone = cursor
        cursor = cursor.nextSibling
        gone.remove()
      }
      if (node === cursor) {
        cursor = cursor.nextSibling
        continue
      }
      parent.insertBefore(node, cursor)
    }
    while (cursor) {
      const next = cursor.nextSibling
      cursor.remove()
      cursor = next
    }
  }

  function patchStreamingMessageNode(node: HTMLElement, message: GroupMessage): boolean {
    const body = node.querySelector<HTMLElement>('.message-body')
    if (!body) return false
    body.className = 'message-body thinking-dots'
    if (!message.content.trim()) {
      body.replaceChildren()
      setPendingText(body, message)
    } else {
      delete body.dataset.pendingText
      delete body.dataset.pendingSince
      reveal.show(streamingRevealKey(message), body, message.content)
    }
    return true
  }

  // The waiting text, marked so the clock below can add how long it has been.
  function setPendingText(body: HTMLElement, message: GroupMessage): void {
    const text = pendingReplyText(message)
    body.textContent = text
    body.dataset.pendingText = text
    body.dataset.pendingSince = String(message.createdAt)
  }

  // Once a second, replies still waiting for their first words say how long they have waited (from
  // 5 seconds on), without re-rendering the chat.
  window.setInterval(() => {
    const bodies = deps.messagesEl.querySelectorAll<HTMLElement>('.message-body[data-pending-since]')
    if (bodies.length === 0) return
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    for (const body of bodies) {
      const base = body.dataset.pendingText?.trimEnd()
      // Only while the body still holds the waiting text (never over a reply's words).
      if (!base || body.firstElementChild || !body.textContent?.startsWith(base)) continue
      const seconds = Math.floor((Date.now() - Number(body.dataset.pendingSince)) / 1000)
      if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) continue
      const next = `${base} · ${seconds}${en ? 's' : ' 秒'} `
      if (body.textContent !== next) body.textContent = next
    }
  }, 1000)

  // A reply not started yet: 正在回复中, or, while its request is sent again, which retry and why.
  // Message bodies are left alone by the page's language pass, so this picks its language itself.
  function pendingReplyText(message: GroupMessage): string {
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    const retry = message.retry
    if (!retry) return en ? 'Replying ' : '正在回复中 '
    const reason = retry.reason.length > 60 ? `${retry.reason.slice(0, 60)}…` : retry.reason
    return en ? `Retrying (${retry.attempt} of ${retry.total}): ${reason} ` : `正在重试（第 ${retry.attempt}/${retry.total} 次）：${reason} `
  }

  function renderTeamClaimInto(body: HTMLElement, message: GroupMessage): boolean {
    const claim = deps.renderTeamClaim?.(message)
    if (!claim) return false
    body.append(claim)
    return true
  }

  function renderMarkdownMessageBody(body: HTMLElement, content: string): void {
    renderMarkdownInto(body, content)
  }

  function renderPlainMessageBody(body: HTMLElement, content: string): void {
    body.append(document.createTextNode(content))
  }

  function compareButton(message: GroupMessage): HTMLButtonElement | undefined {
    const chat = deps.getCurrentChat()
    if (message.type === 'user' && chat && deps.isTeamInvitation?.(chat, message.id)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'message-compare-btn message-team-btn'
      button.replaceChildren(createIcon('flag'), document.createTextNode('查看分工'))
      button.addEventListener('click', event => {
        event.stopPropagation()
        deps.openTeamCard?.(chat.id)
      })
      return button
    }
    const count = message.type === 'user' ? replyCounts.get(message.id) ?? 0 : 0
    if (count < 2 || !deps.openReplyComparison) return undefined
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-compare-btn'
    button.replaceChildren(createIcon('compare'), document.createTextNode(`对比 ${count} 个回复`))
    button.addEventListener('click', event => {
      event.stopPropagation()
      deps.openReplyComparison?.(message.id)
    })
    return button
  }

  function renderSavedHighlights(body: HTMLElement, message: GroupMessage): void {
    const highlights = deps.getStore().messageHighlightsById?.[message.id]
    if (!highlights?.length) return
    applyHighlightsToBody(body, highlights)
  }

  function shouldRenderMarkdownMessage(message: GroupMessage): boolean {
    return message.contentFormat === 'markdown' || message.type === 'assistant'
  }

  // options.text: a word shown beside the icon, for a button whose icon alone is not clear enough.
  function createMessageIconButton(label: string, icon: MessageActionIcon, onClick: (button: HTMLButtonElement) => void, options: { activateOnPointerDown?: boolean; text?: string } = {}): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `message-tool-btn${options.text ? ' message-tool-btn-labeled' : ''}`
    button.setAttribute('aria-label', label)
    if (options.text) {
      const text = document.createElement('span')
      text.className = 'message-tool-label'
      text.textContent = options.text
      button.append(text)
    }
    setMessageButtonIcon(button, icon)
    let activatedOnPointerDown = false
    if (options.activateOnPointerDown) {
      button.addEventListener('pointerdown', event => {
        if (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent && event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        activatedOnPointerDown = true
        onClick(button)
      })
    }
    button.addEventListener('click', event => {
      if (activatedOnPointerDown) {
        activatedOnPointerDown = false
        return
      }
      event.stopPropagation()
      onClick(button)
    })
    return button
  }

  function setMessageButtonIcon(button: HTMLButtonElement, icon: MessageActionIcon): void {
    const text = button.querySelector('.message-tool-label')
    button.replaceChildren(messageActionIcon(icon), ...(text ? [text] : []))
  }

  // The page's line icons ('jump' is the external-window one).
  function messageActionIcon(icon: MessageActionIcon): SVGSVGElement {
    return createIcon(icon === 'jump' ? 'external' : icon)
  }

  async function handleCopyMessage(button: HTMLButtonElement, message: GroupMessage): Promise<void> {
    try {
      await copyMessageContent(message)
      showCopyFeedback(button)
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : String(error))
    }
  }

  function handleResyncMessage(message: GroupMessage): void {
    deps.log.warn('ui:message-resync:click', {
      chatId: message.chatId,
      roleId: message.roleId,
      messageId: message.id,
      contentLength: message.content.length,
    })
    if (!message.roleId) {
      deps.log.warn('ui:message-resync:missing-role', { chatId: message.chatId, messageId: message.id })
      return
    }
    deps.state.preserveNextMessageScroll = true
    deps.resyncMessageReply(message)
      .then(() => {
        deps.showSuccess('执行成功了')
      })
      .catch(error => {
        deps.log.warn('ui:message-resync:failed', {
          chatId: message.chatId,
          roleId: message.roleId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        })
        deps.showError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        deps.state.preserveNextMessageScroll = false
      })
  }

  function showCopyFeedback(button: HTMLButtonElement): void {
    button.classList.add('copied')
    button.setAttribute('aria-label', '已复制')
    setMessageButtonIcon(button, 'check')
    window.setTimeout(() => {
      button.classList.remove('copied')
      button.setAttribute('aria-label', '复制回复')
      setMessageButtonIcon(button, 'copy')
    }, COPY_FEEDBACK_MS)
  }

  async function copyMessageContent(message: GroupMessage): Promise<void> {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持复制')
    await navigator.clipboard.writeText(message.content)
  }

  function messageSignature(message: GroupMessage, showName = true, showAvatar = true): string {
    return JSON.stringify({
      type: message.type,
      roleId: message.roleId,
      roleName: message.roleName,
      roleSite: roleForMessage(message)?.chatSite,
      roleCurrentName: roleForMessage(message)?.name,
      roleAvatar: roleAvatarSignature(roleForMessage(message)),
      content: message.content,
      contentFormat: message.contentFormat,
      // File text can be large; its id, name and size identify it well enough.
      attachments: message.attachments?.map(attachment => attachment.type === 'file' ? { id: attachment.id, type: attachment.type, fileName: attachment.fileName, size: attachment.size } : attachment),
      createdAt: message.createdAt,
      status: message.status,
      usage: message.usage,
      answeredByFallback: message.answeredByFallback,
      scheduledTaskId: message.scheduledTaskId,
      stalledWhileGenerating: message.stalledWhileGenerating,
      retry: message.retry,
      choicesOpen: choicesOpen(message),
      memoryProposals: message.memoryProposals,
      references: message.references,
      orchestrationRunId: message.orchestrationRunId,
      orchestrationRound: message.orchestrationRound,
      orchestrationStageId: message.orchestrationStageId,
      orchestrationStageIndex: message.orchestrationStageIndex,
      orchestrationKind: message.orchestrationKind,
      orchestrationReviewResult: findReviewResultForMessage(deps.getStore(), message),
      highlights: deps.getStore().messageHighlightsById?.[message.id],
      compareCount: message.type === 'user' ? replyCounts.get(message.id) ?? 0 : undefined,
      summarized: message.type === 'user' ? summarizedQuestionIds.has(message.id) : undefined,
      roundSummary: isRoundSummaryReply(message),
      summaryTarget: message.roundSummaryOf ? deps.getStore().rolesById[message.targetRoleIds?.[0] ?? '']?.name : undefined,
      targetRoleIds: message.targetRoleIds,
      mentionedRoleIds: message.mentionedRoleIds,
      mentionsAll: message.mentionsAll,
      showName,
      showAvatar,
    })
  }

  function streamingMessageSignature(message: GroupMessage, showName = true, showAvatar = true): string | undefined {
    if (message.type !== 'assistant' || message.status !== 'pending') return undefined
    return JSON.stringify({
      type: message.type,
      roleId: message.roleId,
      roleName: message.roleName,
      roleSite: roleForMessage(message)?.chatSite,
      contentFormat: message.contentFormat,
      createdAt: message.createdAt,
      status: message.status,
      references: message.references,
      orchestrationRunId: message.orchestrationRunId,
      orchestrationRound: message.orchestrationRound,
      orchestrationStageId: message.orchestrationStageId,
      orchestrationStageIndex: message.orchestrationStageIndex,
      orchestrationKind: message.orchestrationKind,
      orchestrationReviewResult: findReviewResultForMessage(deps.getStore(), message),
      highlights: deps.getStore().messageHighlightsById?.[message.id],
      showName,
      showAvatar,
    })
  }

  function renderMessageMentions(message: GroupMessage): HTMLElement | undefined {
    if (!message.mentionsAll && !message.mentionedRoleIds?.length) return undefined
    const store = deps.getStore()
    const roles = (message.mentionedRoleIds ?? []).map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
    if (!message.mentionsAll && roles.length === 0) return undefined

    const mentions = document.createElement('div')
    mentions.className = 'message-mentions'
    if (message.mentionsAll) {
      const mention = document.createElement('span')
      mention.className = 'message-mention'
      mention.textContent = '@所有人'
      mentions.append(mention)
    }
    for (const role of roles) {
      const mention = document.createElement('span')
      mention.className = 'message-mention'
      mention.textContent = `@${roleMentionLabel(role, mentionLabelOptions())}`
      mentions.append(mention)
    }
    return mentions
  }

  function appendMentionsToBody(body: HTMLElement, mentions: HTMLElement): void {
    body.append(mentions)
  }

  function scheduleThinkingTimeouts(): void {
    for (const timer of deps.state.thinkingTimeoutTimers) window.clearTimeout(timer)
    deps.state.thinkingTimeoutTimers = []

    const now = Date.now()
    for (const role of deps.getCurrentRoles()) {
      if (role.status !== 'thinking') continue
      const remaining = THINKING_TIMEOUT_MS - (now - role.updatedAt)
      if (remaining <= 0) {
        if (!deps.state.loggedThinkingTimeoutRoleIds.has(role.id)) {
          deps.state.loggedThinkingTimeoutRoleIds.add(role.id)
          deps.log.warn('ui:thinking-bubble:timeout', { chatId: role.chatId, roleId: role.id, timeoutMs: THINKING_TIMEOUT_MS })
        }
        continue
      }
      deps.state.loggedThinkingTimeoutRoleIds.delete(role.id)
      deps.state.thinkingTimeoutTimers.push(window.setTimeout(deps.render, remaining + 1))
    }
  }

  // A member that has no reply yet: stopped, waiting for its turn (the message has not been sent to it
  // yet: API members answer one after another, web pages a few at a time), or answering. Message
  // bodies are left alone by the page's language pass, so this picks its language itself.
  function waitingBubbleText(role: GroupRole, stopped: boolean): string {
    const en = normalizeLanguage(deps.getStore().settings.language) === 'en'
    if (stopped) return en ? 'Stopped' : '已停止回复'
    if (isWaitingForTurn(role)) return en ? 'Waiting for its turn ' : '排队中 '
    return en ? 'Replying ' : '正在回复中 '
  }

  function isWaitingForTurn(role: GroupRole): boolean {
    const messages = deps.getCurrentMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const status = messages[index].type === 'user' ? messages[index].deliveryStatus?.[role.id] : undefined
      if (status) return status === 'pending'
    }
    return false
  }

  function replyControlBubble(role: GroupRole, showName = true, showAvatar = true): HTMLElement {
    const stopped = role.status === 'stopped'
    const liveText = stopped ? undefined : liveReplyText(role)
    const signature = JSON.stringify([role.id, role.name, role.chatSite, role.modelSource, role.externalModelId, role.avatarText, role.avatarImage?.length, stopped, Boolean(liveText), showName, showAvatar, normalizeLanguage(deps.getStore().settings.language)])
    const cached = replyCards.get(role.id)
    if (cached?.signature === signature) {
      const body = cached.node.querySelector<HTMLElement>('.message-body')
      if (body) {
        if (liveText) reveal.show(liveRevealKey(role), body, liveText)
        else body.textContent = waitingBubbleText(role, stopped)
        return cached.node
      }
    }
    const article = buildReplyControlBubble(role, stopped, liveText, showName, showAvatar)
    replyCards.set(role.id, { signature, node: article })
    return article
  }

  function buildReplyControlBubble(role: GroupRole, stopped: boolean, liveText: string | undefined, showName: boolean, showAvatar: boolean): HTMLElement {
    const article = document.createElement('article')
    article.className = `message-row message assistant ${stopped ? 'stopped' : 'thinking'}${liveText ? ' live' : ''}${showName ? '' : ' compact'}${showAvatar ? '' : ' no-avatar'}`
    const inner = document.createElement('div')
    inner.className = 'message-inner'
    const avatar = document.createElement('div')
    paintRoleAvatar(avatar, 'message-avatar', role)
    avatar.hidden = !showAvatar
    wireMentionShortcut(avatar, role)
    const stack = document.createElement('div')
    stack.className = 'message-stack'
    if (showName) {
      const name = document.createElement('div')
      name.className = 'message-name'
      const title = document.createElement('span')
      title.className = 'message-name-text'
      title.textContent = role.name
      name.append(title, siteBadge(role))
      const jumpButton = siteJumpButton(role.chatId, role)
      if (jumpButton) name.append(jumpButton)
      wireMentionShortcut(name, role)
      stack.append(name)
    }
    const bubble = document.createElement('div')
    bubble.className = 'message-bubble'
    const body = document.createElement('div')
    body.className = `message-body${stopped ? '' : ' thinking-dots'}`
    if (liveText) reveal.show(liveRevealKey(role), body, liveText)
    else body.textContent = waitingBubbleText(role, stopped)
    bubble.append(body)
    const tools = document.createElement('div')
    tools.className = 'message-tools'
    tools.append(
      stopped
        ? createMessageIconButton('重新发送', 'retry', () => deps.retryRoleReply(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
        : createMessageIconButton('停止回复', 'stop', () => deps.stopRoleReply(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))), { activateOnPointerDown: true, text: '停止' }),
    )
    bubble.append(tools)
    stack.append(bubble)
    inner.append(avatar, stack)
    article.append(inner)
    return article
  }

  function streamingRevealKey(message: GroupMessage): string {
    return `message:${message.id}`
  }

  function liveRevealKey(role: GroupRole): string {
    return `live:${role.id}:${role.lastPromptMessageId ?? ''}`
  }

  // The reply a web member has written so far, when it belongs to the question it is answering now.
  function liveReplyText(role: GroupRole): string | undefined {
    const live = role.liveReply
    if (!live || role.status !== 'thinking' || live.promptMessageId !== role.lastPromptMessageId) return undefined
    if (live.replyAttemptId && role.replyAttemptId && live.replyAttemptId !== role.replyAttemptId) return undefined
    return live.content.trim() || undefined
  }

  function referenceBox(reference: MessageReference): HTMLElement {
    const box = document.createElement('div')
    box.className = 'reference-box'
    box.textContent = `引用 ${reference.roleName || '成员'}：${truncate(reference.contentSnapshot, 160)}`
    return box
  }

  function emptyChatPeopleCard(title: string, body: string): HTMLElement {
    const wrapper = deps.emptyCard(title, body)
    const card = wrapper.querySelector('.empty-card')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-primary'
    button.textContent = '添加成员'
    button.addEventListener('click', deps.openAddPersonDialog)
    card?.append(button)
    return wrapper
  }

  // The user's own messages carry 你; a member's carry its avatar as it is now.
  function paintMessageAvatar(avatar: HTMLElement, message: GroupMessage): void {
    if (message.type === 'user') {
      avatar.className = 'message-avatar role-tone-5'
      avatar.textContent = '你'
      return
    }
    paintRoleAvatar(avatar, 'message-avatar', roleForMessage(message), message.roleName)
  }

  function truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
  }

  function roleForMessage(message: GroupMessage): GroupRole | undefined {
    if (!message.roleId) return undefined
    const role = deps.getStore().rolesById[message.roleId]
    return role?.chatId === message.chatId ? role : undefined
  }

  function wireMentionShortcut(element: HTMLElement, role: GroupRole | undefined): void {
    if (!role) return
    element.classList.add('mention-shortcut')
    element.title = `@${roleMentionLabel(role, mentionLabelOptions())}`
    element.addEventListener('click', event => {
      event.stopPropagation()
      deps.insertMention(role)
    })
    element.addEventListener('contextmenu', event => {
      event.preventDefault()
      event.stopPropagation()
      deps.insertMention(role)
    })
  }

  function siteBadge(role: GroupRole): HTMLElement {
    const badge = document.createElement('span')
    badge.className = `role-site-badge ${role.modelSource === 'external' ? 'site-pill-external' : `site-pill-${role.chatSite ?? 'gemini'}`}`
    badge.textContent = roleModelLabel(role, mentionLabelOptions())
    return badge
  }

  function siteJumpButton(chatId: string, role: GroupRole): HTMLButtonElement | undefined {
    if (role.modelSource === 'external') return undefined
    const button = createMessageIconButton('跳转到原始窗口', 'jump', () => deps.focusRoleFrame(chatId, role.id))
    button.classList.add('message-site-jump-btn')
    return button
  }

  function mentionLabelOptions() {
    return roleMentionLabelOptionsFromSettings(deps.getStore().settings)
  }

  registerSelectionMarkMenu(deps)

  return { renderMessages }
}
