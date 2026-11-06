// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createUiStyleController, UI_STYLE_STORAGE_KEY, type UiStyle } from './uiStyleController'

function createHarness(saved: UiStyle | 'bogus' | undefined) {
  const root = document.createElement('html')
  const chatgpt = document.createElement('button')
  const grok = document.createElement('button')
  const menuChatgpt = document.createElement('button')
  const menuGrok = document.createElement('button')
  const values = new Map<string, string>()
  if (saved) values.set(UI_STYLE_STORAGE_KEY, saved)
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  } as Storage
  const controller = createUiStyleController({ root, buttons: { chatgpt: [chatgpt, menuChatgpt], grok: [grok, menuGrok] }, storage })
  return { root, chatgpt, grok, menuChatgpt, menuGrok, storage, controller }
}

describe('interface style controller', () => {
  it('starts in the ChatGPT style and saves nothing until a style is picked', () => {
    const harness = createHarness(undefined)
    harness.controller.initializeStyle()

    expect(harness.root.dataset.uiStyle).toBe('chatgpt')
    expect(harness.chatgpt.getAttribute('aria-pressed')).toBe('true')
    expect(harness.grok.getAttribute('aria-pressed')).toBe('false')
    expect(harness.storage.getItem(UI_STYLE_STORAGE_KEY)).toBeNull()
  })

  it('restores a saved style and ignores an unknown one', () => {
    const saved = createHarness('grok')
    saved.controller.initializeStyle()
    expect(saved.root.dataset.uiStyle).toBe('grok')
    expect(saved.grok.getAttribute('aria-pressed')).toBe('true')

    const bogus = createHarness('bogus')
    bogus.controller.initializeStyle()
    expect(bogus.root.dataset.uiStyle).toBe('chatgpt')
  })

  it('switches style from its buttons and remembers it', () => {
    const harness = createHarness(undefined)
    harness.controller.initializeStyle()
    harness.controller.registerStyleEvents()
    harness.controller.registerStyleEvents()

    harness.grok.click()
    expect(harness.root.dataset.uiStyle).toBe('grok')
    expect(harness.controller.getStyle()).toBe('grok')
    expect(harness.storage.getItem(UI_STYLE_STORAGE_KEY)).toBe('grok')
    expect([harness.chatgpt.getAttribute('aria-pressed'), harness.grok.getAttribute('aria-pressed')]).toEqual(['false', 'true'])

    harness.chatgpt.click()
    expect(harness.root.dataset.uiStyle).toBe('chatgpt')
    expect(harness.storage.getItem(UI_STYLE_STORAGE_KEY)).toBe('chatgpt')
  })

  it('keeps the header switch and the settings menu in step', () => {
    const harness = createHarness(undefined)
    harness.controller.initializeStyle()
    harness.controller.registerStyleEvents()

    harness.menuGrok.click()

    expect(harness.root.dataset.uiStyle).toBe('grok')
    expect([harness.grok, harness.menuGrok].map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'true'])
    expect([harness.chatgpt, harness.menuChatgpt].map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
  })
})
