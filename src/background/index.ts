import { isChatSite } from '../group/chatSites'
import { loadStore } from '../group/store'
import type { GroupChat, OpenTeamStore } from '../group/types'
import { referencedImageIds } from '../group/backup'
import { createBackupHandlers } from './backupHandlers'
import { createChatHandlers } from './chatHandlers'
import { createMessageHandlers } from './messageHandlers'
import {
  broadcastControlStatusUpdated as broadcastRuntimeControlStatusUpdated,
  broadcastStoreUpdated as broadcastRuntimeStoreUpdated,
  encodeStoreResponse,
  forgetHostTab,
  rememberHost,
  requestRoleRecovery,
  sendError,
  type RuntimeMessage,
  onHostTabsChanged,
  listHostTabIds,
} from './runtimeClient'
import { createMessageRouter } from './messageRouter'
import { classifyRuntimeSender, isRuntimeMessageAllowed, responseForSender } from './senderPolicy'
import { createExternalModelHandlers } from './externalModelHandlers'
import { requireApiModelAccess } from './apiModelAccess'
import { createExternalModelClient, type ExternalModelClient } from './externalModelClient'
import { createLocalAgentApprovals } from './localAgentApprovals'
import { createLocalAgentClient } from './localAgentClient'
import type { LocalAgentInfo } from '../shared/localControlProtocol'
import type { ExternalModelConfig } from '../group/types'
import { createPromptSender } from './promptDelivery'
import { createRoleHandlers } from './roleHandlers'
import { createOrchestrationHandlers, type OrchestrationAutoStreamMessage } from './orchestrationHandlers'
import { createRuntimeFrameRegistry } from './runtimeFrames'
import { createSitePromptDeliveryLimiter } from './sitePromptDeliveryLimiter'
import { getChatRoles, mutateStore } from './storeAccess'
import { createLogger } from '../shared/logger'
import type { BackgroundToRoleMessage } from '../group/runtimeProtocol'
import { createControlActionExecutor } from './controlHandlers'
import { createControlClient } from './controlClient'
import { createImageAttachmentService } from './imageAttachments'
import { createWebSocketCookieSync } from './websocketCookies'
import { chatIdFromNotificationId, createReplyNotifier } from './replyNotifications'
import { createIndexedDbImageAttachmentRepository } from '../shared/imageAttachmentRepository'

const runtimeFrames = createRuntimeFrameRegistry()
const log = createLogger('background')
const CONTROL_KEEPALIVE_ALARM = 'openteam-control-keepalive'
const CONTROL_KEEPALIVE_PERIOD_MINUTES = 0.4

const sendPrompt = createPromptSender({
  log,
  loadImages: async ids => (await imageAttachments.loadUploads(ids)).map(({ fileName, mimeType, data }) => ({ fileName, mimeType, data })),
})
const promptDeliveryLimiter = createSitePromptDeliveryLimiter({ log })
// Each API address is allowed by the user on its own; without that the call is refused, with why.
const apiModelClient = requireApiModelAccess(createExternalModelClient())
// Questions local agent members wait on (run this task? allow this action?), answered on the page.
const localAgentApprovals = createLocalAgentApprovals({
  newId,
  now,
  mutateStore,
  broadcastStoreUpdated: store => broadcastStoreUpdated(store),
})
const localAgentClient = createLocalAgentClient({
  control: {
    request: (action, payload, timeoutMs) => controlClient.request(action, payload, timeoutMs),
    onAgentEvents: (runId, handler) => controlClient.onAgentEvents(runId, handler),
  },
  approvals: localAgentApprovals,
  getLanguage: () => cachedLanguage,
})
let cachedLanguage: unknown
// API models answer directly; a local agent runs through the daemon, only as a group member.
const externalModelClient: ExternalModelClient = {
  stream(input) {
    if (input.model.format === 'local-agent') return localAgentClient.stream(input)
    if (apiModelClient.stream) return apiModelClient.stream(input)
    return (async function* () {
      yield (await apiModelClient.complete(input)).content
    })()
  },
  async complete(input) {
    if (input.model.format !== 'local-agent') return apiModelClient.complete(input)
    let content = ''
    for await (const chunk of localAgentClient.stream(input)) content += chunk
    return { content }
  },
}

async function listLocalAgents(): Promise<LocalAgentInfo[]> {
  const result = await controlClient.request('agent.list')
  if (!result.ok) throw new Error(result.error?.message ?? '没有拿到本机智能体列表')
  const agents = (result.data as { agents?: unknown } | undefined)?.agents
  return Array.isArray(agents) ? agents as LocalAgentInfo[] : []
}

