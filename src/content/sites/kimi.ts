import { CHAT_SITE_INFO, chatSiteConversationId, chatSiteForUrl } from '../../group/chatSites'
import { readResponseTextFromCopyAction } from './clipboardCopy'
import { extractMarkdownFromDom } from './domMarkdown'
import { describeElement, extractCleanTextFromDom, findClosestMatchingAncestor } from './domText'
import { checkSiteHealth, hasLoginControls } from './siteHealth'
import type { ChatSiteAdapter, ConversationSnapshot } from './types'
import { waitForElement } from './waitForElement'

// www.kimi.com, Moonshot's Kimi. A turn is a .chat-content-item-user followed by a
// .chat-content-item-assistant, whose answer is a .markdown inside its tool-call rollup (thinking
// and tool output use .toolcall-content-text and are left out); the Copy icon in the actions row
// copies the answer as Markdown. The input box is a Lexical editor.
const DEFAULT_INPUT_TIMEOUT_MS = 9000
const DEFAULT_CLIPBOARD_TIMEOUT_MS = 1500
const DEFAULT_CLIPBOARD_POLL_MS = 50
// Kimi turns a paste longer than 1,500 characters into a .txt attachment, so prompts go in as
// several shorter pastes, which it keeps as text.
export const KIMI_PASTE_CHUNK_CHARS = 1000
const SEND_CONFIRM_MS = 6000
// How long a refused prompt may sit back in the box before the refusal is reported, so a dialog
// that explains it has time to open.
const RESTORED_SETTLE_MS = 800

export const KIMI_SELECTORS = {
  editor: '.chat-input-editor[contenteditable="true"][data-lexical-editor="true"], .chat-input-editor[role="textbox"][contenteditable="true"]',
  composer: '.chat-editor',
  sendButton: '.send-button-container',
  attachment: '.chat-editor-attachment-area .file-card-container',
  userMessage: '.chat-content-item-user',
  assistantMessage: '.chat-content-item-assistant',
  answer: '.markdown-container:not(.toolcall-content-text) > .markdown',
  notAnswer: '.thinking-container, .toolcall-container, .toolcall-content-text',
  copyIcon: '.segment-assistant-actions .icon-button svg[name="Copy"]',
  stopIcon: 'svg[name="Stop"], svg[name="Pause"]',
  // Kimi's dialogs (sign-in, "too many people are chatting") sit in a full-page mask.
  modal: '.modal-mask .modal-container',
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'SVG', 'svg'])

interface KimiAdapterOptions {
  href?: string
  inputTimeoutMs?: number
  clipboardTimeoutMs?: number
  clipboardPollMs?: number
  sendConfirmMs?: number
}

