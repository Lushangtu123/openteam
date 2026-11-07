import { createStreamingReveal } from './streamingReveal'
import { extractReplyChoices, type ReplyChoice } from '../group/replyChoices'
import { normalizeLanguage } from '../shared/i18n'
import { DEFAULT_MESSAGE_HIGHLIGHT_COLOR, MESSAGE_HIGHLIGHT_COLORS, messageHighlightColorRgb, type MessageHighlightColor } from '../group/highlightColors'
import { roleMentionLabel, roleMentionLabelOptionsFromSettings, roleModelLabel } from '../group/mentionParser'
import type { GroupChat, GroupMessage, GroupRole, MessageFileAttachment, MessageHighlight, MessageImageAttachment, MessageReference, OpenTeamStore, OrchestrationReviewResult } from '../group/types'
import { formatBytes } from './composerAttachments'
import { renderMarkdownInto } from './markdownRender'
import { countRepliesByQuestion } from '../group/replyComparison'
import { hasRoundSummary, isKeyPointsHeading, isOpenTeamRequest } from '../group/roundSummary'
import type { ImageAttachmentBlobRecord } from '../shared/imageAttachmentRepository'
import type { TeamPageState } from './appState'
import { buildChatRenderItems, getChatStartupNotice, getStoppedReplyRoles, getVisibleThinkingRoles, THINKING_TIMEOUT_MS } from './chatExperience'

type MessageActionIcon = 'copy' | 'quote' | 'jump' | 'check' | 'stop' | 'retry' | 'download' | 'edit'

const MAX_CACHED_MESSAGE_NODES = 400
const COPY_FEEDBACK_MS = 1200
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 48
const MARK_MENU_SELECTION_GAP_PX = 12
const MARK_MENU_FALLBACK_HEIGHT_PX = 148
const MARK_MENU_SELECTION_SETTLE_DELAY_MS = 80
// A reply with key points folds to them when the rest is longer than this.
const KEY_POINTS_FOLD_MIN_CHARS = 280

