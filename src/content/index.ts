import type { BackgroundToRoleMessage, PromptFile, RoleToBackgroundMessage } from '../group/runtimeProtocol'
import { createConversationMonitor, type ConversationMonitor } from './conversationMonitor'
import { attachFilesToComposer } from './fileUpload'
import { registerFrameRoleHandshake } from './frameHandshake'
import { materializeReplyImages } from './replyImages'
import { isDirectEmbeddedFrame, isEmbeddedFrame } from './frameEnvironment'
import { waitBeforePromptInput, PROMPT_INPUT_DELAY_MS } from './promptDelay'
import { promptStatusMessage } from './promptStatus'
import { createReplyObserver, type ReplyObserverController } from './replyObserver'
import { readResyncReplyText } from './reportableReply'
import { contentLog as log, sendRuntimeMessage, type ContentRuntimeMessage } from './runtimeClient'
import { createRoleSession } from './roleSession'
import { getActiveChatSiteAdapter } from './sites'
import type { SiteStatusInfo } from './sites/types'
import { createSiteProblemTracker } from './siteProblem'
import { chatSiteForHostname, chatSiteLabel } from '../group/chatSites'
import { requestTypingTurn, watchPromptInBox } from './typingTurn'
import { waitUntilSiteIsDone } from './siteBusy'

const OPEN_TEAM_LOADED_KEY = '__OPENTEAM_LOADED__'

const siteAdapter = getActiveChatSiteAdapter()

let replyObserver: ReplyObserverController | undefined
let conversationMonitor: ConversationMonitor | undefined
let lastReportedStatus: { key: string; status: SiteStatusInfo } | undefined
// A prompt that waits for the site to finish the reply it is writing (see siteBusy.ts).
let promptWaitingForSite: { messageId: string; stopped: boolean } | undefined
const siteProblems = createSiteProblemTracker(chatSiteLabel(chatSiteForHostname(location.hostname)))
const pageStartedAt = Date.now()

const roleSession = createRoleSession({
  siteAdapter,
  log,
  onAssigned() {
    replyObserver?.resetForAssignedRole()
    conversationMonitor?.reportConversationUpdate(true)
    reportSiteStatus(true)
  },
})

conversationMonitor = createConversationMonitor({
  siteAdapter,
  roleSession,
  log,
  sendRuntimeMessage: message => sendBackgroundMessage(message),
})

replyObserver = createReplyObserver({
  siteAdapter,
  roleSession,
  log,
  sendRuntimeMessage: message => sendBackgroundMessage(message),
  reportRoleError,
})

function collectPromptDiagnostics(): Record<string, unknown> {
  return {
    site: siteAdapter.id,
    assignedRole: roleSession.getAssignedRole(),
    ...siteAdapter.collectPromptDiagnostics(),
  }
}

function sendBackgroundMessage<T>(message: RoleToBackgroundMessage): Promise<T> {
  return sendRuntimeMessage<T>(message, log)
}

function startStatusHeartbeat(): void {
  const HEARTBEAT_INTERVAL_MS = 3000

  setInterval(() => reportSiteStatus(false), HEARTBEAT_INTERVAL_MS)
}

