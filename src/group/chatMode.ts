// A group's mode changed after it was made: 独立专家 (each member answers on its own) ⇄ 协作群聊
// (members read one another). Not while members are answering. A group made 协作 does not share what
// was said before: sharedFromSeq marks where its shared context starts, and earlier messages reach a
// member only if they were its own or sent to it (src/group/contextSync.ts, externalModelContext.ts).
import { isDiscussionRunning } from './discussion'
import { isProjectActive } from './project'
import type { GroupChat, GroupMessage, OpenTeamStore, RoomMode } from './types'

export function isRoomMode(value: unknown): value is RoomMode {
  return value === 'independent' || value === 'collaborative'
}

// Why the mode cannot change now, or undefined.
export function chatModeSwitchBlocker(store: OpenTeamStore, chat: GroupChat): string | undefined {
  const answering = chat.roleIds.some(roleId => store.rolesById[roleId]?.status === 'thinking')
  if (answering || isDiscussionRunning(chat)) return '成员还在回答，等这一轮结束再切换模式'
  if (store.activeOrchestrationRunIdByChatId?.[chat.id]) return '编排还在进行，结束后再切换模式'
  if (isProjectActive(chat.project)) return '项目还在进行，结束后再切换模式'
  return undefined
}

// Changes the mode; throws why it cannot. False when it already was that mode.
export function switchChatMode(store: OpenTeamStore, chat: GroupChat, mode: RoomMode): boolean {
  if (chat.mode === mode) return false
  const blocker = chatModeSwitchBlocker(store, chat)
  if (blocker) throw new Error(blocker)
  chat.mode = mode
  if (mode === 'collaborative') chat.sharedFromSeq = Math.max(0, chat.nextMessageSeq - 1)
  else delete chat.sharedFromSeq
  return true
}

// Whether a message is shared context for a member: anything since the group became 协作, and
// before that only its own messages and those sent to it.
export function sharedWithRole(chat: GroupChat, roleId: string, message: GroupMessage): boolean {
  if (message.seq > (chat.sharedFromSeq ?? 0)) return true
  return message.roleId === roleId || Boolean(message.targetRoleIds?.includes(roleId))
}
