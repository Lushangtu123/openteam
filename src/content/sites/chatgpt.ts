import type { ReplyImageSource } from '../../group/types'
import { checkSiteHealth, type SiteHealthContext } from './siteHealth'
import type { ChatSiteAdapter, ConversationSnapshot, SiteStatusInfo } from './types'
import { keepDeepestResponseContainers } from '../responseContainers'
import { readResponseTextFromCopyAction } from './clipboardCopy'
import { readEditorText, setContentEditableText, tryKeyboardSubmit } from './contentEditable'
import { extractMarkdownFromDom } from './domMarkdown'
import { buttonLabelMatches, describeElement, extractCleanTextFromDom, findClosestMatchingAncestor } from './domText'
import { isClickableButton, querySelectorFirstMatching, waitForClickableButton } from './waitForElement'

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com'])
const DEFAULT_INPUT_TIMEOUT_MS = 15000
const DEFAULT_CLIPBOARD_TIMEOUT_MS = 900
const DEFAULT_CLIPBOARD_POLL_MS = 40

const CHATGPT_SELECTORS = {
  // The input box, most specific first. Since November 2026 it has no #prompt-textarea: it is the
  // editor of form[data-chatgpt-composer] (data-composer-markdown, "Ask ChatGPT").
  editor: [
    'form[data-chatgpt-composer] [contenteditable="true"][data-composer-markdown]',
    'form[data-chatgpt-composer] .ProseMirror[contenteditable="true"]',
    'form[data-type="unified-composer"] #prompt-textarea[contenteditable="true"]',
    '#prompt-textarea.ProseMirror[contenteditable="true"]',
    '#prompt-textarea[contenteditable="true"]',
    'div#prompt-textarea',
    'textarea[name="prompt-textarea"]',
    'textarea#mobile-composer-prompt',
    'div.ProseMirror[contenteditable="true"]',
    'form [contenteditable="true"].ProseMirror',
    'div[role="textbox"][contenteditable="true"]',
    '[data-testid="message-input"]',
    'main div[contenteditable="true"]',
  ].join(', '),
  sendButton:
    'button[data-testid="send-button"], button#composer-submit-button, button[aria-label*="Send message"], button[aria-label*="Send prompt"], button[aria-label*="发送"], button[aria-label*="Send"], button[aria-label*="提交"], button[aria-label*="Submit"]',
  response: '[data-message-author-role="assistant"]',
  transcriptResponse: '[data-content-search-unit-key$=":assistant"] [data-chatgpt-selection-message-id]:has([data-markdown-text-style="assistant-message"])',
  imageResponse: '[data-conversation-screenshot-content]',
  // Since November 2026 an image reply is a message block of its own, holding a gallery of
  // blob: images and no text.
  imageMessage: '[data-chatgpt-search-message-ids]:has([data-testid="generated-image-gallery"])',
  transcriptUserUnit: '[data-content-search-unit-key$=":user"]',
  generatedImage:
    'img[src*="/backend-api/estuary/content"], [data-testid*="image"] img[src], [class*="imagegen-image"] img[src], [data-testid="generated-image-preview"] img[src]',
  responseActions: '[role="group"][aria-label="回复操作"], [role="group"][aria-label="Message actions"], [aria-label="回复操作"], [aria-label="Message actions"]',
  turnCopyButton: 'button[data-testid="copy-turn-action-button"], button[aria-label="复制回复"], button[aria-label="Copy response"]',
  copyButton:
    'button[data-testid="copy-turn-action-button"], button[aria-label="复制回复"], button[aria-label="Copy response"], button[aria-label="复制"], button[aria-label="Copy"]',
  turn: 'section[data-turn="assistant"][data-testid^="conversation-turn-"], [data-turn="assistant"][data-testid^="conversation-turn-"]',
  userTurn: '[data-turn="user"], [data-message-author-role="user"]',
  activityIndicator: '.result-streaming[aria-busy="true"], [aria-busy="true"] .result-streaming, [data-testid*="thinking"], [data-testid*="reasoning"]',
  errorDialog: '[role="dialog"] .text-red-500, .error-message, [data-testid="error-message"]',
  blockedPage: 'title:contains("Access Denied"), .cloudflare-challenge, [data-testid="access-denied"]',
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'SVG'])
// Editors inside the conversation, never the input box: a reply's editable writing block (canvas)
// matched the generic selectors before the input box did, and the prompt was typed into it.
const CHATGPT_CONVERSATION_EDITOR_SCOPE = '[data-testid="chatgpt-writing-block"], [data-content-search-unit-key], [data-message-author-role], [data-turn]'

