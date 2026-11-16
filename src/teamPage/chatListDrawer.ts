// In narrow windows the group list leaves the layout and slides in over the chat, opened from the
// header's list button or the rail's 群聊 button. Choosing a group, Escape, or a click outside closes
// it; widening the window puts it back in the layout. In wide windows the list is always shown, and
// those buttons take the focus to it instead. Either way the focus lands in the list: on its search
// box when there is one, else on the open group, else on the first group.
export const CHAT_LIST_OPEN_CLASS = 'chat-list-open'
export const NARROW_LAYOUT_QUERY = '(max-width: 860px)'

export interface NarrowQuery {
  matches: boolean
  addEventListener?(type: 'change', listener: () => void): void
}

export interface ChatListDrawerDependencies {
  appShellEl: HTMLElement
  sidebarEl: HTMLElement
  toggles: HTMLButtonElement[]
  narrowQuery: NarrowQuery
  documentRef?: Document
}

export function registerChatListDrawer(deps: ChatListDrawerDependencies) {
  const documentRef = deps.documentRef ?? document
  const isOpen = () => deps.appShellEl.classList.contains(CHAT_LIST_OPEN_CLASS)

  function setOpen(open: boolean): void {
    deps.appShellEl.classList.toggle(CHAT_LIST_OPEN_CLASS, open)
    for (const toggle of deps.toggles) toggle.setAttribute('aria-expanded', String(open))
  }

  function focusList(): void {
    const search = deps.sidebarEl.querySelector<HTMLInputElement>('#chat-list-search')
    const searchShown = search && !search.closest('[hidden]') && search.getClientRects().length > 0
    const target = searchShown
      ? search
      : deps.sidebarEl.querySelector<HTMLElement>('.chat-name[aria-current="true"]') ?? deps.sidebarEl.querySelector<HTMLElement>('.chat-name')
    target?.focus()
  }

  for (const toggle of deps.toggles) {
    toggle.addEventListener('click', event => {
      if (!deps.narrowQuery.matches) {
        focusList()
        return
      }
      event.stopPropagation()
      const opening = !isOpen()
      setOpen(opening)
      if (opening) focusList()
    })
  }
  deps.sidebarEl.addEventListener('click', event => {
    const target = event.target as Element | null
    // A chat picked (its row or its name, also with the keyboard); not its menu.
    if (target?.closest('.chat-item') && !target.closest('button:not(.chat-name), [role="menu"], .chat-item-menu')) setOpen(false)
  })
  deps.sidebarEl.addEventListener('submit', () => setOpen(false))
  documentRef.addEventListener('click', event => {
    if (!isOpen()) return
    const target = event.target as Node | null
    if (target && (deps.sidebarEl.contains(target) || deps.toggles.some(toggle => toggle.contains(target)))) return
    setOpen(false)
  })
  documentRef.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) setOpen(false)
  })
  deps.narrowQuery.addEventListener?.('change', () => {
    if (!deps.narrowQuery.matches) setOpen(false)
  })

  return { close: () => setOpen(false), isOpen }
}
