import type { RoleToBackgroundMessage } from '../group/runtimeProtocol'
import type { ReplyImageSource } from '../group/types'
import { createReplyTimeout } from './replyTimeout'
import { createReplyTracker } from './replyTracker'
import { materializeReplyImages } from './replyImages'
import { resolveReportableReplyText, type ReportableReplyText } from './reportableReply'
import { countResponseContainers, keepDeepestResponseContainers } from './responseContainers'
import type { ContentLogger } from './runtimeClient'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

type ReplySource = 'observer' | 'timeout-compensation' | 'polling-compensation'

const RESPONSE_DEBOUNCE_MS = 2500
const RESPONSE_FINAL_SETTLE_MS = 1500
const REPLY_POLL_INTERVAL_MS = 2000
const REPLY_TIMEOUT_MS = 120000
const SHORT_REPLY_MAX_CHARS = 50
const SHORT_REPLY_STABLE_SETTLE_MS = 5000
// How often the reply written so far is sent to the chat while the site is still writing.
export const REPLY_PROGRESS_INTERVAL_MS = 1000

export interface ReplyObserverController {
  capturePromptReplyBaseline(messageId: string | undefined): void
  clearPromptReplyBaseline(): void
  clearReplyPolling(): void
  startReplyPolling(messageId: string, replyAttemptId: string | undefined): void
  startReplyReporting(): void
  seedStoredRoleReplies(replies: string[] | undefined): void
  resetForAssignedRole(): void
}