export function createKimiAdapter(options: KimiAdapterOptions = {}): ChatSiteAdapter {
  const inputTimeoutMs = options.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS
  const clipboardTimeoutMs = options.clipboardTimeoutMs ?? DEFAULT_CLIPBOARD_TIMEOUT_MS
  const clipboardPollMs = options.clipboardPollMs ?? DEFAULT_CLIPBOARD_POLL_MS
  const sendConfirmMs = options.sendConfirmMs ?? SEND_CONFIRM_MS

  function getConversationSnapshot(): ConversationSnapshot {
    return getKimiConversationLocation(options.href ?? location.href)
  }

  async function fillAndSend(content: string, autoSend = true): Promise<void> {
    const blockedBefore = findBlockingDialog()
    if (blockedBefore !== undefined) throw new Error(blockedMessage(blockedBefore))

    const editor = await waitForElement(KIMI_SELECTORS.editor, inputTimeoutMs)
    await writePrompt(editor, content)
    if (comparable(editorText(editor)) !== comparable(content)) {
      throw new Error(document.querySelector(KIMI_SELECTORS.attachment)
        ? 'Kimi 把输入的内容转成了附件，请删掉输入框里的附件后重试'
        : 'Kimi 输入框没有接收完整的内容')
    }
    if (!autoSend) return

    const assistantTurns = document.querySelectorAll(KIMI_SELECTORS.assistantMessage).length
    const sendButton = await waitForSendButton(inputTimeoutMs)
    sendButton.click()
    await confirmSent(content, assistantTurns, sendConfirmMs)
  }

  return {
    id: 'kimi',
    getConversationSnapshot,
    getConversationId: () => getConversationSnapshot().conversationId || '__default__',
    getResponseContainers,
    getAllAssistantReplies: () => getResponseContainers().map(readKimiResponseText).filter(Boolean),
    readResponseText: readKimiResponseText,
    readResponseMarkdown: readKimiResponseMarkdown,
    readResponseTextFromCopy: node => readResponseTextFromCopyAction({ node, timeoutMs: clipboardTimeoutMs, pollMs: clipboardPollMs, findCopyButton }),
    findResponseContainer: element => findClosestMatchingAncestor(element, KIMI_SELECTORS.assistantMessage),
    isGenerating: isKimiGenerating,
    findEditor: () => document.querySelector<HTMLElement>(KIMI_SELECTORS.editor),
    checkStatus: context => checkSiteHealth({
      findEditor: () => document.querySelector(KIMI_SELECTORS.editor),
      isGenerating: isKimiGenerating,
      findBlockingDialog,
    }, context),
    stopGenerating: async () => {
      const button = findStopButton()
      if (!button) return false
      button.click()
      return true
    },
    fillAndSend,
    collectPromptDiagnostics,
  }
}

export function getKimiConversationLocation(href: string): ConversationSnapshot {
  if (chatSiteForUrl(href) !== 'kimi') return {}
  return { conversationId: chatSiteConversationId(href), conversationUrl: new URL(href).href }
}

// Splits a prompt into pastes Kimi keeps as text, never between the two halves of an emoji.
export function kimiPasteChunks(content: string, size = KIMI_PASTE_CHUNK_CHARS): string[] {
  const text = content.replace(/\r\n?/g, '\n')
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length)
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

// Lexical keeps its own copy of the text, so writing the DOM directly is undone on its next update.
// It does handle the browser's own editing events: a deleteContentBackward beforeinput empties the
// selection, and a paste inserts text with its line breaks (execCommand insertText drops them).
async function writePrompt(editor: HTMLElement, content: string): Promise<void> {
  editor.focus()
  selectContents(editor)
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }))
  await nextTask()
  for (const chunk of kimiPasteChunks(content)) {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', chunk)
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    await nextTask()
  }
  await nextTask()
}

function selectContents(editor: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(editor)
  selection.removeAllRanges()
  selection.addRange(range)
}

function nextTask(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 0))
}

// Lexical shows line breaks and spaces its own way, so the check ignores whitespace.
function comparable(value: string): string {
  return value.replace(/[\s ​]+/g, '')
}

async function waitForSendButton(timeoutMs: number): Promise<HTMLElement> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const button = [...document.querySelectorAll<HTMLElement>(`${KIMI_SELECTORS.composer} ${KIMI_SELECTORS.sendButton}, ${KIMI_SELECTORS.sendButton}`)]
      .find(candidate => !candidate.classList.contains('disabled') && candidate.getAttribute('aria-disabled') !== 'true' && !candidate.querySelector(KIMI_SELECTORS.stopIcon))
    if (button) return button
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }
  throw new Error('Kimi 发送按钮暂不可用，请稍后重试')
}

