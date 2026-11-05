import { ROLE_FRAME_MESSAGE_TYPES } from './senderPolicy'

// Test helper: deliver a runtime message from the context that really sends it.
// Role-frame messages come from AI-site frames embedded in team.html; everything
// else comes from the team page itself.
const TEST_EXTENSION_ORIGIN = 'chrome-extension://test'
const TEST_TEAM_PAGE_URL = `${TEST_EXTENSION_ORIGIN}/team.html`

export function senderForMessage(message: { type?: unknown }, sender: chrome.runtime.MessageSender): chrome.runtime.MessageSender {
  if (typeof message.type === 'string' && ROLE_FRAME_MESSAGE_TYPES.has(message.type)) {
    return { ...sender, tab: { url: TEST_TEAM_PAGE_URL, ...sender.tab } as chrome.tabs.Tab }
  }
  return { ...sender, url: TEST_TEAM_PAGE_URL, origin: TEST_EXTENSION_ORIGIN }
}
