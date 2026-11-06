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
  // The site's prompt input box, where attached files are pasted.
  findEditor?(): HTMLElement | null
  // For sites that add their file inputs only while their upload menu is open: opens it so the
  // inputs are on the page, and returns how to close it again. Such sites get files through their
  // file input first, and pasting only as a fallback.
  revealFileInputs?(): Promise<(() => void) | undefined>
  stopGenerating(): Promise<boolean>
  fillAndSend(content: string, autoSend?: boolean): Promise<void>
  collectPromptDiagnostics(): Record<string, unknown>
}
