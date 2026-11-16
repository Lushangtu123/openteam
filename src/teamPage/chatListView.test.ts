// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { MemoryItem, OpenTeamStore } from '../group/types'
import { createTeamPageState } from './appState'
import { createChatListView } from './chatListView'

describe('team page chat list view boundary', () => {
  it('wires chat export and deletion through the chat menu', () => {
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(viewSource).toContain("exportRecord.textContent = ui('导出记录')")
    expect(viewSource).toContain("runCommand('GROUP_CHAT_UPDATE'")
    expect(viewSource).toContain('formatChatExportMarkdown')
    expect(viewSource).toContain('safeChatExportFilename')
    expect(viewSource).toContain("sendRuntimeMessage('GROUP_CHAT_DELETE'")
    expect(viewSource).toContain('chat-delete:fallback-local-store')
  })
})

describe('chat menu and the memory store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeStore(language: 'zh-CN' | 'en' = 'zh-CN'): OpenTeamStore {
    const store = createDefaultStore()
    store.settings.language = language
    store.chatsById['chat-1'] = { id: 'chat-1', name: '选型群', mode: 'collaborative', roleIds: ['r1'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    store.chatOrder = ['chat-1']
    const item = (id: string, patch: Partial<MemoryItem>): MemoryItem => ({ id, scope: 'global', kind: 'fact', content: id, source: { origin: 'user' }, createdAt: 1, updatedAt: 1, ...patch })
    store.memoryItemsById = {
      everywhere: item('everywhere', {}),
      group: item('group', { scope: 'chat', scopeId: 'chat-1' }),
      member: item('member', { scope: 'role', scopeId: 'r1' }),
      other: item('other', { scope: 'chat', scopeId: 'chat-2' }),
    }
    store.memoryOrder = ['everywhere', 'group', 'member', 'other']
    return store
  }

  function openMenu(store: OpenTeamStore) {
    const state = createTeamPageState()
    const chatListEl = document.createElement('div')
    const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
    const sendRuntimeMessage = vi.fn(async () => ({ ok: true, store }))
    const view = createChatListView({
      state,
      getStore: () => store,
      applyStore: vi.fn(),
      storeSummaryEl: document.createElement('p'),
      chatListEl,
      iframeHost: { removeChat: vi.fn(), restoreChat: vi.fn() },
      getTemplates: () => [],
      getChatRecentSummary: () => '',
      roleToneClass: () => '',
      roleAvatarLabel: value => value.slice(0, 1),
      emptyCard: () => document.createElement('div'),
      renderSelectedChat: vi.fn(),
      renderRolePanel: vi.fn(),
      sendRuntimeMessage: sendRuntimeMessage as never,
      runCommand,
      log: { warn: vi.fn() },
      showError: vi.fn(),
    })
    state.chatMenuChatId = 'chat-1'
    view.renderChatList()
    const item = (text: string) => [...chatListEl.querySelectorAll<HTMLButtonElement>('.chat-action-menu button')].find(button => button.textContent === text)
    return { chatListEl, runCommand, sendRuntimeMessage, item }
  }

  it('switches the group\'s memory off, and back on', () => {
    const store = makeStore()
    const first = openMenu(store)
    first.item('关闭本群记忆')?.click()
    expect(first.runCommand).toHaveBeenCalledWith('GROUP_CHAT_UPDATE', { chatId: 'chat-1', patch: { memoryDisabled: true } })
    expect(first.chatListEl.querySelector('.chat-action-menu')).toBeNull()

    store.chatsById['chat-1'].memoryDisabled = true
    const second = openMenu(store)
    expect(second.item('关闭本群记忆')).toBeUndefined()
    second.item('开启本群记忆')?.click()
    expect(second.runCommand).toHaveBeenCalledWith('GROUP_CHAT_UPDATE', { chatId: 'chat-1', patch: { memoryDisabled: false } })
  })

  it('names the switch in English', () => {
    expect(openMenu(makeStore('en')).item('Switch off memory here')).toBeDefined()
  })

  it('says how many memory items go with a deleted group, and deletes only after a yes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const refused = openMenu(makeStore())
    refused.item('删除群聊')?.click()
    expect(confirm).toHaveBeenLastCalledWith('确定删除「选型群」吗？删除后这个群聊的消息和角色都会移除。为这个群和它的成员保存的 2 条记忆也会一并删除。')
    expect(refused.sendRuntimeMessage).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    const english = openMenu(makeStore('en'))
    english.item('Delete chat')?.click()
    expect(confirm).toHaveBeenLastCalledWith('Delete "选型群"? Its messages and members are removed. The 2 memory items saved for this group and its members will be deleted too.')
    await vi.waitFor(() => expect(english.sendRuntimeMessage).toHaveBeenCalledWith('GROUP_CHAT_DELETE', { chatId: 'chat-1' }))
  })

  it('does not mention memory when the group has none', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const store = makeStore()
    store.memoryItemsById = { everywhere: store.memoryItemsById!.everywhere }
    store.memoryOrder = ['everywhere']
    openMenu(store).item('删除群聊')?.click()
    expect(confirm).toHaveBeenLastCalledWith('确定删除「选型群」吗？删除后这个群聊的消息和角色都会移除。')
  })
})
