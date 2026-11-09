// What the user can change about a member in a chat: its name and its avatar (a preset colour, up to
// two characters, or a small picture). The rules live here so the store and the edit window agree.
import type { GroupChat, GroupRole, OpenTeamLanguage, OpenTeamStore } from './types'

export const ROLE_NAME_MAX_CHARACTERS = 50
export const ROLE_AVATAR_TONE_COUNT = 6
export const ROLE_AVATAR_TEXT_MAX_CHARACTERS = 2
// A picture is stored as a data: URL beside the member, so it stays small: the edit window shrinks it
// to a square of this size and keeps it under the length below.
export const ROLE_AVATAR_IMAGE_SIZE = 96
export const ROLE_AVATAR_IMAGE_MAX_LENGTH = 24_000

// @all and @所有人 reach everyone and @编排 starts orchestration: a member with one of these names could
// never be mentioned.
const RESERVED_ROLE_NAMES = ['all', '所有人', '编排', 'orchestration']
const AVATAR_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export type RoleNameProblem = 'empty' | 'too-long' | 'whitespace' | 'at' | 'reserved' | 'duplicate'
export type AvatarTextProblem = 'too-long' | 'whitespace'
export type RoleProfileProblem = RoleNameProblem | `avatar-text-${AvatarTextProblem}` | 'avatar-color' | 'avatar-image'

export interface RoleProfilePatch {
  name?: string
  // An empty string clears the field, so the avatar goes back to the name's first character.
  avatarText?: string
  // One of the preset colours, as tone-0 … tone-5.
  avatarColor?: string
  avatarImage?: string
}

export interface RoleAvatarSource {
  name: string
  avatarColor?: string
  avatarText?: string
  avatarImage?: string
}

interface GraphemeSegmenter {
  segment(value: string): Iterable<{ segment: string }>
}

interface IntlWithSegmenter {
  Segmenter?: new (locale: string | undefined, options: { granularity: 'grapheme' }) => GraphemeSegmenter
}

export function countUserPerceivedCharacters(value: string): number {
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  if (!Segmenter) return [...value].length
  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
}

export function isReservedRoleName(name: string): boolean {
  return RESERVED_ROLE_NAMES.includes(name.trim().toLowerCase())
}

// Names are compared without case. The other names are the chat's other members.
export function roleNameProblem(name: string, otherNames: string[] = []): RoleNameProblem | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (countUserPerceivedCharacters(trimmed) > ROLE_NAME_MAX_CHARACTERS) return 'too-long'
  if (/\s/.test(trimmed)) return 'whitespace'
  if (trimmed.includes('@')) return 'at'
  if (isReservedRoleName(trimmed)) return 'reserved'
  const key = trimmed.toLowerCase()
  if (otherNames.some(other => other.trim().toLowerCase() === key)) return 'duplicate'
  return undefined
}

export function avatarTextProblem(text: string): AvatarTextProblem | undefined {
  const trimmed = text.trim()
  if (/\s/.test(trimmed)) return 'whitespace'
  if (countUserPerceivedCharacters(trimmed) > ROLE_AVATAR_TEXT_MAX_CHARACTERS) return 'too-long'
  return undefined
}

export function avatarToneKey(index: number): string {
  return `tone-${index}`
}

export function readAvatarTone(value: string | undefined): number | undefined {
  const match = value?.trim().match(/^tone-(\d)$/)
  if (!match) return undefined
  const index = Number(match[1])
  return index < ROLE_AVATAR_TONE_COUNT ? index : undefined
}

// The colour a name gets when the user has not picked one.
export function avatarToneForSeed(seed: string | undefined): number {
  const source = seed || 'OpenTeam'
  let hash = 0
  for (let index = 0; index < source.length; index += 1) hash = (hash + source.charCodeAt(index) * (index + 1)) % ROLE_AVATAR_TONE_COUNT
  return hash
}

export function roleAvatarTone(role: RoleAvatarSource): number {
  return readAvatarTone(role.avatarColor) ?? avatarToneForSeed(role.name)
}

// Only a small PNG, JPEG or WebP picture held in the store itself: never a link to somewhere else, which
// would load from another site, and never SVG.
export function isStorableAvatarImage(value: string | undefined): value is string {
  return typeof value === 'string' && value.length <= ROLE_AVATAR_IMAGE_MAX_LENGTH && AVATAR_IMAGE_PATTERN.test(value)
}

// Stored values read back from storage, a backup or a saved team: anything that breaks the rules is dropped.
export function readStoredAvatar(value: { avatarColor?: unknown; avatarText?: unknown; avatarImage?: unknown }): Pick<RoleAvatarSource, 'avatarColor' | 'avatarText' | 'avatarImage'> {
  const avatar: Pick<RoleAvatarSource, 'avatarColor' | 'avatarText' | 'avatarImage'> = {}
  if (typeof value.avatarColor === 'string' && readAvatarTone(value.avatarColor) !== undefined) avatar.avatarColor = value.avatarColor.trim()
  if (typeof value.avatarText === 'string' && value.avatarText.trim() && !avatarTextProblem(value.avatarText)) avatar.avatarText = value.avatarText.trim()
  if (typeof value.avatarImage === 'string' && isStorableAvatarImage(value.avatarImage)) avatar.avatarImage = value.avatarImage
  return avatar
}

