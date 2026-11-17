// Selecting text in a reply offers to highlight it, put it in the open note, or both, in a small
// menu over the selection. The menu waits for the selection to settle (a drag ends, or the keyboard
// stops moving it) so that it does not jump while the user selects.
import { DEFAULT_MESSAGE_HIGHLIGHT_COLOR, MESSAGE_HIGHLIGHT_COLORS, messageHighlightColorRgb, type MessageHighlightColor } from '../group/highlightColors'
import type { GroupMessage, OpenTeamStore } from '../group/types'

const MARK_MENU_SELECTION_GAP_PX = 12
const MARK_MENU_FALLBACK_HEIGHT_PX = 148
const MARK_MENU_SELECTION_SETTLE_DELAY_MS = 80

export interface SelectionMarkMenuDependencies {
  messagesEl: HTMLElement
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<unknown>
  insertTextIntoActiveNote?(text: string): void
  showError(message: string): void
}

export function registerSelectionMarkMenu(deps: SelectionMarkMenuDependencies): void {
  let markMenu: HTMLElement | undefined
  let selectedMark: { message: GroupMessage; text: string; startOffset: number; endOffset: number; rect: DOMRect; color: MessageHighlightColor } | undefined
  let selectedHighlightColor: MessageHighlightColor = DEFAULT_MESSAGE_HIGHLIGHT_COLOR
  let selectionDragActive = false
  let ignoreNextDocumentClick = false
  let markMenuUpdateTimer: number | undefined

  deps.messagesEl.addEventListener('mousedown', beginSelectionDrag)
  deps.messagesEl.addEventListener('pointerdown', beginSelectionDrag)
  deps.messagesEl.addEventListener('dragstart', cancelSelectionMarking)
  document.addEventListener('mouseup', finishSelectionDrag)
  document.addEventListener('pointerup', finishSelectionDrag)

  document.addEventListener('selectionchange', () => {
    if (selectionDragActive) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideMarkMenu()
      return
    }
    scheduleMarkMenuFromSelection()
  })

  document.addEventListener('click', event => {
    if (ignoreNextDocumentClick) {
      ignoreNextDocumentClick = false
      return
    }
    if (markMenu?.contains(event.target as Node)) return
    const target = event.target as Element | null
    if (target?.closest('.message-body')) return
    hideMarkMenu()
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideMarkMenu()
  })

  function beginSelectionDrag(event: MouseEvent | PointerEvent): void {
    const target = event.target as Element | null
    if (!target || target.closest('button, input, textarea, select, a, [role="button"]')) return
    if (!deps.messagesEl.contains(target)) return
    selectionDragActive = true
    clearMarkMenuUpdate()
    hideMarkMenu()
  }

  function finishSelectionDrag(event: MouseEvent | PointerEvent): void {
    const target = event.target as Node | null
    if (!selectionDragActive && (!target || !deps.messagesEl.contains(target))) return
    selectionDragActive = false
    ignoreNextDocumentClick = true
    scheduleMarkMenuFromSelection()
  }

  function cancelSelectionMarking(): void {
    selectionDragActive = false
    ignoreNextDocumentClick = false
    clearMarkMenuUpdate()
    hideMarkMenu()
  }

  function scheduleMarkMenuFromSelection(): void {
    clearMarkMenuUpdate()
    markMenuUpdateTimer = window.setTimeout(() => {
      markMenuUpdateTimer = undefined
      showMarkMenuFromSelection()
    }, MARK_MENU_SELECTION_SETTLE_DELAY_MS)
  }

  function clearMarkMenuUpdate(): void {
    if (markMenuUpdateTimer === undefined) return
    window.clearTimeout(markMenuUpdateTimer)
    markMenuUpdateTimer = undefined
  }

  function showMarkMenuFromSelection(): void {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideMarkMenu()
      return
    }

    const range = selection.getRangeAt(0)
    const body = closestMessageBody(range.commonAncestorContainer)
    if (!body || !deps.messagesEl.contains(body)) {
      hideMarkMenu()
      return
    }

    const article = body.closest<HTMLElement>('.message-row[data-message-id]')
    const messageId = article?.dataset.messageId
    const message = messageId ? deps.getStore().messagesById[messageId] : undefined
    const selectedText = selection.toString().trim()
    if (!message || !selectedText) {
      hideMarkMenu()
      return
    }

    const startOffset = message.content.indexOf(selectedText)
    if (startOffset < 0) {
      hideMarkMenu()
      return
    }

    selectedMark = {
      message,
      text: selectedText,
      startOffset,
      endOffset: startOffset + selectedText.length,
      rect: rangeRect(range),
      color: selectedHighlightColor,
    }
    renderMarkMenu()
  }

  function renderMarkMenu(): void {
    if (!selectedMark) return
    markMenu?.remove()
    markMenu = document.createElement('div')
    markMenu.className = 'mark-menu'
    const colorRow = document.createElement('div')
    colorRow.className = 'mark-color-row'
    colorRow.setAttribute('aria-label', '高亮颜色')
    for (const color of MESSAGE_HIGHLIGHT_COLORS) {
      colorRow.append(markColorButton(color.value, color.label))
    }
    markMenu.append(
      colorRow,
      markMenuButton('高亮', '高亮', () => applySelectedMark('highlight')),
      markMenuButton('加入笔记', '加入笔记', () => applySelectedMark('note')),
      markMenuButton('高亮并加入笔记', '高亮并加入笔记', () => applySelectedMark('both')),
    )
    document.body.append(markMenu)
    const menuRect = markMenu.getBoundingClientRect()
    const menuHeight = menuRect.height || markMenu.offsetHeight || MARK_MENU_FALLBACK_HEIGHT_PX
    const menuWidth = menuRect.width || markMenu.offsetWidth
    const preferredTop = selectedMark.rect.top - menuHeight - MARK_MENU_SELECTION_GAP_PX
    const top = preferredTop >= 8
      ? preferredTop
      : Math.min(Math.max(8, selectedMark.rect.bottom + MARK_MENU_SELECTION_GAP_PX), window.innerHeight - menuHeight - 8)
    const centeredLeft = selectedMark.rect.left + selectedMark.rect.width / 2 - menuWidth / 2
    const left = Math.min(Math.max(8, centeredLeft), window.innerWidth - menuWidth - 8)
    markMenu.style.top = `${top}px`
    markMenu.style.left = `${left}px`
  }

  function markMenuButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.setAttribute('aria-label', label)
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      onClick()
    })
    return button
  }

  function markColorButton(color: MessageHighlightColor, label: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mark-color-btn'
    button.setAttribute('aria-label', `高亮颜色：${label}`)
    button.setAttribute('aria-pressed', String(selectedMark?.color === color))
    button.style.setProperty('--mark-color-rgb', messageHighlightColorRgb(color))
    button.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      selectedHighlightColor = color
      if (selectedMark) selectedMark.color = color
      renderMarkMenu()
    })
    return button
  }

  function applySelectedMark(action: 'highlight' | 'note' | 'both'): void {
    const mark = selectedMark
    if (!mark) return
    if (action === 'note' || action === 'both') deps.insertTextIntoActiveNote?.(mark.text)
    if (action === 'highlight' || action === 'both') {
      deps.runCommand('GROUP_MESSAGE_HIGHLIGHT_CREATE', {
        chatId: mark.message.chatId,
        messageId: mark.message.id,
        text: mark.text,
        startOffset: mark.startOffset,
        endOffset: mark.endOffset,
        color: mark.color,
      }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    }
    window.getSelection()?.removeAllRanges()
    hideMarkMenu()
  }

  function hideMarkMenu(): void {
    clearMarkMenuUpdate()
    selectedMark = undefined
    markMenu?.remove()
    markMenu = undefined
  }
}

function closestMessageBody(node: Node): HTMLElement | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  return element?.closest<HTMLElement>('.message-body') ?? undefined
}

function rangeRect(range: Range): DOMRect {
  if (typeof range.getBoundingClientRect === 'function') return range.getBoundingClientRect()
  return new DOMRect(8, 8, 1, 1)
}