export function findChatGptEditor(): HTMLElement | null {
  return querySelectorFirstMatching(CHATGPT_SELECTORS.editor, element => !element.closest(CHATGPT_CONVERSATION_EDITOR_SCOPE))
}

async function waitForChatGptEditor(timeoutMs: number): Promise<HTMLElement> {
  const startedAt = Date.now()
  for (;;) {
    const editor = findChatGptEditor()
    if (editor) return editor
    if (Date.now() - startedAt >= timeoutMs) throw new Error('ChatGPT 输入框暂不可用，请稍后重试')
    await new Promise(resolve => window.setTimeout(resolve, 250))
  }
}
const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com'])

interface ChatGptAdapterOptions {
  href?: string
  inputTimeoutMs?: number
  clipboardTimeoutMs?: number
  clipboardPollMs?: number
}

export function createChatGptAdapter(options: ChatGptAdapterOptions = {}): ChatSiteAdapter {
  const inputTimeoutMs = options.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS
  const clipboardTimeoutMs = options.clipboardTimeoutMs ?? DEFAULT_CLIPBOARD_TIMEOUT_MS
  const clipboardPollMs = options.clipboardPollMs ?? DEFAULT_CLIPBOARD_POLL_MS

  function currentHref(): string {
    return options.href ?? location.href
  }

  function getConversationSnapshot(): ConversationSnapshot {
    return getChatGptConversationLocation(currentHref())
  }

  function getConversationId(): string {
    return getConversationSnapshot().conversationId || '__default__'
  }

  function getResponseContainers(): Element[] {
    const turnResponses = [...document.querySelectorAll(CHATGPT_SELECTORS.turn)]
      .map(turn => findPrimaryResponseInTurn(turn))
      .filter((response): response is Element => Boolean(response))
    const standaloneImageResponses = [...document.querySelectorAll(CHATGPT_SELECTORS.imageResponse)]
      .filter(response =>
        !response.closest(CHATGPT_SELECTORS.turn) &&
        !response.closest(CHATGPT_SELECTORS.userTurn) &&
        isGeneratedImageResponse(response),
      )
    const imageMessages = [...document.querySelectorAll(CHATGPT_SELECTORS.imageMessage)]
      .filter(message => !message.closest(CHATGPT_SELECTORS.transcriptUserUnit) && isGeneratedImageResponse(message))
    return uniqueElements([
      ...(turnResponses.length > 0 ? turnResponses : [...document.querySelectorAll(CHATGPT_SELECTORS.response)]),
      ...document.querySelectorAll(CHATGPT_SELECTORS.transcriptResponse),
      ...standaloneImageResponses,
      ...imageMessages,
    ])
  }

  function getAllAssistantReplies(): string[] {
    return keepDeepestResponseContainers(getResponseContainers()).map(container => extractCleanText(container)).filter(Boolean)
  }

  async function fillAndSend(content: string, autoSend = true): Promise<void> {
    const editor = await waitForChatGptEditor(inputTimeoutMs)

    setContentEditableText(editor, content)
    if (readEditorText(editor) !== content.trim()) {
      throw new Error('ChatGPT editor did not accept the prompt text')
    }

    if (!autoSend) return

    try {
      const sendButton = await waitForClickableButton(CHATGPT_SELECTORS.sendButton, inputTimeoutMs, 'ChatGPT 发送按钮暂不可用，请稍后重试')
      sendButton.click()
    } catch (error) {
      if (!tryKeyboardSubmit(editor)) throw error
    }
  }

  return {
    id: 'chatgpt',
    getConversationSnapshot,
    getConversationId,
    getResponseContainers,
    getAllAssistantReplies,
    readResponseText: extractCleanText,
    readResponseImages: extractResponseImages,
    readResponseTextFromCopy: node => readResponseTextFromCopy(node, clipboardTimeoutMs, clipboardPollMs),
    readResponseMarkdown: extractMarkdownFromDom,
    findResponseContainer,
    readResponseId: readChatGptResponseId,
    isGenerating: isChatGptGenerating,
    checkStatus: checkChatGptStatus,
    findEditor: findChatGptEditor,
    stopGenerating: stopChatGptGenerating,
    fillAndSend,
    collectPromptDiagnostics,
  }
}

function checkChatGptStatus(context: SiteHealthContext): SiteStatusInfo {
  return checkSiteHealth({
    findEditor: findChatGptEditor,
    isGenerating: isChatGptGenerating,
    isLoginPage: () => /\/(auth\/)?log-?in\b/.test(location.pathname),
    findSiteError: () => document.querySelector(CHATGPT_SELECTORS.errorDialog)?.textContent?.trim() || undefined,
  }, context)
}

