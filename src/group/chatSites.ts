// Every AI chat site OpenTeam can open in a frame and talk to. Adding a site takes an entry here, an
// adapter in src/content/sites/, and its hosts in public/manifest.json and
// public/openteam-frame-rules.json (src/extensionConfig.test.ts checks those files against this list).
export const CHAT_SITES = ['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'kimi'] as const

export type ChatSite = typeof CHAT_SITES[number]

export interface ChatSiteInfo {
  label: string
  // Hosts the site's chat pages are served from.
  hosts: readonly string[]
  // Where a new conversation starts.
  homeUrl: string
  // A conversation page's path, capturing the conversation id.
  conversationPath: RegExp
  // About how many prompt characters the site's model takes in.
  contextChars: number
  // Words that name the site in an orchestration plan or an API model's name (lower case, no spaces).
  aliases: readonly string[]
}

export const CHAT_SITE_INFO: Readonly<Record<ChatSite, ChatSiteInfo>> = {
  gemini: {
    label: 'Gemini',
    hosts: ['gemini.google.com'],
    homeUrl: 'https://gemini.google.com/',
    conversationPath: /^\/app\/([^/]+)/,
    contextChars: 1_000_000,
    aliases: ['gemini', 'google'],
  },
  chatgpt: {
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    homeUrl: 'https://chatgpt.com/',
    conversationPath: /^\/(?:g\/[^/]+\/)?c\/([^/]+)/,
    contextChars: 272_000,
    aliases: ['chatgpt', 'gpt', 'openai'],
  },
  claude: {
    label: 'Claude',
    hosts: ['claude.ai'],
    homeUrl: 'https://claude.ai/new',
    conversationPath: /^\/chat\/([^/]+)/,
    contextChars: 500_000,
    aliases: ['claude', 'anthropic'],
  },
  deepseek: {
    label: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    homeUrl: 'https://chat.deepseek.com/',
    conversationPath: /^\/a\/chat\/s\/([^/]+)/,
    contextChars: 1_000_000,
    aliases: ['deepseek'],
  },
  grok: {
    label: 'Grok',
    hosts: ['grok.com'],
    homeUrl: 'https://grok.com/',
    conversationPath: /^\/(?:chat|c)\/([^/]+)/,
    contextChars: 256_000,
    aliases: ['grok', 'xai'],
  },
  qwen: {
    label: 'Qwen',
    hosts: ['chat.qwen.ai'],
    homeUrl: 'https://chat.qwen.ai/',
    conversationPath: /^\/c\/([^/]+)/,
    contextChars: 256_000,
    aliases: ['qwen', 'tongyi', 'alibaba', 'aliyun', '通义', '千问'],
  },
  kimi: {
    label: 'Kimi',
    hosts: ['www.kimi.com'],
    homeUrl: 'https://www.kimi.com/',
    conversationPath: /^\/chat\/([^/]+)/,
    // Prompts are pasted 1,000 characters at a time, so very long ones take a while to type in.
    contextChars: 128_000,
    aliases: ['kimi', 'moonshot', '月之暗面'],
  },
}

export const DEFAULT_FALLBACK_CHAT_SITE: ChatSite = 'gemini'

export function isChatSite(value: unknown): value is ChatSite {
  return typeof value === 'string' && (CHAT_SITES as readonly string[]).includes(value)
}

export function chatSiteLabel(site: ChatSite | undefined): string {
  return CHAT_SITE_INFO[site ?? DEFAULT_FALLBACK_CHAT_SITE].label
}

export function chatSiteOrigin(site: ChatSite | undefined): string {
  return `https://${CHAT_SITE_INFO[site ?? DEFAULT_FALLBACK_CHAT_SITE].hosts[0]}`
}

export function chatSiteForHostname(hostname: string): ChatSite | undefined {
  return CHAT_SITES.find(site => CHAT_SITE_INFO[site].hosts.includes(hostname))
}

// The site a supported chat page URL belongs to. Only https URLs on a site's exact hosts count, and
// the URL must start with the plain origin, so user info or a port cannot slip in a lookalike.
export function chatSiteForUrl(value: string | undefined): ChatSite | undefined {
  if (!value) return undefined
  const site = CHAT_SITES.find(candidate => CHAT_SITE_INFO[candidate].hosts.some(host => value.startsWith(`https://${host}/`)))
  if (!site) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && CHAT_SITE_INFO[site].hosts.includes(url.hostname) ? site : undefined
  } catch {
    return undefined
  }
}

export function chatSiteConversationId(value: string | undefined): string | undefined {
  const site = chatSiteForUrl(value)
  if (!site) return undefined
  const conversationId = new URL(value!).pathname.match(CHAT_SITE_INFO[site].conversationPath)?.[1]
  return conversationId ? decodeURIComponent(conversationId) : undefined
}

// Reads a site from free text such as "Qwen", "通义千问" or "gpt-4o".
export function chatSiteFromText(value: unknown): ChatSite | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!normalized) return undefined
  if (isChatSite(normalized)) return normalized
  return CHAT_SITES.find(site => CHAT_SITE_INFO[site].aliases.some(alias => aliasMatches(normalized, alias)))
}

// Short Latin aliases ("gpt", "xai") must be the whole text; longer ones may appear anywhere in it.
function aliasMatches(text: string, alias: string): boolean {
  return /^[a-z]{1,3}$/.test(alias) ? text === alias : text.includes(alias)
}
