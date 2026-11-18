import type { FrameRoleReadyResponse, RoleToBackgroundMessage } from '../group/runtimeProtocol'
import type { ContentLogger } from './runtimeClient'
import type { RoleSession } from './roleSession'
import type { ChatSiteAdapter } from './sites/types'

const FRAME_ASSIGN_MESSAGE = 'OPENTEAM_ASSIGN_FRAME_ROLE'

export interface FrameRoleHandshake {
  // After the link to the background was made again (it restarted): this page's member, again.
  announceAgain(): void
}

export function registerFrameRoleHandshake(options: {
  siteAdapter: ChatSiteAdapter
  roleSession: RoleSession
  log: ContentLogger
  extensionOrigin: string
  seedStoredRoleReplies(replies: string[] | undefined): void
  sendRuntimeMessage<T>(message: RoleToBackgroundMessage): Promise<T>
  // OpenTeam in the side panel asks its pages to link over a port (memberLink.ts); resolves once linked.
  linkOverPort(): Promise<void>
}): FrameRoleHandshake {
  let lastAssignment: { chatId: string; roleId: string; hostTabId?: number } | undefined

  window.addEventListener('message', event => {
    // Only the OpenTeam page that embeds this frame may assign it a role.
    if (event.source !== window.parent || event.origin !== options.extensionOrigin) return
    if (!event.data || typeof event.data !== 'object') return
    if (event.data.type !== FRAME_ASSIGN_MESSAGE) return

    const chatId = typeof event.data.chatId === 'string' ? event.data.chatId : typeof event.data.roomId === 'string' ? event.data.roomId : ''
    const roleId = typeof event.data.roleId === 'string' ? event.data.roleId : ''
    const hostTabId = typeof event.data.hostTabId === 'number' ? event.data.hostTabId : undefined
    if (!roleId) return

    options.log.info('frame-role:assignment-received', { chatId, roleId, hostTabId, transport: event.data.transport, conversationId: options.siteAdapter.getConversationSnapshot().conversationId })
    lastAssignment = { chatId, roleId, ...(hostTabId !== undefined ? { hostTabId } : {}) }
    const linked = event.data.transport === 'port' ? options.linkOverPort() : Promise.resolve()
    linked.then(() => announce(chatId, roleId, hostTabId))
  })

  function announce(chatId: string, roleId: string, hostTabId: number | undefined): void {
    const snapshot = options.siteAdapter.getConversationSnapshot()
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
  }

  return {
    announceAgain() {
      if (lastAssignment) announce(lastAssignment.chatId, lastAssignment.roleId, lastAssignment.hostTabId)
    },
  }
}
