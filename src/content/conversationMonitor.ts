import type { RoleToBackgroundMessage } from '../group/runtimeProtocol'
import type { ContentLogger } from './runtimeClient'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

export interface ConversationMonitor {
  reportConversationUpdate(force?: boolean): void
  start(): void
}

const CONVERSATION_POLL_MS = 1_000
const CONVERSATION_SETTLE_MS = 500

export function createConversationMonitor(options: {
  siteAdapter: ChatSiteAdapter
  roleSession: RoleSession
  log: ContentLogger
  sendRuntimeMessage<T>(message: RoleToBackgroundMessage): Promise<T>
}): ConversationMonitor {
  let lastReportedConversationKey = ''
  let conversationMonitorStarted = false

  function reportConversationUpdate(force = false): void {
    const assignedRole = options.roleSession.getAssignedRole()
    if (!assignedRole) return

    const chatId = options.roleSession.getAssignedChatId(assignedRole)
    if (!chatId) return

    const snapshot = options.siteAdapter.getConversationSnapshot()
    const key = `${chatId}:${assignedRole.roleId}:${snapshot.conversationId || ''}:${snapshot.conversationUrl || ''}`
    if (!force && key === lastReportedConversationKey) return
    lastReportedConversationKey = key

    options
      .sendRuntimeMessage({
        type: 'TEAM_ROLE_CONVERSATION_UPDATED',
        chatId,
        roleId: assignedRole.roleId,
        conversationId: snapshot.conversationId,
        conversationUrl: snapshot.conversationUrl,
      })
      .catch(error => options.log.warn('conversation-update:failed', { error: error instanceof Error ? error.message : String(error) }))
  }

  // A content script cannot see the page's own history.pushState calls: they run in the page's
  // world, with its own copy of the History object. So the page's address is watched instead: the
  // Navigation API reports same-document navigations to every world, and a check each second covers
  // browsers without it. Changes are reported once the address has settled for a moment.
  function start(): void {
    if (conversationMonitorStarted) return
    conversationMonitorStarted = true

    let settleTimer: number | undefined
    let lastHref = location.href
    const notify = () => {
      lastHref = location.href
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(() => reportConversationUpdate(), CONVERSATION_SETTLE_MS)
    }

    const navigation = (window as Window & { navigation?: EventTarget }).navigation
    navigation?.addEventListener('currententrychange', notify)
    window.setInterval(() => {
      if (location.href !== lastHref) notify()
    }, CONVERSATION_POLL_MS)
    window.addEventListener('popstate', notify)
    window.addEventListener('hashchange', notify)
    notify()
  }

  return { reportConversationUpdate, start }
}
