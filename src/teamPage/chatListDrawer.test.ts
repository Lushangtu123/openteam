// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_LIST_OPEN_CLASS, registerChatListDrawer } from './chatListDrawer'

afterEach(() => {
  document.body.replaceChildren()
})

function setup(narrow: boolean) {
  document.body.innerHTML = `
    <div id="app">
      <button id="rail-chats"></button>
      <aside id="sidebar">
        <section class="chat-item"><button class="chat-name" type="button">群聊 A</button> <button class="chat-menu-btn">更多</button></section>
        <form id="create"><button type="submit">创建</button></form>
      </aside>
      <main><button id="open-chat-list"></button><p id="chat">聊天</p></main>
    </div>
  `
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  let listener: (() => void) | undefined
  const query = { matches: narrow, addEventListener: (_type: 'change', next: () => void) => { listener = next } }
  const drawer = registerChatListDrawer({ appShellEl: $('app'), sidebarEl: $('sidebar'), toggles: [$('open-chat-list'), $('rail-chats')], narrowQuery: query })
  const open = () => $('app').classList.contains(CHAT_LIST_OPEN_CLASS)
  const resize = (next: boolean) => { query.matches = next; listener?.() }
  return { $, drawer, open, resize }
}

describe('chat list drawer', () => {
  it('opens from the header or the rail in narrow windows, and closes on a choice, outside, or Escape', () => {
    const { $, open } = setup(true)
    $('open-chat-list').click()
    expect(open()).toBe(true)
    expect($('open-chat-list').getAttribute('aria-expanded')).toBe('true')

    $('sidebar').querySelector<HTMLButtonElement>('.chat-menu-btn')!.click()
    expect(open()).toBe(true)
    $('sidebar').querySelector<HTMLElement>('.chat-item')!.click()
    expect(open()).toBe(false)

    $('rail-chats').click()
    expect(open()).toBe(true)
    $('chat').click()
    expect(open()).toBe(false)

    $('rail-chats').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(open()).toBe(false)

    $('rail-chats').click()
    $('sidebar').querySelector<HTMLElement>('.chat-item .chat-name')!.click()
    expect(open()).toBe(false)
  })

  it('does nothing in wide windows, and closes when the window widens', () => {
    const { $, open, resize } = setup(false)
    $('open-chat-list').click()
    expect(open()).toBe(false)

    resize(true)
    $('open-chat-list').click()
    expect(open()).toBe(true)
    resize(false)
    expect(open()).toBe(false)
    expect($('rail-chats').getAttribute('aria-expanded')).toBe('false')
  })
})
