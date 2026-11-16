// The memory store, listed: what is kept, for whom, and where each item came from. Every item can
// be edited, kept in every prompt, switched off for now, or deleted here
// (docs/MEMORY_STORE.zh-CN.md, section 6).
import { MAX_MEMORY_ITEMS, listMemoryItems } from '../group/memoryStore'
import type { MemoryItem, OpenTeamStore } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import { createIcon, type IconName } from './icons'
import { MEMORY_KIND_LABELS, openMemoryDialog } from './memoryDialog'

export interface MemoryPanelDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // The group on screen: new items are offered for it, and the list can be narrowed to it.
  getCurrentChatId?(): string | undefined
  confirm?(text: string): boolean
  onClose?(): void
}

type MemoryFilter = 'all' | 'global' | 'chat' | 'disabled'

// Where an item applies, in words.
export function memoryScopeLabel(store: OpenTeamStore, item: MemoryItem, english: boolean): string {
  const t = (zh: string, en: string): string => english ? en : zh
  if (item.scope === 'global') return t('全部群聊', 'Every group')
  if (item.scope === 'chat') {
    const chat = store.chatsById[item.scopeId ?? '']
    return chat ? t(`群聊「${chat.name}」`, `Group "${chat.name}"`) : t('已删除的群聊', 'A deleted group')
  }
  const role = store.rolesById[item.scopeId ?? '']
  const chat = role ? store.chatsById[role.chatId] : undefined
  if (!role) return t('已移除的成员', 'A removed member')
  return chat ? t(`「${chat.name}」里的「${role.name}」`, `"${role.name}" in "${chat.name}"`) : t(`成员「${role.name}」`, `Member "${role.name}"`)
}

// Whose words an item holds.
export function memorySourceLabel(store: OpenTeamStore, item: MemoryItem, english: boolean): string {
  const t = (zh: string, en: string): string => english ? en : zh
  if (item.source.origin === 'user') return t('你写的', 'Written by you')
  const role = store.rolesById[item.source.roleId ?? '']
  return role ? t(`出自「${role.name}」的回复`, `From "${role.name}"'s reply`) : t('出自一位成员的回复', 'From a member\'s reply')
}

