import { describe, expect, it } from 'vitest'
import { classifyRuntimeSender, isRuntimeMessageAllowed, responseForSender } from './senderPolicy'

const ORIGIN = 'chrome-extension://cnccbifloajlkjglmiojkpimjciamlpe'
const teamPage = { id: 'ext', url: `${ORIGIN}/team.html`, origin: ORIGIN, tab: { id: 7, url: `${ORIGIN}/team.html` } } as chrome.runtime.MessageSender
const teamPageFrame = { id: 'ext', url: 'https://chatgpt.com/c/1', origin: 'https://chatgpt.com', frameId: 3, tab: { id: 7, url: `${ORIGIN}/team.html` } } as chrome.runtime.MessageSender
const framedByWebsite = { id: 'ext', url: 'https://chatgpt.com/', origin: 'https://chatgpt.com', frameId: 3, tab: { id: 9, url: 'https://evil.example/' } } as chrome.runtime.MessageSender
const topLevelAiTab = { id: 'ext', url: 'https://chatgpt.com/', origin: 'https://chatgpt.com', frameId: 0, tab: { id: 9, url: 'https://chatgpt.com/' } } as chrome.runtime.MessageSender

describe('runtime sender policy', () => {
  it('classifies extension pages, team page frames and everything else', () => {
    expect(classifyRuntimeSender(teamPage, ORIGIN)).toBe('extension-page')
    expect(classifyRuntimeSender(teamPageFrame, ORIGIN)).toBe('team-page-frame')
    expect(classifyRuntimeSender(framedByWebsite, ORIGIN)).toBe('untrusted')
    expect(classifyRuntimeSender(topLevelAiTab, ORIGIN)).toBe('untrusted')
    expect(classifyRuntimeSender({ url: `${ORIGIN}.evil.example/team.html` } as chrome.runtime.MessageSender, ORIGIN)).toBe('untrusted')
  })

  it('lets team page frames send only role-frame messages', () => {
    expect(isRuntimeMessageAllowed('TEAM_ROLE_REPLY', 'team-page-frame')).toBe(true)
    expect(isRuntimeMessageAllowed('TEAM_FRAME_ROLE_READY', 'team-page-frame')).toBe(true)
    expect(isRuntimeMessageAllowed('GROUP_STORE_GET', 'team-page-frame')).toBe(false)
    expect(isRuntimeMessageAllowed('GROUP_SETTINGS_UPDATE', 'team-page-frame')).toBe(false)
    expect(isRuntimeMessageAllowed('TEAM_ROLE_REPLY', 'untrusted')).toBe(false)
    expect(isRuntimeMessageAllowed('GROUP_STORE_GET', 'extension-page')).toBe(true)
  })

  it('removes the store from responses sent to content scripts', () => {
    const response = { ok: true, role: { id: 'r1' }, store: { settings: { externalModelsById: { m: { apiKey: 'secret' } } } } }

    expect(responseForSender(response, 'team-page-frame')).toEqual({ ok: true, role: { id: 'r1' } })
    expect(responseForSender(response, 'extension-page')).toBe(response)
    expect(responseForSender(undefined, 'team-page-frame')).toBeUndefined()
  })
})
