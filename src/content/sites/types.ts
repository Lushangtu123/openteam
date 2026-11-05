import type { SiteStatus } from '../../group/runtimeProtocol'
import type { ReplyImageSource, RoleSiteHealthReason } from '../../group/types'
import type { SiteHealthContext } from './siteHealth'

export interface SiteStatusInfo {
  status: SiteStatus
  reason?: RoleSiteHealthReason
  detail?: string
  timestamp: number
}

export interface ConversationSnapshot {
  conversationId?: string
  conversationUrl?: string
}

export interface ChatSiteAdapter {
  readonly id: string
  getConversationSnapshot(): ConversationSnapshot
  getConversationId(): string
  getResponseContainers(): Element[]
  getAllAssistantReplies(): string[]
  readResponseText(node: Node): string
  readResponseImages?(node: Node): ReplyImageSource[]
  readResponseTextFromCopy?(node: Node): Promise<string | undefined>
  readResponseMarkdown?(node: Node): string
  findResponseContainer(element: Element | null): Element | null
  isGenerating(): boolean
  checkStatus?(context: SiteHealthContext): SiteStatusInfo
  stopGenerating(): Promise<boolean>
  fillAndSend(content: string, autoSend?: boolean): Promise<void>
  collectPromptDiagnostics(): Record<string, unknown>
}
