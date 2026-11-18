// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { movePanelTools } from './panelTools'

function setup() {
  document.body.innerHTML = `
    <nav class="rail"><div class="rail-actions"><button id="rail-chats"></button><button id="search"></button><button id="notes"></button></div>
      <div class="rail-bottom"><button id="open-in-tab"></button><button id="settings"></button></div></nav>
    <aside id="chat-sidebar"><div class="chat-list"></div></aside>`
  const sidebar = document.getElementById('chat-sidebar')!
  const buttons = ['search', 'notes', 'open-in-tab', 'settings'].map(id => document.getElementById(id) as HTMLButtonElement)
  return { sidebar, buttons }
}

describe('the side panel’s tools, in a row at the bottom of the group list', () => {
  it('moves the rail’s buttons there, in order, as a labelled toolbar', () => {
    const { sidebar, buttons } = setup()
    const row = movePanelTools({ sidebarEl: sidebar, buttons, label: '工具', onUse: vi.fn() })
    expect(row.parentElement).toBe(sidebar)
    expect(sidebar.lastElementChild).toBe(row)
    expect(row.getAttribute('role')).toBe('toolbar')
    expect(row.getAttribute('aria-label')).toBe('工具')
    expect([...row.querySelectorAll('button')].map(button => button.id)).toEqual(['search', 'notes', 'open-in-tab', 'settings'])
    expect(document.querySelector('.rail')!.querySelectorAll('button').length).toBe(1)
  })

  it('lets the list close first when one is used, even if the button stops the click there', () => {
    const { sidebar, buttons } = setup()
    const onUse = vi.fn()
    movePanelTools({ sidebarEl: sidebar, buttons, label: '工具', onUse })
    const settings = buttons[3]
    const opened = vi.fn()
    settings.addEventListener('click', event => {
      event.stopPropagation()
      opened()
    })
    settings.click()
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledTimes(1)
  })
})
