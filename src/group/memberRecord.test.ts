import { describe, expect, it } from 'vitest'
import { memberRecordLines, memberRecords, recordFor, recordText } from './memberRecord'
import { createDefaultStore } from './store'
import type { GroupMessage, GroupRole, OpenTeamStore } from './types'

function role(id: string, chatId: string, fields: Partial<GroupRole>): GroupRole {
  return { id, chatId, name: id, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1, ...fields }
}

function reply(id: string, chatId: string, roleId: string, fields: Partial<GroupMessage> = {}): GroupMessage {
  return { id, chatId, seq: 1, type: 'assistant', roleId, content: '回答', createdAt: 1, status: 'received', ...fields }
}

// Two groups: 安全审计员 from the library on Kimi in both (named 安全审计员2 in the second), on the
// Gemini API in the second too, and a member written for a task.
function setup(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.defaultChatSite = 'kimi'
  const chats = { a: ['ra', 'rb'], b: ['rc', 'rd'] }
  for (const [chatId, roleIds] of Object.entries(chats)) {
    store.chatsById[chatId] = { id: chatId, name: chatId, mode: 'collaborative', roleIds, messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    store.chatOrder.push(chatId)
  }
  store.rolesById.ra = role('ra', 'a', { name: '安全审计员', templateId: 'builtin-security', chatSite: 'kimi', redoneReplies: 1 })
  store.rolesById.rb = role('rb', 'a', { name: '预算设计师', chatSite: 'deepseek' })
  store.rolesById.rc = role('rc', 'b', { name: '安全审计员2', templateId: 'builtin-security', chatSite: 'kimi' })
  store.rolesById.rd = role('rd', 'b', { name: '安全审计员3', templateId: 'builtin-security', modelSource: 'external', externalModelId: 'gem' })
  const add = (message: GroupMessage) => {
    store.messagesById[message.id] = message
    store.chatsById[message.chatId].messageIds.push(message.id)
  }
  add(reply('a1', 'a', 'ra'))
  add(reply('a2', 'a', 'ra'))
  add(reply('a3', 'a', 'ra', { status: 'error' }))
  add(reply('a4', 'a', 'rb'))
  add(reply('a5', 'a', 'rb', { answeredByFallback: 'Gemini API' }))
  add({ id: 'u1', chatId: 'a', seq: 9, type: 'user', content: '照这个改', createdAt: 2, status: 'received', references: [{ messageId: 'a1', roleId: 'ra', contentSnapshot: '回答' }] })
  add(reply('b1', 'b', 'rc'))
  add(reply('b2', 'b', 'rc'))
  add(reply('b3', 'b', 'rd', { modelId: 'gem' }))
  // A member who left the group: its replies count by its name and the model on them.
  add(reply('b4', 'b', 'gone', { roleName: '财务顾问', modelId: 'gem' }))
  store.messageHighlightsById = { a1: [{ id: 'h', messageId: 'a1', text: '要点', startOffset: 0, endOffset: 2, createdAt: 3 }], b1: [] }
  store.memoryItemsById = { m: { id: 'm', scope: 'global', kind: 'fact', content: '记住', source: { origin: 'user', chatId: 'b', messageId: 'b2' }, createdAt: 3, updatedAt: 3 } }
  store.libraryByChatId = { a: [{ id: 'd', title: '预算', kind: 'message', source: 'a4', chars: 2, addedAt: 3 }] }
  return store
}

describe('how each role on each model has done, from what the user did with its replies', () => {
  it('counts the finished replies of a library role on a model across groups, the ones the user kept and the ones asked again', () => {
    const records = memberRecords(setup())
    const security = recordFor(records, { templateId: 'builtin-security', name: '安全审计员', model: 'site:kimi' })
    // a1 quoted and marked (once), b2 remembered; a3 failed is not a reply.
    expect(security).toMatchObject({ name: '安全审计员', templateId: 'builtin-security', model: 'site:kimi', replies: 4, kept: 2, redone: 1 })
    expect(recordFor(records, { templateId: 'builtin-security', name: '安全审计员', model: 'external:gem' })).toMatchObject({ replies: 1, kept: 0, redone: 0 })
  })

  it('counts a role written for a task by its name, saved replies as kept, and leaves out what its backup model wrote', () => {
    const records = memberRecords(setup())
    expect(recordFor(records, { name: '预算设计师', model: 'site:deepseek' })).toMatchObject({ replies: 1, kept: 1 })
    expect(recordFor(records, { name: '财务顾问', model: 'external:gem' })).toMatchObject({ replies: 1, kept: 0 })
    expect(recordFor(records, { name: '预算设计师', model: 'site:kimi' })).toBeUndefined()
  })

  it('says it in a line under a pick, and gives the planner the roles with enough replies on the models it may use', () => {
    const store = setup()
    const records = memberRecords(store)
    const security = recordFor(records, { templateId: 'builtin-security', name: '安全审计员', model: 'site:kimi' })!
    expect(recordText(security, false)).toBe('过去 4 次回答，你留用了 2 次，重答 1 次')
    expect(recordText({ ...security, redone: 0 }, true)).toBe('4 replies before, 2 of them kept')
    const lines = memberRecordLines(records, [{ key: 'site:kimi', label: 'Kimi' }, { key: 'site:deepseek', label: 'DeepSeek' }], false)
    expect(lines).toEqual(['- 安全审计员（角色库 id=builtin-security）· Kimi：4 次回答，留用 2 次，重答 1 次'])
    expect(memberRecordLines(records, [{ key: 'site:kimi', label: 'Kimi' }], true)).toEqual(['- 安全审计员 (library id=builtin-security) · Kimi: 4 replies, 2 kept, 1 asked again'])
  })
})
