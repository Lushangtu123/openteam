// 让 AI 按任务挑 learns from how members did: for each role (a library role by its id, any other by
// its name) on each model, how many finished replies it gave across the groups, how many of them the
// user kept (quoted, marked, remembered, saved to the library, or adopted as a decision) and how
// many the user asked again (重新回复 on a finished reply, counted on the member: role.redoneReplies).
// Only names, models and counts reach the planner (memberPicker.ts); no reply text does.
import { memberPickModelKey, type MemberPickModel } from './memberPicker'
import { getRoleTemplateById } from './roleTemplates'
import type { GroupMessage, GroupRole, OpenTeamStore } from './types'

export interface MemberRecord {
  key: string
  name: string
  templateId?: string
  // "site:kimi" or "external:<model id>", as memberPickModelKey gives it.
  model: string
  replies: number
  kept: number
  redone: number
}

// Fewer replies than this say little; the planner is not told about them.
export const MEMBER_RECORD_MIN_REPLIES = 3
const MEMBER_RECORD_LINES_MAX = 15

export function memberRecords(store: OpenTeamStore): MemberRecord[] {
  const kept = keptReplyIds(store)
  const records = new Map<string, MemberRecord>()
  const recordOf = (who: { templateId?: string; name: string }, model: string): MemberRecord => {
    const key = recordKey(who, model)
    let record = records.get(key)
    if (!record) {
      const templateName = who.templateId ? getRoleTemplateById(store, who.templateId)?.name : undefined
      record = { key, name: templateName ?? who.name, ...(who.templateId ? { templateId: who.templateId } : {}), model, replies: 0, kept: 0, redone: 0 }
      records.set(key, record)
    }
    return record
  }
  for (const chatId of store.chatOrder) {
    const chat = store.chatsById[chatId]
    if (!chat) continue
    for (const id of chat.messageIds) {
      const message = store.messagesById[id]
      if (!message || message.type !== 'assistant' || message.status !== 'received' || !message.roleId || !message.content.trim()) continue
      const role = store.rolesById[message.roleId] as GroupRole | undefined
      const model = replyModel(store, message, role)
      const name = role?.name ?? message.roleName
      if (!model || !name) continue
      const record = recordOf({ ...(role?.templateId ? { templateId: role.templateId } : {}), name }, model)
      record.replies += 1
      if (kept.has(message.id)) record.kept += 1
    }
  }
  for (const role of Object.values(store.rolesById)) {
    if (!role.redoneReplies) continue
    recordOf(role, memberPickModelKey(role, store.settings.defaultChatSite)).redone += role.redoneReplies
  }
  return [...records.values()]
}

// The record of a role (a pick, a member) on a model.
export function recordFor(records: MemberRecord[], who: { templateId?: string; name: string; model: string }): MemberRecord | undefined {
  const key = recordKey(who, who.model)
  return records.find(record => record.key === key)
}

// The line under a pick in the window.
export function recordText(record: MemberRecord, english: boolean): string {
  if (english) return `${record.replies} replies before, ${record.kept} of them kept${record.redone ? `, ${record.redone} asked again` : ''}`
  return `过去 ${record.replies} 次回答，你留用了 ${record.kept} 次${record.redone ? `，重答 ${record.redone} 次` : ''}`
}

// What the planner is told: the roles with enough replies on the models it may give, most replies first.
export function memberRecordLines(records: MemberRecord[], models: MemberPickModel[], english: boolean): string[] {
  const labels = new Map(models.map(model => [model.key, model.label]))
  return records
    .filter(record => labels.has(record.model) && record.replies >= MEMBER_RECORD_MIN_REPLIES)
    .sort((left, right) => right.replies - left.replies || right.kept - left.kept)
    .slice(0, MEMBER_RECORD_LINES_MAX)
    .map(record => {
      const label = labels.get(record.model)!
      if (english) return `- ${record.name}${record.templateId ? ` (library id=${record.templateId})` : ''} · ${label}: ${record.replies} replies, ${record.kept} kept${record.redone ? `, ${record.redone} asked again` : ''}`
      return `- ${record.name}${record.templateId ? `（角色库 id=${record.templateId}）` : ' '}· ${label}：${record.replies} 次回答，留用 ${record.kept} 次${record.redone ? `，重答 ${record.redone} 次` : ''}`
    })
}

function recordKey(who: { templateId?: string; name: string }, model: string): string {
  return who.templateId ? `template:${who.templateId}|${model}` : `name:${who.name.trim().toLowerCase()}|${model}`
}

// The model that wrote a reply: the API model on it, else the member's site. A web member's reply
// its backup model wrote is not the site's, and is left out.
function replyModel(store: OpenTeamStore, message: GroupMessage, role: GroupRole | undefined): string | undefined {
  const web = role ? role.modelSource !== 'external' : !message.modelId
  if (web && message.answeredByFallback) return undefined
  if (message.modelId) return `external:${message.modelId}`
  return role ? memberPickModelKey(role, store.settings.defaultChatSite) : undefined
}

// The replies the user kept: quoted in a message, marked, remembered or adopted, or saved to the library.
function keptReplyIds(store: OpenTeamStore): Set<string> {
  const ids = new Set<string>()
  for (const message of Object.values(store.messagesById)) {
    if (message.type !== 'user') continue
    for (const reference of message.references ?? []) ids.add(reference.messageId)
  }
  for (const [messageId, highlights] of Object.entries(store.messageHighlightsById ?? {})) if (highlights.length) ids.add(messageId)
  for (const item of Object.values(store.memoryItemsById ?? {})) {
    if (item.source.origin === 'user' && item.source.messageId) ids.add(item.source.messageId)
  }
  for (const docs of Object.values(store.libraryByChatId ?? {})) {
    for (const doc of docs) if (doc.kind === 'message' && doc.source) ids.add(doc.source)
  }
  return ids
}
