import type { GroupMessage } from './types'

// A user message's status, from where each member it went to stands.
export function updateUserMessageDeliveryStatus(message: GroupMessage): void {
  const statuses = Object.values(message.deliveryStatus ?? {})
  if (statuses.length === 0) return
  if (statuses.every(status => status === 'error')) {
    message.status = 'error'
    return
  }
  if (statuses.every(status => status === 'received' || status === 'error')) {
    message.status = 'received'
    return
  }
  if (statuses.every(status => status === 'sent' || status === 'received' || status === 'error')) {
    message.status = 'sent'
    return
  }
  message.status = 'pending'
}
