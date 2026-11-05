import type { FrameRoleReadyResponse, RoleToBackgroundMessage } from '../group/runtimeProtocol'
import type { ContentLogger } from './runtimeClient'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

const FRAME_ASSIGN_MESSAGE = 'OPENTEAM_ASSIGN_FRAME_ROLE'

export function registerFrameRoleHandshake(options: {
  siteAdapter: ChatSiteAdapter
  roleSession: RoleSession
  log: ContentLogger
  extensionOrigin: string
  seedStoredRoleReplies(replies: string[] | undefined): void
  sendRuntimeMessage<T>(message: RoleToBackgroundMessage): Promise<T>
}): void {
  window.addEventListener('message', event => {
    // Only the OpenTeam page that embeds this frame may assign it a role.
    if (event.source !== window.parent || event.origin !== options.extensionOrigin) return
    if (!event.data || typeof event.data !== 'object') return
    if (event.data.type !== FRAME_ASSIGN_MESSAGE) return

    const chatId = typeof event.data.chatId === 'string' ? event.data.chatId : typeof event.data.roomId === 'string' ? event.data.roomId : ''
    const roleId = typeof event.data.roleId === 'string' ? event.data.roleId : ''
    const hostTabId = typeof event.data.hostTabId === 'number' ? event.data.hostTabId : undefined
    if (!roleId) return

    const snapshot = options.siteAdapter.getConversationSnapshot()
    options.log.info('frame-role:assignment-received', { chatId, roleId, hostTabId, conversationId: snapshot.conversationId })
    options
      .sendRuntimeMessage<FrameRoleReadyResponse>({
        type: 'TEAM_FRAME_ROLE_READY',
        chatId,
        roleId,
        hostTabId,
        conversationId: snapshot.conversationId || options.siteAdapter.getConversationId(),
        conversationUrl: snapshot.conversationUrl,
      })
      .then(response => {
        if (!response.ok || !response.role) {
          options.log.warn('frame-role:ready-failed', { roleId, error: response.error })
          return
        }

        options.seedStoredRoleReplies(response.replyHistory)
        options.roleSession.assignRole({
          chatId,
          roleId: response.role.id,
          roleName: response.role.name,
          roomId: response.role.chatId || chatId,
        })
      })
      .catch(error => options.log.warn('frame-role:ready-error', { roleId, error: error instanceof Error ? error.message : String(error) }))
  })
}
