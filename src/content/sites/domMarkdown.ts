// Not part of a reply: controls (DeepSeek's are <div role="button">), and the bar above a ChatGPT
// writing block, which repeats the document's title.
const SKIP_SELECTORS = 'button, [role="button"], svg, style, script, textarea, mat-icon, header'
// Prose outside a code block's <pre> means the element holds more than the code block.
const PROSE_SELECTORS = 'p, li, h1, h2, h3, h4, h5, h6, table, blockquote'
const CONTROL_SELECTORS = 'button, [role="button"]'
const TOOLBAR_LABEL_MAX_LENGTH = 24

export function extractMarkdownFromDom(node: Node): string {
  return normalizeMarkdown(block(node))
}

function block(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return [...node.childNodes].map(child => block(child, depth)).join('')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (element.getAttribute('aria-hidden') === 'true') return ''
  if (element.matches(SKIP_SELECTORS)) return ''

  if (tag === 'pre') return fence(element)
  const codeBlock = codeBlockWithToolbar(element)
  if (codeBlock) return codeBlock

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1))
    return `\n${'#'.repeat(level)} ${plainText(element)}\n`
  }

  if (tag === 'p') return `\n${inlineChildren(element).trim()}\n`

  if (tag === 'blockquote') {
    return `\n${plainText(element)
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n')}\n`
  }

  if (tag === 'ul') {
    return `\n${[...element.children].map(item => `${'  '.repeat(depth)}- ${listItemText(item, depth)}`).join('\n')}\n`
  }

  if (tag === 'ol') {
    return `\n${[...element.children].map((item, index) => `${'  '.repeat(depth)}${index + 1}. ${listItemText(item, depth)}`).join('\n')}\n`
  }

  if (tag === 'table') return tableMarkdown(element)

  return [...element.childNodes].map(child => block(child, depth)).join('')
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (element.getAttribute('aria-hidden') === 'true') return ''
  if (element.matches(SKIP_SELECTORS)) return ''

  const content = inlineChildren(element)
  if (tag === 'strong' || tag === 'b') return `**${content}**`
  if (tag === 'em' || tag === 'i') return `*${content}*`
  if (tag === 'code') return `\`${content}\``
  if (tag === 'a') {
    const href = element.getAttribute('href')
    return href ? `[${content}](${href})` : content
  }
  if (tag === 'br') return '\n'

  return content
}

function inlineChildren(element: Element): string {
  return [...element.childNodes].map(inline).join('')
}

function listItemText(element: Element, depth: number): string {
  const inlinePart = [...element.childNodes]
    .filter(child => child.nodeType !== Node.ELEMENT_NODE || !['UL', 'OL'].includes((child as Element).tagName))
    .map(inline)
    .join('')
    .trim()
  const nestedPart = [...element.children]
    .filter(child => child.tagName === 'UL' || child.tagName === 'OL')
    .map(child => block(child, depth + 1).trimEnd())
    .join('\n')
  return [inlinePart, nestedPart].filter(Boolean).join('\n')
}

// A code block drawn with a toolbar beside its <pre>, as ChatGPT and DeepSeek draw them: the
// toolbar's label names the language ("JSON") and the rest is buttons. None of it is the reply.
// The toolbar is what sits beside the code's branch, and it has a control; text with no control
// beside the code is prose (Kimi draws paragraphs as <div>), so that is not a code block.
function codeBlockWithToolbar(element: Element): string | undefined {
  const pres = element.getElementsByTagName('pre')
  if (pres.length !== 1) return undefined
  const pre = pres[0]
  if ([...element.querySelectorAll(PROSE_SELECTORS)].some(node => !pre.contains(node))) return undefined
  const codeBranch = [...element.children].find(child => child.contains(pre))
  if (!codeBranch) return undefined
  // The code's own branch holds its toolbar: it is found further in.
  if (codeBranch !== pre && textOutside(codeBranch, pre).trim()) return undefined

  const toolbar = [...element.children].filter(child => child !== codeBranch)
  if (!toolbar.some(child => child.matches(CONTROL_SELECTORS) || child.querySelector(CONTROL_SELECTORS))) return undefined
  const label = textOutside(element, codeBranch).replace(/\s+/g, ' ').trim()
  return label.length <= TOOLBAR_LABEL_MAX_LENGTH ? fence(pre, label) : undefined
}

function textOutside(element: Element, inner?: Element): string {
  return [...element.childNodes].map(child => {
    if (child === inner) return ''
    if (child.nodeType === Node.TEXT_NODE) return child.textContent || ''
    if (child.nodeType !== Node.ELEMENT_NODE) return ''
    const childElement = child as Element
    if (childElement.getAttribute('aria-hidden') === 'true' || childElement.matches(SKIP_SELECTORS)) return ''
    return textOutside(childElement, inner)
  }).join(' ')
}

// The fence names the language when the toolbar or the <code> element does.
function fence(pre: Element, label = ''): string {
  const code = pre.querySelector('code')
  const labelled = label.toLowerCase().replace(/\s+/g, '')
  const language = /^[\w+#.-]+$/.test(labelled) ? labelled : (code?.className.match(/\blanguage-([\w+#.-]+)/)?.[1] ?? '').toLowerCase()
  const text = code?.textContent ?? pre.textContent ?? ''
  return `\n\`\`\`${language}\n${text.trim()}\n\`\`\`\n`
}

function tableMarkdown(element: Element): string {
  const rows = [...element.querySelectorAll('tr')].map(row => [...row.children].map(cell => plainText(cell)).join(' | '))
  if (rows.length === 0) return ''

  const separator = rows[0].split('|').map(() => ' --- ').join('|')
  return `\n${[rows[0], separator, ...rows.slice(1)].join('\n')}\n`
}

function plainText(element: Element): string {
  return (element.textContent || '').replace(/\s+/g, ' ').trim()
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
