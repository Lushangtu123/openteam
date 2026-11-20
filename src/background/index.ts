import { isChatSite } from '../group/chatSites'
import { backgroundErrorForUser } from '../shared/connectionErrors'
import { loadStore } from '../group/store'
import { guardSpendCaps } from './spendCapGuard'
import { createResultSender } from './resultSender'
import { createWebPageReader } from './webPageReader'
import { hostAccessPattern } from '../shared/hostAccess'
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
  addPanelPort,
  panelOpen,
  postToPanels,
} from './runtimeClient'
import { MEMBER_PORT_NAME, PANEL_PORT_NAME } from '../group/runtimeProtocol'
import { createMemberPorts, isMemberPortTabId } from './memberPorts'
import { chatSiteForUrl } from '../group/chatSites'
import { createMessageRouter } from './messageRouter'
import { classifyRuntimeSender, isRuntimeMessageAllowed, responseForSender } from './senderPolicy'
import { createExternalModelHandlers } from './externalModelHandlers'
import { ALL_SITES_DROPPED_AT_KEY, dropAllSitesAccess } from './allSitesAccess'
import { restrictStorageToExtension } from './storageAccess'
import { createInterruptedReplySweeper } from './interruptedReplies'
import { createMemoryHandlers } from './memoryHandlers'
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
import { createSiteCheckHandlers } from './siteCheckHandlers'
import { createScheduledTaskHandlers } from './scheduledTaskHandlers'
import { createSiteUsageHandlers } from './siteUsageHandlers'
import { checkLinks } from './linkCheck'
import { ACCOUNT_BALANCE_ALARM, createAccountBalances } from './accountBalances'
import { createScheduledTaskRunner, SCHEDULED_TASK_ALARM } from './scheduledTaskRunner'
import { keepLogsAcrossRestarts } from './diagnosticsLogs'
import { recentLogs } from '../shared/logger'
import { createControlClient } from './controlClient'
import { createTeamPageShower } from './teamPageTab'
import { createImageAttachmentService } from './imageAttachments'
import { createWebSocketCookieSync, memberPageTabIds } from './websocketCookies'
import { chatIdFromNotificationId, createReplyNotifier } from './replyNotifications'
import { createIndexedDbImageAttachmentRepository } from '../shared/imageAttachmentRepository'
import { createWebPageOffers, readPageInTab } from './webPageOffers'
import type { CapturedWebPage } from '../group/webPage'

const runtimeFrames = createRuntimeFrameRegistry()
const log = createLogger('background')
// 导出诊断信息 reads these; they outlive the worker in session storage.
void keepLogsAcrossRestarts(chrome.storage?.session)
const CONTROL_KEEPALIVE_ALARM = 'openteam-control-keepalive'
const CONTROL_KEEPALIVE_PERIOD_MINUTES = 0.4

const sendPrompt = createPromptSender({
  log,
  sendToFrame: (tabId, frameId, message) => sendToMemberFrame(tabId, frameId, message),
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
// 读网页: API members read pages as they answer; a new site waits on the user's answer, asked the way
// local agents ask (webPageReader.ts).
const webPageReader = createWebPageReader({
  fetch: (url, init) => fetch(url, init),
  hasAccess: pattern => chrome.permissions.contains({ origins: [pattern] }),
  ask: (context, question, signal) => localAgentApprovals.ask(context, question, signal),
  log,
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
const modelClient: ExternalModelClient = {
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
// Every API call passes the daily spending caps (花费上限, src/group/spendCap.ts).
const externalModelClient = guardSpendCaps(modelClient, {
  loadStore,
  mutateStore,
  broadcastStoreUpdated: store => broadcastStoreUpdated(store),
  now: () => Date.now(),
  notify(id, title, message) {
    if (!chrome.notifications?.create) return
    chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/openteam-128.png'), title, message, priority: 1 }, () => void chrome.runtime.lastError)
  },
  log,
})

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
  return sendToMemberFrame(tabId, frameId, message)
}

// A member's page: in a frame of an OpenTeam tab, or in the side panel, reached over its port.
function sendToMemberFrame(tabId: number, frameId: number, message: unknown): Promise<unknown> {
  if (isMemberPortTabId(tabId)) return memberPorts.send(tabId, message as BackgroundToRoleMessage)
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
      syncPageMenu(language)
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
    // Off unless switched on: it adds a line to members' prompts.
    if (typeof message.memoryProposals === 'boolean') {
      if (message.memoryProposals) store.settings.memoryProposals = true
      else delete store.settings.memoryProposals
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

// 附上网页: the page the icon or 发到 OpenTeam was used on (see webPageOffers.ts).
const webPageOffers = createWebPageOffers({
  extensionOrigin: chrome.runtime.getURL(''),
  storage: {
    get: key => chrome.storage.session.get(key),
    set: items => chrome.storage.session.set(items),
    remove: key => chrome.storage.session.remove(key),
  },
  getTab: tabId => chrome.tabs.get(tabId).catch(() => undefined),
  async readTab(tabId) {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: readPageInTab })
    if (!result?.result) throw new Error('the page gave no text')
    return result.result as CapturedWebPage
  },
  language: async () => (await loadStore()).settings.language === 'en' ? 'en' : 'zh-CN',
  now,
})

const PAGE_MENU_ID = 'openteam-send-page'

// 发到 OpenTeam in a page's right-click menu, in the page's language. Made again on each install
// and update, and renamed when the language changes.
function syncPageMenu(language: string | undefined): void {
  if (!chrome.contextMenus) return
  const title = language === 'en' ? 'Send this page to OpenTeam' : '把这个网页发到 OpenTeam'
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: PAGE_MENU_ID, title, contexts: ['page', 'selection'] }, () => void chrome.runtime.lastError)
  })
}

