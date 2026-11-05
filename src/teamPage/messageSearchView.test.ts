// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { applyTeamLanguage } from './languageController'
import { createMessageSearchView } from './messageSearchView'

function makeStore(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  const add = (chatId: string, name: string, contents: string[]) => {
    store.chatOrder.push(chatId)
    const messageIds = contents.map((_, index) => `${chatId}-${index}`)
    store.chatsById[chatId] = { id: chatId, name, mode: 'independent', roleIds: [], messageIds, nextMessageSeq: contents.length + 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    contents.forEach((content, index) => {
      store.messagesById[messageIds[index]] = { id: messageIds[index], chatId, seq: index + 1, type: index === 0 ? 'user' : 'assistant', roleName: '工程师', content, createdAt: Date.parse('2026-11-05T10:00:00Z') + index * 60_000 + (chatId === 'b' ? 3_600_000 : 0), status: 'received' }
    })
  }
  add('a', '产品评审', ['缓存方案怎么样', '缓存会带来一致性风险'])
  add('b', '技术方案', ['讨论缓存命中率'])
  return store
}

function setup(currentChatId = 'a') {
  const store = makeStore()
  const openButtonEl = document.createElement('button')
  document.body.append(openButtonEl)
  const openMessage = vi.fn()
  const view = createMessageSearchView({ openButtonEl, getStore: () => store, getCurrentChatId: () => currentChatId, openMessage })
  view.registerEvents()
  return { view, openMessage, store }
}

function type(text: string): void {
  const input = document.querySelector<HTMLInputElement>('.message-search-input')!
  input.value = text
  input.dispatchEvent(new Event('input'))
  vi.advanceTimersByTime(150)
}

function press(key: string, target: EventTarget = document.querySelector('.message-search-input')!, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
}

const resultTexts = () => [...document.querySelectorAll('.message-search-result')].map(item => item.querySelector('.message-search-snippet')?.textContent)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('message search panel', () => {
  it('opens with Ctrl+K, searches as you type and marks the matches', () => {
    setup()
    press('k', document, { ctrlKey: true })
    expect(document.querySelector('.message-search-dialog')).not.toBeNull()
    expect(document.querySelector('.message-search-count')?.textContent).toBe('输入关键词，多个词用空格分开')

    type('缓存')

    expect(resultTexts()).toEqual(['讨论缓存命中率', '缓存会带来一致性风险', '缓存方案怎么样'])
    expect(document.querySelector('.message-search-count')?.textContent).toBe('找到 3 条消息')
    expect([...document.querySelectorAll('.message-search-snippet mark')].map(mark => mark.textContent)).toEqual(['缓存', '缓存', '缓存'])
    expect(document.querySelector('.message-search-meta')?.textContent).toContain('技术方案')

    press('k', document, { metaKey: true })
    expect(document.querySelector('.message-search-dialog')).toBeNull()
  })

  it('moves through results with the arrow keys and opens the chosen one', () => {
    const { openMessage } = setup()
    document.querySelector('button')!.click()
    type('缓存')

    press('ArrowDown')
    expect(document.querySelectorAll('.message-search-result')[1].getAttribute('aria-selected')).toBe('true')
    press('ArrowUp')
    press('ArrowUp')
    expect(document.querySelectorAll('.message-search-result')[2].getAttribute('aria-selected')).toBe('true')
    press('Enter')

    expect(openMessage).toHaveBeenCalledWith('a', 'a-0')
    expect(document.querySelector('.message-search-dialog')).toBeNull()
  })

  it('searches only the current chat when asked, and says when nothing matches', () => {
    setup('b')
    document.querySelector('button')!.click()
    type('缓存')
    ;[...document.querySelectorAll<HTMLButtonElement>('.message-search-scope button')][1].click()

    expect(resultTexts()).toEqual(['讨论缓存命中率'])

    type('不存在的词')
    expect(document.querySelector('.message-search-count')?.textContent).toBe('没有找到消息')
    expect(resultTexts()).toEqual([])
  })

  it('opens a result on click, remembers the search and closes with Escape', () => {
    const { openMessage } = setup()
    document.querySelector('button')!.click()
    type('一致性')
    document.querySelector<HTMLElement>('.message-search-result')!.click()
    expect(openMessage).toHaveBeenCalledWith('a', 'a-1')

    document.querySelector('button')!.click()
    expect(document.querySelector<HTMLInputElement>('.message-search-input')?.value).toBe('一致性')
    expect(resultTexts()).toEqual(['缓存会带来一致性风险'])
    press('Escape', document)
    expect(document.querySelector('.message-search-dialog')).toBeNull()
  })

  it('lets the language pass translate the panel but not the found messages', () => {
    const { store } = setup()
    store.settings.language = 'en'
    document.querySelector('button')!.click()
    type('缓存')

    applyTeamLanguage('en')

    expect(document.querySelector<HTMLInputElement>('.message-search-input')?.placeholder).toBe('Search messages in all chats…')
    expect(document.querySelector('.message-search-count')?.textContent).toBe('3 messages found')
    expect(resultTexts()[0]).toBe('讨论缓存命中率')
    expect(document.querySelector('.message-search-meta')?.textContent).toContain('技术方案')
  })
})
