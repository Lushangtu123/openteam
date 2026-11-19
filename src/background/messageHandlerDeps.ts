// What the message handlers are given, and the shapes they share with the modules they use.
import type { LoadedUpload, UploadedImage } from './imageAttachments'
import type { BackgroundToRoleMessage } from '../group/runtimeProtocol'
import type { GroupChat, GroupMessage, LinkCheck, MessageImageAttachment, OpenTeamStore, ReplyImageSource } from '../group/types'
import type { ExternalModelClient } from './externalModelClient'
import type { PromptSender } from './promptDelivery'
import type { ExternalPromptDelivery, PreparedRolePromptDelivery } from './rolePromptDelivery'
import type { RuntimeFrameRegistry } from './runtimeFrames'
import type { SitePromptDeliveryLimiter } from './sitePromptDeliveryLimiter'

export interface ExternalModelRunRegistry {
  register(chatId: string, roleId: string, replyAttemptId: string, controller: AbortController): void
  abort(chatId: string, roleId: string, replyAttemptId?: string): void
  unregister(chatId: string, roleId: string, replyAttemptId: string): void
}

// A request OpenTeam sent one member, with its prepared delivery.
export interface OpenTeamRequest {
  request: GroupMessage
  prepared: PreparedRolePromptDelivery
}

export interface MessageHandlersDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
  // Told when a member finished with a message (replied or failed for good), to notify the user
  // once every member it went to has.
  onPromptSettled?(store: OpenTeamStore, chatId: string, promptMessageId: string): Promise<unknown> | void
  getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status']
  log: {
    debug(event: string, details?: Record<string, unknown>): void
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  newId(prefix: string): string
  now(): number
  runtimeFrames: Pick<RuntimeFrameRegistry, 'bind' | 'getByAddress' | 'getByRole'> & Partial<Pick<RuntimeFrameRegistry, 'lostPage'>>
  sendRoleMessage(tabId: number, frameId: number, message: BackgroundToRoleMessage): Promise<unknown>
  sendError(reason: string): Promise<void> | void
  sendPrompt: PromptSender
  promptDeliveryLimiter?: SitePromptDeliveryLimiter
  externalModelClient?: ExternalModelClient
  externalModelRuns?: ExternalModelRunRegistry
  imageAttachments?: {
    captureReplyImages(input: { chatId: string; messageId: string; images: ReplyImageSource[] }): Promise<MessageImageAttachment[]>
    deleteByIds(ids: string[]): Promise<void>
    saveUploads?(input: { chatId: string; messageId: string; images: UploadedImage[] }): Promise<void>
    loadUploads?(ids: string[]): Promise<LoadedUpload[]>
  }
  deliveryRetryDelaysMs?: readonly number[]
  externalModelRetryDelaysMs?: readonly number[]
  roleErrorRetryDelaysMs?: readonly number[]
  requestRoleRecovery?(chatId: string, roleId: string, reason?: string): Promise<boolean>
  waitForRetry?(ms: number): Promise<void>
  // Opens source links to see whether they hold up (linkCheck.ts); without it, links stay unchecked.
  checkLinks?(urls: string[]): Promise<Record<string, LinkCheck>>
  // A web member's backup API model answers its prompt (memberBackup.ts); resolves when it is done.
  answerForMember?(delivery: ExternalPromptDelivery): Promise<unknown>
}

// What the message handlers share, made once by createMessageHandlers and handed to each group.
export interface MessageHandlerContext {
  // The dependencies as given: a project reports its milestones to these, not to the ones below.
  baseDeps: MessageHandlersDependencies
  // The same, except that a settled prompt also moves on the round, discussion or project it belongs to.
  deps: MessageHandlersDependencies
  externalModelClient: ExternalModelClient
  externalModelRuns: ExternalModelRunRegistry
  // How many times each member's prompt was tried again after an error.
  roleErrorRetryCounts: Map<string, number>
  deliverExternal(delivery: ExternalPromptDelivery): Promise<OpenTeamStore | undefined>
  deliverExternalTogether(deliveries: ExternalPromptDelivery[]): Promise<OpenTeamStore | undefined>
}
