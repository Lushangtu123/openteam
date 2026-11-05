import { describe, expect, it } from 'vitest'
import { CHAT_SITE_INFO, CHAT_SITES, chatSiteConversationId, chatSiteForHostname, chatSiteForUrl, chatSiteFromText, chatSiteLabel, isChatSite } from './chatSites'
import { extractSupportedConversationId, getDefaultChatSiteUrl, getSafeSupportedChatIframeSrcForSite, getSupportedChatOriginForSite, isSafeSupportedChatUrl } from './conversationUrl'

describe('chat site registry', () => {
  it('knows each site by id, host and label', () => {
    expect(CHAT_SITES).toEqual(['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'kimi'])
    expect(isChatSite('qwen')).toBe(true)
    expect(isChatSite('kimi')).toBe(true)
    expect(isChatSite('doubao')).toBe(false)
    expect(isChatSite(undefined)).toBe(false)
    expect(chatSiteForHostname('chat.qwen.ai')).toBe('qwen')
    expect(chatSiteForHostname('chat.openai.com')).toBe('chatgpt')
    expect(chatSiteForHostname('www.qianwen.com')).toBeUndefined()
    expect(chatSiteForHostname('www.kimi.com')).toBe('kimi')
    expect(chatSiteLabel('qwen')).toBe('Qwen')
    expect(chatSiteLabel(undefined)).toBe('Gemini')
  })

  it('accepts only https links on the exact hosts, without user info or ports', () => {
    expect(chatSiteForUrl('https://chat.qwen.ai/c/abc')).toBe('qwen')
    expect(chatSiteForUrl('https://chat.qwen.ai.evil.example/c/abc')).toBeUndefined()
    expect(chatSiteForUrl('https://evil.example/?next=https://chat.qwen.ai/')).toBeUndefined()
    expect(chatSiteForUrl('https://chat.qwen.ai@evil.example/')).toBeUndefined()
    expect(chatSiteForUrl('https://chat.qwen.ai:8443/')).toBeUndefined()
    expect(chatSiteForUrl('http://chat.qwen.ai/')).toBeUndefined()
    expect(chatSiteForUrl('javascript:alert(1)//https://chat.qwen.ai/')).toBeUndefined()
    for (const site of CHAT_SITES) expect(chatSiteForUrl(CHAT_SITE_INFO[site].homeUrl)).toBe(site)
  })

  it('reads conversation ids from every site\'s conversation links', () => {
    expect(chatSiteConversationId('https://chat.qwen.ai/c/baa37efc-84a7')).toBe('baa37efc-84a7')
    expect(chatSiteConversationId('https://chat.qwen.ai/')).toBeUndefined()
    expect(chatSiteConversationId('https://gemini.google.com/app/abc123')).toBe('abc123')
    expect(chatSiteConversationId('https://chatgpt.com/c/c-1')).toBe('c-1')
    expect(chatSiteConversationId('https://chatgpt.com/g/g-xyz-writer/c/c-2')).toBe('c-2')
    expect(chatSiteConversationId('https://claude.ai/chat/c-3')).toBe('c-3')
    expect(chatSiteConversationId('https://chat.deepseek.com/a/chat/s/c-4')).toBe('c-4')
    expect(chatSiteConversationId('https://grok.com/c/c-5')).toBe('c-5')
    expect(chatSiteConversationId('https://grok.com/chat/c-6')).toBe('c-6')
    expect(chatSiteConversationId('https://www.kimi.com/chat/d0ilaujof8jjl1c6u7vg?chat_enter_method=history')).toBe('d0ilaujof8jjl1c6u7vg')
  })

  it('opens Qwen people on chat.qwen.ai', () => {
    expect(getDefaultChatSiteUrl('qwen')).toBe('https://chat.qwen.ai/')
    expect(getSupportedChatOriginForSite(undefined, 'qwen')).toBe('https://chat.qwen.ai')
    expect(getSafeSupportedChatIframeSrcForSite('https://chat.qwen.ai/c/abc', 'qwen')).toBe('https://chat.qwen.ai/c/abc')
    expect(getSafeSupportedChatIframeSrcForSite('https://evil.example/', 'qwen')).toBe('https://chat.qwen.ai/')
    expect(isSafeSupportedChatUrl('https://chat.qwen.ai/c/abc')).toBe(true)
    expect(extractSupportedConversationId('https://chat.qwen.ai/c/abc')).toBe('abc')
  })

  it('reads a site from a planner\'s or a model\'s free-text name', () => {
    expect(chatSiteFromText('Qwen')).toBe('qwen')
    expect(chatSiteFromText('通义千问')).toBe('qwen')
    expect(chatSiteFromText('qwen3-max')).toBe('qwen')
    expect(chatSiteFromText('ChatGPT')).toBe('chatgpt')
    expect(chatSiteFromText('gpt')).toBe('chatgpt')
    expect(chatSiteFromText('Deep Seek')).toBe('deepseek')
    expect(chatSiteFromText('xAI')).toBe('grok')
    expect(chatSiteFromText('Google')).toBe('gemini')
    expect(chatSiteFromText('Moonshot Kimi')).toBe('kimi')
    expect(chatSiteFromText('月之暗面')).toBe('kimi')
    expect(chatSiteFromText('Mistral')).toBeUndefined()
    expect(chatSiteFromText('')).toBeUndefined()
    expect(chatSiteFromText(3)).toBeUndefined()
  })
})