export interface MessagesViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  messagesEl: HTMLElement
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getCurrentMessages(): GroupMessage[]
  emptyCard(title: string, body: string): HTMLElement
  openAddPersonDialog(): void
  roleToneClass(seed: string | undefined): string
  roleAvatarLabel(name: string | undefined): string
  messageTitle(message: GroupMessage): string
  focusRoleFrame(chatId: string, roleId: string | undefined): void
  insertMention(role: GroupRole): void
  setReference(message: GroupMessage): void
  // Puts one of the user's messages back in the input box to be sent again.
  editAndResend?(message: GroupMessage): void
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
  let markMenu: HTMLElement | undefined
  let selectedMark: { message: GroupMessage; text: string; startOffset: number; endOffset: number; rect: DOMRect; color: MessageHighlightColor } | undefined
  let selectedHighlightColor: MessageHighlightColor = DEFAULT_MESSAGE_HIGHLIGHT_COLOR
  let selectionDragActive = false
  let ignoreNextDocumentClick = false
  let markMenuUpdateTimer: number | undefined
  const imageObjectUrls = new Map<string, string>()
  const imageLoadPromises = new Map<string, Promise<string | undefined>>()
  let timeDividers = new Map<string, HTMLElement>()
  // People who answered each question in the chat on screen, counted once per render.
  let replyCounts = new Map<string, number>()
  // Choices are offered only on replies newer than the user's latest message.
  let latestUserSeq = 0
  // Questions whose round has a summary (or one on the way), and the summary requests by id.
  let summarizedQuestionIds = new Set<string>()
  let summaryRequestsById = new Map<string, GroupMessage>()
  // Folded replies the user opened, until the page is reloaded.
  const expandedReplyIds = new Set<string>()
  // The discussion bar, kept while its state is the same so a click is not lost to a re-render.
  let discussionBarCache: { key: string; node: HTMLElement } | undefined
  // Approval cards by approval id, kept while they wait.
  let approvalCardCache = new Map<string, HTMLElement>()
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
    // OpenTeam's own requests (summaries, discussion turns) are not the user speaking, so they leave
    // the round's choices open.
    latestUserSeq = messages.reduce((latest, message) => message.type === 'user' && !isOpenTeamRequest(message) ? Math.max(latest, message.seq) : latest, 0)
    releaseUnusedImageUrls(messages)
    const preserveScroll = deps.state.preserveNextMessageScroll
    const previousScrollTop = deps.messagesEl.scrollTop
    const shouldFollowNewReplies = isScrolledNearBottom(deps.messagesEl)

    if (!chat) {
      reconcileChildren(deps.messagesEl, [deps.emptyCard('选择一个群聊', '左侧群聊列表会显示最近摘要、状态和更新时间。')])
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
        nodes.push(emptyChatPeopleCard('暂无人员', '先添加人员，再开始群聊协作。'))
      } else {
        nodes.push(startupNotice ? deps.emptyCard(startupNotice.title, startupNotice.body) : deps.emptyCard('等待第一条消息', '直接发送会记录消息；@ 人员或 @所有人 后触发回复。'))
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
    nodes.push(...approvalCards(chat))
    const discussion = discussionBar(chat, messages)
    if (discussion) nodes.push(discussion)
    const projectBoard = deps.renderProjectBoard?.(chat, messages)
    if (projectBoard) nodes.push(projectBoard)
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
    avatar.className = `message-avatar ${messageToneClass(message)}`
    avatar.textContent = messageAvatarLabel(message)
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
      title.textContent = deps.messageTitle(message)
      name.append(title)
      const role = roleForMessage(message)
      if (role) {
        name.append(siteBadge(role))
        const jumpButton = siteJumpButton(message.chatId, role)
        if (jumpButton) name.append(jumpButton)
      }
      const usage = usageLabel(message)
      if (usage) name.append(usage)
      wireMentionShortcut(name, role)
      stack.append(name)
    }

    const bubble = document.createElement('div')
    bubble.className = 'message-bubble'
    const orchestrationLabel = renderOrchestrationMessageLabel(message)
    if (orchestrationLabel) bubble.append(orchestrationLabel)
    const bubbleLabel = message.discussionTopic ? '轮流讨论'
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
      body.textContent = '正在回复中 '
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
    const foldToggle = message.type === 'assistant' && message.status === 'received' ? foldToKeyPoints(body, message.id) : undefined
    if (foldToggle) bubble.append(foldToggle)
    const imageGrid = renderMessageImageGrid(message)
    if (imageGrid) bubble.append(imageGrid)
    const fileList = renderMessageFileList(message)
    if (fileList) bubble.append(fileList)
    const reviewSummary = renderOrchestrationReviewSummary(message)
    if (reviewSummary) bubble.append(reviewSummary)
    if (message.references?.length) bubble.append(referenceBox(message.references[0]))

    if (message.type === 'assistant') {
      const tools = document.createElement('div')
      tools.className = 'message-tools'
      const role = roleForMessage(message)
      if (message.roleId && message.status === 'pending' && role) {
        tools.append(createMessageIconButton('停止回复', 'stop', () => deps.stopRoleReply(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))), { activateOnPointerDown: true }))
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
      }
      bubble.append(tools)
    }

    if (message.type === 'user' && deps.editAndResend && !message.orchestrationKind && message.content.trim()) {
      const tools = document.createElement('div')
      tools.className = 'message-tools'
      tools.append(createMessageIconButton('编辑后重新发送', 'edit', () => deps.editAndResend?.(message)))
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

  // A reply that starts with key points shows only them until opened, when the rest is long. The
  // reply is rendered whole and the rest hidden, so highlights and copying keep working.
  function foldToKeyPoints(body: HTMLElement, messageId: string): HTMLButtonElement | undefined {
    const parts = keyPointsParts([...body.children])
    if (!parts) return undefined
    body.classList.add('has-key-points')
    const restLength = [...body.children].slice(parts).reduce((total, element) => total + (element.textContent?.trim().length ?? 0), 0)
    if (restLength < KEY_POINTS_FOLD_MIN_CHARS) return undefined

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'key-points-toggle'
    const update = () => {
      const expanded = expandedReplyIds.has(messageId)
      body.classList.toggle('folded', !expanded)
      toggle.setAttribute('aria-expanded', String(expanded))
      toggle.textContent = expanded ? '收起' : '展开全文'
    }
    toggle.addEventListener('click', () => {
      if (expandedReplyIds.has(messageId)) expandedReplyIds.delete(messageId)
      else expandedReplyIds.add(messageId)
      update()
    })
    update()
    return toggle
  }

  // Marks a reply's key points and says how many leading elements they take. Members write them as
  // a heading and a list, a heading and lines, or the heading and lines in one paragraph.
  function keyPointsParts(children: Element[]): number | undefined {
    const [first, second] = children
    if (!first) return undefined
    const isLines = (element: Element | undefined) => element?.tagName === 'P' && Boolean(element.querySelector('br'))
    if (isKeyPointsHeading(first.textContent ?? '')) {
      if (!second || !(second.tagName === 'UL' || second.tagName === 'OL' || isLines(second))) return undefined
      first.classList.add('key-points-heading')
      second.classList.add('key-points-list')
      return 2
    }
    if (isLines(first) && isKeyPointsHeading(firstLineText(first))) {
      first.classList.add('key-points-list', 'key-points-block')
      return 1
    }
    return undefined
  }

  function firstLineText(element: Element): string {
    let text = ''
    for (const node of element.childNodes) {
      if (node.nodeName === 'BR') break
      text += node.textContent ?? ''
    }
    return text
  }

  // What local agent members wait on: a run to allow (with the whole task), or one of the agent's
  // actions. The buttons are the agent's own choices.
  function approvalCards(chat: GroupChat): HTMLElement[] {
    const next = new Map<string, HTMLElement>()
    const cards: HTMLElement[] = []
    for (const role of deps.getCurrentRoles()) {
      const approval = role.pendingApproval
      if (!approval) continue
      const node = approvalCardCache.get(approval.id) ?? buildApprovalCard(chat, role, approval)
      next.set(approval.id, node)
      cards.push(node)
    }
    approvalCardCache = next
    return cards
  }

  function buildApprovalCard(chat: GroupChat, role: GroupRole, approval: NonNullable<GroupRole['pendingApproval']>): HTMLElement {
    const card = document.createElement('section')
    card.className = `approval-card approval-${approval.kind}`
    card.dataset.approvalId = approval.id
    card.setAttribute('role', 'alertdialog')
    const title = document.createElement('div')
    title.className = 'approval-card-title'
    title.textContent = approval.title
    card.append(title)
    if (approval.detail && approval.kind === 'run') {
      const details = document.createElement('details')
      details.className = 'approval-card-detail'
      const summary = document.createElement('summary')
      summary.textContent = '看看要执行的任务'
      const text = document.createElement('pre')
      text.textContent = approval.detail
      details.append(summary, text)
      card.append(details)
    } else if (approval.detail) {
      const detail = document.createElement('p')
      detail.className = 'approval-card-note'
      detail.textContent = approval.detail
      card.append(detail)
    }
    const actions = document.createElement('div')
    actions.className = 'approval-card-actions'
    let primaryGiven = false
    for (const option of approval.options) {
      const button = document.createElement('button')
      button.type = 'button'
      const allow = option.kind?.startsWith('allow') ?? false
      button.className = `btn btn-small${allow && !primaryGiven ? ' btn-primary' : ''}`
      if (allow) primaryGiven = true
      button.textContent = option.label
      button.addEventListener('click', () => {
        for (const other of actions.querySelectorAll('button')) other.disabled = true
        deps.runCommand('GROUP_LOCAL_AGENT_DECIDE', { chatId: chat.id, roleId: role.id, approvalId: approval.id, optionId: option.id })
          .catch(error => {
            for (const other of actions.querySelectorAll('button')) other.disabled = false
            deps.showError(error instanceof Error ? error.message : String(error))
          })
      })
      actions.append(button)
    }
    card.append(actions)
    return card
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
    if ((replyCounts.get(message.id) ?? 0) < 2 || summarizedQuestionIds.has(message.id)) return undefined
    const chat = deps.getCurrentChat()
    if (chat && deps.isTeamInvitation?.(chat, message.id)) return undefined
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-compare-btn message-summary-btn'
    button.textContent = '✦ 汇总本轮'
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
  function reconcileChildren(parent: HTMLElement, nodes: Node[]): void {
    let cursor = parent.firstChild
    for (const node of nodes) {
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
      body.textContent = '正在回复中 '
    } else {
      reveal.show(streamingRevealKey(message), body, message.content)
    }
    return true
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

  function renderMessageImageGrid(message: GroupMessage): HTMLElement | undefined {
    const attachments = message.attachments?.filter(attachment => attachment.type === 'image') ?? []
    if (attachments.length === 0) return undefined

    const grid = document.createElement('div')
    grid.className = `message-image-grid image-count-${Math.min(attachments.length, 4)}`
    // Uploads carry no dimensions, so they keep their own size instead of filling the bubble.
    if (attachments.every(attachment => attachment.source === 'user-upload')) grid.classList.add('message-image-grid-uploads')
    for (const attachment of attachments) {
      grid.append(renderImageAttachment(message, attachment))
    }
    return grid
  }

  function compareButton(message: GroupMessage): HTMLButtonElement | undefined {
    const chat = deps.getCurrentChat()
    if (message.type === 'user' && chat && deps.isTeamInvitation?.(chat, message.id)) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'message-compare-btn message-team-btn'
      button.textContent = '⚑ 查看分工'
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
    button.textContent = `⇆ 对比 ${count} 个回复`
    button.addEventListener('click', event => {
      event.stopPropagation()
      deps.openReplyComparison?.(message.id)
    })
    return button
  }

  function renderMessageFileList(message: GroupMessage): HTMLElement | undefined {
    const files = message.attachments?.filter((attachment): attachment is MessageFileAttachment => attachment.type === 'file') ?? []
    if (files.length === 0) return undefined
    const list = document.createElement('div')
    list.className = 'message-file-list'
    for (const file of files) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'message-file-chip'
      chip.title = `下载 ${file.fileName}`
      const icon = document.createElement('span')
      icon.className = 'message-file-icon'
      icon.textContent = file.fileName.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toUpperCase() ?? 'TXT'
      const name = document.createElement('span')
      name.className = 'message-file-name'
      name.textContent = file.fileName
      const size = document.createElement('span')
      size.className = 'message-file-size'
      size.textContent = formatBytes(file.size)
      chip.append(icon, name, size)
      chip.addEventListener('click', event => {
        event.stopPropagation()
        const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType || 'text/plain' }))
        const link = document.createElement('a')
        link.href = url
        link.download = file.fileName
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      list.append(chip)
    }
    return list
  }

  function renderImageAttachment(message: GroupMessage, attachment: MessageImageAttachment): HTMLElement {
    const tile = document.createElement('div')
    tile.className = `message-image-tile ${attachment.status === 'error' ? 'message-image-error' : 'message-image-loading'}`

    if (attachment.status === 'error') {
      const errorText = document.createElement('span')
      errorText.textContent = attachment.error || '图片获取失败'
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'message-image-retry'
      retry.textContent = '重新同步'
      retry.addEventListener('click', event => {
        event.stopPropagation()
        handleResyncMessage(message)
      })
      tile.append(errorText, retry)
      return tile
    }

    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'message-image-preview'
    preview.setAttribute('aria-label', '预览图片')
    preview.disabled = true
    const image = document.createElement('img')
    image.alt = attachment.alt || (attachment.source === 'user-upload' ? attachment.fileName : undefined) || 'ChatGPT 生成图片'
    image.loading = 'lazy'
    image.decoding = 'async'
    if (attachment.width) image.width = attachment.width
    if (attachment.height) image.height = attachment.height
    preview.append(image)

    const download = createMessageIconButton('下载图片', 'download', () => {
      downloadImageAttachment(attachment).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
    download.classList.add('message-image-download')
    download.disabled = true
    tile.append(preview, download)

    loadImageObjectUrl(attachment.id)
      .then(url => {
        if (!url || !tile.isConnected) {
          if (url && !tile.isConnected) releaseImageUrl(attachment.id)
          return
        }
        image.src = url
        preview.disabled = false
        download.disabled = false
        tile.classList.remove('message-image-loading')
        preview.addEventListener('click', () => window.open(url, '_blank', 'noopener'))
      })
      .catch(error => {
        tile.className = 'message-image-tile message-image-error'
        tile.replaceChildren()
        const errorText = document.createElement('span')
        errorText.textContent = error instanceof Error ? error.message : '图片读取失败'
        tile.append(errorText)
      })

    return tile
  }

  async function loadImageObjectUrl(attachmentId: string): Promise<string | undefined> {
    const cached = imageObjectUrls.get(attachmentId)
    if (cached) return cached
    const pending = imageLoadPromises.get(attachmentId)
    if (pending) return pending

    const load = (async () => {
      const record = await deps.loadImageAttachment?.(attachmentId)
      if (!record) throw new Error('本地图片不可用，请重新同步')
      const url = URL.createObjectURL(record.blob)
      imageObjectUrls.set(attachmentId, url)
      return url
    })().finally(() => {
      imageLoadPromises.delete(attachmentId)
    })
    imageLoadPromises.set(attachmentId, load)
    return load
  }

  async function downloadImageAttachment(attachment: MessageImageAttachment): Promise<void> {
    const url = await loadImageObjectUrl(attachment.id)
    if (!url) throw new Error('本地图片不可用，请重新同步')
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = attachment.fileName || 'chatgpt-image.png'
    anchor.rel = 'noreferrer'
    anchor.click()
  }

  function releaseUnusedImageUrls(messages: GroupMessage[]): void {
    const activeIds = new Set(messages.flatMap(message => message.attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.status === 'ready').map(attachment => attachment.id))
    for (const attachmentId of imageObjectUrls.keys()) {
      if (!activeIds.has(attachmentId)) releaseImageUrl(attachmentId)
    }
  }

  function releaseImageUrl(attachmentId: string): void {
    const url = imageObjectUrls.get(attachmentId)
    if (!url) return
    URL.revokeObjectURL(url)
    imageObjectUrls.delete(attachmentId)
  }

  function renderSavedHighlights(body: HTMLElement, message: GroupMessage): void {
    const highlights = deps.getStore().messageHighlightsById?.[message.id]
    if (!highlights?.length) return
    applyHighlightsToBody(body, highlights)
  }

  function shouldRenderMarkdownMessage(message: GroupMessage): boolean {
    return message.contentFormat === 'markdown' || message.type === 'assistant'
  }

  function createMessageIconButton(label: string, icon: MessageActionIcon, onClick: (button: HTMLButtonElement) => void, options: { activateOnPointerDown?: boolean } = {}): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'message-tool-btn'
    button.setAttribute('aria-label', label)
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
    button.replaceChildren(messageActionIcon(icon))
  }

  function messageActionIcon(icon: MessageActionIcon): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', messageActionIconPath(icon))
    // The quote marks are drawn up and to the left of the middle of their box.
    if (icon === 'quote') path.setAttribute('transform', 'translate(0.9 1.6)')
    svg.append(path)
    return svg
  }

  function messageActionIconPath(icon: MessageActionIcon): string {
    if (icon === 'copy') return 'M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Zm-3 3A2.5 2.5 0 0 1 7.5 8H8v5.5a2.5 2.5 0 0 0 2.5 2.5H16v.5a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 5 16.5v-6Z'
    if (icon === 'quote') return 'M7.2 6.5c-1.7 1.4-2.7 3-2.7 5.1 0 1.9 1.1 3.2 2.8 3.2 1.3 0 2.3-.9 2.3-2.2 0-1.2-.8-2-2-2.1.2-1.1.9-2 2.1-3l-1.1-1.4c-.5.1-1 .2-1.4.4Zm8 0c-1.7 1.4-2.7 3-2.7 5.1 0 1.9 1.1 3.2 2.8 3.2 1.3 0 2.3-.9 2.3-2.2 0-1.2-.8-2-2-2.1.2-1.1.9-2 2.1-3l-1.1-1.4c-.5.1-1 .2-1.4.4Z'
    if (icon === 'check') return 'M9.2 16.4 4.8 12l1.4-1.4 3 3 8.6-8.6 1.4 1.4-10 10Z'
    if (icon === 'stop') return 'M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6Z'
    if (icon === 'retry') return 'M12 5a7 7 0 1 1-6.3 4H4a9 9 0 1 0 2.6-4.4L4 2v7h7L8.1 6.1A7 7 0 0 1 12 5Z'
    if (icon === 'edit') return 'M15.3 4.9a2.2 2.2 0 0 1 3.1 0l.7.7a2.2 2.2 0 0 1 0 3.1L9.6 18.2 5 19l.8-4.6 9.5-9.5Zm-1.2 3.6-6.6 6.6-.4 1.9 1.9-.4 6.6-6.6-1.5-1.5Z'
    if (icon === 'download') return 'M11 4h2v8.2l2.6-2.6L17 11l-5 5-5-5 1.4-1.4 2.6 2.6V4Zm-5 13h12v2H6v-2Z'
    return 'M14 5h5v5h-1.6V7.7l-7.1 7.1-1.1-1.1 7.1-7.1H14V5ZM6.5 6h4v1.6h-4a.9.9 0 0 0-.9.9v9a.9.9 0 0 0 .9.9h9a.9.9 0 0 0 .9-.9v-4H18v4A2.5 2.5 0 0 1 15.5 20h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6Z'
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

  function renderOrchestrationMessageLabel(message: GroupMessage): HTMLElement | undefined {
    if (!message.orchestrationKind) return undefined
    const label = document.createElement('div')
    label.className = `orchestration-message-label orchestration-message-${message.orchestrationKind}`
    label.textContent = orchestrationMessageLabelText(message)
    return label
  }

  function orchestrationMessageLabelText(message: GroupMessage): string {
    const parts = ['编排']
    if (message.orchestrationStageIndex !== undefined) parts.push(`第 ${message.orchestrationStageIndex + 1} 步`)
    parts.push(orchestrationKindLabel(message.orchestrationKind))
    return parts.join(' · ')
  }

  function orchestrationKindLabel(kind: GroupMessage['orchestrationKind']): string {
    if (kind === 'task') return '任务'
    if (kind === 'role') return '人员'
    if (kind === 'review') return '复核'
    return '状态'
  }

  function renderOrchestrationReviewSummary(message: GroupMessage): HTMLElement | undefined {
    if (message.orchestrationKind !== 'review') return undefined
    const result = findReviewResultForMessage(message)
    if (!result) return undefined
    const summary = document.createElement('div')
    summary.className = 'orchestration-review-summary'
    summary.append(reviewSummaryLine('决策', reviewDecisionLabel(result.decision)))
    if (result.reason) summary.append(reviewSummaryLine('原因', result.reason))
    if (result.failedCriteria.length > 0) summary.append(reviewSummaryLine('未通过', result.failedCriteria.join('、')))
    if (result.nextRoundInstruction) summary.append(reviewSummaryLine('重试说明', result.nextRoundInstruction))
    return summary
  }

  function findReviewResultForMessage(message: GroupMessage): OrchestrationReviewResult | undefined {
    if (!message.orchestrationRunId) return undefined
    const run = deps.getStore().orchestrationRunsById[message.orchestrationRunId]
    for (const stageRun of run?.stageRuns ?? []) {
      const result = stageRun.reviewResults?.find(result => result.messageId === message.id)
      if (result) return result
    }
    return undefined
  }

  function reviewSummaryLine(label: string, value: string): HTMLElement {
    const line = document.createElement('div')
    line.className = 'orchestration-review-line'
    const labelEl = document.createElement('span')
    labelEl.textContent = `${label}：`
    const valueEl = document.createElement('span')
    valueEl.textContent = value
    line.append(labelEl, valueEl)
    return line
  }

  function reviewDecisionLabel(decision: OrchestrationReviewResult['decision']): string {
    if (decision === 'pass') return '通过'
    return '不通过'
  }

  function messageSignature(message: GroupMessage, showName = true, showAvatar = true): string {
    return JSON.stringify({
      type: message.type,
      roleId: message.roleId,
      roleName: message.roleName,
      roleSite: roleForMessage(message)?.chatSite,
      content: message.content,
      contentFormat: message.contentFormat,
      // File text can be large; its id, name and size identify it well enough.
      attachments: message.attachments?.map(attachment => attachment.type === 'file' ? { id: attachment.id, type: attachment.type, fileName: attachment.fileName, size: attachment.size } : attachment),
      createdAt: message.createdAt,
      status: message.status,
      usage: message.usage,
      choicesOpen: choicesOpen(message),
      references: message.references,
      orchestrationRunId: message.orchestrationRunId,
      orchestrationRound: message.orchestrationRound,
      orchestrationStageId: message.orchestrationStageId,
      orchestrationStageIndex: message.orchestrationStageIndex,
      orchestrationKind: message.orchestrationKind,
      orchestrationReviewResult: findReviewResultForMessage(message),
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
      orchestrationReviewResult: findReviewResultForMessage(message),
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

  function replyControlBubble(role: GroupRole, showName = true, showAvatar = true): HTMLElement {
    const stopped = role.status === 'stopped'
    const liveText = stopped ? undefined : liveReplyText(role)
    const article = document.createElement('article')
    article.className = `message-row message assistant ${stopped ? 'stopped' : 'thinking'}${liveText ? ' live' : ''}${showName ? '' : ' compact'}${showAvatar ? '' : ' no-avatar'}`
    const inner = document.createElement('div')
    inner.className = 'message-inner'
    const avatar = document.createElement('div')
    avatar.className = `message-avatar ${deps.roleToneClass(role.name)}`
    avatar.textContent = deps.roleAvatarLabel(role.name)
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
    else body.textContent = stopped ? '已停止回复' : '正在回复中 '
    bubble.append(body)
    const tools = document.createElement('div')
    tools.className = 'message-tools'
    tools.append(
      stopped
        ? createMessageIconButton('重新发送', 'retry', () => deps.retryRoleReply(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
        : createMessageIconButton('停止回复', 'stop', () => deps.stopRoleReply(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error))), { activateOnPointerDown: true }),
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
    box.textContent = `引用 ${reference.roleName || '人员'}：${truncate(reference.contentSnapshot, 160)}`
    return box
  }

  function emptyChatPeopleCard(title: string, body: string): HTMLElement {
    const wrapper = deps.emptyCard(title, body)
    const card = wrapper.querySelector('.empty-card')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-primary'
    button.textContent = '添加人员'
    button.addEventListener('click', deps.openAddPersonDialog)
    card?.append(button)
    return wrapper
  }

  function messageAvatarLabel(message: GroupMessage): string {
    if (message.type === 'user') return '你'
    return deps.roleAvatarLabel(message.roleName)
  }

  function messageToneClass(message: GroupMessage): string {
    if (message.type === 'user') return 'role-tone-5'
    return deps.roleToneClass(message.roleName)
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

  deps.messagesEl.addEventListener('mousedown', beginSelectionDrag)
  deps.messagesEl.addEventListener('pointerdown', beginSelectionDrag)
  deps.messagesEl.addEventListener('dragstart', cancelSelectionMarking)
  document.addEventListener('mouseup', finishSelectionDrag)
  document.addEventListener('pointerup', finishSelectionDrag)

  document.addEventListener('selectionchange', () => {
    if (selectionDragActive) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideMarkMenu()
      return
    }
    scheduleMarkMenuFromSelection()
  })

  document.addEventListener('click', event => {
    if (ignoreNextDocumentClick) {
      ignoreNextDocumentClick = false
      return
    }
    if (markMenu?.contains(event.target as Node)) return
    const target = event.target as Element | null
    if (target?.closest('.message-body')) return
    hideMarkMenu()
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideMarkMenu()
  })

  function beginSelectionDrag(event: MouseEvent | PointerEvent): void {
    const target = event.target as Element | null
    if (!target || target.closest('button, input, textarea, select, a, [role="button"]')) return
    if (!deps.messagesEl.contains(target)) return
    selectionDragActive = true
    clearMarkMenuUpdate()
    hideMarkMenu()
  }

  function finishSelectionDrag(event: MouseEvent | PointerEvent): void {
    const target = event.target as Node | null
    if (!selectionDragActive && (!target || !deps.messagesEl.contains(target))) return
    selectionDragActive = false
    ignoreNextDocumentClick = true
    scheduleMarkMenuFromSelection()
  }

  function cancelSelectionMarking(): void {
    selectionDragActive = false
    ignoreNextDocumentClick = false
    clearMarkMenuUpdate()
    hideMarkMenu()
  }

  function scheduleMarkMenuFromSelection(): void {
    clearMarkMenuUpdate()
    markMenuUpdateTimer = window.setTimeout(() => {
      markMenuUpdateTimer = undefined
      showMarkMenuFromSelection()
    }, MARK_MENU_SELECTION_SETTLE_DELAY_MS)
  }

  function clearMarkMenuUpdate(): void {
    if (markMenuUpdateTimer === undefined) return
    window.clearTimeout(markMenuUpdateTimer)
    markMenuUpdateTimer = undefined
  }

  function showMarkMenuFromSelection(): void {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideMarkMenu()
      return
    }

    const range = selection.getRangeAt(0)
    const body = closestMessageBody(range.commonAncestorContainer)
    if (!body || !deps.messagesEl.contains(body)) {
      hideMarkMenu()
      return
    }

    const article = body.closest<HTMLElement>('.message-row[data-message-id]')
    const messageId = article?.dataset.messageId
    const message = messageId ? deps.getStore().messagesById[messageId] : undefined
    const selectedText = selection.toString().trim()
    if (!message || !selectedText) {
      hideMarkMenu()
      return
    }

    const startOffset = message.content.indexOf(selectedText)
    if (startOffset < 0) {
      hideMarkMenu()
      return
    }

    selectedMark = {
      message,
      text: selectedText,
      startOffset,
      endOffset: startOffset + selectedText.length,
      rect: rangeRect(range),
      color: selectedHighlightColor,
    }
    renderMarkMenu()
  }

  function renderMarkMenu(): void {
    if (!selectedMark) return
    markMenu?.remove()
    markMenu = document.createElement('div')
    markMenu.className = 'mark-menu'
    const colorRow = document.createElement('div')
    colorRow.className = 'mark-color-row'
    colorRow.setAttribute('aria-label', '高亮颜色')
    for (const color of MESSAGE_HIGHLIGHT_COLORS) {
      colorRow.append(markColorButton(color.value, color.label))
    }
    markMenu.append(
      colorRow,
      markMenuButton('高亮', '高亮', () => applySelectedMark('highlight')),
      markMenuButton('加入笔记', '加入笔记', () => applySelectedMark('note')),
      markMenuButton('高亮并加入笔记', '高亮并加入笔记', () => applySelectedMark('both')),
    )
    document.body.append(markMenu)
    const menuRect = markMenu.getBoundingClientRect()
    const menuHeight = menuRect.height || markMenu.offsetHeight || MARK_MENU_FALLBACK_HEIGHT_PX
    const menuWidth = menuRect.width || markMenu.offsetWidth
    const preferredTop = selectedMark.rect.top - menuHeight - MARK_MENU_SELECTION_GAP_PX
    const top = preferredTop >= 8
      ? preferredTop
      : Math.min(Math.max(8, selectedMark.rect.bottom + MARK_MENU_SELECTION_GAP_PX), window.innerHeight - menuHeight - 8)
    const centeredLeft = selectedMark.rect.left + selectedMark.rect.width / 2 - menuWidth / 2
    const left = Math.min(Math.max(8, centeredLeft), window.innerWidth - menuWidth - 8)
    markMenu.style.top = `${top}px`
    markMenu.style.left = `${left}px`
  }

  function markMenuButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.setAttribute('aria-label', label)
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    })
    return button
  }

  function markColorButton(color: MessageHighlightColor, label: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mark-color-btn'
    button.setAttribute('aria-label', `高亮颜色：${label}`)
    button.setAttribute('aria-pressed', String(selectedMark?.color === color))
    button.style.setProperty('--mark-color-rgb', messageHighlightColorRgb(color))
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      selectedHighlightColor = color
      if (selectedMark) selectedMark.color = color
      renderMarkMenu()
    })
    return button
  }

  function applySelectedMark(action: 'highlight' | 'note' | 'both'): void {
    const mark = selectedMark
    if (!mark) return
    if (action === 'note' || action === 'both') deps.insertTextIntoActiveNote?.(mark.text)
    if (action === 'highlight' || action === 'both') {
      deps.runCommand('GROUP_MESSAGE_HIGHLIGHT_CREATE', {
        chatId: mark.message.chatId,
        messageId: mark.message.id,
        text: mark.text,
        startOffset: mark.startOffset,
        endOffset: mark.endOffset,
        color: mark.color,
      }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    }
    window.getSelection()?.removeAllRanges()
    hideMarkMenu()
  }

  function hideMarkMenu(): void {
    clearMarkMenuUpdate()
    selectedMark = undefined
    markMenu?.remove()
    markMenu = undefined
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

  return { renderMessages }
}

function closestMessageBody(node: Node): HTMLElement | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  return element?.closest<HTMLElement>('.message-body') ?? undefined
}

