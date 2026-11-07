// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerHeaderMenus } from './headerMenus'

afterEach(() => {
  document.body.replaceChildren()
})

function setup() {
  document.body.innerHTML = `
    <header class="chat-header">
      <div id="wrap">
        <button id="open-workflow" class="header-menu-trigger" aria-controls="workflow-menu" aria-expanded="false">工作流</button>
        <div id="workflow-menu" role="menu" hidden>
          <button id="open-orchestration" role="menuitem">编排</button>
          <button id="open-project" role="menuitem">项目</button>
        </div>
      </div>
      <button id="toggle-notes-panel">笔记</button>
      <button id="open-more" class="header-menu-trigger" aria-controls="more-menu" aria-expanded="false">更多</button>
      <div id="more-menu" role="menu" hidden>
        <button id="proxy-orchestration" role="menuitem" data-menu-proxy="open-orchestration">编排</button>
        <button id="proxy-notes" role="menuitem" data-menu-proxy="toggle-notes-panel">笔记</button>
        <button id="restore-chat" role="menuitem">恢复会话</button>
      </div>
    </header>
    <main id="outside">聊天</main>
  `
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const menus = registerHeaderMenus(document.querySelector<HTMLElement>('.chat-header')!)
  return { $, menus }
}

describe('header menus', () => {
  it('opens one menu at a time and closes it on a choice, a click outside, or Escape', () => {
    const { $ } = setup()
    const orchestrate = vi.fn()
    $('open-orchestration').addEventListener('click', orchestrate)

    $('open-workflow').click()
    expect($('workflow-menu').hidden).toBe(false)
    expect($('open-workflow').getAttribute('aria-expanded')).toBe('true')
    $('open-more').click()
    expect([$('workflow-menu').hidden, $('more-menu').hidden]).toEqual([true, false])

    $('outside').click()
    expect($('more-menu').hidden).toBe(true)

    $('open-workflow').click()
    $('open-orchestration').click()
    expect(orchestrate).toHaveBeenCalledTimes(1)
    expect($('workflow-menu').hidden).toBe(true)

    $('open-more').click()
    $('restore-chat').focus()
    $('restore-chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect($('more-menu').hidden).toBe(true)
    expect(document.activeElement).toBe($('open-more'))
  })

  it('moves between items with the arrow keys', () => {
    const { $ } = setup()
    $('open-more').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe($('proxy-orchestration'))
    $('proxy-orchestration').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe($('restore-chat'))
  })

  it('stands in for header buttons, and only while they could be used', () => {
    const { $ } = setup()
    const notes = vi.fn()
    $('toggle-notes-panel').addEventListener('click', notes)

    $('open-more').click()
    expect([$('proxy-orchestration').hidden, $('proxy-notes').hidden]).toEqual([false, false])
    $('proxy-notes').click()
    expect(notes).toHaveBeenCalledTimes(1)
    expect($('more-menu').hidden).toBe(true)

    // An independent group has no 编排; without a group the whole 工作流 part is hidden.
    $('open-orchestration').hidden = true
    $('open-more').click()
    expect($('proxy-orchestration').hidden).toBe(true)
    $('open-more').click()
    $('open-orchestration').hidden = false
    $('wrap').hidden = true
    $('open-more').click()
    expect($('proxy-orchestration').hidden).toBe(true)
  })
})