// Reports the page's health for the role this frame was assigned: right after the assignment, and
// then whenever it changes. Until a role is assigned there is nobody to report it for.
function reportSiteStatus(force: boolean): void {
  const assignedRole = roleSession.getAssignedRole()
  const chatId = roleSession.getAssignedChatId(assignedRole)
  if (!assignedRole || !chatId) return

  try {
    const currentStatus = getCurrentSiteStatus()
    failPendingReplyOnSiteProblem(currentStatus)
    const key = [chatId, assignedRole.roleId, currentStatus.status, currentStatus.reason, currentStatus.detail].join('|')
    if (!force && lastReportedStatus?.key === key) return
    lastReportedStatus = { key, status: currentStatus }
    sendBackgroundMessage({
      type: 'TEAM_SITE_STATUS_UPDATE',
      chatId,
      roleId: assignedRole.roleId,
      siteId: siteAdapter.id,
      status: currentStatus.status,
      ...(currentStatus.reason ? { reason: currentStatus.reason } : {}),
      ...(currentStatus.detail ? { detail: currentStatus.detail } : {}),
    }).catch(error => log.warn('status-heartbeat:report-failed', { error: error instanceof Error ? error.message : String(error) }))
  } catch (error) {
    log.warn('status-heartbeat:check-failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

// See siteProblem.ts: a reply the page has shown it cannot give fails with the page's own message.
function failPendingReplyOnSiteProblem(status: SiteStatusInfo): void {
  const active = roleSession.getActivePrompt()
  const reason = siteProblems.observe(active?.messageId, status)
  if (!active || !reason) return
  log.warn('site-problem:fail-reply', { messageId: active.messageId, status: status.status, reason: status.reason, detail: status.detail })
  const replyAttemptId = active.replyAttemptId
  roleSession.clearActivePrompt(active.messageId)
  replyObserver?.clearPromptReplyBaseline()
  replyObserver?.clearReplyPolling()
  reportRoleError(active.messageId, reason, undefined, undefined, replyAttemptId)
}

function getCurrentSiteStatus(): SiteStatusInfo {
  if (siteAdapter.checkStatus) return siteAdapter.checkStatus({ pageAgeMs: Date.now() - pageStartedAt })
  return {
    status: siteAdapter.isGenerating() ? 'generating' : 'ready',
    timestamp: Date.now(),
  }
}

async function attachPromptFiles(files: PromptFile[] | undefined): Promise<void> {
  if (!files?.length) return
  if (!siteAdapter.findEditor) throw new Error(`${siteAdapter.id} 暂不支持上传图片`)
  const editor = await waitForEditor(siteAdapter.findEditor, 15_000)
  log.info('attach-files:start', { site: siteAdapter.id, files: files.map(file => ({ name: file.fileName, type: file.mimeType, size: file.data.length })) })
  await attachFilesToComposer({ editor, files, revealFileInputs: siteAdapter.revealFileInputs })
  log.info('attach-files:done', { site: siteAdapter.id, count: files.length })
}

async function waitForEditor(find: () => HTMLElement | null, timeoutMs: number): Promise<HTMLElement> {
  for (let waited = 0; waited <= timeoutMs; waited += 250) {
    const editor = find()
    if (editor) return editor
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('找不到网站的输入框，无法上传图片')
}

async function fillAndSend(content: string, autoSend = true): Promise<void> {
  log.info('fill-send:start', { site: siteAdapter.id, contentLength: content.length, autoSend, diagnostics: collectPromptDiagnostics() })
  await siteAdapter.fillAndSend(content, autoSend)
  log.info('fill-send:done', { site: siteAdapter.id, contentLength: content.trim().length, autoSend })
}

function reportRoleError(
  messageId: string | undefined,
  reason: string,
  chatId = roleSession.getAssignedChatId(),
  roleId = roleSession.getAssignedRole()?.roleId || '',
  replyAttemptId = roleSession.getActiveReplyAttemptId(),
): void {
  const assignedRole = roleSession.getAssignedRole()
  if (!chatId || !roleId) {
    log.warn('role-error:skipped-missing-identity', { messageId, reason, assignedRole })
    return
  }

  log.warn('role-error:report', { chatId, roleId, messageId, reason, diagnostics: collectPromptDiagnostics() })
  sendBackgroundMessage({
    type: 'TEAM_ROLE_ERROR',
    chatId,
    roleId,
    messageId,
    replyAttemptId,
    reason,
  }).catch(error => log.warn('role-error:failed', { error: error instanceof Error ? error.message : String(error) }))
}

function registerMessageHandlers(): void {
  chrome.runtime.onMessage.addListener((message: ContentRuntimeMessage, _sender, sendResponse) => {
    if (message?.type === 'TEAM_SEND_PROMPT') {
      handleSendPromptMessage(message, sendResponse)
      return true
    }

    if (message?.type === 'TEAM_STOP_GENERATION') {
      handleStopGenerationMessage(message, sendResponse)
      return true
    }

    if (message?.type === 'TEAM_RESYNC_REPLY') {
      handleResyncReplyMessage(message, sendResponse)
      return true
    }

    return false
  })
}

function handleResyncReplyMessage(message: Extract<BackgroundToRoleMessage, { type: 'TEAM_RESYNC_REPLY' }>, sendResponse: (response?: unknown) => void): void {
  log.warn('message:resync-reply:start', {
    chatId: message.chatId,
    roleId: message.roleId,
    messageId: message.messageId,
    currentContentLength: message.currentContent?.length ?? 0,
  })

  readResyncReplyText(siteAdapter, message.currentContent, log)
    .then(reply => {
      log.warn('message:resync-reply:read', {
        chatId: message.chatId,
        roleId: message.roleId,
        messageId: message.messageId,
        contentLength: reply.text.length,
        contentFormat: reply.contentFormat,
      })
      const snapshot = siteAdapter.getConversationSnapshot()
      return materializeReplyImages(reply.images, log).then(images => sendBackgroundMessage({
        type: 'TEAM_ROLE_REPLY_RESYNC',
        chatId: message.chatId,
        roleId: message.roleId,
        messageId: message.messageId,
        content: reply.text,
        contentFormat: reply.contentFormat,
        images,
        conversationId: snapshot.conversationId,
        conversationUrl: snapshot.conversationUrl,
      }))
    })
    .then(response => {
      const responseRecord = typeof response === 'object' && response !== null ? response as Record<string, unknown> : undefined
      log.warn('message:resync-reply:reported', {
        chatId: message.chatId,
        roleId: message.roleId,
        messageId: message.messageId,
        ok: responseRecord?.ok,
        hasStore: Boolean(responseRecord?.store),
      })
      sendResponse(response ?? { ok: true })
    })
    .catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      log.warn('message:resync-reply:failed', { messageId: message.messageId, error: reason, diagnostics: collectPromptDiagnostics() })
      sendResponse({ ok: false, error: reason })
    })
}

function handleStopGenerationMessage(message: Extract<BackgroundToRoleMessage, { type: 'TEAM_STOP_GENERATION' }>, sendResponse: (response?: unknown) => void): void {
  // A prompt still waiting for the site is not sent once its reply is stopped.
  if (promptWaitingForSite && (!message.messageId || message.messageId === promptWaitingForSite.messageId)) promptWaitingForSite.stopped = true
  const activePrompt = roleSession.getActivePrompt()
  log.info('message:stop-generation', {
    chatId: message.chatId,
    roleId: message.roleId,
    messageId: message.messageId,
    activeMessageId: activePrompt?.messageId,
  })

  if (
    activePrompt &&
    ((message.messageId && activePrompt.messageId !== message.messageId) ||
      (message.replyAttemptId && activePrompt.replyAttemptId && activePrompt.replyAttemptId !== message.replyAttemptId))
  ) {
    sendResponse({ ok: false, error: '当前回复已经切换，停止请求已过期' })
    return
  }

  siteAdapter
    .stopGenerating()
    .then(stopped => {
      if (!stopped) {
        sendResponse({ ok: false, error: '当前页面没有可点击的停止按钮' })
        return
      }

      roleSession.clearActivePrompt(message.messageId)
      replyObserver?.clearPromptReplyBaseline()
      replyObserver?.clearReplyPolling()
      sendResponse({ ok: true })
    })
    .catch(error => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    })
}

function handleSendPromptMessage(message: Extract<BackgroundToRoleMessage, { type: 'TEAM_SEND_PROMPT' }>, sendResponse: (response?: unknown) => void): void {
  const promptChatId = message.chatId || roleSession.getAssignedChatId()
  const promptRoleId = message.roleId || roleSession.getAssignedRole()?.roleId || ''
  const isRetry = message.isRetry ?? false
  log.warn('orchestration-diagnostic:content-send-prompt:received', {
    chatId: promptChatId,
    roleId: promptRoleId,
    payloadChatId: message.chatId,
    payloadRoleId: message.roleId,
    messageId: message.messageId,
    replyAttemptId: message.replyAttemptId,
    contentLength: message.content.length,
    autoSend: message.autoSend,
    isRetry,
    assignedRole: roleSession.getAssignedRole(),
    assignedChatId: roleSession.getAssignedChatId(),
    diagnostics: collectPromptDiagnostics(),
  })

  // Bug 3 fix: When this is a retry, check if the prompt was already delivered to the page.
  // If the active prompt already matches this messageId, the prompt was already sent —
  // skip re-sending and just wait for the reply.
  if (isRetry) {
    const activePrompt = roleSession.getActivePrompt()
    if (activePrompt?.messageId === message.messageId) {
      log.warn('retry:prompt-already-delivered', {
        messageId: message.messageId,
        chatId: promptChatId,
        roleId: promptRoleId,
      })
      // Prompt already delivered, just ensure polling is running
      replyObserver?.startReplyPolling(message.messageId, message.replyAttemptId)
      sendResponse({ ok: true, messageId: message.messageId, skipped: true })
      return
    }
  }

  // The same prompt again while it waits for the site (see siteBusy.ts): it is on its way.
  if (promptWaitingForSite?.messageId === message.messageId) {
    sendResponse({ ok: true, messageId: message.messageId, skipped: true })
    return
  }

  const waiting = { messageId: message.messageId, stopped: false }
  sendBackgroundMessage(promptStatusMessage('sending', promptChatId, promptRoleId))
    .then(() => {
      log.info('message:send-prompt:delay-before-input', { messageId: message.messageId, delayMs: PROMPT_INPUT_DELAY_MS })
      return waitBeforePromptInput()
    })
    .then(() => {
      promptWaitingForSite = waiting
      return waitUntilSiteIsDone({
        isGenerating: () => siteAdapter.isGenerating(),
        isStopped: () => waiting.stopped,
        heartbeat: () => {
          log.warn('message:send-prompt:site-still-writing', { messageId: message.messageId })
          sendBackgroundMessage(promptStatusMessage('sending', promptChatId, promptRoleId)).catch(() => undefined)
        },
      })
    })
    .finally(() => {
      if (promptWaitingForSite === waiting) promptWaitingForSite = undefined
    })
    .then(async outcome => {
      if (outcome === 'stopped') {
        // Stopped while it waited: the member is stopped already, and the prompt never went in.
        log.warn('message:send-prompt:stopped-before-sending', { messageId: message.messageId })
        sendResponse({ ok: true, messageId: message.messageId, skipped: true })
        return
      }
      // From here the prompt is this page's: what is on the page now, the reply the site may just
      // have finished included, is not its reply.
      replyObserver?.capturePromptReplyBaseline(message.messageId)
      roleSession.startPrompt(message.messageId, message.replyAttemptId)
      await inTypingTurn(message.content, () => attachPromptFiles(message.files).then(() => fillAndSend(message.content, message.autoSend !== false)))
      await sendPromptOnItsWay()
    })
    .catch(error => {
      const reason = error instanceof Error ? error.message : String(error)
      log.warn('message:send-prompt:failed', { messageId: message.messageId, error: reason, diagnostics: collectPromptDiagnostics() })
      roleSession.clearActivePrompt(message.messageId)
      replyObserver?.clearPromptReplyBaseline()
      replyObserver?.clearReplyPolling()
      reportRoleError(message.messageId, reason, promptChatId, promptRoleId, message.replyAttemptId)
      sendBackgroundMessage(promptStatusMessage('error', promptChatId, promptRoleId, reason)).catch(() => undefined)
      sendResponse({ ok: false, messageId: message.messageId, error: reason })
    })

  // The prompt is in and sent: tell the background, and watch for its reply.
  function sendPromptOnItsWay(): Promise<void> {
    return Promise.resolve()
      .then(() => {
        conversationMonitor?.reportConversationUpdate()
        if (promptChatId && promptRoleId) {
          sendBackgroundMessage({ type: 'TEAM_SEND_ACK', chatId: promptChatId, roleId: promptRoleId, messageId: message.messageId }).catch(error =>
            log.warn('message:send-prompt:ack-failed', { messageId: message.messageId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
      })
      .then(() => sendBackgroundMessage(promptStatusMessage('generating', promptChatId, promptRoleId)))
      .then(() => {
        replyObserver?.startReplyPolling(message.messageId, message.replyAttemptId)
        log.info('message:send-prompt:ok', { messageId: message.messageId })
        sendResponse({ ok: true, messageId: message.messageId })
      })
  }
}

// Typing a prompt takes the keyboard focus into this page. Inside OpenTeam it waits for a turn (the
// user has paused typing, no other member page is typing), and gives the turn back as soon as the
// prompt is in the box: sending is a click and needs no focus.
async function inTypingTurn(prompt: string, type: () => Promise<void>): Promise<void> {
  const turn = requestTypingTurn({ extensionOrigin: chrome.runtime.getURL('').replace(/\/$/, '') })
  await turn.granted
  const stopWatching = watchPromptInBox(() => siteAdapter.findEditor?.(), prompt, turn.done)
  try {
    await type()
  } finally {
    stopWatching()
    turn.done()
  }
}

function startOpenTeam(): void {
  const embedded = isEmbeddedFrame()
  const directEmbedded = isDirectEmbeddedFrame()
  log.info('boot', { href: location.href, conversationId: siteAdapter.getConversationId(), embedded, directEmbedded })
  registerMessageHandlers()

  if (embedded) {
    if (directEmbedded) {
      conversationMonitor?.start()
      replyObserver?.startReplyReporting()
      registerFrameRoleHandshake({
        siteAdapter,
        roleSession,
        log,
        extensionOrigin: chrome.runtime.getURL('').replace(/\/$/, ''),
        seedStoredRoleReplies: replies => replyObserver?.seedStoredRoleReplies(replies),
        sendRuntimeMessage: message => sendBackgroundMessage(message),
      })
      startStatusHeartbeat()
    }
    return
  }

  conversationMonitor?.start()
  replyObserver?.startReplyReporting()
  startStatusHeartbeat()
}

function bootWhenReady(): void {
  if (document.body) {
    startOpenTeam()
    return
  }

  document.addEventListener('DOMContentLoaded', startOpenTeam, { once: true })
}

if (!(window as unknown as Record<string, boolean>)[OPEN_TEAM_LOADED_KEY]) {
  ;(window as unknown as Record<string, boolean>)[OPEN_TEAM_LOADED_KEY] = true
  bootWhenReady()
}