export function describeRoleProfileProblem(problem: RoleProfileProblem, languageInput: OpenTeamLanguage | undefined, name = ''): string {
  const en = languageInput === 'en'
  switch (problem) {
    case 'empty': return en ? 'Give the member a name' : '名字不能为空'
    case 'too-long': return en ? `Names are at most ${ROLE_NAME_MAX_CHARACTERS} characters` : `名字最多 ${ROLE_NAME_MAX_CHARACTERS} 个字`
    case 'whitespace': return en ? 'Names cannot contain spaces' : '名字不能包含空格'
    case 'at': return en ? 'Names cannot contain @' : '名字不能包含 @'
    case 'reserved': return en ? `"${name.trim()}" is used to mention everyone or orchestration; choose another name` : `「${name.trim()}」用来 @ 所有人或编排，请换一个名字`
    case 'duplicate': return en ? `Another member here is already called "${name.trim()}"` : `这个群里已经有叫「${name.trim()}」的成员`
    case 'avatar-text-too-long': return en ? `Avatar text is at most ${ROLE_AVATAR_TEXT_MAX_CHARACTERS} characters` : `头像文字最多 ${ROLE_AVATAR_TEXT_MAX_CHARACTERS} 个字`
    case 'avatar-text-whitespace': return en ? 'Avatar text cannot contain spaces' : '头像文字不能包含空格'
    case 'avatar-color': return en ? 'Choose one of the colours' : '请选择一个预设颜色'
    case 'avatar-image': return en ? 'The picture could not be saved; choose another' : '图片无法保存，请换一张'
  }
}

// A member the user named keeps its name in a team, so its position is shown beside the name.
export function rolePositionBesideName(role: Pick<GroupRole, 'name' | 'userNamed' | 'teamPosition'>): string | undefined {
  return role.userNamed && role.teamPosition && role.teamPosition !== role.name ? role.teamPosition : undefined
}

export function chatRoleNames(store: OpenTeamStore, chat: GroupChat, exceptRoleId?: string): string[] {
  return chat.roleIds
    .filter(roleId => roleId !== exceptRoleId)
    .map(roleId => store.rolesById[roleId]?.name)
    .filter((name): name is string => Boolean(name))
}

// The user's own edit. Everything is checked before anything changes. A new name is kept from then on:
// confirming a team does not replace it with the member's position.
export function updateGroupRoleProfile(store: OpenTeamStore, roleId: string, patch: RoleProfilePatch, now: number): GroupRole {
  const role = store.rolesById[roleId]
  if (!role) throw new Error(`找不到人员：${roleId}`)
  const chat = store.chatsById[role.chatId]
  if (!chat) throw new Error(`找不到群聊：${role.chatId}`)

  const name = patch.name?.trim()
  if (name !== undefined) {
    const problem = roleNameProblem(name, chatRoleNames(store, chat, role.id))
    if (problem) throw new Error(describeRoleProfileProblem(problem, 'zh-CN', name))
  }
  const avatarText = patch.avatarText?.trim()
  if (avatarText) {
    const problem = avatarTextProblem(avatarText)
    if (problem) throw new Error(describeRoleProfileProblem(`avatar-text-${problem}`, 'zh-CN'))
  }
  const avatarColor = patch.avatarColor?.trim()
  if (avatarColor && readAvatarTone(avatarColor) === undefined) throw new Error(describeRoleProfileProblem('avatar-color', 'zh-CN'))
  const avatarImage = patch.avatarImage?.trim()
  if (avatarImage && !isStorableAvatarImage(avatarImage)) throw new Error(describeRoleProfileProblem('avatar-image', 'zh-CN'))

  if (name !== undefined && name !== role.name) {
    role.name = name
    role.userNamed = true
    renameRoleInMessages(store, chat, role.id, name)
  }
  setOptional(role, 'avatarText', avatarText)
  setOptional(role, 'avatarColor', avatarColor)
  setOptional(role, 'avatarImage', avatarImage)
  role.updatedAt = now
  chat.updatedAt = now
  return role
}

// A member has one name: what it said before is shown, searched, exported and passed to the others under
// the name it has now, as with a nickname in a group chat.
export function renameRoleInMessages(store: OpenTeamStore, chat: GroupChat, roleId: string, name: string): void {
  for (const messageId of chat.messageIds) {
    const message = store.messagesById[messageId]
    if (!message) continue
    if (message.roleId === roleId && message.roleName !== undefined) message.roleName = name
    for (const reference of message.references ?? []) {
      if (reference.roleId === roleId && reference.roleName !== undefined) reference.roleName = name
    }
  }
}

function setOptional(role: GroupRole, key: 'avatarText' | 'avatarColor' | 'avatarImage', value: string | undefined): void {
  if (value === undefined) return
  if (value) {
    role[key] = value
  } else {
    delete role[key]
  }
}
