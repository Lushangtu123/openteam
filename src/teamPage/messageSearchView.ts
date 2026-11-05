import { searchMessages, type MessageSearchResult } from '../group/messageSearch'
import type { GroupMessage, OpenTeamStore } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import { formatMessageTime } from './chatExperience'

const SEARCH_DEBOUNCE_MS = 120

export interface MessageSearchViewDependencies {
  openButtonEl: HTMLButtonElement
  getStore(): OpenTeamStore
  getCurrentChatId(): string | undefined
  // Shows the message in its chat.
  openMessage(chatId: string, messageId: string): void
}

export interface MessageSearchView {
  registerEvents(): void
  open(): void
  close(restoreFocus?: boolean): void
}

type SearchScope = 'all' | 'current'

export function createMessageSearchView(deps: MessageSearchViewDependencies): MessageSearchView {
  let query = ''
  let scope: SearchScope = 'all'
  let results: MessageSearchResult[] = []
  let activeIndex = 0
  let dialog: { backdrop: HTMLElement; input: HTMLInputElement; scopeButtons: Record<SearchScope, HTMLButtonElement>; count: HTMLElement; list: HTMLElement } | undefined
  let searchTimer: number | undefined

  function registerEvents(): void {
    deps.openButtonEl.addEventListener('click', () => open())
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (dialog) close()
        else open()
      }
    })
  }

  function open(): void {
    if (dialog) {
      dialog.input.focus()
      return
    }
    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop message-search-modal'
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) close()
    })

    const panel = document.createElement('section')
    panel.className = 'modal message-search-dialog'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', ui('搜索消息'))

    const bar = document.createElement('label')
    bar.className = 'message-search-bar'
    bar.append(searchIcon())
    const input = document.createElement('input')
    input.type = 'search'
    input.className = 'message-search-input'
    input.placeholder = ui('搜索所有群聊的消息…')
    input.setAttribute('aria-label', ui('搜索消息'))
    input.setAttribute('aria-controls', 'message-search-results')
    input.value = query
    input.addEventListener('input', () => {
      query = input.value
      window.clearTimeout(searchTimer)
      searchTimer = window.setTimeout(() => {
        searchTimer = undefined
        runSearch()
      }, SEARCH_DEBOUNCE_MS)
    })
    input.addEventListener('keydown', handleKeydown)
    const hint = document.createElement('kbd')
    hint.textContent = 'Esc'
    bar.append(input, hint)

    const scopeRow = document.createElement('div')
    scopeRow.className = 'settings-segment message-search-scope'
    scopeRow.setAttribute('role', 'group')
    const scopeButtons = {
      all: scopeButton('all', ui('全部群聊')),
      current: scopeButton('current', ui('当前群聊')),
    }
    scopeRow.append(scopeButtons.all, scopeButtons.current)

    const count = document.createElement('p')
    count.className = 'tiny message-search-count'
    const list = document.createElement('ol')
    list.id = 'message-search-results'
    list.className = 'message-search-results'
    list.setAttribute('role', 'listbox')

    panel.append(bar, scopeRow, count, list)
    backdrop.append(panel)
    document.body.append(backdrop)
    dialog = { backdrop, input, scopeButtons, count, list }
    document.addEventListener('keydown', handleEscape)
    runSearch()
    input.focus()
    input.select()
  }

  // Focus goes back to the search button only when the panel is dismissed, not when a result opens.
  function close(restoreFocus = true): void {
    window.clearTimeout(searchTimer)
    searchTimer = undefined
    dialog?.backdrop.remove()
    dialog = undefined
    document.removeEventListener('keydown', handleEscape)
    if (restoreFocus) deps.openButtonEl.focus()
  }

  function scopeButton(value: SearchScope, label: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'settings-segment-option'
    button.textContent = label
    button.addEventListener('click', () => {
      scope = value
      runSearch()
      dialog?.input.focus()
    })
    return button
  }

  function runSearch(): void {
    if (!dialog) return
    const currentChatId = deps.getCurrentChatId()
    if (scope === 'current' && !currentChatId) scope = 'all'
    dialog.scopeButtons.all.setAttribute('aria-pressed', String(scope === 'all'))
    dialog.scopeButtons.current.setAttribute('aria-pressed', String(scope === 'current'))
    dialog.scopeButtons.current.disabled = !currentChatId

    const outcome = searchMessages(deps.getStore(), query, { chatId: scope === 'current' ? currentChatId : undefined, speakerName })
    results = outcome.results
    activeIndex = 0
    dialog.count.textContent = !query.trim()
      ? ui('输入关键词，多个词用空格分开')
      : outcome.total === 0
        ? ui('没有找到消息')
        : outcome.total > results.length
          ? ui(`找到 ${outcome.total} 条消息，显示最近 ${results.length} 条`)
          : ui(`找到 ${outcome.total} 条消息`)
    renderResults()
  }

  function renderResults(): void {
    if (!dialog) return
    dialog.list.replaceChildren(...results.map((result, index) => resultItem(result, index)))
    syncActive()
  }

  function resultItem(result: MessageSearchResult, index: number): HTMLElement {
    const item = document.createElement('li')
    item.className = 'message-search-result'
    item.id = `message-search-result-${index}`
    item.setAttribute('role', 'option')
    item.addEventListener('mousemove', () => {
      if (activeIndex === index) return
      activeIndex = index
      syncActive()
    })
    item.addEventListener('click', () => choose(index))

    const meta = document.createElement('div')
    meta.className = 'message-search-meta'
    const chat = document.createElement('span')
    chat.className = 'message-search-chat'
    chat.textContent = result.chatName
    const speaker = document.createElement('span')
    speaker.textContent = speakerName(result.message)
    const time = document.createElement('span')
    time.textContent = formatMessageTime(result.message.createdAt)
    meta.append(chat, separator(), speaker, separator(), time)

    const snippet = document.createElement('div')
    snippet.className = 'message-search-snippet'
    for (const part of result.snippet) {
      if (part.match) {
        const mark = document.createElement('mark')
        mark.textContent = part.text
        snippet.append(mark)
      } else {
        snippet.append(document.createTextNode(part.text))
      }
    }
    item.append(meta, snippet)
    return item
  }

  function syncActive(): void {
    if (!dialog) return
    const items = [...dialog.list.children] as HTMLElement[]
    items.forEach((item, index) => item.setAttribute('aria-selected', String(index === activeIndex)))
    const active = items[activeIndex]
    if (active) {
      dialog.input.setAttribute('aria-activedescendant', active.id)
      if (typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' })
    } else {
      dialog.input.removeAttribute('aria-activedescendant')
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length === 0) return
      activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
      syncActive()
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      // Search what was typed even if the debounce has not run yet.
      if (searchTimer !== undefined) {
        window.clearTimeout(searchTimer)
        searchTimer = undefined
        runSearch()
      }
      choose(activeIndex)
    }
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  function choose(index: number): void {
    const result = results[index]
    if (!result) return
    close(false)
    deps.openMessage(result.chatId, result.messageId)
  }

  function speakerName(message: GroupMessage): string {
    if (message.type === 'user') return ui('我')
    if (message.type === 'assistant') return message.roleName || ui('AI 人员')
    return ui('系统')
  }

  function ui(source: string): string {
    return translateUi(source, normalizeLanguage(deps.getStore().settings.language))
  }

  return { registerEvents, open, close }
}

function separator(): HTMLElement {
  const dot = document.createElement('span')
  dot.className = 'message-search-separator'
  dot.textContent = '·'
  return dot
}

function searchIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '11')
  circle.setAttribute('cy', '11')
  circle.setAttribute('r', '6.2')
  const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  handle.setAttribute('d', 'm15.6 15.6 4 4')
  svg.append(circle, handle)
  return svg
}