export function openMemoryPanel(deps: MemoryPanelDependencies): void {
  document.querySelector('.memory-panel-modal')?.remove()
  const english = normalizeLanguage(deps.getStore().settings.language) === 'en'
  const t = (zh: string, en: string): string => english ? en : zh
  const confirm = deps.confirm ?? (text => window.confirm(text))
  const currentChat = () => deps.getStore().chatsById[deps.getCurrentChatId?.() ?? '']
  let query = ''
  let filter: MemoryFilter = 'all'
  let busy = false

  const backdrop = element('div', 'modal-backdrop memory-panel-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal memory-panel')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'memory-panel-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('记忆库', 'Memory'))
  title.id = 'memory-panel-title'
  const count = element('p', 'tiny memory-panel-count')
  heading.append(title, count)
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', close)
  header.append(heading, closeButton)

  const toolbar = element('div', 'memory-panel-toolbar')
  const search = element('input', 'memory-panel-search')
  search.type = 'search'
  search.autocomplete = 'off'
  search.placeholder = t('搜索记忆', 'Search memory')
  search.setAttribute('aria-label', t('搜索记忆', 'Search memory'))
  search.addEventListener('input', () => {
    query = search.value
    renderList()
  })
  const filterSelect = element('select', 'memory-panel-filter')
  filterSelect.setAttribute('aria-label', t('筛选范围', 'Filter by scope'))
  const filterOptions: Array<[MemoryFilter, string]> = [['all', t('全部', 'All')], ['global', t('全部群聊的', 'For every group')]]
  const chatAtOpen = currentChat()
  if (chatAtOpen) filterOptions.push(['chat', t(`「${chatAtOpen.name}」和它的成员的`, `For "${chatAtOpen.name}" and its members`)])
  filterOptions.push(['disabled', t('已停用的', 'Switched off')])
  for (const [value, label] of filterOptions) {
    const option = element('option', '', label)
    option.value = value
    filterSelect.append(option)
  }
  filterSelect.addEventListener('change', () => {
    filter = filterSelect.value as MemoryFilter
    renderList()
  })
  const add = element('button', 'btn btn-primary btn-small memory-panel-add')
  add.type = 'button'
  add.append(createIcon('plus'), element('span', '', t('新建记忆', 'New item')))
  add.addEventListener('click', () => openDialog(undefined, add))
  toolbar.append(search, filterSelect, add)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const list = element('ul', 'memory-panel-list')
  const empty = element('p', 'memory-panel-empty')
  empty.setAttribute('role', 'status')

  dialog.append(header, toolbar, error, list, empty)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  renderList()
  search.focus()

  function visibleItems(store: OpenTeamStore): MemoryItem[] {
    const chat = currentChat()
    const members = new Set(chat?.roleIds ?? [])
    const words = query.trim().toLowerCase()
    return listMemoryItems(store).filter(item => {
      if (filter === 'global' && item.scope !== 'global') return false
      if (filter === 'disabled' && !item.disabled) return false
      if (filter === 'chat' && !(item.scope === 'chat' && item.scopeId === chat?.id) && !(item.scope === 'role' && members.has(item.scopeId ?? ''))) return false
      return !words || [item.content, ...(item.tags ?? [])].some(text => text.toLowerCase().includes(words))
    })
  }

  function renderList(): void {
    const store = deps.getStore()
    const total = listMemoryItems(store).length
    const items = visibleItems(store)
    count.textContent = t(
      `${total} / ${MAX_MEMORY_ITEMS} 条。成员只在相关的问题里读到它们；常驻的每次都带上。`,
      `${total} / ${MAX_MEMORY_ITEMS} items. Members read them when a question brings them up; pinned ones are always included.`,
    )
    list.replaceChildren(...items.map(item => itemRow(store, item)))
    list.hidden = items.length === 0
    empty.hidden = items.length > 0
    empty.textContent = total === 0
      ? t('还没有记忆。在一条消息下面点"记住这条"，或者在这里新建。', 'Nothing saved yet. Use "Remember this" under a message, or add an item here.')
      : t('没有符合的记忆。', 'No item matches.')
  }

  function itemRow(store: OpenTeamStore, item: MemoryItem): HTMLLIElement {
    const row = element('li', `memory-panel-item${item.disabled ? ' is-disabled' : ''}`)
    row.dataset.memoryItem = item.id
    const meta = element('div', 'memory-panel-meta')
    meta.append(
      element('span', 'memory-panel-badge memory-panel-kind', MEMORY_KIND_LABELS[item.kind][english ? 1 : 0]),
      element('span', 'memory-panel-scope', memoryScopeLabel(store, item, english)),
    )
    if (item.pinned) meta.append(element('span', 'memory-panel-badge', t('常驻', 'Pinned')))
    if (item.disabled) meta.append(element('span', 'memory-panel-badge memory-panel-off', t('已停用', 'Off')))
    meta.append(element('span', 'memory-panel-source', memorySourceLabel(store, item, english)))
    const content = element('p', 'memory-panel-content', item.content)
    row.append(meta, content)
    if (item.tags?.length) {
      const tags = element('p', 'tiny memory-panel-tags', `${t('标签：', 'Tags: ')}${item.tags.join(english ? ', ' : '、')}`)
      row.append(tags)
    }
    const actions = element('div', 'memory-panel-actions')
    actions.append(
      actionButton(item, 'edit', t('编辑', 'Edit'), 'edit', button => openDialog(item, button)),
      actionButton(item, 'pin', item.pinned ? t('取消常驻', 'Unpin') : t('设为常驻', 'Pin'), undefined, () => run(item, 'pin', 'GROUP_MEMORY_UPDATE', { itemId: item.id, patch: { pinned: !item.pinned } })),
      actionButton(item, 'toggle', item.disabled ? t('启用', 'Switch on') : t('停用', 'Switch off'), undefined, () => run(item, 'toggle', 'GROUP_MEMORY_UPDATE', { itemId: item.id, patch: { disabled: !item.disabled } })),
      actionButton(item, 'delete', t('删除', 'Delete'), 'trash', () => {
        if (!confirm(t('确定删除这条记忆吗？删除后无法恢复。', 'Delete this item? It cannot be brought back.'))) return
        void run(item, 'delete', 'GROUP_MEMORY_DELETE', { itemId: item.id })
      }),
    )
    row.append(actions)
    return row
  }

  function actionButton(item: MemoryItem, action: string, label: string, icon: IconName | undefined, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const button = element('button', 'btn btn-ghost btn-small memory-panel-action')
    button.type = 'button'
    button.dataset.memoryAction = action
    if (icon) button.append(createIcon(icon))
    button.append(element('span', '', label))
    // Read with the item's text, so a screen reader's list of buttons tells the rows apart.
    button.setAttribute('aria-label', `${label}${english ? ': ' : '：'}${preview(item.content)}`)
    button.addEventListener('click', () => onClick(button))
    return button
  }

  async function run(item: MemoryItem, action: string, type: string, payload: Record<string, unknown>): Promise<void> {
    if (busy) return
    busy = true
    error.textContent = ''
    try {
      await deps.runCommand(type, payload)
    } catch (caught) {
      error.textContent = translateUi(caught instanceof Error ? caught.message : String(caught), english ? 'en' : 'zh-CN')
    } finally {
      busy = false
      renderList()
      // The row was redrawn: put the focus back on the button that was pressed, or on the search
      // box when its row is gone.
      const again = [...list.querySelectorAll<HTMLElement>('[data-memory-item]')].find(row => row.dataset.memoryItem === item.id)?.querySelector<HTMLButtonElement>(`[data-memory-action="${action}"]`)
      ;(again ?? search).focus()
    }
  }

  function openDialog(item: MemoryItem | undefined, opener: HTMLButtonElement): void {
    const itemId = item?.id
    openMemoryDialog({ ...(item ? { item } : {}), ...(currentChat() ? { chatId: currentChat().id } : {}) }, {
      getStore: deps.getStore,
      runCommand: deps.runCommand,
      onClose: () => {
        renderList()
        const again = itemId ? [...list.querySelectorAll<HTMLElement>('[data-memory-item]')].find(row => row.dataset.memoryItem === itemId)?.querySelector<HTMLButtonElement>('[data-memory-action="edit"]') : undefined
        ;(again ?? (opener.isConnected ? opener : search)).focus()
      },
    })
  }

  function handleEscape(event: KeyboardEvent): void {
    // The save window opened from here closes first.
    if (event.key !== 'Escape' || document.querySelector('.memory-dialog-modal')) return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }
}

function preview(content: string): string {
  const characters = [...content.replace(/\s+/g, ' ')]
  return characters.length > 30 ? `${characters.slice(0, 30).join('')}…` : characters.join('')
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