async function readResponseTextFromCopy(node: Node, timeoutMs: number, pollMs: number): Promise<string | undefined> {
  return readResponseTextFromCopyAction({ node, timeoutMs, pollMs, findCopyButton })
}

function findCopyButton(response: Element): HTMLButtonElement | undefined {
  const turn = response.closest(CHATGPT_SELECTORS.turn) ?? response.parentElement
  const turnActionCopyButton = findTurnActionCopyButton(turn)
  if (turnActionCopyButton) return turnActionCopyButton

  return findLastClickableCopyButton(turn, CHATGPT_SELECTORS.copyButton)
}

function findTurnActionCopyButton(turn: Element | null): HTMLButtonElement | undefined {
  const actions = turn?.querySelector(CHATGPT_SELECTORS.responseActions)
  const button = actions?.querySelector<HTMLButtonElement>(CHATGPT_SELECTORS.turnCopyButton)
  return button && isClickableButton(button) ? button : undefined
}

function findLastClickableCopyButton(scope: Element | null, selectors: string): HTMLButtonElement | undefined {
  const buttons = [...(scope?.querySelectorAll<HTMLButtonElement>(selectors) ?? [])]
  return buttons.reverse().find(button => isClickableButton(button) && isVisibleElement(button))
}

export function getChatGptConversationLocation(href: string): ConversationSnapshot {
  const url = parseSafeChatGptUrl(href)
  if (!url) return {}

  return {
    conversationId: extractConversationId(url),
    conversationUrl: url.href,
  }
}

function parseSafeChatGptUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && CHATGPT_HOSTS.has(url.hostname) ? url : undefined
  } catch {
    return undefined
  }
}

function extractConversationId(url: URL): string | undefined {
  const directConversationId = url.pathname.startsWith('/c/') ? url.pathname.slice('/c/'.length).split('/')[0] : undefined
  const gptsConversationId = url.pathname.match(/^\/g\/[^/]+\/c\/([^/]+)/)?.[1]
  const conversationId = directConversationId ?? gptsConversationId
  return conversationId ? decodeURIComponent(conversationId) : undefined
}

function collectPromptDiagnostics(): Record<string, unknown> {
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    title: document.title,
    editorMatches: [...document.querySelectorAll(CHATGPT_SELECTORS.editor)].slice(0, 5).map(describeElement),
    sendButtonMatches: [...document.querySelectorAll(CHATGPT_SELECTORS.sendButton)].slice(0, 5).map(describeElement),
    visibleButtonSamples: [...document.querySelectorAll('button')].slice(0, 12).map(describeElement),
  }
}

function extractCleanText(node: Node): string {
  return extractCleanTextFromDom(node, { skipTags: SKIP_TAGS })
}

// Each ChatGPT reply carries its message id (a UUID). ChatGPT keeps only the last few turns of a
// long conversation on the page.
const CHATGPT_MESSAGE_ID_ATTRIBUTES = ['data-chatgpt-selection-message-id', 'data-message-id'] as const

export function readChatGptResponseId(element: Element): string | undefined {
  const selector = CHATGPT_MESSAGE_ID_ATTRIBUTES.map(name => `[${name}]`).join(', ')
  const holder = element.closest(selector) ?? element.querySelector(selector)
  for (const name of CHATGPT_MESSAGE_ID_ATTRIBUTES) {
    const id = holder?.getAttribute(name)
    if (id) return id
  }
  return undefined
}

function findResponseContainer(element: Element | null): Element | null {
  const turn = element?.closest(CHATGPT_SELECTORS.turn)
  const turnResponse = turn ? findPrimaryResponseInTurn(turn) : null
  if (turnResponse) return turnResponse

  const textResponse = findClosestMatchingAncestor(element, `${CHATGPT_SELECTORS.response}, ${CHATGPT_SELECTORS.transcriptResponse}`)
  if (textResponse) return textResponse

  const imageMessage = findClosestMatchingAncestor(element, CHATGPT_SELECTORS.imageMessage)
  if (imageMessage && !imageMessage.closest(CHATGPT_SELECTORS.transcriptUserUnit) && isGeneratedImageResponse(imageMessage)) return imageMessage

  const imageResponse = findClosestMatchingAncestor(element, CHATGPT_SELECTORS.imageResponse)
  return imageResponse &&
    !imageResponse.closest(CHATGPT_SELECTORS.userTurn) &&
    isGeneratedImageResponse(imageResponse)
    ? imageResponse
    : null
}