// Kimi empties the input box as soon as Send is clicked, and may even show the question as a new
// turn, before refusing the message: with a dialog ("Too many people are chatting with Kimi"), or
// by going back to the start page with the prompt put back in the box (a usage limit). So neither
// an empty box nor a new question proves the message went out; Kimi starting to generate or a reply
// appearing does. With neither, the wait ends after timeoutMs and the message counts as sent unless
// the prompt is back in the box.
async function confirmSent(prompt: string, assistantTurnsBefore: number, timeoutMs: number): Promise<void> {
  const expected = comparable(prompt)
  const startedAt = Date.now()
  let emptied = false
  let restoredAt: number | undefined
  const promptInBox = () => {
    const editor = document.querySelector<HTMLElement>(KIMI_SELECTORS.editor)
    return editor ? comparable(editorText(editor)) : ''
  }
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => window.setTimeout(resolve, 100))
    const blocked = findBlockingDialog()
    if (blocked !== undefined) throw new Error(blockedMessage(blocked))
    if (isKimiGenerating() || document.querySelectorAll(KIMI_SELECTORS.assistantMessage).length > assistantTurnsBefore) return
    const inBox = promptInBox()
    if (!inBox) {
      emptied = true
      restoredAt = undefined
    } else if (emptied && inBox === expected) {
      restoredAt ??= Date.now()
      if (Date.now() - restoredAt >= RESTORED_SETTLE_MS) throw notSentError()
    }
  }
  // Still sitting in the box: the click did nothing.
  if (promptInBox() === expected) throw notSentError()
}

function notSentError(): Error {
  return new Error(hasLoginControls()
    ? 'Kimi 没有发出这条消息：这个页面还没有登录 Kimi，请先在 Kimi 页面登录'
    : 'Kimi 没有发出这条消息（可能是使用额度用完或排队人数太多），请到 Kimi 页面查看')
}

function editorText(editor: HTMLElement): string {
  return editor.innerText || editor.textContent || ''
}

// The text of an open Kimi dialog, or undefined when there is none.
export function findBlockingDialog(): string | undefined {
  const dialog = [...document.querySelectorAll<HTMLElement>(KIMI_SELECTORS.modal)].find(isShown)
  return dialog ? (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : undefined
}

function blockedMessage(dialog: string): string {
  return `Kimi 页面上有弹窗挡住了发送${dialog ? `：「${dialog}」` : ''}，请在 Kimi 页面里处理后重试`
}

function isShown(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

function getResponseContainers(): Element[] {
  return [...document.querySelectorAll(KIMI_SELECTORS.assistantMessage)]
}

function answerParts(node: Node): Element[] {
  if (node.nodeType !== Node.ELEMENT_NODE) return []
  return [...(node as Element).querySelectorAll(KIMI_SELECTORS.answer)].filter(part => !part.closest(KIMI_SELECTORS.notAnswer))
}

function readKimiResponseText(node: Node): string {
  return answerParts(node).map(part => extractCleanTextFromDom(part, { skipTags: SKIP_TAGS })).filter(Boolean).join('\n\n')
}

function readKimiResponseMarkdown(node: Node): string {
  return answerParts(node).map(part => extractMarkdownFromDom(part)).filter(Boolean).join('\n\n')
}

function findCopyButton(response: Element): HTMLElement | undefined {
  return response.querySelector(KIMI_SELECTORS.copyIcon)?.closest<HTMLElement>('.icon-button') ?? undefined
}

function isKimiGenerating(): boolean {
  return Boolean(findStopButton())
}

function findStopButton(): HTMLElement | undefined {
  return [...document.querySelectorAll(KIMI_SELECTORS.stopIcon)]
    .map(icon => icon.closest<HTMLElement>(`${KIMI_SELECTORS.sendButton}, .icon-button, button, [role="button"]`))
    .find((button): button is HTMLElement => Boolean(button) && !button!.classList.contains('disabled'))
}

function collectPromptDiagnostics(): Record<string, unknown> {
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    title: document.title,
    homeUrl: CHAT_SITE_INFO.kimi.homeUrl,
    editorMatches: [...document.querySelectorAll(KIMI_SELECTORS.editor)].slice(0, 5).map(describeElement),
    sendButtonMatches: [...document.querySelectorAll(KIMI_SELECTORS.sendButton)].slice(0, 5).map(element => ({ ...describeElement(element), icons: [...element.querySelectorAll('svg[name]')].map(icon => icon.getAttribute('name')) })),
    attachments: document.querySelectorAll(KIMI_SELECTORS.attachment).length,
    dialog: findBlockingDialog(),
  }
}