export function createReplyObserver(options: {
  siteAdapter: ChatSiteAdapter
  roleSession: RoleSession
  log: ContentLogger
  sendRuntimeMessage<T>(message: RoleToBackgroundMessage): Promise<T>
  reportRoleError(messageId: string | undefined, reason: string, chatId?: string, roleId?: string, replyAttemptId?: string): void
}): ReplyObserverController {
  const { siteAdapter, roleSession, log } = options
  let promptBaselineContainers = new Set<Element>()
  let promptBaselineContainerKeys = new WeakMap<Element, string>()
  let promptBaselineReplies = new Set<string>()
  let promptBaselineContainerCount = 0
  let promptBaselinePromptId = ''
  let replyPollingTimer: number | null = null
  let replyPollingInFlight = false
  let replyProgressTimer: number | null = null
  let replyProgressInFlight = false
  let lastProgressText = ''
  const replyTracker = createReplyTracker()
  const replyTimeout = createReplyTimeout(REPLY_TIMEOUT_MS, (messageId, failureReason) => {
    const assignedRole = roleSession.getAssignedRole()
    log.warn('reply-timeout', { messageId, roleId: assignedRole?.roleId, roleName: assignedRole?.roleName, reason: failureReason })

    const replyAttemptId = roleSession.getActiveReplyAttemptId()
    const activePrompt = roleSession.getActivePrompt()
    if (activePrompt?.messageId === messageId && siteAdapter.isGenerating()) {
      log.warn('reply-timeout:extended-generating', { messageId, roleId: assignedRole?.roleId, roleName: assignedRole?.roleName })
      options
        .sendRuntimeMessage({
          type: 'TEAM_ROLE_STATUS',
          status: 'generating',
          ...statusIdentityPayload(),
        })
        .catch(error => log.warn('reply-timeout:heartbeat-failed', { messageId, error: error instanceof Error ? error.message : String(error) }))
      replyTimeout.arm(messageId)
      return
    }
    if (!siteAdapter.isGenerating() && tryReportLatestReply(messageId, 'timeout-compensation')) return

    roleSession.clearActivePrompt(messageId)
    const statusIdentity = statusIdentityPayload()
    options
      .sendRuntimeMessage({
        type: 'TEAM_ROLE_STATUS',
        status: 'error',
        ...statusIdentity,
        error: failureReason,
      })
      .catch(error => log.warn('reply-timeout:status-failed', { error: error instanceof Error ? error.message : String(error) }))
    options.reportRoleError(messageId, failureReason, undefined, undefined, replyAttemptId)
    clearReplyPolling()
  })

  function getConversationId(): string {
    return siteAdapter.getConversationId()
  }

  function capturePromptReplyBaseline(messageId: string | undefined): void {
    const containers = siteAdapter.getResponseContainers()
    const replies = containers.map(container => siteAdapter.readResponseText(container)).filter(Boolean)
    const snapshots = containers.map(element => readReplySnapshot(element)).filter(hasReplySnapshot)
    promptBaselineContainers = new Set(containers)
    promptBaselineContainerKeys = new WeakMap()
    for (const snapshot of snapshots) {
      promptBaselineContainerKeys.set(snapshot.element, snapshot.key)
    }
    promptBaselineReplies = new Set(snapshots.map(snapshot => snapshot.key))
    promptBaselineContainerCount = countResponseContainers(containers)
    promptBaselinePromptId = messageId ?? ''
    replyTracker.seed(getConversationId(), replies)
    log.debug('reply-baseline:captured', {
      messageId,
      conversationId: getConversationId(),
      containerCount: promptBaselineContainers.size,
      replyCount: promptBaselineReplies.size,
      positionalContainerCount: promptBaselineContainerCount,
      promptId: promptBaselinePromptId,
    })
  }

  function clearPromptReplyBaseline(): void {
    promptBaselineContainers.clear()
    promptBaselineContainerKeys = new WeakMap()
    promptBaselineReplies.clear()
    promptBaselineContainerCount = 0
    promptBaselinePromptId = ''
  }

  function seedStoredRoleReplies(replies: string[] | undefined): void {
    const validReplies = (replies ?? []).map(reply => reply.trim()).filter(Boolean)
    if (validReplies.length === 0) return
    replyTracker.seedGlobal(validReplies)
    log.debug('reply-history:seeded', { count: validReplies.length, conversationId: getConversationId() })
  }

  function isPromptBaselineReply(text: string, element: Element): boolean {
    const currentContainers = siteAdapter.getResponseContainers()
    const elementIndex = currentContainers.indexOf(element)
    const snapshot = readReplySnapshot(element, text)
    if (!hasReplySnapshot(snapshot)) return true

    let matchingBaselineContainer: Element | undefined
    let matchingBaselineKey: string | undefined
    for (const container of promptBaselineContainers) {
      if (container === element || container.contains(element)) {
        matchingBaselineContainer = container
        matchingBaselineKey = promptBaselineContainerKeys.get(container)
        break
      }
    }

    const sameBaselineElement = Boolean(matchingBaselineContainer && matchingBaselineKey === snapshot.key)
    if (elementIndex >= 0 && currentContainers.length > promptBaselineContainerCount && elementIndex >= promptBaselineContainerCount && !sameBaselineElement) {
      return false
    }
    if (promptBaselineReplies.has(snapshot.key)) return true
    if (matchingBaselineContainer) return sameBaselineElement

    return false
  }

  function findCompensationReply(messageId: string): { text: string; element: Element } | undefined {
    return keepDeepestResponseContainers(siteAdapter.getResponseContainers())
      .map(element => readReplySnapshot(element))
      .filter(snapshot => hasReplySnapshot(snapshot) && !isPromptBaselineReply(snapshot.text, snapshot.element))
      .reverse()
      .find(snapshot => replyTracker.consumeIfNewForMessage(getConversationId(), snapshot.key, messageId))
  }

  function findCompensationCandidate(): { text: string; element: Element } | undefined {
    return keepDeepestResponseContainers(siteAdapter.getResponseContainers())
      .map(element => readReplySnapshot(element))
      .filter(snapshot => hasReplySnapshot(snapshot) && !isPromptBaselineReply(snapshot.text, snapshot.element))
      .reverse()[0]
  }

  function clearReplyPolling(): void {
    if (replyPollingTimer) {
      window.clearTimeout(replyPollingTimer)
      replyPollingTimer = null
    }
    replyPollingInFlight = false
    clearReplyProgress()
  }

  function clearReplyProgress(): void {
    if (replyProgressTimer) {
      window.clearInterval(replyProgressTimer)
      replyProgressTimer = null
    }
    lastProgressText = ''
  }

  // While the site writes its reply, send what it has written so far so the chat can show it.
  // Only text read from the page is sent (never by pressing the site's copy button), and the
  // finished reply still arrives the usual way and replaces it.
  function startReplyProgress(messageId: string, replyAttemptId: string | undefined): void {
    clearReplyProgress()
    replyProgressTimer = window.setInterval(() => sendReplyProgress(messageId, replyAttemptId), REPLY_PROGRESS_INTERVAL_MS)
  }

  function sendReplyProgress(messageId: string, replyAttemptId: string | undefined): void {
    const activePrompt = roleSession.getActivePrompt()
    if (activePrompt?.messageId !== messageId || activePrompt.replyAttemptId !== replyAttemptId) {
      clearReplyProgress()
      return
    }
    const assignedRole = roleSession.getAssignedRole()
    if (!assignedRole || replyProgressInFlight) return

    const candidate = findCompensationCandidate()
    if (!candidate) return
    const conversationId = getConversationId()
    if (replyTracker.isKnown(conversationId, candidate.text)) return
    const partial = readPartialReply(candidate.element, candidate.text)
    if (!partial.text || partial.text === lastProgressText || replyTracker.isKnown(conversationId, partial.text)) return

    lastProgressText = partial.text
    replyProgressInFlight = true
    options
      .sendRuntimeMessage({
        type: 'TEAM_ROLE_REPLY_PROGRESS',
        chatId: roleSession.getAssignedChatId(assignedRole),
        roleId: assignedRole.roleId,
        messageId,
        replyAttemptId,
        content: partial.text,
        ...(partial.contentFormat ? { contentFormat: partial.contentFormat } : {}),
      })
      .catch(error => log.debug('reply-progress:send-failed', { messageId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        replyProgressInFlight = false
      })
  }

  function readPartialReply(element: Element, domText: string): { text: string; contentFormat?: 'markdown' } {
    try {
      const markdown = siteAdapter.readResponseMarkdown?.(element).trim()
      if (markdown) return { text: markdown, contentFormat: 'markdown' }
    } catch (error) {
      log.debug('reply-progress:markdown-failed', { error: error instanceof Error ? error.message : String(error) })
    }
    return { text: domText.trim() }
  }

  function normalizedReplyLength(text: string): number {
    return text.replace(/\s+/g, '').length
  }

  function isVeryShortReply(text: string): boolean {
    const length = normalizedReplyLength(text)
    return length > 0 && length <= SHORT_REPLY_MAX_CHARS
  }

  function startReplyPolling(messageId: string, replyAttemptId: string | undefined): void {
    clearReplyPolling()
    replyTimeout.arm(messageId)
    startReplyProgress(messageId, replyAttemptId)

    let stableKey = ''
    let stableSince = 0

    const schedule = () => {
      replyPollingTimer = window.setTimeout(tick, REPLY_POLL_INTERVAL_MS)
    }

    const resetStableCandidate = () => {
      stableKey = ''
      stableSince = 0
    }

    const tick = () => {
      replyPollingTimer = null

      const activePrompt = roleSession.getActivePrompt()
      if (activePrompt?.messageId !== messageId || activePrompt.replyAttemptId !== replyAttemptId) {
        clearReplyPolling()
        return
      }

      if (replyPollingInFlight) {
        schedule()
        return
      }

      const candidate = findCompensationCandidate()
      if (!candidate) {
        resetStableCandidate()
        schedule()
        return
      }

      const candidateSnapshot = readReplySnapshot(candidate.element, candidate.text)
      const timestamp = Date.now()
      const generating = siteAdapter.isGenerating()
      if (candidateSnapshot.key !== stableKey) {
        stableKey = candidateSnapshot.key
        stableSince = timestamp
        log.debug('reply-poll:candidate', { messageId, textLength: candidate.text.length, imageCount: candidateSnapshot.images.length })
        schedule()
        return
      }

      const stableDuration = timestamp - stableSince
      if (stableDuration < RESPONSE_FINAL_SETTLE_MS) {
        schedule()
        return
      }
      if (generating) {
        log.debug('reply-poll:defer-generating', { messageId, stableDuration, textLength: candidate.text.length })
        schedule()
        return
      }
      if (candidate.text && isVeryShortReply(candidate.text) && stableDuration < SHORT_REPLY_STABLE_SETTLE_MS) {
        log.debug('reply-poll:defer-short', {
          messageId,
          stableDuration,
          textLength: candidate.text.length,
          normalizedLength: normalizedReplyLength(candidate.text),
        })
        schedule()
        return
      }

      replyPollingInFlight = true
      resolveReportableReplyText(siteAdapter, candidate.element, candidate.text, log)
        .then(reply => {
          const active = roleSession.getActivePrompt()
          const assignedRole = roleSession.getAssignedRole()
          if (active?.messageId !== messageId || active.replyAttemptId !== replyAttemptId) return
          if (!replyTracker.consumeIfNewForMessage(getConversationId(), reportableReplyKey(reply), messageId)) {
            log.debug('reply-poll:skipped', { messageId, textLength: reply.text.length, roleId: assignedRole?.roleId })
            schedule()
            return
          }
          log.warn('reply-poll:compensated', { messageId, textLength: reply.text.length, roleId: assignedRole?.roleId })
          reportAcceptedReply(messageId, reply, 'polling-compensation')
        })
        .catch(error => {
          log.warn('reply-poll:resolve-failed', { messageId, error: error instanceof Error ? error.message : String(error) })
          const active = roleSession.getActivePrompt()
          if (active?.messageId === messageId && active.replyAttemptId === replyAttemptId) schedule()
        })
        .finally(() => {
          replyPollingInFlight = false
        })
    }

    schedule()
  }

  function reportAcceptedReply(messageId: string, reply: ReportableReplyText, source: ReplySource): void {
    const assignedRole = roleSession.getAssignedRole()
    if (!assignedRole) return

    const replyAttemptId = roleSession.clearActivePrompt(messageId)
    clearPromptReplyBaseline()
    replyTimeout.clear()
    clearReplyPolling()
    const text = reply.text
    log.info('reply:accepted', { messageId, textLength: text.length, roleId: assignedRole.roleId, roleName: assignedRole.roleName, source })

    const snapshot = siteAdapter.getConversationSnapshot()
    const chatId = roleSession.getAssignedChatId(assignedRole)
    // Images the page shows through blob: URLs are read here, before the reply leaves the page.
    materializeReplyImages(reply.images, log)
      .then(images => options.sendRuntimeMessage({
        type: 'TEAM_ROLE_REPLY',
        chatId,
        roleId: assignedRole.roleId,
        messageId,
        replyAttemptId,
        content: text,
        contentFormat: reply.contentFormat,
        images,
        conversationId: snapshot.conversationId,
        conversationUrl: snapshot.conversationUrl,
      }))
      .then(() => {
        const activePrompt = roleSession.getActivePrompt()
        if (activePrompt) {
          log.info('reply:skip-idle-active-prompt', { completedMessageId: messageId, activeMessageId: activePrompt.messageId })
          return undefined
        }
        return options.sendRuntimeMessage({ type: 'TEAM_ROLE_STATUS', status: 'idle', ...statusIdentityPayload() })
      })
      .catch(error => log.warn('reply:report-failed', { error: error instanceof Error ? error.message : String(error) }))
  }

  function statusIdentityPayload(): { chatId?: string; roleId?: string } {
    const assignedRole = roleSession.getAssignedRole()
    const chatId = roleSession.getAssignedChatId(assignedRole)
    const roleId = assignedRole?.roleId
    return {
      ...(chatId ? { chatId } : {}),
      ...(roleId ? { roleId } : {}),
    }
  }

  function tryReportLatestReply(messageId: string, source: 'timeout-compensation'): boolean {
    const assignedRole = roleSession.getAssignedRole()
    if (!assignedRole) return false
    const reply = findCompensationReply(messageId)
    if (!reply) return false

    log.warn('reply:compensated', { messageId, textLength: reply.text.length, roleId: assignedRole.roleId, source })
    const snapshot = readReplySnapshot(reply.element, reply.text)
    reportAcceptedReply(messageId, { text: reply.text, ...(snapshot.images.length > 0 ? { images: snapshot.images } : {}) }, source)
    return true
  }

  function observeResponseContainers(onStableText: (text: string, element: Element) => void): void {
    let debounceTimer: number | null = null
    const pendingContainers = new Set<Element>()
    const shortReplyCandidates = new WeakMap<Element, { text: string; since: number }>()

    function trackShortReplyCandidate(container: Element): void {
      const text = siteAdapter.readResponseText(container)
      if (!isVeryShortReply(text)) {
        shortReplyCandidates.delete(container)
        return
      }

      const current = shortReplyCandidates.get(container)
      if (current?.text === text) return
      shortReplyCandidates.set(container, { text, since: Date.now() })
    }

    function shouldDeferShortReply(container: Element, text: string): boolean {
      if (!isVeryShortReply(text)) {
        shortReplyCandidates.delete(container)
        return false
      }

      const current = shortReplyCandidates.get(container)
      if (!current || current.text !== text) {
        shortReplyCandidates.set(container, { text, since: Date.now() })
        return true
      }

      const stableDuration = Date.now() - current.since
      if (stableDuration >= SHORT_REPLY_STABLE_SETTLE_MS) {
        shortReplyCandidates.delete(container)
        return false
      }

      log.debug('observer:defer-short', {
        stableDuration,
        textLength: text.length,
        normalizedLength: normalizedReplyLength(text),
      })
      return true
    }

    function flush(): void {
      if (debounceTimer) {
        window.clearTimeout(debounceTimer)
        debounceTimer = null
      }

      const pendingCount = pendingContainers.size
      const containers = keepDeepestResponseContainers([...pendingContainers])
      const snapshots = containers.map(element => readReplySnapshot(element)).filter(hasReplySnapshot)
      log.debug('observer:flush', { pending: pendingCount, kept: containers.length, snapshots: snapshots.length })
      pendingContainers.clear()

      window.setTimeout(() => {
        const generating = siteAdapter.isGenerating()
        for (const snapshot of snapshots) {
          if (!snapshot.element.isConnected) continue

          const current = readReplySnapshot(snapshot.element)
          if (!hasReplySnapshot(current)) continue

          if (generating || current.key !== snapshot.key) {
            log.debug('observer:defer-unstable', {
              generating,
              previousLength: snapshot.text.length,
              currentLength: current.text.length,
            })
            schedule(snapshot.element)
            continue
          }

          if (current.text && shouldDeferShortReply(snapshot.element, current.text)) {
            schedule(snapshot.element)
            continue
          }

          log.debug('observer:stable', { textLength: current.text.length, imageCount: current.images.length })
          onStableText(current.text, snapshot.element)
        }
      }, RESPONSE_FINAL_SETTLE_MS)
    }

    function schedule(container: Element): void {
      trackShortReplyCandidate(container)
      pendingContainers.add(container)

      if (debounceTimer) window.clearTimeout(debounceTimer)
      debounceTimer = window.setTimeout(flush, RESPONSE_DEBOUNCE_MS)
    }

    function inspectNode(node: Node): void {
      if (node.nodeType === Node.TEXT_NODE) {
        const container = siteAdapter.findResponseContainer((node as Text).parentElement)
        if (container) schedule(container)
        return
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return

      const element = node as Element
      const container = siteAdapter.findResponseContainer(element)
      if (container) {
        schedule(container)
        return
      }

      for (const responseContainer of siteAdapter.getResponseContainers()) {
        if (element.contains(responseContainer)) schedule(responseContainer)
      }
    }

    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData' || mutation.type === 'attributes') {
          inspectNode(mutation.target)
          continue
        }

        mutation.addedNodes.forEach(inspectNode)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src'] })

    requestAnimationFrame(() => {
      siteAdapter.getResponseContainers().forEach(schedule)
    })
  }

  function startReplyReporting(): void {
    observeResponseContainers((text, element) => {
      const assignedRole = roleSession.getAssignedRole()
      if (!assignedRole) return

      const messageId = roleSession.getActiveMessageId()
      if (!messageId) {
        log.debug('reply:skipped-no-active-message', { textLength: text.length, roleId: assignedRole.roleId })
        return
      }
      if (messageId && isPromptBaselineReply(text, element)) {
        log.debug('reply:skipped-baseline', { messageId, textLength: text.length, roleId: assignedRole.roleId })
        return
      }

      resolveReportableReplyText(siteAdapter, element, text, log)
        .then(reply => {
          const currentRole = roleSession.getAssignedRole()
          if (!currentRole) return
          if (!replyTracker.consumeIfNewForMessage(getConversationId(), reportableReplyKey(reply), messageId)) {
            log.debug('reply:skipped', { messageId, textLength: reply.text.length, roleId: currentRole.roleId })
            return
          }
          reportAcceptedReply(messageId, reply, 'observer')
        })
        .catch(() => {
          const currentRole = roleSession.getAssignedRole()
          if (!currentRole) return
          if (!replyTracker.consumeIfNewForMessage(getConversationId(), text, messageId)) {
            log.debug('reply:skipped', { messageId, textLength: text.length, roleId: currentRole.roleId })
            return
          }
          reportAcceptedReply(messageId, { text }, 'observer')
        })
    })
  }

  function resetForAssignedRole(): void {
    clearPromptReplyBaseline()
    replyTimeout.clear()
    clearReplyPolling()
    replyTracker.seed(getConversationId(), siteAdapter.getAllAssistantReplies())
  }

  function readReplySnapshot(element: Element, knownText?: string): ReplySnapshot {
    const text = knownText ?? siteAdapter.readResponseText(element)
    const images = siteAdapter.readResponseImages?.(element) ?? []
    return {
      element,
      text,
      images,
      key: buildReplyKey(text, images),
    }
  }

  return {
    capturePromptReplyBaseline,
    clearPromptReplyBaseline,
    clearReplyPolling,
    startReplyPolling,
    startReplyReporting,
    seedStoredRoleReplies,
    resetForAssignedRole,
  }
}

interface ReplySnapshot {
  element: Element
  text: string
  images: ReplyImageSource[]
  key: string
}

function hasReplySnapshot(snapshot: ReplySnapshot): boolean {
  return Boolean(snapshot.text.trim() || snapshot.images.length > 0)
}

function buildReplyKey(text: string, images: ReplyImageSource[]): string {
  return `${text.trim()}\u0000${images.map(image => image.sourceUrl).sort().join('\u0000')}`
}

function reportableReplyKey(reply: ReportableReplyText): string {
  return buildReplyKey(reply.text, reply.images ?? [])
}
