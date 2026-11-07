// The header's drop-down menus (工作流, 更多): a click opens one, and a choice, a click elsewhere or
// Escape closes it; the arrow keys move between its items. An item with data-menu-proxy stands in for
// a header button that narrow windows hide: it clicks that button, and shows only while the button
// could be used.
export interface HeaderMenus {
  closeAll(): void
}

interface MenuPair {
  trigger: HTMLButtonElement
  menu: HTMLElement
}

export function registerHeaderMenus(root: HTMLElement, documentRef: Document = document): HeaderMenus {
  const pairs: MenuPair[] = [...root.querySelectorAll<HTMLButtonElement>('.header-menu-trigger[aria-controls]')]
    .map(trigger => ({ trigger, menu: documentRef.getElementById(trigger.getAttribute('aria-controls') ?? '') }))
    .filter((pair): pair is MenuPair => pair.menu instanceof HTMLElement)

  function usable(button: HTMLElement): boolean {
    if (button.hidden || (button as HTMLButtonElement).disabled) return false
    // A button inside a closed menu is still usable; one inside a hidden part of the header is not.
    for (let element = button.parentElement; element; element = element.parentElement) {
      if (element.hidden && element.getAttribute('role') !== 'menu') return false
    }
    return true
  }

  function items(menu: HTMLElement): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .filter(item => !item.hidden && documentRef.defaultView?.getComputedStyle(item).display !== 'none')
  }

  function syncProxies(menu: HTMLElement): void {
    for (const item of menu.querySelectorAll<HTMLButtonElement>('[data-menu-proxy]')) {
      const target = documentRef.getElementById(item.dataset.menuProxy ?? '')
      item.hidden = !target || !usable(target)
    }
  }

  function close(pair: MenuPair, returnFocus = false): void {
    if (pair.menu.hidden) return
    pair.menu.hidden = true
    pair.trigger.setAttribute('aria-expanded', 'false')
    if (returnFocus) pair.trigger.focus()
  }

  function closeAll(): void {
    for (const pair of pairs) close(pair)
  }

  function open(pair: MenuPair, focusFirst: boolean): void {
    closeAll()
    syncProxies(pair.menu)
    pair.menu.hidden = false
    pair.trigger.setAttribute('aria-expanded', 'true')
    if (focusFirst) items(pair.menu)[0]?.focus()
  }

  for (const pair of pairs) {
    pair.trigger.addEventListener('click', () => {
      if (pair.menu.hidden) open(pair, false)
      else close(pair)
    })
    pair.trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown') return
      event.preventDefault()
      open(pair, true)
    })
    pair.menu.addEventListener('click', event => {
      const item = (event.target as Element | null)?.closest<HTMLButtonElement>('[role="menuitem"]')
      if (!item) return
      close(pair)
      const proxied = item.dataset.menuProxy ? documentRef.getElementById(item.dataset.menuProxy) : null
      proxied?.click()
    })
    pair.menu.addEventListener('keydown', event => {
      const list = items(pair.menu)
      const at = list.indexOf(documentRef.activeElement as HTMLButtonElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        list[(at + step + list.length) % list.length]?.focus()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close(pair, true)
      } else if (event.key === 'Tab') {
        close(pair)
      }
    })
  }

  documentRef.addEventListener('click', event => {
    const target = event.target as Node | null
    for (const pair of pairs) {
      if (!pair.menu.contains(target) && !pair.trigger.contains(target)) close(pair)
    }
  })
  documentRef.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const openPair = pairs.find(pair => !pair.menu.hidden)
    if (openPair) close(openPair, true)
  })

  return { closeAll }
}
