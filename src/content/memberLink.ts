// A member's AI page held by OpenTeam in the side panel. Chrome reaches a page inside a frame
// through its tab, and the side panel is no tab, so this page links to the background over a port
// (MEMBER_PORT_NAME) and both ways go over it: what it reports, and what it is asked to do (send a
// prompt, stop, read the reply again), each with its answer. See src/background/memberPorts.ts.
// The OpenTeam page says to link this way when it assigns the page its member (frameHandshake.ts).
import type { RoleToBackgroundMessage } from '../group/runtimeProtocol'

// How soon the link is made again after the background stopped (connecting wakes it).
export const MEMBER_LINK_RECONNECT_MS = 500
const RESTARTED_ERROR = 'OpenTeam 的后台重新启动了'

interface LinkPort {
  postMessage(message: unknown): void
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

export interface MemberLinkDependencies {
  connect(): LinkPort
  // The page's handlers for what the background sends, as for chrome.runtime.onMessage: true when
  // the answer comes later through respond.
  dispatch(message: unknown, respond: (response?: unknown) => void): boolean
  // Linked again after the background restarted: the page tells it which member it is again.
  onRelinked(): void
}

export interface MemberLink {
  // Links; resolves once the background has the link.
  start(): Promise<void>
  active(): boolean
  send<T>(message: RoleToBackgroundMessage): Promise<T>
}

export function createMemberLink(deps: MemberLinkDependencies): MemberLink {
  let port: LinkPort | undefined
  let started = false
  let nextId = 1
  let linked: Promise<void> = Promise.resolve()
  const pending = new Map<number, { resolve(response: unknown): void; reject(error: Error): void }>()

  function open(again: boolean): Promise<void> {
    return new Promise(resolveLinked => {
      const current = deps.connect()
      port = current
      current.onMessage.addListener(raw => {
        if (!isRecord(raw)) return
        if (raw.type === 'linked') {
          resolveLinked()
          if (again) deps.onRelinked()
          return
        }
        if (typeof raw.replyTo === 'number') {
          const waiting = pending.get(raw.replyTo)
          pending.delete(raw.replyTo)
          waiting?.resolve(raw.response)
          return
        }
        if (typeof raw.id !== 'number') return
        const id = raw.id
        let answered = false
        const respond = (response?: unknown) => {
          if (answered) return
          answered = true
          try {
            current.postMessage({ replyTo: id, response })
          } catch {
            // The link closed meanwhile.
          }
        }
        if (!deps.dispatch(raw.message, respond)) respond(undefined)
      })
      current.onDisconnect.addListener(() => {
        if (port !== current) return
        port = undefined
        for (const waiting of pending.values()) waiting.reject(new Error(RESTARTED_ERROR))
        pending.clear()
        setTimeout(() => {
          linked = open(true)
        }, MEMBER_LINK_RECONNECT_MS)
      })
    })
  }

  return {
    start() {
      if (!started) {
        started = true
        linked = open(false)
      }
      return linked
    },
    active: () => started,
    async send<T>(message: RoleToBackgroundMessage): Promise<T> {
      await linked
      const current = port
      if (!current) throw new Error(RESTARTED_ERROR)
      const id = nextId
      nextId += 1
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: response => resolve(response as T), reject })
        try {
          current.postMessage({ id, message })
        } catch {
          pending.delete(id)
          reject(new Error(RESTARTED_ERROR))
        }
      })
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
