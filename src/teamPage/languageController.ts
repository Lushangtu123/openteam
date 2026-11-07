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

// Per text node, like attributes below: the Chinese source and what the last pass wrote.
const TEXT_SOURCES = new WeakMap<Text, { source: string; output: string }>()
// Per attribute: the Chinese source and what this pass last wrote, so a value the page's code sets
// later (a placeholder that follows a setting) becomes the new source instead of being undone.
const ATTRIBUTE_SOURCES = new WeakMap<Element, Map<string, { source: string; output: string }>>()
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
  '.reply-compare-question',
  '.reply-compare-columns',
  '.reply-compare-select',
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

// The pass runs on every render, and a long chat holds a hundred thousand nodes, so it does not walk
// the whole page each time. While the page has only ever been in Chinese there is nothing to do: all
// text is still its source. Once it has been translated, a MutationObserver lists what changed since
// the last pass and only that is translated; a change of language walks the page once.
interface LanguagePassState {
  translatedAway: boolean
  language?: TeamLanguage
  observer?: MutationObserver
}
const PASS_STATES = new WeakMap<Document, LanguagePassState>()

export function applyTeamLanguage(language: TeamLanguage, root: ParentNode = document): void {
  const normalized = normalizeLanguage(language)
  const doc = root instanceof Document ? root : root.ownerDocument ?? document
  // Even an unchanged lang makes the browser restyle and re-lay-out the whole page, so only set it on change.
  if (doc.documentElement.lang !== normalized) doc.documentElement.lang = normalized
  if (doc.documentElement.dataset.language !== normalized) doc.documentElement.dataset.language = normalized

  let state = PASS_STATES.get(doc)
  if (!state) {
    state = { translatedAway: false }
    PASS_STATES.set(doc, state)
  }
  if (normalized !== 'zh-CN') state.translatedAway = true
  if (!state.translatedAway) return

  if (!(root instanceof Document)) {
    translateTree(root, normalized, doc)
    return
  }
  if (!root.body) return
  if (!state.observer || state.language !== normalized || typeof MutationObserver === 'undefined') {
    state.observer?.takeRecords()
    translateTree(root.body, normalized, doc)
    state.language = normalized
    if (!state.observer && typeof MutationObserver !== 'undefined') {
      state.observer = new MutationObserver(() => undefined)
      state.observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: TRANSLATED_ATTRIBUTES })
    }
  } else {
    translateChanges(state.observer.takeRecords(), normalized, doc)
  }
  // What this pass wrote is not a change to translate next time.
  state.observer?.takeRecords()
}

function translateTree(root: ParentNode, language: TeamLanguage, doc: Document): void {
  translateTextNodes(root, language, doc)
  translateAttributes(root, language, doc)
}

function translateChanges(records: MutationRecord[], language: TeamLanguage, doc: Document): void {
  const added = new Set<Node>()
  const texts = new Set<Text>()
  const attributes = new Set<Element>()
  for (const record of records) {
    if (record.type === 'childList') record.addedNodes.forEach(node => added.add(node))
    else if (record.type === 'characterData') texts.add(record.target as Text)
    else attributes.add(record.target as Element)
  }
  for (const node of added) {
    if (!node.isConnected) continue
    if (node.nodeType === Node.TEXT_NODE) texts.add(node as Text)
    else if (node.nodeType === Node.ELEMENT_NODE) translateTree(node as Element, language, doc)
  }
  for (const text of texts) {
    if (text.isConnected && text.data.trim() && text.parentElement && !text.parentElement.closest(SKIP_SELECTOR)) translateText(text, language)
  }
  for (const element of attributes) {
    if (element.isConnected && (element.matches(FORM_FIELD_SELECTOR) || !element.closest(SKIP_SELECTOR))) translateElementAttributes(element, language)
  }
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

  for (const node of nodes) translateText(node, language)
}

// Text the page's code set since the last pass becomes the new source instead of being undone.
function translateText(node: Text, language: TeamLanguage): void {
  const known = TEXT_SOURCES.get(node)
  const source = known && (node.data === known.output || node.data === known.source) ? known.source : node.data
  const translated = translateTextNode(source, language)
  TEXT_SOURCES.set(node, { source, output: translated })
  // Rewriting unchanged text would invalidate layout of the whole page.
  if (node.data !== translated) node.data = translated
}

function translateAttributes(root: ParentNode, language: TeamLanguage, doc: Document): void {
  for (const element of elementsWithTranslatedAttributes(root, doc)) translateElementAttributes(element, language)
}

function translateElementAttributes(element: Element, language: TeamLanguage): void {
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    const value = element.getAttribute(attribute)
    if (!value) continue
    const sources = attributeSourcesFor(element)
    const known = sources.get(attribute)
    const source = known && (value === known.output || value === known.source) ? known.source : value
    const translated = translateUi(source, language)
    sources.set(attribute, { source, output: translated })
    if (value !== translated) element.setAttribute(attribute, translated)
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

function attributeSourcesFor(element: Element): Map<string, { source: string; output: string }> {
  const existing = ATTRIBUTE_SOURCES.get(element)
  if (existing) return existing
  const next = new Map<string, { source: string; output: string }>()
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
