// Reading what the team page and member pages send: who it is from, a reply's text and images, a page's
// health, and the plain values a request carries.
import { isChatSite } from '../group/chatSites'
import type { ChatSite, GroupChat, MessageReference, OpenTeamStore, OrchestrationFlow, ReplyImageSource, RoleSiteHealthReason, RoleSiteHealthStatus } from '../group/types'
import { messageTabId, type RuntimeMessage, senderFrameId } from './runtimeClient'
import type { MessageHandlersDependencies } from './messageHandlerDeps'

export function readIdentity(deps: MessageHandlersDependencies, message: RuntimeMessage, sender: chrome.runtime.MessageSender): { chatId: string; roleId: string } {
  const identity = readIdentityOptional(deps, message, sender)
  if (identity) return identity
  throw new Error('缺少 chatId/roleId')
}

export function readIdentityOptional(deps: MessageHandlersDependencies, message: RuntimeMessage, sender: chrome.runtime.MessageSender): { chatId: string; roleId: string } | undefined {
  const chatId = readOptionalString(message.chatId)
  const roleId = readOptionalString(message.roleId)
  if (chatId && roleId) return { chatId, roleId }

  const tabId = messageTabId(message, sender)
  if (tabId !== undefined) {
    const binding = deps.runtimeFrames.getByAddress(tabId, senderFrameId(sender))
    if (binding) return { chatId: binding.chatId, roleId: binding.roleId }
  }

  return undefined
}

export function resolveReference(store: OpenTeamStore, chat: GroupChat, raw: unknown, newId: (prefix: string) => string): MessageReference | undefined {
  if (!isRecord(raw)) return undefined

  const messageId = readOptionalString(raw.messageId)
  if (messageId) {
    const message = store.messagesById[messageId]
    if (message && message.chatId === chat.id) {
      return {
        messageId: message.id,
        roleId: message.roleId,
        roleName: message.roleName,
        contentSnapshot: message.content,
      }
    }
  }

  const contentSnapshot = readOptionalString(raw.contentSnapshot)
  if (!contentSnapshot) return undefined
  return {
    messageId: messageId ?? newId('ref'),
    roleId: readOptionalString(raw.roleId),
    roleName: readOptionalString(raw.roleName),
    contentSnapshot,
  }
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

export function resolveOrchestrationMentionFlow(
  store: OpenTeamStore,
  chat: GroupChat,
  target: 'default' | { name: string },
): OrchestrationFlow {
  const orderedFlows = (store.orchestrationFlowOrderByChatId[chat.id] ?? [])
    .map(flowId => store.orchestrationFlowsById[flowId])
    .filter((flow): flow is OrchestrationFlow => Boolean(flow && flow.chatId === chat.id))
  const extraFlows = Object.values(store.orchestrationFlowsById)
    .filter((flow): flow is OrchestrationFlow => Boolean(flow && flow.chatId === chat.id && !orderedFlows.some(ordered => ordered.id === flow.id)))
  const flows = [...orderedFlows, ...extraFlows]

  if (target === 'default') {
    const flow = flows[0]
    if (!flow) throw new Error('当前群聊还没有编排流程，请先创建或保存一个编排流程')
    return flow
  }

  const name = target.name.trim()
  const flow = flows.find(candidate => candidate.name.trim() === name)
  if (!flow) throw new Error(`找不到名为“${name}”的编排流程，请先创建或保存`)
  return flow
}

export function readReplyContent(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// Image bytes read inside the page (for blob: sources), capped per image and per reply.
export const MAX_REPLY_IMAGE_DATA_CHARS = Math.ceil((25 * 1024 * 1024) / 3) * 4
export const MAX_REPLY_IMAGES_DATA_CHARS = 4 * MAX_REPLY_IMAGE_DATA_CHARS

export function readReplyImageSources(value: unknown): ReplyImageSource[] {
  if (!Array.isArray(value)) return []
  let dataChars = 0
  return value.slice(0, 20).flatMap(item => {
    if (!isRecord(item) || typeof item.sourceUrl !== 'string' || !item.sourceUrl.trim()) return []
    const width = readOptionalImageDimension(item.width)
    const height = readOptionalImageDimension(item.height)
    const data = readReplyImageData(item.data)
    const withData = data !== undefined && dataChars + data.length <= MAX_REPLY_IMAGES_DATA_CHARS
    if (withData) dataChars += data.length
    return [{
      sourceUrl: item.sourceUrl.trim(),
      ...(typeof item.alt === 'string' && item.alt.trim() ? { alt: item.alt.trim().slice(0, 500) } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(withData ? { data } : {}),
      ...(withData && typeof item.mimeType === 'string' ? { mimeType: item.mimeType.slice(0, 40) } : {}),
    }]
  })
}

export function readReplyImageData(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_REPLY_IMAGE_DATA_CHARS) return undefined
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined
}

export function readOptionalImageDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 20_000 ? value : undefined
}

export function readSiteId(value: unknown): ChatSite | undefined {
  return isChatSite(value) ? value : undefined
}

export function readSiteHealthStatus(value: unknown): RoleSiteHealthStatus | undefined {
  if (value === 'ready' || value === 'generating' || value === 'loading' || value === 'error' || value === 'blocked' || value === 'unauthorized') return value
  return undefined
}

export function readSiteHealthReason(value: unknown): RoleSiteHealthReason | undefined {
  if (value === 'verification' || value === 'http-error' || value === 'overlay' || value === 'embed-blocked' || value === 'login' || value === 'guest' || value === 'no-editor' || value === 'site-error') return value
  return undefined
}

export function isTrustedImageSenderUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      url.hostname === 'chatgpt.com' ||
      url.hostname === 'chat.openai.com' ||
      url.hostname === 'gemini.google.com' ||
      url.hostname === 'grok.com' ||
      url.hostname === 'chat.qwen.ai'
    )
  } catch {
    return false
  }
}

export function isBoundImageSender(
  deps: MessageHandlersDependencies,
  identity: { chatId: string; roleId: string },
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): boolean {
  if (!isTrustedImageSenderUrl(sender.url)) return false
  const tabId = messageTabId(message, sender)
  if (tabId === undefined) return false
  const binding = deps.runtimeFrames.getByAddress(tabId, senderFrameId(sender))
  return Boolean(binding?.ready && binding.chatId === identity.chatId && binding.roleId === identity.roleId)
}

export function requireString(value: unknown, error: string): string {
  const result = readOptionalString(value)
  if (!result) throw new Error(error)
  return result
}

export function requireNumber(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(error)
  return value
}

export function requireNoteContent(value: unknown): NonNullable<OpenTeamStore['globalNote']> {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('笔记内容格式无效')
  return value as NonNullable<OpenTeamStore['globalNote']>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
