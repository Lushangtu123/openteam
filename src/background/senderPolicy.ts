// Decides which runtime messages the background accepts from which context.
// Extension pages (team.html) are trusted. Content scripts run inside third-party
// AI sites, so they may only send role-frame messages, and only from frames
// embedded in the OpenTeam team page.

export const ROLE_FRAME_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'TEAM_FRAME_ROLE_READY',
  'TEAM_ROLE_CONVERSATION_UPDATED',
  'TEAM_SEND_ACK',
  'TEAM_ROLE_ERROR',
  'TEAM_ROLE_STATUS',
  'TEAM_ROLE_REPLY',
  'TEAM_ROLE_REPLY_RESYNC',
  'TEAM_SITE_STATUS_UPDATE',
])

export type RuntimeSenderKind = 'extension-page' | 'team-page-frame' | 'untrusted'

export function classifyRuntimeSender(sender: chrome.runtime.MessageSender, extensionOrigin: string): RuntimeSenderKind {
  if (sender.url?.startsWith(`${extensionOrigin}/`) && (!sender.origin || sender.origin === extensionOrigin)) return 'extension-page'
  if (sender.tab?.url?.startsWith(`${extensionOrigin}/team.html`)) return 'team-page-frame'
  return 'untrusted'
}

export function isRuntimeMessageAllowed(type: unknown, kind: RuntimeSenderKind): boolean {
  if (kind === 'extension-page') return true
  return kind === 'team-page-frame' && typeof type === 'string' && ROLE_FRAME_MESSAGE_TYPES.has(type)
}

// Responses to content scripts never need the whole store (chats, notes, API keys).
export function responseForSender(response: unknown, kind: RuntimeSenderKind): unknown {
  if (kind === 'extension-page' || !response || typeof response !== 'object' || !('store' in response)) return response
  const { store: _store, ...rest } = response as Record<string, unknown>
  return rest
}
