import { chatSiteForHostname, type ChatSite } from '../../group/chatSites'
import { createClaudeAdapter } from './claude'
import { createChatGptAdapter } from './chatgpt'
import { createDeepSeekAdapter } from './deepseek'
import { createGeminiAdapter } from './gemini'
import { createGrokAdapter } from './grok'
import { createKimiAdapter } from './kimi'
import { createQwenAdapter } from './qwen'
import type { ChatSiteAdapter } from './types'

// One adapter per site in the registry; a site without one does not compile.
const ADAPTERS: Record<ChatSite, () => ChatSiteAdapter> = {
  gemini: createGeminiAdapter,
  chatgpt: createChatGptAdapter,
  claude: createClaudeAdapter,
  deepseek: createDeepSeekAdapter,
  grok: createGrokAdapter,
  qwen: createQwenAdapter,
  kimi: createKimiAdapter,
}

export function getActiveChatSiteAdapter(): ChatSiteAdapter {
  return ADAPTERS[chatSiteForHostname(location.hostname) ?? 'gemini']()
}