// Whether a local agent model can run: the agent is listed, and its folder is allowed.
async function checkLocalAgent(model: ExternalModelConfig): Promise<string> {
  const agent = (await listLocalAgents()).find(candidate => candidate.id === model.localAgentId)
  if (!agent) throw new Error(`本地守护进程里没有这个智能体：${model.localAgentId}。用 openteamcli agent add 添加它。`)
  if (agent.type !== 'stdio') throw new Error('这个智能体需要以 stdio 方式运行（ACP）。')
  const workspace = (model.workspace ?? '').replace(/\/+$/, '')
  const allowed = agent.cwdAllowlist.some(root => workspace === root || workspace.startsWith(`${root}/`))
  if (!allowed) throw new Error(`工作目录 ${workspace} 不在这个智能体允许的范围内（${agent.cwdAllowlist.join('、') || '还没有允许任何目录'}）。`)
  return `可以使用：${agent.name} 在 ${workspace}`
}
const imageAttachmentRepository = createIndexedDbImageAttachmentRepository()
const imageAttachments = createImageAttachmentService({
  fetchImage(url, init) {
    return fetch(url, init)
  },
  repository: imageAttachmentRepository,
  newId: () => newId('attachment'),
  now,
})

function sendRoleMessage(tabId: number, frameId: number, message: BackgroundToRoleMessage): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId })
}

function now(): number {
  return Date.now()
}

