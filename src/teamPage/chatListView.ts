import { countMemoryForChat, deleteMemoryForChat } from '../group/memoryStore'
import { createDefaultStore, loadStore, saveStore } from '../group/store'
import type { GroupChat, GroupRole, OpenTeamStore, RoleTemplate } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import type { TeamPageState } from './appState'
import { formatChatExportMarkdown, safeChatExportFilename } from './chatExport'
import { formatChatListTime } from './chatExperience'
import { orderChatsForList, shouldShowChatSearch } from './chatListOrder'
import type { RuntimeResponse } from './runtimeClient'
import { openScheduledTasksDialog } from './scheduledTasksDialog'

interface ChatListIframeHost {
  removeChat(chatId: string): void
  restoreChat(chat: GroupChat, roles: GroupRole[]): void
}

export interface ChatListViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  applyStore(store: OpenTeamStore): void
  storeSummaryEl: HTMLElement
  chatListEl: HTMLElement
  chatListSearchBoxEl?: HTMLElement
  chatListSearchEl?: HTMLInputElement
  iframeHost: ChatListIframeHost
  getTemplates(): RoleTemplate[]
  getChatRecentSummary(chat: GroupChat): string
  roleToneClass(value: string): string
  roleAvatarLabel(value: string): string
  emptyCard(title: string, body: string): HTMLElement
  renderSelectedChat(): void
  renderRolePanel(): void
  // Opens the group's 资料库.
  openLibrary?(chatId: string): void
  sendRuntimeMessage<T>(type: string, payload?: Record<string, unknown>): Promise<RuntimeResponse<T>>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  log: {
    warn(event: string, details?: Record<string, unknown>): void
  }
  showError(message: string): void
}

export interface ChatListView {
  renderChatList(): void
  switchChat(chatId: string): void
}

