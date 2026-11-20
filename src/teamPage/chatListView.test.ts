// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { MemoryItem, OpenTeamStore } from '../group/types'
import { createTeamPageState } from './appState'
import { createChatListView } from './chatListView'
import { currentScheduledTasksDialog } from './scheduledTasksDialog'

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

  it('opens the group\'s scheduled tasks, saying how many it has', () => {
    const store = makeStore()
    store.chatsById['chat-1'].scheduledTasks = [{ id: 'sched-1', content: '@所有人 总结', days: [1], time: '08:30', enabled: true, armedAt: 0, createdAt: 0, updatedAt: 0 }]
    const { item, chatListEl } = openMenu(store)
    item('定时任务 (1)')?.click()
    expect(chatListEl.querySelector('.chat-action-menu')).toBeNull()
    expect(document.querySelector('.scheduled-tasks-modal [role="dialog"]')).not.toBeNull()
    currentScheduledTasksDialog()?.close()
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

describe('choosing several groups', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setup(language: 'zh-CN' | 'en' = 'zh-CN') {
    const store = createDefaultStore()
    store.settings.language = language
    for (const [id, name] of [['chat-1', '网站自检 1'], ['chat-2', '网站自检 2'], ['chat-3', '正式项目']]) {
      store.chatsById[id] = { id, name, mode: 'independent', roleIds: [`r-${id}`], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    }
    store.chatOrder = ['chat-1', 'chat-2', 'chat-3']
    store.memoryItemsById = { m1: { id: 'm1', scope: 'chat', scopeId: 'chat-2', kind: 'fact', content: 'x', source: { origin: 'user' }, createdAt: 1, updatedAt: 1 } }
    store.memoryOrder = ['m1']
    const state = createTeamPageState()
    state.selectedChatId = 'chat-3'
    const chatListEl = document.createElement('div')
    document.body.replaceChildren(chatListEl)
    const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
    const remaining = createDefaultStore()
    const sendRuntimeMessage = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => ({ ok: true, store: remaining }))
    const applyStore = vi.fn()
    const removeChat = vi.fn()
    const view = createChatListView({
      state,
      getStore: () => store,
      applyStore,
      storeSummaryEl: document.createElement('p'),
      chatListEl,
      iframeHost: { removeChat, restoreChat: vi.fn() },
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
    view.renderChatList()
    const rows = () => [...chatListEl.querySelectorAll<HTMLElement>('.chat-item')]
    const checkbox = (index: number) => rows()[index].querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const bar = () => chatListEl.querySelector<HTMLElement>('.chat-select-bar')
    const barButton = (text: string) => [...(bar()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button => button.textContent === text)
    const startFrom = (index: number, label = '选择多个…') => {
      rows()[index].querySelector<HTMLButtonElement>('.chat-menu-btn')!.click()
      ;[...chatListEl.querySelectorAll<HTMLButtonElement>('.chat-action-menu button')].find(button => button.textContent === label)!.click()
    }
    return { store, state, chatListEl, rows, checkbox, bar, barButton, startFrom, runCommand, sendRuntimeMessage, applyStore, removeChat }
  }

  it('starts from a group’s menu with that group ticked, and rows tick instead of opening', () => {
    const { rows, checkbox, bar, startFrom, runCommand } = setup()
    startFrom(0)

    expect(bar()?.textContent).toContain('已选 1 个')
    expect(rows().map((_, index) => checkbox(index).checked)).toEqual([true, false, false])
    expect(checkbox(1).getAttribute('aria-label')).toBe('选择「网站自检 2」')
    expect(rows()[0].querySelector('.chat-menu-btn')).toBeNull()

    rows()[1].click()
    expect(rows().map((_, index) => checkbox(index).checked)).toEqual([true, true, false])
    expect(bar()?.textContent).toContain('已选 2 个')

    // The list is drawn again on each tick; a keyboard user stays on the box they ticked.
    checkbox(2).focus()
    checkbox(2).click()
    expect(document.activeElement).toBe(checkbox(2))
    expect(checkbox(2).checked).toBe(true)
    expect(runCommand).not.toHaveBeenCalledWith('GROUP_CHAT_SWITCH', expect.anything())
  })

  it('selects all and none, and leaves without deleting', () => {
    const { rows, checkbox, bar, barButton, startFrom } = setup()
    startFrom(0)
    barButton('全选')!.click()
    expect(rows().map((_, index) => checkbox(index).checked)).toEqual([true, true, true])
    barButton('全不选')!.click()
    expect(rows().map((_, index) => checkbox(index).checked)).toEqual([false, false, false])
    expect(barButton('删除')!.disabled).toBe(true)

    barButton('取消')!.click()
    expect(bar()).toBeNull()
    expect(rows()[0].querySelector('.chat-menu-btn')).toBeTruthy()
  })

  it('deletes the chosen groups after one yes that counts their memory, then leaves select mode', async () => {
    const { rows, bar, barButton, startFrom, sendRuntimeMessage, applyStore, removeChat } = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    startFrom(0)
    rows()[1].click()

    barButton('删除')!.click()
    expect(confirm).toHaveBeenLastCalledWith('确定删除选中的 2 个群聊吗？它们的消息和成员都会移除，为它们保存的 1 条记忆也会一并删除。删除后无法恢复。')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
    expect(bar()).toBeTruthy()

    barButton('删除')!.click()
    await vi.waitFor(() => expect(sendRuntimeMessage).toHaveBeenCalledWith('GROUP_CHATS_DELETE', { chatIds: ['chat-1', 'chat-2'] }))
    await vi.waitFor(() => expect(applyStore).toHaveBeenCalled())
    expect(removeChat.mock.calls.map(call => call[0])).toEqual(['chat-1', 'chat-2'])
    expect(bar()).toBeNull()
  })

  it('leaves select mode on Escape', () => {
    const { bar, startFrom, chatListEl } = setup()
    startFrom(0)
    chatListEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(bar()).toBeNull()
  })

  it('speaks English when the page does', () => {
    const { bar, barButton, startFrom } = setup('en')
    startFrom(0, 'Select several…')
    expect(bar()?.textContent).toContain('1 selected')
    expect(barButton('Select all')).toBeTruthy()
  })
})

describe('the group list while the store keeps changing', () => {
  function setup(runCommand: (type: string, payload?: Record<string, unknown>) => Promise<void> = vi.fn(async () => undefined)) {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    for (const [id, name] of [['chat-1', '网站自检 11-17 09:14'], ['chat-2', '网站自检 11-17 09:07']]) {
      store.chatsById[id] = { id, name, mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    }
    store.chatOrder = ['chat-1', 'chat-2']
    const state = createTeamPageState()
    state.selectedChatId = 'chat-1'
    const chatListEl = document.createElement('div')
    document.body.replaceChildren(chatListEl)
    let summary = '最近一条'
    const view = createChatListView({
      state, getStore: () => store, applyStore: vi.fn(), storeSummaryEl: document.createElement('p'), chatListEl,
      iframeHost: { removeChat: vi.fn(), restoreChat: vi.fn() }, getTemplates: () => [], getChatRecentSummary: () => summary,
      roleToneClass: () => '', roleAvatarLabel: value => value.slice(0, 1), emptyCard: () => document.createElement('div'),
      renderSelectedChat: vi.fn(), renderRolePanel: vi.fn(), sendRuntimeMessage: vi.fn() as never, runCommand,
      log: { warn: vi.fn() }, showError: vi.fn(),
    })
    view.renderChatList()
    return { store, state, view, chatListEl, setSummary: (value: string) => { summary = value } }
  }

  it('keeps its rows when nothing they show changed, so hovering does not flash and a click is not lost (seen live)', () => {
    const { store, view, chatListEl } = setup()
    const row = chatListEl.querySelector('.chat-item')
    // A store update the list does not show: a member's page status, say.
    store.chatsById['chat-2'].status = 'running'
    view.renderChatList()
    expect(chatListEl.querySelector('.chat-item')).toBe(row)
  })

  it('redraws when something it shows changed: a name, the last message, the open group, a new message', () => {
    const { store, state, view, chatListEl, setSummary } = setup()
    const first = () => chatListEl.querySelector('.chat-item')
    let row = first()
    store.chatsById['chat-1'].name = '改名了'
    view.renderChatList()
    expect(first()).not.toBe(row)
    row = first()
    setSummary('新的一条')
    view.renderChatList()
    expect(first()).not.toBe(row)
    row = first()
    state.selectedChatId = 'chat-2'
    view.renderChatList()
    expect(first()).not.toBe(row)
    row = first()
    store.viewState = { ...store.viewState, chatHasNewMessageById: { 'chat-1': true } }
    view.renderChatList()
    expect(first()).not.toBe(row)
    expect(first()?.classList.contains('has-activity')).toBe(true)
  })

  it('marks a clicked group as on its way until the switch command has finished', async () => {
    let finish: () => void = () => undefined
    const runCommand = vi.fn((_type: string, _payload?: Record<string, unknown>) => new Promise<void>(resolve => { finish = resolve }))
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
    const { state, chatListEl } = setup(runCommand)
    ;(chatListEl.querySelectorAll('.chat-item')[1] as HTMLElement).click()
    raf.mockRestore()
    expect(state.selectedChatId).toBe('chat-2')
    expect(state.pendingChatSwitchId).toBe('chat-2')
    expect(runCommand).toHaveBeenCalledWith('GROUP_CHAT_SWITCH', { chatId: 'chat-2' })
    finish()
    await vi.waitFor(() => expect(state.pendingChatSwitchId).toBeUndefined())
  })
})

describe('the group menu\'s library entry', () => {
  it('shows how many documents the group has, and opens its library', () => {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    store.chatsById['chat-1'] = { id: 'chat-1', name: '产品群', mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    store.chatOrder = ['chat-1']
    store.libraryByChatId = { 'chat-1': [{ id: 'd', title: '需求', kind: 'file', chars: 1, addedAt: 1 }] }
    const state = createTeamPageState()
    state.selectedChatId = 'chat-1'
    const chatListEl = document.createElement('div')
    document.body.replaceChildren(chatListEl)
    const openLibrary = vi.fn()
    const view = createChatListView({
      state, getStore: () => store, applyStore: vi.fn(), storeSummaryEl: document.createElement('p'), chatListEl,
      iframeHost: { removeChat: vi.fn(), restoreChat: vi.fn() }, getTemplates: () => [], getChatRecentSummary: () => '',
      roleToneClass: () => '', roleAvatarLabel: value => value.slice(0, 1), emptyCard: () => document.createElement('div'),
      renderSelectedChat: vi.fn(), renderRolePanel: vi.fn(), sendRuntimeMessage: vi.fn() as never, runCommand: vi.fn(async () => undefined),
      log: { warn: vi.fn() }, showError: vi.fn(), openLibrary,
    })
    view.renderChatList()
    chatListEl.querySelector<HTMLButtonElement>('.chat-menu-btn')!.click()
    const entry = chatListEl.querySelector<HTMLButtonElement>('[data-chat-library]')!
    expect(entry.textContent).toBe('资料库 (1)')
    entry.click()
    expect(openLibrary).toHaveBeenCalledWith('chat-1')
    expect(state.chatMenuChatId).toBeUndefined()
  })
})