function newId(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  return `${prefix}-${cryptoApi?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

async function broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> {
  cachedLanguage = store.settings.language
  await broadcastRuntimeStoreUpdated(store, { excludeTabId })
}

async function broadcastAutoGenerateStream(message: OrchestrationAutoStreamMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message)
  } catch (error) {
    log.debug('auto-orchestration-stream:runtime-failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

function getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status'] {
  const roles = getChatRoles(store, chat)
  if (roles.length === 0) return 'draft'
  if (roles.some(role => role.status === 'thinking' || role.status === 'loading')) return 'running'
  if (roles.some(role => role.status === 'error')) return 'error'
  return 'ready'
}

async function handleStoreGet(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, bindings: runtimeFrames.list(), controlStatus: controlClient.status() }
}

async function handleSettingsUpdate(message: RuntimeMessage) {
  const { store } = await mutateStore(store => {
    const defaultChatSite = readOptionalString(message.defaultChatSite)
    if (isChatSite(defaultChatSite)) {
      store.settings.defaultChatSite = defaultChatSite
    }
    if (typeof message.agentControlEnabled === 'boolean') {
      store.settings.agentControlEnabled = message.agentControlEnabled
    }
    if (typeof message.agentControlPort === 'number' && Number.isInteger(message.agentControlPort) && message.agentControlPort >= 1024 && message.agentControlPort <= 65535) {
      store.settings.agentControlPort = message.agentControlPort
    }
    const language = readOptionalString(message.language)
    if (language === 'en' || language === 'zh-CN') {
      store.settings.language = language
    }
    if (typeof message.replyNotifications === 'boolean') {
      if (message.replyNotifications) delete store.settings.replyNotifications
      else store.settings.replyNotifications = false
    }
    if (typeof message.replyKeyPoints === 'boolean') {
      if (message.replyKeyPoints) delete store.settings.replyKeyPoints
      else store.settings.replyKeyPoints = false
    }
    if (typeof message.roundSummary === 'boolean') {
      if (message.roundSummary) delete store.settings.roundSummary
      else store.settings.roundSummary = false
    }
  })
  await broadcastStoreUpdated(store)
  syncControlClient().catch(error => log.warn('control-client:settings-sync-failed', { error: errorReason(error) }))
  return { ok: true, store }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message
  const reason = String(error)
  return reason.trim() || 'Unknown OpenTeam background error'
}

function logBackgroundFailure(event: string, error: unknown, details: Record<string, unknown> = {}): void {
  log.warn(event, { ...details, error: errorReason(error) })
}

function sendResponseSafely(sendResponse: (response?: unknown) => void, response: unknown): void {
  try {
    sendResponse(response)
  } catch (error) {
    logBackgroundFailure('message-response:failed', error)
  }
}

const routeMessage = createMessageRouter([
  { type: 'GROUP_STORE_GET', handler: handleStoreGet },
  ...createChatHandlers({ broadcastStoreUpdated, getChatStatusFromRoles, imageAttachments: imageAttachmentRepository, log, newId, now, runtimeFrames }),
  { type: 'GROUP_SETTINGS_UPDATE', handler: handleSettingsUpdate },
  ...createBackupHandlers({ broadcastStoreUpdated, log, imageAttachments: imageAttachmentRepository }),
  ...createExternalModelHandlers({ broadcastStoreUpdated, externalModelClient, checkLocalAgent, newId, now }),
  { type: 'LOCAL_AGENT_LIST', handler: async () => ({ ok: true, agents: await listLocalAgents() }) },
  {
    type: 'GROUP_LOCAL_AGENT_DECIDE',
    handler: async message => {
      const chatId = typeof message.chatId === 'string' ? message.chatId : ''
      const roleId = typeof message.roleId === 'string' ? message.roleId : ''
      const approvalId = typeof message.approvalId === 'string' ? message.approvalId : ''
      const optionId = typeof message.optionId === 'string' ? message.optionId : ''
      if (!chatId || !roleId || !approvalId || !optionId) throw new Error('缺少要回答的请求')
      await localAgentApprovals.decide({ chatId, roleId }, approvalId, optionId)
      return { ok: true }
    },
  },
  ...createRoleHandlers({ broadcastStoreUpdated, externalModelClient, log, newId, now, runtimeFrames, sendPrompt }),
  ...createOrchestrationHandlers({ broadcastStoreUpdated, broadcastAutoGenerateStream, externalModelClient, getChatStatusFromRoles, log, newId, now, promptDeliveryLimiter, requestRoleRecovery, runtimeFrames, sendPrompt }),
  ...createMessageHandlers({ broadcastStoreUpdated, externalModelClient, getChatStatusFromRoles, imageAttachments, log, newId, now, onPromptSettled: notifyWhenAnswered, promptDeliveryLimiter, requestRoleRecovery, runtimeFrames, sendError, sendPrompt, sendRoleMessage }),
])

const executeControlCommand = createControlActionExecutor({
  loadStore,
  routeRuntimeMessage(message) {
    return Promise.resolve(routeMessage(message, {}))
  },
  runtimeFrames,
  openTeamPage,
  waitFor(ms) {
    return new Promise(resolve => globalThis.setTimeout(resolve, ms))
  },
  now,
})

log.info('control-client:create', {
  extensionId: getExtensionId(),
  extensionVersion: getExtensionVersion(),
})

const controlClient = createControlClient({
  loadStore,
  executeCommand: executeControlCommand,
  getExtensionVersion() {
    return getExtensionVersion()
  },
  getProfileId() {
    return getExtensionId()
  },
  log,
  setTimer(handler, ms) {
    return globalThis.setTimeout(handler, ms)
  },
  clearTimer(timerId) {
    globalThis.clearTimeout(timerId)
  },
  onStatusChange(status) {
    return broadcastRuntimeControlStatusUpdated(status)
  },
})
let controlClientInitialized = false

cleanupOrphanedImageAttachments().catch(error => {
  log.warn('image-attachments:orphan-cleanup-failed', { error: errorReason(error) })
})

async function cleanupOrphanedImageAttachments(): Promise<void> {
  await imageAttachmentRepository.deleteOrphans(new Set(referencedImageIds(await loadStore())))
}

function syncControlClient(): Promise<void> {
  log.info('control-client:sync')
  return controlClient.sync()
}

function initializeControlClient(): void {
  if (controlClientInitialized) return
  controlClientInitialized = true
  try {
    chrome.alarms?.create?.(CONTROL_KEEPALIVE_ALARM, { periodInMinutes: CONTROL_KEEPALIVE_PERIOD_MINUTES })
    log.info('control-client:keepalive-alarm-scheduled', {
      alarm: CONTROL_KEEPALIVE_ALARM,
      periodInMinutes: CONTROL_KEEPALIVE_PERIOD_MINUTES,
    })
  } catch (error) {
    logBackgroundFailure('control-client:keepalive-alarm-failed', error)
  }
  log.info('control-client:initial-sync-scheduled')
  syncControlClient().catch(error => {
    log.warn('control-client:initial-sync-failed', { error: errorReason(error) })
  })
}

function getExtensionVersion(): string {
  try {
    return chrome.runtime.getManifest?.().version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function getExtensionId(): string {
  return chrome.runtime.id ?? 'unknown-extension'
}

// Every member answered a message: a desktop notification if no OpenTeam tab is in view. Needs the
// notifications permission; without it, nothing happens.
function teamPageTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: `${chrome.runtime.getURL('team.html')}*` })
}

const replyNotifier = createReplyNotifier({
  create: (id, options) => new Promise(resolve => chrome.notifications.create(id, options, resolve)),
  async isTeamPageInView() {
    for (const tab of await teamPageTabs()) {
      if (!tab.active) continue
      const window = await chrome.windows.get(tab.windowId)
      if (window.focused && window.state !== 'minimized') return true
    }
    return false
  },
  iconUrl: chrome.runtime.getURL('icons/openteam-128.png'),
  log,
})

function notifyWhenAnswered(store: OpenTeamStore, chatId: string, promptMessageId: string): Promise<unknown> | void {
  if (!chrome.notifications?.create) return
  return replyNotifier.notify(store, chatId, promptMessageId)
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener(notificationId => {
    const chatId = chatIdFromNotificationId(notificationId)
    if (!chatId) return
    chrome.notifications.clear(notificationId)
    showTeamPageChat(chatId).catch(error => logBackgroundFailure('reply-notification:open-failed', error))
  })
}

// Brings an OpenTeam tab to the front on the given group (opening one if none is open).
async function showTeamPageChat(chatId: string): Promise<void> {
  const { store } = await mutateStore(store => {
    if (store.chatsById[chatId]) store.currentChatId = chatId
  })
  await broadcastStoreUpdated(store)
  const [tab] = await teamPageTabs()
  if (!tab?.id) {
    await openTeamPage()
    return
  }
  await chrome.tabs.update(tab.id, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
}

async function openTeamPage(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('team.html'), active: true })
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    log.info('extension-installed')
    initializeControlClient()
  } catch (error) {
    logBackgroundFailure('extension-installed:failed', error)
  }
})

chrome.runtime.onStartup?.addListener(() => {
  initializeControlClient()
})

chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name !== CONTROL_KEEPALIVE_ALARM) return
  syncControlClient().catch(error => log.warn('control-client:keepalive-sync-failed', { error: errorReason(error) }))
})

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  try {
    if (message?.type === 'OPENTEAM_PING') {
      sendResponseSafely(sendResponse, { ok: true, tabId: sender.tab?.id ?? null })
      return true
    }

    const senderKind = classifyRuntimeSender(sender, chrome.runtime.getURL('').replace(/\/$/, ''))
    if (!isRuntimeMessageAllowed(message?.type, senderKind)) {
      log.debug('message-handler:sender-rejected', { type: message?.type, senderKind, senderUrl: sender.url, tabUrl: sender.tab?.url })
      sendResponseSafely(sendResponse, { ok: false, error: 'OpenTeam rejected a message from an untrusted context' })
      return true
    }

    Promise.resolve()
      .then(() => routeMessage(message, sender))
      .then(response => {
        const allowed = responseForSender(response, senderKind)
        sendResponseSafely(sendResponse, senderKind === 'extension-page' ? encodeStoreResponse(allowed, message, sender) : allowed)
      })
      .catch((error: unknown) => {
        const reason = errorReason(error)
        log.warn('message-handler:failed', { type: message?.type, error: reason })
        sendError(reason).catch(() => undefined)
        sendResponseSafely(sendResponse, { ok: false, error: reason })
      })
  } catch (error) {
    const reason = errorReason(error)
    logBackgroundFailure('message-listener:failed', error, { type: message?.type })
    sendError(reason).catch(() => undefined)
    sendResponseSafely(sendResponse, { ok: false, error: reason })
  }

  return true
})

chrome.action.onClicked.addListener(() => {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('team.html'), active: true }).catch(error => {
      logBackgroundFailure('open-team-page:failed', error)
    })
  } catch (error) {
    logBackgroundFailure('open-team-page:failed', error)
  }
})

// Grok's chat WebSocket from the team page's frames: see websocketCookies.ts. Skipped when the
// cookies permission or session rules are not available.
if (chrome.cookies?.onChanged && chrome.declarativeNetRequest?.updateSessionRules) {
  const webSocketCookies = createWebSocketCookieSync({
    getCookies: async url => {
      // Partitioned cookies are kept per top-level site; the frames' top level is this extension.
      const topLevelSite = chrome.runtime.getURL('').replace(/\/$/, '')
      const [unpartitioned, partitioned] = await Promise.all([
        chrome.cookies.getAll({ url }),
        // partitionKey (Chrome 119+) is not in the installed chrome types yet.
        chrome.cookies.getAll({ url, partitionKey: { topLevelSite } } as chrome.cookies.GetAllDetails).catch(() => []),
      ])
      return [...unpartitioned, ...partitioned]
    },
    updateSessionRules: update => chrome.declarativeNetRequest.updateSessionRules(update),
    listTabIds: listHostTabIds,
    log,
  })
  onHostTabsChanged(() => webSocketCookies.schedule())
  chrome.cookies.onChanged.addListener(change => {
    if (webSocketCookies.watchesDomain(change.cookie.domain)) webSocketCookies.schedule()
  })
  webSocketCookies.schedule()
}

chrome.tabs.onRemoved.addListener(tabId => {
  try {
    forgetHostTab(tabId)
    const removed = runtimeFrames.removeTab(tabId)
    if (removed.length === 0) return

    mutateStore(store => {
      const timestamp = now()
      for (const binding of removed) {
        const role = store.rolesById[binding.roleId]
        if (!role || role.chatId !== binding.chatId || role.status === 'thinking') continue
        role.status = 'loading'
        role.updatedAt = timestamp
      }
    })
      .then(({ store }) => broadcastStoreUpdated(store))
      .catch(error => logBackgroundFailure('tab-removed:update-failed', error, { tabId }))
  } catch (error) {
    logBackgroundFailure('tab-removed:failed', error, { tabId })
  }
})

initializeControlClient()
