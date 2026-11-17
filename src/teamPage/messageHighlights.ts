// The highlights the user saved on a reply, drawn over its rendered text. A highlight is found at
// its saved offsets when the text there still matches, otherwise wherever its text first appears.
import { messageHighlightColorRgb } from '../group/highlightColors'
import type { MessageHighlight } from '../group/types'

export function applyHighlightsToBody(body: HTMLElement, highlights: MessageHighlight[]): void {
  const bodyText = body.textContent ?? ''
  const normalized = highlights
    .map(highlight => {
      const renderedStart = bodyText.slice(highlight.startOffset, highlight.endOffset) === highlight.text ? highlight.startOffset : bodyText.indexOf(highlight.text)
      return renderedStart >= 0 ? { ...highlight, startOffset: renderedStart, endOffset: renderedStart + highlight.text.length } : undefined
    })
    .filter((highlight): highlight is MessageHighlight => Boolean(highlight))
    .sort((left, right) => left.startOffset - right.startOffset)

  let cursor = 0
  for (const highlight of normalized) {
    if (highlight.startOffset < cursor) continue
    wrapTextRange(body, highlight.startOffset, highlight.endOffset, highlight.color)
    cursor = highlight.endOffset
  }
}

function wrapTextRange(root: HTMLElement, startOffset: number, endOffset: number, color: MessageHighlight['color']): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let textPosition = 0
  const ranges: Array<{ node: Text; start: number; end: number }> = []

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const nodeStart = textPosition
    const nodeEnd = nodeStart + node.data.length
    if (nodeEnd > startOffset && nodeStart < endOffset) {
      ranges.push({
        node,
        start: Math.max(0, startOffset - nodeStart),
        end: Math.min(node.data.length, endOffset - nodeStart),
      })
    }
    textPosition = nodeEnd
  }

  for (const range of ranges.reverse()) {
    const selected = range.node.splitText(range.start)
    selected.splitText(range.end - range.start)
    const mark = document.createElement('span')
    mark.className = 'message-highlight'
    mark.style.setProperty('--message-highlight-rgb', messageHighlightColorRgb(color))
    selected.parentNode?.insertBefore(mark, selected)
    mark.append(selected)
  }
}