function rangeRect(range: Range): DOMRect {
  if (typeof range.getBoundingClientRect === 'function') return range.getBoundingClientRect()
  return new DOMRect(8, 8, 1, 1)
}

function applyHighlightsToBody(body: HTMLElement, highlights: MessageHighlight[]): void {
  const bodyText = body.textContent ?? ''
  const normalized = highlights
    .map(highlight => {
      const renderedStart = bodyText.slice(highlight.startOffset, highlight.endOffset) === highlight.text ? highlight.startOffset : bodyText.indexOf(highlight.text)
      return renderedStart >= 0 ? { ...highlight, startOffset: renderedStart, endOffset: renderedStart + highlight.text.length } : undefined
    })
    .filter((highlight): highlight is MessageHighlight => Boolean(highlight))
    .sort((left, right) => left.startOffset - right.startOffset)

  let cursor = 0
  for (const highlight of normalized) {
    if (highlight.startOffset < cursor) continue
    wrapTextRange(body, highlight.startOffset, highlight.endOffset, highlight.color)
    cursor = highlight.endOffset
  }
}

function wrapTextRange(root: HTMLElement, startOffset: number, endOffset: number, color: MessageHighlight['color']): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let textPosition = 0
  const ranges: Array<{ node: Text; start: number; end: number }> = []

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const nodeStart = textPosition
    const nodeEnd = nodeStart + node.data.length
    if (nodeEnd > startOffset && nodeStart < endOffset) {
      ranges.push({
        node,
        start: Math.max(0, startOffset - nodeStart),
        end: Math.min(node.data.length, endOffset - nodeStart),
      })
    }
    textPosition = nodeEnd
  }

  for (const range of ranges.reverse()) {
    const selected = range.node.splitText(range.start)
    selected.splitText(range.end - range.start)
    const mark = document.createElement('span')
    mark.className = 'message-highlight'
    mark.style.setProperty('--message-highlight-rgb', messageHighlightColorRgb(color))
    selected.parentNode?.insertBefore(mark, selected)
    mark.append(selected)
  }
}