// 定时任务 (see scheduledTaskRunner.ts). It sends through this router, once it is made.
const accountBalances = createAccountBalances({
  fetch: (url, init) => fetch(url, init),
  hash: async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join(''),
  broadcastStoreUpdated,
  now,
  log,
})

// 把结果发出去: a scheduled task's round goes to its destination once it is over (resultSender.ts).
const resultSender = createResultSender({
  loadStore,
  mutateStore,
  broadcastStoreUpdated: store => broadcastStoreUpdated(store),
  fetch: (url, init) => fetch(url, init),
  async hasAccess(url) {
    const pattern = hostAccessPattern(url)
    return Boolean(pattern) && chrome.permissions.contains({ origins: [pattern!] })
  },
  now,
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  newId,
  log,
})

const scheduledTasks = createScheduledTaskRunner({
  loadStore,
  route: message => Promise.resolve(routeMessage(message, {})),
  broadcastStoreUpdated,
  teamPageOpen: () => listHostTabIds().length > 0 || panelOpen(),
  panelOpen,
  async showTeamPage() {
    // After the background restarts it no longer knows the OpenTeam tab that is open.
    const open = await chrome.tabs.query({ url: `${chrome.runtime.getURL('team.html')}*` })
    for (const tab of open) if (tab.id !== undefined) rememberHost({} as chrome.runtime.MessageSender, tab.id)
    await showTeamPage()
  },
  requestRoleRecovery,
  runtimeFrames,
  alarms: {
    create: (name, info) => chrome.alarms?.create?.(name, info),
    clear: name => chrome.alarms?.clear?.(name),
  },
  waitFor: ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)),
  now,
  log,
})

const routeMessage = createMessageRouter([
  { type: 'GROUP_STORE_GET', handler: handleStoreGet },
  // The background's recent log entries, for 导出诊断信息 (already cleaned: src/shared/logger.ts).
  { type: 'DIAGNOSTICS_LOGS_GET', handler: async () => ({ ok: true, logs: recentLogs() }) },
  ...webPageOffers.handlers,
  // OpenTeam in the side panel (see openSidePanel below): an OpenTeam tab asks on opening whether a
  // panel holds the members' pages now.
  { type: 'TEAM_PANEL_PRESENCE_GET', handler: async () => ({ ok: true, open: panelOpen() }) },
  {
    type: 'TEAM_PAGE_SHOW',
    handler: async message => {
      await showTeamPage({ fromWindowId: typeof message.windowId === 'number' ? message.windowId : undefined, focusWindow: true })
      // A member's page asked for from the side panel: the OpenTeam tab holding it shows it.
      if (typeof message.chatId === 'string' && typeof message.roleId === 'string') {
        const focus = { type: 'TEAM_ROLE_FOCUS', chatId: message.chatId, roleId: message.roleId }
        for (const tabId of listHostTabIds()) await chrome.tabs.sendMessage(tabId, focus, { frameId: 0 }).catch(() => undefined)
      }
      return { ok: true }
    },
  },
  ...createChatHandlers({ broadcastStoreUpdated, getChatStatusFromRoles, imageAttachments: imageAttachmentRepository, log, newId, now, runtimeFrames }),
  { type: 'GROUP_SETTINGS_UPDATE', handler: handleSettingsUpdate },
  ...createBackupHandlers({ broadcastStoreUpdated, log, imageAttachments: imageAttachmentRepository }),
  ...createMemoryHandlers({ broadcastStoreUpdated, log, now }),
  // Runs through this router itself, once it is made.
  ...createScheduledTaskHandlers({ broadcastStoreUpdated, newId, now, log, schedulesChanged: () => scheduledTasks.sync(), runNow: (chatId, taskId) => scheduledTasks.runNow(chatId, taskId) }),
  ...createSiteUsageHandlers({ broadcastStoreUpdated, log }),
  ...accountBalances.routes,
  ...resultSender.routes,
  ...createSiteCheckHandlers({ route: message => Promise.resolve(routeMessage(message, {})), broadcastStoreUpdated, runtimeFrames, waitFor: ms => new Promise(resolve => globalThis.setTimeout(resolve, ms)), now }),
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
  ...createMessageHandlers({ webPageReader, broadcastStoreUpdated, checkLinks: urls => checkLinks(urls, { fetch: (url, init) => fetch(url, init), hasAccess: pattern => chrome.permissions.contains({ origins: [pattern] }), now }), externalModelClient, getChatStatusFromRoles, imageAttachments, log, newId, now, onPromptSettled: (store, chatId, promptMessageId) => Promise.all([notifyWhenAnswered(store, chatId, promptMessageId), resultSender.onPromptSettled(store, chatId, promptMessageId)]), promptDeliveryLimiter, requestRoleRecovery, runtimeFrames, sendError, sendPrompt, sendRoleMessage }),
])

