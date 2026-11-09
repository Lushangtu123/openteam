import type { GroupChat, GroupMessage, OpenTeamStore } from '../group/types'
import { avatarToneForSeed, isStorableAvatarImage, roleAvatarTone, type RoleAvatarSource } from '../group/roleProfile'
import { getAvatarInitial } from './chatExperience'

export function emptyCard(title: string, body: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'empty-state'
  const card = document.createElement('div')
  card.className = 'empty-card'
  const heading = document.createElement('h3')
  heading.textContent = title
  const paragraph = document.createElement('p')
  paragraph.className = 'muted'
  paragraph.textContent = body
  card.append(heading, paragraph)
  wrapper.append(card)
  return wrapper
}

export function roleToneClass(seed: string | undefined): string {
  return `role-tone-${avatarToneForSeed(seed)}`
}

export function roleAvatarLabel(name: string | undefined): string {
  return getAvatarInitial(name)
}

// Changes when the member's avatar changes, for cached message rows. A picture is long, so its length
// and last characters stand for it.
export function roleAvatarSignature(role: RoleAvatarSource | undefined): string {
  if (!role) return ''
  const image = role.avatarImage ? `${role.avatarImage.length}:${role.avatarImage.slice(-32)}` : ''
  return `${role.avatarColor ?? ''}|${role.avatarText ?? ''}|${image}`
}

// Draws a member's avatar into the element: the picture the user chose, or the avatar text (the name's
// first character unless the user set one) on the member's colour. Without a member (one that has left)
// it draws the fallback name's first character on that name's colour.
export function paintRoleAvatar(element: HTMLElement, baseClass: string, role: RoleAvatarSource | undefined, fallbackName?: string): void {
  const source: RoleAvatarSource = role ?? { name: fallbackName ?? '' }
  if (isStorableAvatarImage(source.avatarImage)) {
    element.className = `${baseClass} has-avatar-image`
    const image = document.createElement('img')
    image.className = 'avatar-image'
    image.src = source.avatarImage
    image.alt = ''
    image.draggable = false
    element.replaceChildren(image)
    return
  }
  element.className = `${baseClass} role-tone-${roleAvatarTone(source)}`
  const text = source.avatarText?.trim()
  if (text && [...text].length > 1) {
    // Two characters, a little smaller so they fit the circle.
    const pair = document.createElement('span')
    pair.className = 'avatar-text-pair'
    pair.textContent = text
    element.replaceChildren(pair)
    return
  }
  element.textContent = text || getAvatarInitial(source.name)
}

export function getChatRecentSummary(chat: GroupChat, store: OpenTeamStore): string {
  const lastMessageId = chat.messageIds[chat.messageIds.length - 1]
  const message = lastMessageId ? store.messagesById[lastMessageId] : undefined
  if (!message) return '暂无消息。可恢复聊天、添加成员或发送第一条任务。'
  return `${messageTitle(message)}：${truncate(plainPreview(message.content), 72)}`
}

// A reply's text without Markdown marks (bold, headings, list bullets), on one line.
export function plainPreview(content: string): string {
  return content
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s?)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function messageTitle(message: GroupMessage): string {
  if (message.type === 'user') return '我'
  if (message.type === 'assistant') return message.roleName || 'AI 成员'
  return '系统'
}

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}
