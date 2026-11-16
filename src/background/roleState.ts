// A member's own state: whether it can be sent to, how long it has waited, and the site conversation it
// keeps.
import { CHAT_SITE_INFO, chatSiteForUrl } from '../group/chatSites'
import { extractSupportedConversationId, getDefaultChatSiteUrlForRole, normalizeSupportedChatConversationUrl } from '../group/conversationUrl'
import { REPLY_STUCK_AFTER_MS } from '../group/replyTiming'
import type { GroupRole, RuntimeFrameBinding } from '../group/types'
import type { MessageHandlersDependencies } from './messageHandlerDeps'

export const STALE_THINKING_MS = REPLY_STUCK_AFTER_MS
export function updateConversation(role: GroupRole, conversationUrl: string | undefined, conversationId: string | undefined): void {
  const safeUrl = normalizeSupportedChatConversationUrl(conversationUrl)
  const conversationIdFromUrl = extractSupportedConversationId(safeUrl)
  if (safeUrl && conversationIdFromUrl) {
    role.geminiConversationUrl = safeUrl
    role.geminiConversationId = conversationIdFromUrl
    return
  }

  if (isMeaningfulConversationId(conversationId)) role.geminiConversationId = conversationId
}

// The member's window shows its site's start page (a new chat) although it had a conversation, and
// it is not waiting on a reply (just after a prompt the site is still on its start page). Returns the
// conversation it had. A login page or any other page is not a start page.
export function conversationLeftFor(role: GroupRole, pageUrl: string | undefined, defaultChatSite: GroupRole['chatSite']): string | undefined {
  const savedUrl = role.geminiConversationUrl
  if (!savedUrl || !extractSupportedConversationId(savedUrl) || role.status === 'thinking') return undefined
  const safeUrl = normalizeSupportedChatConversationUrl(pageUrl)
  const site = chatSiteForUrl(safeUrl)
  if (!safeUrl || !site || site !== chatSiteForUrl(savedUrl) || extractSupportedConversationId(safeUrl)) return undefined
  const path = (url: string) => new URL(url).pathname.replace(/\/+$/, '')
  const startPaths = new Set(['', path(CHAT_SITE_INFO[site].homeUrl), path(getDefaultChatSiteUrlForRole(role, defaultChatSite))])
  // Gemini's start page is /app.
  if (site === 'gemini') startPaths.add('/app')
  return startPaths.has(path(safeUrl)) ? savedUrl : undefined
}

export function isMeaningfulConversationId(value: string | undefined): value is string {
  return Boolean(value && value !== '__default__')
}

// A member waiting for a reply counts as stuck once nothing has moved that reply for a while (see
// ../group/replyTiming), and can then be sent to again. role.updatedAt is the clock: while the member waits, only signs
// of the reply set it (the prompt going out, text arriving, the page saying it is generating).
// Other news about the member (its page loaded, the chat was closed, a message skipped it) leaves
// it alone, or a member that never answers would look busy for as long as the group is in use.
export function isStaleThinkingRole(role: GroupRole, timestamp: number): boolean {
  return role.status === 'thinking' && timestamp - role.updatedAt >= STALE_THINKING_MS
}

export function isRoleDeliverable(role: GroupRole, binding: RuntimeFrameBinding | undefined, timestamp: number): boolean {
  if (!binding?.ready) return false
  return role.status === 'ready' || role.status === 'error' || role.status === 'stopped' || role.status === 'loading' || role.status === 'pending' || isStaleThinkingRole(role, timestamp)
}

export function recoverDeliverableRoleStatus(role: GroupRole, timestamp: number, log: MessageHandlersDependencies['log']): void {
  if (role.status === 'ready') return

  log.warn('role:auto-recover-status', { roleId: role.id, roleName: role.name, previousStatus: role.status, lastPromptMessageId: role.lastPromptMessageId })
  role.status = 'ready'
  delete role.lastPromptMessageId
  delete role.replyAttemptId
  role.updatedAt = timestamp
}

export function readPersonaLength(role: GroupRole): number {
  return (role.systemPrompt?.trim() || role.description?.trim() || role.name.trim()).length
}
