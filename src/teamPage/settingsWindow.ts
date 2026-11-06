// The settings window: categories on the left (tabs), one row per setting on the right. Opening and
// closing (the ⚙ button, Esc, a click outside) are handled with the other popovers in
// teamUiController; this adds the tabs and the close button.

export interface SettingsWindowDependencies {
  windowEl: HTMLElement
  settingsButtonEl: HTMLButtonElement
}

export function registerSettingsWindow(deps: SettingsWindowDependencies): { selectTab(name: string): void } {
  const tabs = [...deps.windowEl.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')]
  const panels = [...deps.windowEl.querySelectorAll<HTMLElement>('[data-settings-panel]')]

  function selectTab(name: string): void {
    for (const tab of tabs) {
      const selected = tab.dataset.settingsTab === name
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== name
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.settingsTab ?? ''))
    // Up and down move between categories, as in a vertical tab list.
    tab.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const next = tabs[(index + (event.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length]
      selectTab(next.dataset.settingsTab ?? '')
      next.focus()
    })
  })
  deps.windowEl.querySelector<HTMLButtonElement>('#close-settings')?.addEventListener('click', () => {
    deps.windowEl.hidden = true
    deps.settingsButtonEl.setAttribute('aria-expanded', 'false')
    deps.settingsButtonEl.focus()
  })
  selectTab(tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.dataset.settingsTab ?? tabs[0]?.dataset.settingsTab ?? '')
  return { selectTab }
}
