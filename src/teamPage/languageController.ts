import { normalizeLanguage, translateUi, type TeamLanguage } from '../shared/i18n'

export interface LanguageSettingsControllerDependencies {
  englishButton: HTMLButtonElement
  chineseButton: HTMLButtonElement
  getLanguage(): TeamLanguage
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export interface LanguageSettingsController {
  registerEvents(): void
  render(): void
}

const TEXT_SOURCES = new WeakMap<Text, string>()
const ATTRIBUTE_SOURCES = new WeakMap<Element, Map<string, string>>()
const TRANSLATED_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'data-tooltip']
const FORM_FIELD_SELECTOR = 'input, textarea'
const SKIP_SELECTOR = [
  'script',
  'style',
  'textarea',
  'input',
  '[contenteditable="true"]',
  '.ProseMirror',
  '.notes-editor',
  '.message-body',
  '.message-name-text',
  '.message-mention',
  '.message-time-divider',
  '.reference-box',
  '.message-search-results',
].join(', ')

export function createLanguageSettingsController(deps: LanguageSettingsControllerDependencies): LanguageSettingsController {
  let registered = false
  let pendingLanguage: TeamLanguage | undefined

  function render(): void {
    const language = pendingLanguage ?? normalizeLanguage(deps.getLanguage())
    deps.englishButton.setAttribute('aria-pressed', String(language === 'en'))
    deps.chineseButton.setAttribute('aria-pressed', String(language === 'zh-CN'))
    applyTeamLanguage(language)
  }

  function registerEvents(): void {
    if (registered) return
    registered = true
    deps.englishButton.addEventListener('click', () => updateLanguage('en'))
    deps.chineseButton.addEventListener('click', () => updateLanguage('zh-CN'))
  }

  function updateLanguage(language: TeamLanguage): void {
    if ((pendingLanguage ?? normalizeLanguage(deps.getLanguage())) === language) return
    pendingLanguage = language
    render()
    deps.runCommand('GROUP_SETTINGS_UPDATE', { language })
      .then(() => {
        if (pendingLanguage === language) pendingLanguage = undefined
        render()
      })
      .catch(error => {
        if (pendingLanguage === language) pendingLanguage = undefined
        render()
        deps.showError(error instanceof Error ? error.message : String(error))
      })
  }

  return { registerEvents, render }
}

export function applyTeamLanguage(language: TeamLanguage, root: ParentNode = document): void {
  const normalized = normalizeLanguage(language)
  const doc = root instanceof Document ? root : root.ownerDocument ?? document
  // Even an unchanged lang makes the browser restyle and re-lay-out the whole page, so only set it on change.
  if (doc.documentElement.lang !== normalized) doc.documentElement.lang = normalized
  if (doc.documentElement.dataset.language !== normalized) doc.documentElement.dataset.language = normalized

  const translationRoot = root instanceof Document ? root.body : root
  if (!translationRoot) return
  translateTextNodes(translationRoot, normalized, doc)
  translateAttributes(translationRoot, normalized, doc)
}

// Both walks skip SKIP_SELECTOR subtrees (message bodies, editors) as a whole instead of visiting
// every node inside them: the pass runs on every render, and a long chat holds tens of thousands.
function translateTextNodes(root: ParentNode, language: TeamLanguage, doc: Document): void {
  if (root instanceof Element && root.closest(SKIP_SELECTOR)) return
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return (node as Element).matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
      }
      if (!node.textContent?.trim() || !node.parentElement) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  const nodes: Text[] = []
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text)
  }

  for (const node of nodes) {
    const source = TEXT_SOURCES.get(node) ?? node.textContent ?? ''
    if (!TEXT_SOURCES.has(node)) TEXT_SOURCES.set(node, source)
    // This pass runs on every render; rewriting unchanged text would invalidate layout of the whole page.
    const translated = translateTextNode(source, language)
    if (node.data !== translated) node.data = translated
  }
}

function translateAttributes(root: ParentNode, language: TeamLanguage, doc: Document): void {
  for (const element of elementsWithTranslatedAttributes(root, doc)) {
    for (const attribute of TRANSLATED_ATTRIBUTES) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      const sources = attributeSourcesFor(element)
      const source = sources.get(attribute) ?? value
      sources.set(attribute, source)
      const translated = translateUi(source, language)
      if (value !== translated) element.setAttribute(attribute, translated)
    }
  }
}

// Elements outside SKIP_SELECTOR subtrees, plus form fields anywhere (their placeholders are UI copy).
function elementsWithTranslatedAttributes(root: ParentNode, doc: Document): Element[] {
  if (root instanceof Element && root.closest(SKIP_SELECTOR)) {
    return [...(root.matches(FORM_FIELD_SELECTOR) ? [root] : []), ...root.querySelectorAll(FORM_FIELD_SELECTOR)]
  }

  const elements: Element[] = root instanceof Element ? [root] : []
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const element = node as Element
      if (!element.matches(SKIP_SELECTOR) || element.matches(FORM_FIELD_SELECTOR)) return NodeFilter.FILTER_ACCEPT
      elements.push(...element.querySelectorAll(FORM_FIELD_SELECTOR))
      return NodeFilter.FILTER_REJECT
    },
  })
  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element)
  }
  return elements
}

function attributeSourcesFor(element: Element): Map<string, string> {
  const existing = ATTRIBUTE_SOURCES.get(element)
  if (existing) return existing
  const next = new Map<string, string>()
  ATTRIBUTE_SOURCES.set(element, next)
  return next
}

function translateTextNode(source: string, language: TeamLanguage): string {
  if (language === 'zh-CN') return source
  const leading = source.match(/^\s*/)?.[0] ?? ''
  const trailing = source.match(/\s*$/)?.[0] ?? ''
  const trimmed = source.trim()
  if (!trimmed) return source
  return `${leading}${translateUi(trimmed, language)}${trailing}`
}
