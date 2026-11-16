// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, GroupRole, MemoryItem, OpenTeamStore } from '../group/types'
import { memoryRecipientsText, openMemoryDialog } from './memoryDialog'

afterEach(() => {
  document.body.replaceChildren()
})

function makeStore(language: 'zh-CN' | 'en' = 'zh-CN', mode: 'collaborative' | 'independent' = 'collaborative'): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = language
  const role = (id: string, name: string, chatSite: GroupRole['chatSite']): GroupRole => ({ id, chatId: 'c1', name, chatSite, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 })
  store.rolesById = { r1: role('r1', 'DeepSeek', 'deepseek'), r2: role('r2', 'Kimi', 'kimi') }
  store.chatsById.c1 = { id: 'c1', name: '选型群', mode, roleIds: ['r1', 'r2'], messageIds: ['m1', 'm2'], nextMessageSeq: 3, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.messagesById = {
    m1: { id: 'm1', chatId: 'c1', seq: 1, type: 'user', content: '数据库用 Postgres', status: 'sent', createdAt: 1 } as GroupMessage,
    m2: { id: 'm2', chatId: 'c1', seq: 2, type: 'assistant', roleId: 'r2', content: '建议主键用 UUID', status: 'received', createdAt: 2 } as GroupMessage,
  }
  return store
}

function item(patch: Partial<MemoryItem> = {}): MemoryItem {
  return { id: 'mem1', scope: 'chat', scopeId: 'c1', kind: 'decision', content: '数据库用 Postgres', source: { origin: 'user' }, createdAt: 1, updatedAt: 1, ...patch }
}

function open(input: Parameters<typeof openMemoryDialog>[0], store = makeStore(), runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)) {
  const onClose = vi.fn()
  openMemoryDialog(input, { getStore: () => store, runCommand, onClose })
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const type = (selector: string, value: string) => {
    const field = $<HTMLInputElement>(selector)
    field.value = value
    field.dispatchEvent(new Event('input'))
  }
  const choose = (selector: string, value: string) => {
    const field = $<HTMLSelectElement>(selector)
    field.value = value
    field.dispatchEvent(new Event('change'))
  }
  const pickScope = (scope: string) => {
    const radio = $<HTMLInputElement>(`input[name="memory-scope"][value="${scope}"]`)
    radio.checked = true
    radio.dispatchEvent(new Event('change'))
  }
  const save = () => $<HTMLFormElement>('.memory-dialog-form').requestSubmit()
  return { store, runCommand, onClose, $, type, choose, pickScope, save }
}

describe('who a memory item is sent to, in words', () => {
  it('names third-party sites and local agents for an item kept for every group', () => {
    const text = memoryRecipientsText(makeStore(), 'global', undefined, undefined, { origin: 'user' }, false)
    expect(text).toContain('所有群聊里的所有成员')
    expect(text).toContain('第三方站点')
    expect(text).toContain('本地智能体')
  })

  it('lists the group\'s members for a group item', () => {
    const store = makeStore()
    expect(memoryRecipientsText(store, 'chat', store.chatsById.c1, undefined, { origin: 'user' }, false)).toBe('会发给：「选型群」的成员：「DeepSeek」、「Kimi」。')
  })

  it('says the other members cannot read a member\'s reply in an independent group', () => {
    const store = makeStore('zh-CN', 'independent')
    const text = memoryRecipientsText(store, 'chat', store.chatsById.c1, undefined, { origin: 'member', roleId: 'r2' }, false)
    expect(text).toBe('只发给：「选型群」里的「Kimi」。这个群是独立模式，这段文字出自「Kimi」的回复，其他成员读不到。')
    // The member who wrote it has left the group: nobody is left to read it.
    delete store.rolesById.r2
    store.chatsById.c1.roleIds = ['r1']
    expect(memoryRecipientsText(store, 'chat', store.chatsById.c1, undefined, { origin: 'member', roleId: 'r2' }, false)).toContain('不会发给任何成员')
    expect(memoryRecipientsText(store, 'chat', store.chatsById.c1, undefined, { origin: 'user' }, false)).not.toContain('读不到')
  })

  it('names the one member for a member item, and says when the group has memory off', () => {
    const store = makeStore()
    expect(memoryRecipientsText(store, 'role', store.chatsById.c1, 'r1', { origin: 'user' }, false)).toContain('只发给：「选型群」里的「DeepSeek」')
    store.chatsById.c1.memoryDisabled = true
    expect(memoryRecipientsText(store, 'role', store.chatsById.c1, 'r1', { origin: 'user' }, false)).toContain('这个群已关闭记忆')
    expect(memoryRecipientsText(store, 'global', store.chatsById.c1, undefined, { origin: 'user' }, false)).not.toContain('已关闭记忆')
  })

  it('answers in English', () => {
    const store = makeStore('en')
    expect(memoryRecipientsText(store, 'chat', store.chatsById.c1, undefined, { origin: 'user' }, true)).toBe('Sent to: the members of "选型群": 「DeepSeek」, 「Kimi」.')
  })
})