// Replies their members can no longer give, ended at these moments (see interruptedReplies.ts).
const interruptedReplies = createInterruptedReplySweeper({
  tabs: { query: queryInfo => chrome.tabs.query(queryInfo) },
  teamPageUrl: chrome.runtime.getURL('team.html'),
  sessionStorage: chrome.storage?.session,
  async settle(scope) {
    const response = await routeMessage({ type: 'GROUP_REPLIES_INTERRUPTED', ...scope }, {}) as { settled?: unknown[] } | undefined
    return response?.settled?.length ?? 0
  },
  now,
  log,
})

// The OpenTeam page, reused when it is open (see teamPageTab.ts).
const showTeamPage = createTeamPageShower(chrome.tabs, chrome.runtime.getURL('team.html'), chrome.windows)

chrome.runtime.onConnect?.addListener(port => {
  if (port.name === PANEL_PORT_NAME) addPanelPort(port)
  if (port.name === MEMBER_PORT_NAME) memberPorts.connect(port)
})

const executeControlCommand = createControlActionExecutor({
  loadStore,
  routeRuntimeMessage(message) {
    return Promise.resolve(routeMessage(message, {}))
  },
  runtimeFrames,
  openTeamPage: () => showTeamPage(),
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
  await showTeamPage({ focusWindow: true })
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    log.info('extension-installed')
    initializeControlClient()
    loadStore().then(store => syncPageMenu(store.settings.language), () => syncPageMenu(undefined))
  } catch (error) {
    logBackgroundFailure('extension-installed:failed', error)
  }
})

chrome.runtime.onStartup?.addListener(() => {
  initializeControlClient()
})

// 用量's real spend: DeepSeek and Kimi accounts' balances, read every hour and when 用量 opens.
chrome.alarms?.create?.(ACCOUNT_BALANCE_ALARM, { periodInMinutes: 60 })

chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name === ACCOUNT_BALANCE_ALARM) {
    accountBalances.refresh().catch(error => log.warn('account-balance:refresh-failed', { error: errorReason(error) }))
    return
  }
  if (alarm.name === SCHEDULED_TASK_ALARM) {
    scheduledTasks.checkDue().catch(error => log.warn('scheduled-task:check-failed', { error: errorReason(error) }))
    return
  }
  if (alarm.name !== CONTROL_KEEPALIVE_ALARM) return
  syncControlClient().catch(error => log.warn('control-client:keepalive-sync-failed', { error: errorReason(error) }))
})

// A message from an OpenTeam page or a member's page, checked against who sent it, then handled.
async function processMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const senderKind = classifyRuntimeSender(sender, chrome.runtime.getURL('').replace(/\/$/, ''))
  if (!isRuntimeMessageAllowed(message?.type, senderKind)) {
    log.debug('message-handler:sender-rejected', { type: message?.type, senderKind, senderUrl: sender.url, tabUrl: sender.tab?.url })
    return { ok: false, error: 'OpenTeam rejected a message from an untrusted context' }
  }
  try {
    const response = await routeMessage(message, sender)
    const allowed = responseForSender(response, senderKind)
    return senderKind === 'extension-page' ? encodeStoreResponse(allowed, message, sender) : allowed
  } catch (error) {
    const reason = errorReason(error)
    log.warn('message-handler:failed', { type: message?.type, error: reason })
    // Chrome's wording for a member page that is gone is put in plain words; the log keeps it.
    const shown = backgroundErrorForUser(reason)
    sendError(shown).catch(() => undefined)
    return { ok: false, error: shown }
  }
}

