// Members' AI pages held by OpenTeam in the side panel. A page in a frame is reached through its
// tab (chrome.tabs.sendMessage), and the side panel is no tab, so such a page opens a port instead
// (src/content/memberLink.ts) and both ways go over it. Each port gets an address of its own: a
// "tab" number no real tab can have (real ones are never negative), with frame 0. The rest of the
// background keeps addressing member pages by tab and frame; sending to such a number goes over
// the port, and a closed port is handled like a closed tab.
import type { BackgroundToRoleMessage, RoleToBackgroundMessage } from '../group/runtimeProtocol'

// The first address given out; each next port gets one lower.
const FIRST_MEMBER_PORT_TAB_ID = -1000

// The wording Chrome uses when a tab's page is gone, so the existing handling applies.
export const MEMBER_PORT_GONE_ERROR = 'Could not establish connection. Receiving end does not exist.'

export function isMemberPortTabId(tabId: number): boolean {
  return Number.isInteger(tabId) && tabId <= FIRST_MEMBER_PORT_TAB_ID
}

interface MemberPort {
  port: chrome.runtime.Port
  pending: Map<number, { resolve(response: unknown): void; reject(error: Error): void }>
}

export interface MemberPortsDependencies {
  // OpenTeam in the side panel: what the page's messages count as coming from (a frame of it).
  panelPageUrl: string
  // A page of an AI site OpenTeam uses; ports from anywhere else are refused.
  isMemberPageUrl(url: string): boolean
  // Handles a message from a member page, as runtime messages from frames in an OpenTeam tab are.
  handle(message: RoleToBackgroundMessage, sender: chrome.runtime.MessageSender): Promise<unknown>
  // A port closed: its page is gone (it reloaded, or the panel closed).
  onGone(tabId: number): void
}

export function createMemberPorts(deps: MemberPortsDependencies) {
  const byTabId = new Map<number, MemberPort>()
  let nextTabId = FIRST_MEMBER_PORT_TAB_ID
  let nextRequestId = 1

  function connect(port: chrome.runtime.Port): void {
    const url = port.sender?.url ?? ''
    if (!deps.isMemberPageUrl(url)) {
      port.disconnect()
      return
    }
    const tabId = nextTabId
    nextTabId -= 1
    const member: MemberPort = { port, pending: new Map() }
    byTabId.set(tabId, member)
    const sender: chrome.runtime.MessageSender = {
      tab: { id: tabId, url: deps.panelPageUrl } as chrome.tabs.Tab,
      frameId: 0,
      url,
      ...(port.sender?.origin ? { origin: port.sender.origin } : {}),
      ...(port.sender?.documentId ? { documentId: port.sender.documentId } : {}),
    }

    port.onMessage.addListener((raw: unknown) => {
      if (!isRecord(raw)) return
      if (typeof raw.replyTo === 'number') {
        const waiting = member.pending.get(raw.replyTo)
        member.pending.delete(raw.replyTo)
        waiting?.resolve(raw.response)
        return
      }
      if (typeof raw.id !== 'number' || !isRecord(raw.message)) return
      const id = raw.id
      deps.handle(raw.message as RoleToBackgroundMessage, sender)
        .then(response => response, (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        .then(response => {
          try {
            port.postMessage({ replyTo: id, response })
          } catch {
            // The page went away meanwhile.
          }
        })
    })
    port.onDisconnect.addListener(() => {
      byTabId.delete(tabId)
      for (const waiting of member.pending.values()) waiting.reject(new Error(MEMBER_PORT_GONE_ERROR))
      member.pending.clear()
      deps.onGone(tabId)
    })
    port.postMessage({ type: 'linked', tabId })
  }

  // Like chrome.tabs.sendMessage to the page's frame: resolves with its answer.
  function send(tabId: number, message: BackgroundToRoleMessage): Promise<unknown> {
    const member = byTabId.get(tabId)
    if (!member) return Promise.reject(new Error(MEMBER_PORT_GONE_ERROR))
    const id = nextRequestId
    nextRequestId += 1
    return new Promise((resolve, reject) => {
      member.pending.set(id, { resolve, reject })
      try {
        member.port.postMessage({ id, message })
      } catch {
        member.pending.delete(id)
        reject(new Error(MEMBER_PORT_GONE_ERROR))
      }
    })
  }

  return { connect, send }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
