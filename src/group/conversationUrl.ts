import { CHAT_SITE_INFO, chatSiteConversationId, chatSiteForUrl, chatSiteOrigin, DEFAULT_FALLBACK_CHAT_SITE } from './chatSites'
import type { ChatSite } from './types'

const GEMINI_ORIGIN = 'https://gemini.google.com'
const GEMINI_HOME_URL = `${GEMINI_ORIGIN}/`
const GEMINI_APP_PREFIX = '/app/'
const CHATGPT_HOME_URL = CHAT_SITE_INFO.chatgpt.homeUrl
const CHATGPT_HOSTS = new Set(CHAT_SITE_INFO.chatgpt.hosts)
const GROK_HOME_URL = CHAT_SITE_INFO.grok.homeUrl

interface ChatSiteStartUrlRole {
  chatSite?: ChatSite
  chatGptGptsUrl?: string
  grokProjectUrl?: string
}

export function isSafeGeminiUrl(value: string | undefined): value is string {
  if (!value || !value.startsWith(GEMINI_HOME_URL)) return false

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'gemini.google.com'
  } catch {
    return false
  }
}

export function getSafeGeminiUrl(value: string | undefined): string {
  return isSafeGeminiUrl(value) ? value : GEMINI_HOME_URL
}

export function getSafeGeminiIframeSrc(value: string | undefined): string {
  return getSafeGeminiUrl(value)
}

export function isSafeSupportedChatUrl(value: string | undefined): value is string {
  return Boolean(chatSiteForUrl(value))
}

export function getSafeSupportedChatUrl(value: string | undefined): string {
  return isSafeSupportedChatUrl(value) ? value : GEMINI_HOME_URL
}

export function getSafeSupportedChatIframeSrc(value: string | undefined): string {
  return getSafeSupportedChatUrl(value)
}

export function getDefaultChatSiteUrl(site: ChatSite | undefined): string {
  return CHAT_SITE_INFO[site ?? DEFAULT_FALLBACK_CHAT_SITE].homeUrl
}

export function getDefaultChatSiteUrlForRole(role: ChatSiteStartUrlRole, fallbackSite?: ChatSite): string {
  const site = role.chatSite ?? fallbackSite
  if (site === 'chatgpt') return normalizeChatGptGptsUrl(role.chatGptGptsUrl) ?? CHATGPT_HOME_URL
  if (site === 'grok') return normalizeGrokProjectUrl(role.grokProjectUrl) ?? GROK_HOME_URL
  return getDefaultChatSiteUrl(site)
}

export function getSafeSupportedChatIframeSrcForSite(value: string | undefined, site: ChatSite | undefined): string {
  return isSafeSupportedChatUrl(value) ? value : getDefaultChatSiteUrl(site)
}

export function getSafeSupportedChatIframeSrcForRole(value: string | undefined, role: ChatSiteStartUrlRole, fallbackSite?: ChatSite): string {
  return isSafeSupportedChatUrl(value) ? value : getDefaultChatSiteUrlForRole(role, fallbackSite)
}

export function normalizeSupportedChatConversationUrl(value: string | undefined): string | undefined {
  return isSafeSupportedChatUrl(value) ? new URL(value).href : undefined
}

export function normalizeChatGptGptsUrl(value: string | undefined): string | undefined {
  const url = parseSafeChatGptUrl(value)
  if (!url) return undefined

  const match = url.pathname.match(/^\/g\/([^/]+)/)
  const gptsSlug = match?.[1]
  return gptsSlug ? `${url.origin}/g/${gptsSlug}` : undefined
}

export function normalizeGrokProjectUrl(value: string | undefined): string | undefined {
  const url = parseSafeGrokUrl(value)
  if (!url) return undefined

  const projectId = url.pathname.match(/^\/project\/([^/]+)/)?.[1]
  return projectId ? `${url.origin}/project/${projectId}` : undefined
}

export function extractSupportedConversationId(value: string | undefined): string | undefined {
  return chatSiteConversationId(value)
}

export function getSupportedChatOrigin(value: string | undefined): string {
  if (!isSafeSupportedChatUrl(value)) return GEMINI_ORIGIN
  return new URL(value).origin
}

export function getSupportedChatOriginForSite(value: string | undefined, site: ChatSite | undefined): string {
  if (isSafeSupportedChatUrl(value)) return new URL(value).origin
  return chatSiteOrigin(site)
}

export function extractGeminiConversationId(value: string | undefined): string | undefined {
  if (!isSafeGeminiUrl(value)) return undefined

  const url = new URL(value)
  if (!url.pathname.startsWith(GEMINI_APP_PREFIX)) return undefined

  const conversationId = url.pathname.slice(GEMINI_APP_PREFIX.length).split('/')[0]
  return conversationId ? decodeURIComponent(conversationId) : undefined
}

export function normalizeGeminiConversationUrl(value: string | undefined): string | undefined {
  return isSafeGeminiUrl(value) ? new URL(value).href : undefined
}

function parseSafeChatGptUrl(value: string | undefined): URL | undefined {
  if (!value || (!value.startsWith(CHATGPT_HOME_URL) && !value.startsWith('https://chat.openai.com/'))) return undefined

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && CHATGPT_HOSTS.has(url.hostname) ? url : undefined
  } catch {
    return undefined
  }
}

function parseSafeGrokUrl(value: string | undefined): URL | undefined {
  if (!value || !value.startsWith(GROK_HOME_URL)) return undefined

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'grok.com' ? url : undefined
  } catch {
    return undefined
  }
}