// Members' AI pages in the side panel (memberPorts.ts). What they report that the OpenTeam page
// itself watches (a page ready, a site's state) reaches a tab's page directly; the panel is told.
const memberPorts = createMemberPorts({
  panelPageUrl: chrome.runtime.getURL('team.html?view=panel'),
  isMemberPageUrl: url => Boolean(chatSiteForUrl(url)),
  async handle(message, sender) {
    const response = await processMessage(message as RuntimeMessage, sender)
    if (message.type === 'TEAM_FRAME_ROLE_READY' || message.type === 'TEAM_SITE_STATUS_UPDATE') postToPanels(message)
    return response
  },
  onGone: tabId => memberPageTabGone(tabId),
})

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  try {
    if (message?.type === 'OPENTEAM_PING') {
      sendResponseSafely(sendResponse, { ok: true, tabId: sender.tab?.id ?? null })
      return true
    }

    processMessage(message, sender).then(response => sendResponseSafely(sendResponse, response))
  } catch (error) {
    const reason = errorReason(error)
    logBackgroundFailure('message-listener:failed', error, { type: message?.type })
    sendError(reason).catch(() => undefined)
    sendResponseSafely(sendResponse, { ok: false, error: reason })
  }

  return true
})

// The toolbar icon: the OpenTeam tab already open, preferably in this window, or a new one here.
// The toolbar icon and 发到 OpenTeam open OpenTeam in the side panel, beside the page they were used
// on, and offer that page to the composer (webPageOffers.ts). Without a side panel (an older Chrome)
// the OpenTeam tab is shown instead.
chrome.action.onClicked.addListener(tab => {
  openTeamPageFrom(tab)
})

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== PAGE_MENU_ID || !tab) return
  openTeamPageFrom(tab, info.selectionText)
})

function openTeamPageFrom(tab: chrome.tabs.Tab, selection?: string): void {
  // Chrome opens the side panel only straight from the click, before anything is awaited.
  const panel = openSidePanel(tab.windowId)
  const offered = webPageOffers.offer(tab, selection).catch(error => logBackgroundFailure('web-page-offer:failed', error))
  panel.then(opened => opened ? undefined : offered.then(() => showTeamPage({ fromWindowId: tab.windowId, focusWindow: true })))
    .catch(error => logBackgroundFailure('open-team-page:failed', error))
}

function openSidePanel(windowId: number | undefined): Promise<boolean> {
  if (!chrome.sidePanel?.open || windowId === undefined) return Promise.resolve(false)
  return chrome.sidePanel.open({ windowId }).then(() => true, error => {
    logBackgroundFailure('side-panel:open-failed', error)
    return false
  })
}

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
    listTabIds: () => memberPageTabIds(listHostTabIds(), panelOpen()),
    log,
  })
  onHostTabsChanged(() => webSocketCookies.schedule())
  chrome.cookies.onChanged.addListener(change => {
    if (webSocketCookies.watchesDomain(change.cookie.domain)) webSocketCookies.schedule()
  })
  webSocketCookies.schedule()
}

chrome.tabs.onRemoved.addListener(tabId => memberPageTabGone(tabId))

// A tab closed, or a side panel member page's port closed: its member pages are gone.
function memberPageTabGone(tabId: number): void {
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
      .then(() => interruptedReplies.afterTabClosed())
      .catch(error => logBackgroundFailure('tab-removed:update-failed', error, { tabId }))
  } catch (error) {
    logBackgroundFailure('tab-removed:failed', error, { tabId })
  }
}

// The extension's storage is for its own pages and background only (see storageAccess.ts).
if (chrome.storage) void restrictStorageToExtension({ local: chrome.storage.local, sync: chrome.storage.sync, session: chrome.storage.session }, log)

initializeControlClient()
void interruptedReplies.atBackgroundStart()
// A task due while the browser was closed or the background asleep runs, or is skipped, now.
scheduledTasks.checkDue().catch(error => log.warn('scheduled-task:check-failed', { error: errorReason(error) }))

// An install that was updated from a version requiring every website gives that access back, once
// (see allSitesAccess.ts). Skipped where the browser has no way to remove a permission.
if (chrome.permissions) {
  void dropAllSitesAccess({
    permissions: chrome.permissions,
    readDroppedAt: async () => Number((await chrome.storage.local.get(ALL_SITES_DROPPED_AT_KEY))[ALL_SITES_DROPPED_AT_KEY]) || 0,
    writeDroppedAt: timestamp => chrome.storage.local.set({ [ALL_SITES_DROPPED_AT_KEY]: timestamp }),
    reload: () => chrome.runtime.reload(),
    now,
    log,
  })
}