export function createChatListView(deps: ChatListViewDependencies): ChatListView {
  deps.chatListSearchEl?.addEventListener('input', () => {
    deps.state.chatListQuery = deps.chatListSearchEl?.value ?? ''
    renderChatList()
  })
  deps.chatListSearchEl?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !deps.chatListSearchEl?.value) return
    event.preventDefault()
    deps.chatListSearchEl.value = ''
    deps.state.chatListQuery = ''
    renderChatList()
  })
  deps.chatListEl.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !deps.state.chatSelection) return
    event.preventDefault()
    leaveSelection()
  })

  // What the rows last drawn showed. The page redraws on every store update, every few seconds while
  // members work; rebuilding unchanged rows made them flash under the mouse, and a click whose press
  // and release fell either side of a rebuild was lost (seen live).
  let drawnList: string | undefined

  function renderChatList() {
    // Drawn anew when it changed: the control that had focus gets it back.
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey
    renderChatListItems()
    if (focusKey) [...deps.chatListEl.querySelectorAll<HTMLElement>('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey)?.focus()
  }

  function renderChatListItems() {
    const store = deps.getStore()
    const allChats = store.chatOrder.map(chatId => store.chatsById[chatId]).filter((chat): chat is GroupChat => Boolean(chat))
    deps.storeSummaryEl.textContent = ui(`${allChats.length} 个群聊 · ${deps.getTemplates().length} 个角色`)
    const query = deps.state.chatListQuery
    if (deps.chatListSearchBoxEl) deps.chatListSearchBoxEl.hidden = !shouldShowChatSearch(allChats.length, query)
    if (deps.chatListSearchEl) deps.chatListSearchEl.placeholder = ui('搜索群聊')
    const listed = orderChatsForList(allChats, query, deps.getChatRecentSummary)
    const shown = JSON.stringify([
      language(), allChats.length, query, deps.state.selectedChatId, deps.state.chatMenuChatId, deps.state.chatSelection,
      listed.map(chat => [
        chat.id, chat.name, Boolean(chat.pinned), deps.getChatRecentSummary(chat), formatChatListTime(chat.updatedAt),
        Boolean(store.viewState?.chatHasNewMessageById?.[chat.id]), Boolean(chat.memoryDisabled), chat.scheduledTasks?.length ?? 0,
      ]),
    ])
    if (shown === drawnList) return
    drawnList = shown
    deps.chatListEl.replaceChildren()

    if (allChats.length === 0) {
      deps.chatListEl.append(deps.emptyCard(ui('还没有群聊'), ui('点上方的加号新建：按任务组队、从模板创建，或建一个空白群聊。')))
      return
    }

    const chats = listed
    const selection = deps.state.chatSelection
    if (selection) deps.chatListEl.append(selectionBar(chats, selection))
    if (chats.length === 0) {
      deps.chatListEl.append(deps.emptyCard(ui('没有找到群聊'), language() === 'en' ? `No group's name or last message contains "${query.trim()}".` : `没有名称或最近消息包含「${query.trim()}」的群聊。`))
      return
    }

    for (const chat of chats) {
      const item = document.createElement('section')
      const hasActivity = chat.id !== deps.state.selectedChatId && Boolean(store.viewState?.chatHasNewMessageById?.[chat.id])
      item.className = `chat-item${chat.id === deps.state.selectedChatId ? ' active' : ''}${hasActivity ? ' has-activity' : ''}${selection ? ' selecting' : ''}`
      // The whole row switches to the chat on a click; for the keyboard and screen readers its name is
      // the button (a row acting as a button could not hold the menu button too). While choosing
      // several, a click ticks the row instead.
      item.addEventListener('click', () => selection ? toggleSelected(chat.id) : switchChat(chat.id))

      const avatar = document.createElement('div')
      avatar.className = `chat-avatar ${deps.roleToneClass(chat.name)}`
      avatar.textContent = deps.roleAvatarLabel(chat.name)

      const body = document.createElement('div')
      body.className = 'chat-item-body'

      const row = document.createElement('div')
      row.className = 'chat-row chat-item-title'
      const name = document.createElement('button')
      name.type = 'button'
      name.className = 'chat-name'
      name.textContent = chat.name
      if (chat.id === deps.state.selectedChatId) name.setAttribute('aria-current', 'true')
      const menuButton = document.createElement('button')
      menuButton.type = 'button'
      menuButton.className = 'icon-btn chat-menu-btn'
      menuButton.setAttribute('aria-label', language() === 'en' ? `Open chat menu for ${chat.name}` : `打开 ${chat.name} 的群聊菜单`)
      menuButton.append(moreIcon())
      menuButton.addEventListener('click', event => {
        event.stopPropagation()
        deps.state.chatMenuChatId = deps.state.chatMenuChatId === chat.id ? undefined : chat.id
        renderChatList()
      })
      row.append(name)
      if (chat.pinned) row.append(pinMark())

      const summary = document.createElement('div')
      summary.className = 'summary-line'
      summary.textContent = deps.getChatRecentSummary(chat)

      body.append(row, summary)

      const side = document.createElement('div')
      side.className = 'chat-item-side'
      const time = document.createElement('span')
      time.className = 'chat-time'
      time.textContent = formatChatListTime(chat.updatedAt)
      if (selection) {
        const tick = document.createElement('input')
        tick.type = 'checkbox'
        tick.className = 'chat-select-check'
        tick.dataset.focusKey = `select:${chat.id}`
        tick.checked = selection.includes(chat.id)
        tick.setAttribute('aria-label', language() === 'en' ? `Select "${chat.name}"` : `选择「${chat.name}」`)
        tick.addEventListener('click', event => event.stopPropagation())
        tick.addEventListener('change', () => toggleSelected(chat.id))
        side.append(time, tick)
      } else {
        side.append(time, menuButton)
      }

      item.append(avatar, body, side)
      if (!selection && deps.state.chatMenuChatId === chat.id) item.append(chatActionMenu(chat))
      deps.chatListEl.append(item)
    }
  }

  function toggleSelected(chatId: string): void {
    const selection = deps.state.chatSelection ?? []
    deps.state.chatSelection = selection.includes(chatId) ? selection.filter(id => id !== chatId) : [...selection, chatId]
    renderChatList()
  }

  function leaveSelection(): void {
    deps.state.chatSelection = undefined
    renderChatList()
  }

  // Over the list while choosing several: how many are ticked, all or none of those listed (the
  // search may hide some), delete, and leave.
  function selectionBar(listed: GroupChat[], selection: string[]): HTMLElement {
    const en = language() === 'en'
    const bar = document.createElement('div')
    bar.className = 'chat-select-bar'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', en ? 'Selected groups' : '选中的群聊')
    const count = document.createElement('span')
    count.className = 'chat-select-count'
    count.setAttribute('aria-live', 'polite')
    count.textContent = en ? `${selection.length} selected` : `已选 ${selection.length} 个`
    const allListed = listed.length > 0 && listed.every(chat => selection.includes(chat.id))
    const all = barButton(allListed ? (en ? 'Select none' : '全不选') : (en ? 'Select all' : '全选'), 'btn btn-ghost', () => {
      deps.state.chatSelection = allListed ? selection.filter(id => !listed.some(chat => chat.id === id)) : [...new Set([...selection, ...listed.map(chat => chat.id)])]
      renderChatList()
    }, 'select-bar:all')
    const remove = barButton(en ? 'Delete' : '删除', 'btn btn-ghost btn-danger', () => {
      deleteSelected().catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    }, 'select-bar:delete')
    remove.disabled = selection.length === 0
    const cancel = barButton(en ? 'Cancel' : '取消', 'btn btn-ghost', leaveSelection, 'select-bar:cancel')
    bar.append(count, all, remove, cancel)
    return bar
  }

  function barButton(text: string, className: string, onClick: () => void, focusKey: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.dataset.focusKey = focusKey
    button.textContent = text
    button.addEventListener('click', event => {
      event.stopPropagation()
      onClick()
    })
    return button
  }

  // One yes for all of them, counting the memory items that go too.
  async function deleteSelected(): Promise<void> {
    const store = deps.getStore()
    const chats = (deps.state.chatSelection ?? []).map(id => store.chatsById[id]).filter((chat): chat is GroupChat => Boolean(chat))
    if (chats.length === 0) return
    const memoryCount = chats.reduce((total, chat) => total + countMemoryForChat(store, chat.id, chat.roleIds), 0)
    const question = language() === 'en'
      ? `Delete the ${chats.length} selected ${chats.length === 1 ? 'group' : 'groups'}? Their messages and members are removed${memoryCount ? `, and the ${memoryCount} memory ${memoryCount === 1 ? 'item' : 'items'} saved for them too` : ''}. This cannot be undone.`
      : `确定删除选中的 ${chats.length} 个群聊吗？它们的消息和成员都会移除${memoryCount ? `，为它们保存的 ${memoryCount} 条记忆也会一并删除` : ''}。删除后无法恢复。`
    if (!window.confirm(question)) return
    const chatIds = chats.map(chat => chat.id)
    const response = await deps.sendRuntimeMessage<{ deleted?: number }>('GROUP_CHATS_DELETE', { chatIds })
    if (response.ok === false) throw new Error(response.error || '删除群聊失败')
    for (const chatId of chatIds) deps.iframeHost.removeChat(chatId)
    deps.state.chatSelection = undefined
    deps.applyStore(response.store ?? createDefaultStore())
    renderChatList()
  }

  function switchChat(chatId: string) {
    if (chatId === deps.state.selectedChatId) {
      deps.state.chatMenuChatId = undefined
      deps.state.roleSiteMenuRoleId = undefined
      renderChatList()
      deps.renderRolePanel()
      return
    }
    deps.state.selectedChatId = chatId
    deps.state.pendingChatSwitchId = chatId
    deps.state.selectedRoleId = undefined
    deps.state.selectedReference = undefined
    deps.state.peopleDrawerOpen = false
    deps.state.chatMenuChatId = undefined
    deps.state.roleSiteMenuRoleId = undefined
    deps.renderSelectedChat()
    if (deps.state.pendingSwitchAnimationFrame !== undefined) window.cancelAnimationFrame(deps.state.pendingSwitchAnimationFrame)
    deps.state.pendingSwitchAnimationFrame = window.requestAnimationFrame(() => {
      deps.state.pendingSwitchAnimationFrame = undefined
      if (deps.state.selectedChatId !== chatId) {
        if (deps.state.pendingChatSwitchId === chatId) deps.state.pendingChatSwitchId = undefined
        return
      }
      deps.runCommand('GROUP_CHAT_SWITCH', { chatId })
        .catch(error => deps.showError(error.message))
        // Done or refused, the store leads again.
        .finally(() => { if (deps.state.pendingChatSwitchId === chatId) deps.state.pendingChatSwitchId = undefined })
    })
  }

  function pinMark(): HTMLElement {
    const mark = document.createElement('span')
    mark.className = 'chat-pin-mark'
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', ui('已置顶'))
    mark.title = ui('已置顶')
    mark.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none"><path d="M9 4h6l-1 5 3 3H7l3-3-1-5Z" /><path d="M12 12v8" /></svg>'
    return mark
  }

  function chatActionMenu(chat: GroupChat): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'chat-action-menu'
    menu.addEventListener('click', event => event.stopPropagation())
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'btn btn-ghost'
    pin.textContent = ui(chat.pinned ? '取消置顶' : '置顶群聊')
    pin.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      deps.runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, patch: { pinned: !chat.pinned } }).catch(error => deps.showError(error.message))
    })
    const rename = document.createElement('button')
    rename.type = 'button'
    rename.className = 'btn btn-ghost'
    rename.textContent = ui('编辑名称')
    rename.addEventListener('click', () => {
      const nextName = window.prompt(ui('编辑名称'), chat.name)?.trim()
      deps.state.chatMenuChatId = undefined
      if (!nextName) {
        renderChatList()
        return
      }
      deps.runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, patch: { name: nextName } }).catch(error => deps.showError(error.message))
    })
    const duplicate = document.createElement('button')
    duplicate.type = 'button'
    duplicate.className = 'btn btn-ghost'
    duplicate.textContent = ui('复制群聊')
    duplicate.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      deps.runCommand('GROUP_CHAT_DUPLICATE', { chatId: chat.id }).catch(error => deps.showError(error.message))
    })
    const exportRecord = document.createElement('button')
    exportRecord.type = 'button'
    exportRecord.className = 'btn btn-ghost'
    exportRecord.textContent = ui('导出记录')
    exportRecord.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      exportChatRecord(chat)
    })
    // Stops this group's members being sent memory items, without deleting any.
    const memory = document.createElement('button')
    memory.type = 'button'
    memory.className = 'btn btn-ghost'
    memory.dataset.chatMemoryToggle = chat.id
    memory.textContent = chat.memoryDisabled ? ui('开启本群记忆') : ui('关闭本群记忆')
    memory.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      deps.runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, patch: { memoryDisabled: !chat.memoryDisabled } }).catch(error => deps.showError(error.message))
    })
    // Messages the group sends itself at set times (scheduledTasksDialog.ts).
    const schedule = document.createElement('button')
    schedule.type = 'button'
    schedule.className = 'btn btn-ghost'
    schedule.dataset.chatSchedule = chat.id
    const taskCount = chat.scheduledTasks?.length ?? 0
    schedule.textContent = taskCount > 0 ? `${ui('定时任务')} (${taskCount})` : ui('定时任务')
    schedule.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      openScheduledTasksDialog(chat.id, { getStore: deps.getStore, runCommand: deps.runCommand })
    })
    // 群资料库 (libraryDialog.ts), with how many documents it has.
    const library = document.createElement('button')
    library.type = 'button'
    library.className = 'btn btn-ghost'
    library.dataset.chatLibrary = chat.id
    const docCount = deps.getStore().libraryByChatId?.[chat.id]?.length ?? 0
    library.textContent = docCount > 0 ? `${ui('资料库')} (${docCount})` : ui('资料库')
    library.hidden = !deps.openLibrary
    library.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      deps.openLibrary?.(chat.id)
    })
    const clearMessages = document.createElement('button')
    clearMessages.type = 'button'
    clearMessages.className = 'btn btn-ghost'
    clearMessages.textContent = ui('清空消息')
    clearMessages.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      if (!window.confirm(`确定清空「${chat.name}」的聊天消息吗？成员会保留，但所有 iframe 会重新创建。`)) return
      clearChatMessages(chat.id).catch(error => deps.showError(error.message))
    })
    const closeFrames = document.createElement('button')
    closeFrames.type = 'button'
    closeFrames.className = 'btn btn-ghost'
    closeFrames.textContent = ui('关闭群聊')
    closeFrames.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      closeChatFrames(chat.id).catch(error => deps.showError(error.message))
    })
    const select = document.createElement('button')
    select.type = 'button'
    select.className = 'btn btn-ghost'
    select.textContent = ui('选择多个…')
    select.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      deps.state.chatSelection = [chat.id]
      renderChatList()
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-ghost btn-danger'
    remove.textContent = ui('删除群聊')
    remove.addEventListener('click', () => {
      deps.state.chatMenuChatId = undefined
      renderChatList()
      // The group's memory items go with it; say how many before the user agrees.
      const memoryCount = countMemoryForChat(deps.getStore(), chat.id, chat.roleIds)
      const question = language() === 'en'
        ? `Delete "${chat.name}"? Its messages and members are removed.${memoryCount ? ` The ${memoryCount} memory ${memoryCount === 1 ? 'item' : 'items'} saved for this group and its members will be deleted too.` : ''}`
        : `确定删除「${chat.name}」吗？删除后这个群聊的消息和角色都会移除。${memoryCount ? `为这个群和它的成员保存的 ${memoryCount} 条记忆也会一并删除。` : ''}`
      if (!window.confirm(question)) return
      deleteChat(chat.id).catch(error => deps.showError(error.message))
    })
    menu.append(pin, rename, duplicate, exportRecord, memory, schedule, library, clearMessages, closeFrames, select, remove)
    return menu
  }

  function language() {
    return normalizeLanguage(deps.getStore().settings.language)
  }

  function ui(source: string): string {
    return translateUi(source, language())
  }

  function exportChatRecord(chat: GroupChat): void {
    try {
      const exportedAt = new Date()
      const markdown = formatChatExportMarkdown(deps.getStore(), chat, exportedAt)
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = safeChatExportFilename(chat.name, exportedAt)
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : '导出群聊记录失败')
    }
  }

  async function clearChatMessages(chatId: string): Promise<void> {
    await deps.runCommand('GROUP_CHAT_CLEAR_MESSAGES', { chatId })
    deps.state.messageNodeCache.clear()
    deps.iframeHost.removeChat(chatId)
    const store = deps.getStore()
    const chat = store.chatsById[chatId]
    if (chat && deps.state.selectedChatId === chatId) {
      const roles = chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role) && role.modelSource !== 'external')
      deps.iframeHost.restoreChat({ ...chat, roleIds: roles.map(role => role.id) }, roles)
    }
  }

  async function closeChatFrames(chatId: string): Promise<void> {
    await deps.runCommand('GROUP_CHAT_CLOSE', { chatId })
    deps.iframeHost.removeChat(chatId)
  }

  async function deleteChat(chatId: string): Promise<void> {
    const response = await deps.sendRuntimeMessage('GROUP_CHAT_DELETE', { chatId })
    if (response.ok === false) {
      if (response.error === 'Unknown OpenTeam message') {
        deps.log.warn('chat-delete:fallback-local-store', { chatId, error: response.error })
        await deleteChatFromLocalStore(chatId)
        return
      }
      throw new Error(response.error || '删除群聊失败')
    }
    deps.iframeHost.removeChat(chatId)
    deps.applyStore(response.store ?? createDefaultStore())
  }

  async function deleteChatFromLocalStore(chatId: string): Promise<void> {
    const nextStore = await loadStore()
    const chat = nextStore.chatsById[chatId]
    if (!chat) throw new Error(`找不到群聊：${chatId}`)

    deleteMemoryForChat(nextStore, chat.id, chat.roleIds)
    for (const roleId of chat.roleIds) delete nextStore.rolesById[roleId]
    for (const messageId of chat.messageIds) delete nextStore.messagesById[messageId]
    nextStore.chatOrder = nextStore.chatOrder.filter(id => id !== chat.id)
    delete nextStore.chatsById[chat.id]
    if (nextStore.currentChatId === chat.id) nextStore.currentChatId = nextStore.chatOrder[0]
    if (nextStore.viewState?.chatReadSeqById) delete nextStore.viewState.chatReadSeqById[chat.id]
    if (nextStore.viewState?.chatHasNewMessageById) delete nextStore.viewState.chatHasNewMessageById[chat.id]

    await saveStore(nextStore)
    deps.iframeHost.removeChat(chatId)
    deps.applyStore(nextStore)
  }

  return { renderChatList, switchChat }
}

// Three dots, drawn like the page's other icons.
function moreIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  for (const cx of [6, 12, 18]) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('cx', String(cx))
    dot.setAttribute('cy', '12')
    dot.setAttribute('r', '1.2')
    svg.append(dot)
  }
  return svg
}
