// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { registerSettingsWindow } from './settingsWindow'

afterEach(() => document.body.replaceChildren())

function setup() {
  document.body.innerHTML = `
    <button id="settings-button" aria-expanded="true"></button>
    <div id="settings-menu">
      <button id="close-settings"></button>
      <button data-settings-tab="general" aria-selected="true"></button>
      <button data-settings-tab="replies" aria-selected="false"></button>
      <button data-settings-tab="data" aria-selected="false"></button>
      <section data-settings-panel="general"></section>
      <section data-settings-panel="replies" hidden></section>
      <section data-settings-panel="data" hidden></section>
    </div>`
  const windowEl = document.querySelector<HTMLElement>('#settings-menu')!
  const settingsButtonEl = document.querySelector<HTMLButtonElement>('#settings-button')!
  const tab = (name: string) => document.querySelector<HTMLButtonElement>(`[data-settings-tab="${name}"]`)!
  const panel = (name: string) => document.querySelector<HTMLElement>(`[data-settings-panel="${name}"]`)!
  registerSettingsWindow({ windowEl, settingsButtonEl })
  return { windowEl, settingsButtonEl, tab, panel }
}

describe('settings window', () => {
  it('shows one category at a time', () => {
    const { tab, panel } = setup()
    expect(panel('general').hidden).toBe(false)
    expect(panel('replies').hidden).toBe(true)

    tab('replies').click()
    expect(tab('replies').getAttribute('aria-selected')).toBe('true')
    expect(tab('general').getAttribute('aria-selected')).toBe('false')
    expect(panel('replies').hidden).toBe(false)
    expect(panel('general').hidden).toBe(true)
  })

  it('moves between categories with the arrow keys, wrapping around', () => {
    const { tab, panel } = setup()
    tab('general').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(panel('data').hidden).toBe(false)
    expect(document.activeElement).toBe(tab('data'))
    tab('data').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(panel('general').hidden).toBe(false)
  })

  it('closes from its close button', () => {
    const { windowEl, settingsButtonEl } = setup()
    document.querySelector<HTMLButtonElement>('#close-settings')!.click()
    expect(windowEl.hidden).toBe(true)
    expect(settingsButtonEl.getAttribute('aria-expanded')).toBe('false')
  })
})