describe('save-to-memory window', () => {
  it('opens on the message\'s text, for this group, and says who gets it', () => {
    const store = makeStore()
    const { $ } = open({ message: store.messagesById.m1 }, store)
    expect($('.memory-dialog').getAttribute('aria-labelledby')).toBe('memory-dialog-title')
    expect($('#memory-dialog-title').textContent).toBe('保存到记忆库')
    expect(document.activeElement).toBe($('#memory-content'))
    expect($<HTMLTextAreaElement>('#memory-content').value).toBe('数据库用 Postgres')
    expect($('#memory-content-hint').textContent).toBe('13 / 500 字')
    expect($<HTMLInputElement>('input[name="memory-scope"]:checked').value).toBe('chat')
    expect($('.memory-dialog-recipients').textContent).toContain('「选型群」的成员')
    expect($<HTMLSelectElement>('.memory-dialog-member').hidden).toBe(true)
  })

  it('saves with the message id, so the background records who wrote the text', async () => {
    const store = makeStore()
    const { save, type, choose, runCommand, onClose } = open({ message: store.messagesById.m2 }, store)
    choose('#memory-kind', 'decision')
    type('#memory-tags', '数据库， 主键')
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_ADD', {
      item: { scope: 'chat', scopeId: 'c1', kind: 'decision', content: '建议主键用 UUID', tags: ['数据库', '主键'], pinned: false, messageId: 'm2' },
    }))
    await vi.waitFor(() => expect(document.querySelector('.memory-dialog-modal')).toBeNull())
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('saves what a member proposed: its text and kind, not the whole reply, and answers the proposal', async () => {
    const store = makeStore()
    const proposal = { id: 'p1', kind: 'preference' as const, content: '回答先给结论。' }
    store.messagesById.m2.memoryProposals = [proposal]
    const { $, save, runCommand } = open({ message: store.messagesById.m2, proposal }, store)
    expect($<HTMLTextAreaElement>('#memory-content').value).toBe('回答先给结论。')
    expect($<HTMLSelectElement>('#memory-kind').value).toBe('preference')
    // A preference is kept in every prompt unless the user says otherwise.
    expect($<HTMLInputElement>('#memory-pinned').checked).toBe(true)
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_ADD', {
      item: { scope: 'chat', scopeId: 'c1', kind: 'preference', content: '回答先给结论。', tags: [], pinned: true, messageId: 'm2', proposalId: 'p1' },
    }))
  })

  it('adopts a round summary: its agreed points, as a decision, the user\'s, for every member', async () => {
    const store = makeStore('zh-CN', 'independent')
    store.messagesById.q = { id: 'q', chatId: 'c1', seq: 3, type: 'user', content: '数据库怎么选？', createdAt: 3, status: 'received' } as GroupMessage
    store.messagesById.sq = { id: 'sq', chatId: 'c1', seq: 4, type: 'user', content: '汇总本轮回复', roundSummaryOf: 'q', createdAt: 4, status: 'received' } as GroupMessage
    store.messagesById.s = { id: 's', chatId: 'c1', seq: 5, type: 'assistant', roleId: 'r2', content: '**共识**\n- 用 PostgreSQL 15\n**分歧**\n- 无明显分歧', sourceMessageId: 'sq', createdAt: 5, status: 'received' } as GroupMessage
    const { $, save, runCommand } = open({ message: store.messagesById.s, adopt: true, chatId: 'c1' }, store)
    expect($('#memory-dialog-title').textContent).toBe('采纳为决定')
    expect($<HTMLTextAreaElement>('#memory-content').value).toBe('关于「数据库怎么选？」：用 PostgreSQL 15。')
    expect($<HTMLSelectElement>('#memory-kind').value).toBe('decision')
    // The user's, so in this independent group every member gets it, not only the summarizer.
    expect($('.memory-dialog-recipients').textContent).toBe('会发给：「选型群」的成员：「DeepSeek」、「Kimi」。')
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_ADD', {
      item: { scope: 'chat', scopeId: 'c1', kind: 'decision', content: '关于「数据库怎么选？」：用 PostgreSQL 15。', tags: [], pinned: false, messageId: 's', adopted: true },
    }))
  })

  it('offers the member who wrote the reply when the item is for one member', () => {
    const store = makeStore()
    const { $, pickScope } = open({ message: store.messagesById.m2 }, store)
    pickScope('role')
    expect($<HTMLSelectElement>('.memory-dialog-member').hidden).toBe(false)
    expect($<HTMLSelectElement>('.memory-dialog-member').value).toBe('r2')
    expect($('.memory-dialog-recipients').textContent).toContain('只发给：「选型群」里的「Kimi」')
  })

  it('warns before an item goes to every group', () => {
    const { $, pickScope } = open({ chatId: 'c1' })
    pickScope('global')
    expect($('.memory-dialog-recipients').textContent).toContain('第三方站点')
  })

  it('pins a preference until the user decides otherwise', async () => {
    const { $, choose, type, save, runCommand } = open({ chatId: 'c1' })
    const pinned = $<HTMLInputElement>('#memory-pinned')
    expect(pinned.checked).toBe(false)
    choose('#memory-kind', 'preference')
    expect(pinned.checked).toBe(true)
    pinned.checked = false
    pinned.dispatchEvent(new Event('change'))
    choose('#memory-kind', 'fact')
    choose('#memory-kind', 'preference')
    expect(pinned.checked).toBe(false)
    type('#memory-content', '回答用中文')
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_ADD', { item: { scope: 'chat', scopeId: 'c1', kind: 'preference', content: '回答用中文', tags: [], pinned: false } }))
  })

  it('takes only the start of a long message and says so', () => {
    const store = makeStore()
    store.messagesById.m2.content = '长'.repeat(620)
    const { $ } = open({ message: store.messagesById.m2 }, store)
    expect($<HTMLTextAreaElement>('#memory-content').value).toHaveLength(500)
    expect($('#memory-content-hint').textContent).toContain('只取了开头')
  })

  it('does not save empty or over-long content, and says why', () => {
    const { $, type, save, runCommand } = open({ chatId: 'c1' })
    save()
    expect($('.team-form-error').textContent).toBe('请写下要记住的内容。')
    expect($('#memory-content').getAttribute('aria-invalid')).toBe('true')
    type('#memory-content', '字'.repeat(501))
    expect($('#memory-content').hasAttribute('aria-invalid')).toBe(false)
    expect($('#memory-content-hint').classList.contains('memory-dialog-over')).toBe(true)
    save()
    expect($('.team-form-error').textContent).toContain('内容有 501 字')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('offers only "every group" when there is no group to save to', () => {
    const store = makeStore()
    const { $ } = open({}, store)
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="memory-scope"]')].map(radio => radio.value)).toEqual(['global'])
    expect($<HTMLInputElement>('input[name="memory-scope"]:checked').value).toBe('global')
  })

  it('edits an item, sending only what changed', async () => {
    const store = makeStore()
    const { $, type, save, runCommand } = open({ item: item({ pinned: true, tags: ['数据库'] }) }, store)
    expect($('#memory-dialog-title').textContent).toBe('编辑记忆')
    expect($<HTMLSelectElement>('#memory-kind').value).toBe('decision')
    expect($<HTMLInputElement>('#memory-pinned').checked).toBe(true)
    expect($<HTMLInputElement>('#memory-tags').value).toBe('数据库')
    type('#memory-content', '数据库用 Postgres 16')
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MEMORY_UPDATE', { itemId: 'mem1', patch: { content: '数据库用 Postgres 16' } }))
  })

  it('moves an item to one member, and sends nothing when nothing changed', async () => {
    const store = makeStore()
    const first = open({ item: item() }, store)
    first.pickScope('role')
    first.choose('.memory-dialog-member', 'r2')
    first.save()
    await vi.waitFor(() => expect(first.runCommand).toHaveBeenCalledWith('GROUP_MEMORY_UPDATE', { itemId: 'mem1', patch: { scope: 'role', scopeId: 'r2' } }))

    const second = open({ item: item() }, store)
    second.save()
    await vi.waitFor(() => expect(second.onClose).toHaveBeenCalledWith(true))
    expect(second.runCommand).not.toHaveBeenCalled()
  })

  it('shows what the background refused, and stays open', async () => {
    const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
    runCommand.mockRejectedValue(new Error('记忆库已经有 500 条，请先删除一些再保存'))
    const { $, type, save, onClose } = open({ chatId: 'c1' }, makeStore(), runCommand)
    type('#memory-content', '一条')
    save()
    await vi.waitFor(() => expect($('.team-form-error').textContent).toBe('记忆库已经有 500 条，请先删除一些再保存'))
    expect(document.querySelector('.memory-dialog-modal')).not.toBeNull()
    expect($<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape, on the close button and on the backdrop', () => {
    const first = open({ chatId: 'c1' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.memory-dialog-modal')).toBeNull()
    expect(first.onClose).toHaveBeenCalledWith(false)

    const second = open({ chatId: 'c1' })
    second.$<HTMLButtonElement>('.modal-close').click()
    expect(document.querySelector('.memory-dialog-modal')).toBeNull()

    const third = open({ chatId: 'c1' })
    third.$<HTMLElement>('.memory-dialog-modal').click()
    expect(document.querySelector('.memory-dialog-modal')).toBeNull()
  })

  it('is in English when the page is', () => {
    const store = makeStore('en')
    store.chatsById.c1.name = 'Stack'
    const { $ } = open({ message: store.messagesById.m1 }, store)
    expect($('#memory-dialog-title').textContent).toBe('Save to memory')
    expect($('#memory-content-hint').textContent).toBe('13 / 500 characters')
    expect([...document.querySelectorAll('#memory-kind option')].map(option => option.textContent)).toEqual(['Fact', 'Decision', 'Preference', 'Note'])
    expect(document.querySelector('.memory-dialog')?.textContent).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
