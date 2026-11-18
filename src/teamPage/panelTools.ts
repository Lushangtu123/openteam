// In the side panel the rail is not shown (it took an eighth of the width): its buttons (search,
// notes, the people library, 在标签页中打开, settings) move into a row at the bottom of the group
// list, which opens from the header's list button. They keep their ids and what they do. Using one
// closes the list first, so what it opens is not behind it.
export function movePanelTools(options: {
  sidebarEl: HTMLElement
  buttons: HTMLButtonElement[]
  label: string
  onUse(): void
}): HTMLElement {
  const row = options.sidebarEl.ownerDocument.createElement('div')
  row.className = 'panel-tools'
  row.setAttribute('role', 'toolbar')
  row.setAttribute('aria-label', options.label)
  row.append(...options.buttons)
  // Before the buttons' own handlers, some of which stop the click from going further.
  row.addEventListener('click', event => {
    if ((event.target as Element | null)?.closest('button')) options.onUse()
  }, true)
  options.sidebarEl.append(row)
  return row
}