function isChatGptGenerating(): boolean {
  return Boolean(findChatGptStopButton() || findChatGptActivityIndicator())
}

async function stopChatGptGenerating(): Promise<boolean> {
  const button = findChatGptStopButton()
  if (!button) return false
  button.click()
  return true
}

function findChatGptStopButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => buttonLabelMatches(button, /stop|stopping|停止|中止/) && isClickableButton(button) && isVisibleInteractiveElement(button))
}

function findChatGptActivityIndicator(): Element | undefined {
  const explicitIndicator = [...document.querySelectorAll(CHATGPT_SELECTORS.activityIndicator)].find(isVisibleOrDocumentedIndicator)
  if (explicitIndicator) return explicitIndicator

  return [...document.querySelectorAll(CHATGPT_SELECTORS.turn)].reverse().find(turn => {
    if (turn.getAttribute('data-turn') !== 'assistant') return false
    return hasShortThinkingStatus(turn)
  })
}

function hasShortThinkingStatus(scope: Element): boolean {
  return [...scope.querySelectorAll<HTMLElement>('div, span, p')].some(element => {
    if (!isVisibleOrDocumentedIndicator(element)) return false
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length > 80) return false
    return /^(正在)?思考中?[。.．…\s]*$|^thinking[.\s…]*$|^reasoning[.\s…]*$/i.test(text)
  })
}

function findPrimaryResponseInTurn(turn: Element): Element | null {
  const textResponse =
    turn.querySelector('[data-message-author-role="assistant"][data-turn-start-message="true"]') ??
    turn.querySelector('[data-message-author-role="assistant"][data-message-id]') ??
    turn.querySelector(CHATGPT_SELECTORS.response)
  if (textResponse) return textResponse

  const screenshotResponse = turn.querySelector(CHATGPT_SELECTORS.imageResponse)
  return screenshotResponse && isReportableScreenshotResponse(screenshotResponse) ? screenshotResponse : null
}

function isGeneratedImageResponse(element: Element): boolean {
  return extractResponseImages(element).length > 0
}

function isReportableScreenshotResponse(element: Element): boolean {
  return isGeneratedImageResponse(element) || Boolean(extractCleanText(element).trim())
}

function extractResponseImages(node: Node): ReplyImageSource[] {
  const scope = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  if (!scope) return []

  const bySourceUrl = new Map<string, ReplyImageSource>()
  for (const image of scope.querySelectorAll<HTMLImageElement>(CHATGPT_SELECTORS.generatedImage)) {
    const sourceUrl = normalizeGeneratedImageUrl(image.currentSrc || image.src)
    if (!sourceUrl) continue

    const current = bySourceUrl.get(sourceUrl)
    const candidate: ReplyImageSource = {
      sourceUrl,
      ...(image.alt.trim() ? { alt: image.alt.trim() } : {}),
      ...readImageDimensions(image),
    }
    bySourceUrl.set(sourceUrl, mergeImageCandidate(current, candidate))
  }

  return [...bySourceUrl.values()]
}

// https images, and blob: images made by ChatGPT itself (read inside the page before sending).
function normalizeGeneratedImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value, location.href)
    if (url.protocol === 'https:') return url.href
    if (url.protocol === 'blob:' && CHATGPT_ORIGINS.has(url.origin)) return url.href
    return undefined
  } catch {
    return undefined
  }
}

function readImageDimensions(image: HTMLImageElement): Pick<ReplyImageSource, 'width' | 'height'> {
  const width = image.naturalWidth || image.width
  const height = image.naturalHeight || image.height
  return {
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
  }
}

function mergeImageCandidate(current: ReplyImageSource | undefined, candidate: ReplyImageSource): ReplyImageSource {
  if (!current) return candidate
  return {
    sourceUrl: current.sourceUrl,
    alt: current.alt ?? candidate.alt,
    width: current.width ?? candidate.width,
    height: current.height ?? candidate.height,
  }
}

function uniqueElements(elements: Element[]): Element[] {
  return [...new Set(elements)]
}

function isVisibleElement(element: Element): boolean {
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  return element.getClientRects().length > 0 || Boolean((element as HTMLElement).offsetParent)
}

function isVisibleInteractiveElement(element: Element): boolean {
  const style = window.getComputedStyle(element)
  if (style.pointerEvents === 'none') return false
  return isVisibleElement(element)
}

function isVisibleOrDocumentedIndicator(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return false
  return isVisibleElement(element) || element.hasAttribute('aria-busy') || Boolean(element.getAttribute('data-testid'))
}
