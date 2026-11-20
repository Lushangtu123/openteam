import type { RuntimeMessage } from './runtimeClient'
import { UNKNOWN_MESSAGE_ERROR } from '../shared/connectionErrors'

export type BackgroundMessageHandler = (message: RuntimeMessage, sender: chrome.runtime.MessageSender) => unknown | Promise<unknown>

export interface BackgroundMessageRoute {
  type: string
  handler: BackgroundMessageHandler
}

export type BackgroundMessageFallback = BackgroundMessageHandler

export function createMessageRouter(routes: BackgroundMessageRoute[], fallback: BackgroundMessageFallback = defaultFallback): BackgroundMessageHandler {
  const handlers = new Map(routes.map(route => [route.type, route.handler]))

  return (message, sender) => {
    const handler = typeof message.type === 'string' ? handlers.get(message.type) : undefined
    return (handler ?? fallback)(message, sender)
  }
}

function defaultFallback(): { ok: false; error: string } {
  return { ok: false, error: UNKNOWN_MESSAGE_ERROR }
}
