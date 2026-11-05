import { CHAT_SITE_INFO, chatSiteConversationId, chatSiteForUrl } from '../../group/chatSites'
import { findClickableCopyButton, readResponseTextFromCopyAction } from './clipboardCopy'
import { extractMarkdownFromDom } from './domMarkdown'
import { buttonLabelMatches, describeElement, extractCleanTextFromDom, findClosestMatchingAncestor } from './domText'
import { checkSiteHealth } from './siteHealth'
import type { ChatSiteAdapter, ConversationSnapshot } from './types'
import { isClickableButton, waitForElement } from './waitForElement'

// chat.qwen.ai, Alibaba's Qwen Chat. A turn is a .qwen-chat-message-user followed by a
// .qwen-chat-message-assistant, whose answer is .response-message-content (class phase-answer)
// after a collapsible thinking card; the copy button in its footer copies the answer as Markdown.
const DEFAULT_INPUT_TIMEOUT_MS = 9000
const DEFAULT_CLIPBOARD_TIMEOUT_MS = 1500
const DEFAULT_CLIPBOARD_POLL_MS = 50
const SEND_CONFIRM_MS = 1500

export const QWEN_SELECTORS = {
  editor: 'textarea.message-input-textarea',
  composer: '.message-input',
  sendButton: 'button.send-button',
  stopButton: 'button.stop-button',
  assistantMessage: '.qwen-chat-message-assistant',
  answer: '.response-message-content',
  // Parts of an assistant turn that are not the answer.
  notAnswer: '.qwen-chat-thinking-tool-status-card-wraper, .qwen-chat-status-card, .qwen-chat-tool-status-card, .response-message-footer, .message-hoc-container, .qwen-markdown-code-header-wrapper',
  copyButton: '.response-message-footer button[aria-label="Copy"], .response-message-footer button[aria-label="复制"]',
  // Ant Design modals; closed ones are removed or hidden with display: none on their wrapper.
  modal: '.ant-modal-wrap .ant-modal[aria-modal="true"], .ant-modal-wrap [role="dialog"][aria-modal="true"]',
  codeBlock: 'pre.qwen-markdown-code',
  codeLine: '.view-lines .view-line',
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'SVG', 'svg'])

interface QwenAdapterOptions {
  href?: string
  inputTimeoutMs?: number
  clipboardTimeoutMs?: number
  clipboardPollMs?: number
}

export function createQwenAdapter(options: QwenAdapterOptions = {}): ChatSiteAdapter {
  const inputTimeoutMs = options.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS
  const clipboardTimeoutMs = options.clipboardTimeoutMs ?? DEFAULT_CLIPBOARD_TIMEOUT_MS
  const clipboardPollMs = options.clipboardPollMs ?? DEFAULT_CLIPBOARD_POLL_MS

  function getConversationSnapshot(): ConversationSnapshot {
    return getQwenConversationLocation(options.href ?? location.href)
  }

  async function fillAndSend(content: string, autoSend = true): Promise<void> {
    const editor = await waitForElement(QWEN_SELECTORS.editor, inputTimeoutMs)
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error('Qwen editor is not a textarea')

    setTextareaValue(editor, content)
    if (normalizeNewlines(editor.value).trim() !== normalizeNewlines(content).trim()) {
      throw new Error('Qwen editor did not accept the prompt text')
    }
    if (!autoSend) return

    const blocked = findBlockingDialog()
    if (blocked !== undefined) throw new Error(blockedMessage(blocked))
    const sendButton = await waitForSendButton(editor, inputTimeoutMs)
    sendButton.click()
    await confirmSent(editor)
  }

  return {
    id: 'qwen',
    getConversationSnapshot,
    getConversationId: () => getConversationSnapshot().conversationId || '__default__',
    getResponseContainers,
    getAllAssistantReplies: () => getResponseContainers().map(readQwenResponseText).filter(Boolean),
    readResponseText: readQwenResponseText,
    readResponseMarkdown: readQwenResponseMarkdown,
    readResponseTextFromCopy: node => readResponseTextFromCopyAction({ node, timeoutMs: clipboardTimeoutMs, pollMs: clipboardPollMs, findCopyButton }),
    findResponseContainer: element => findClosestMatchingAncestor(element, QWEN_SELECTORS.assistantMessage),
    isGenerating: isQwenGenerating,
    findEditor: () => document.querySelector<HTMLElement>(QWEN_SELECTORS.editor),
    checkStatus: context => checkSiteHealth({
      findEditor: () => document.querySelector(QWEN_SELECTORS.editor),
      isGenerating: isQwenGenerating,
      isLoginPage: () => /^\/auth\b/.test(location.pathname),
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

export function getQwenConversationLocation(href: string): ConversationSnapshot {
  if (chatSiteForUrl(href) !== 'qwen') return {}
  return { conversationId: chatSiteConversationId(href), conversationUrl: new URL(href).href }
}

function getResponseContainers(): Element[] {
  return [...document.querySelectorAll(QWEN_SELECTORS.assistantMessage)]
}

function readQwenResponseText(node: Node): string {
  const answer = answerCopy(node)
  return answer ? extractCleanTextFromDom(answer, { skipTags: SKIP_TAGS }) : ''
}

function readQwenResponseMarkdown(node: Node): string {
  const answer = answerCopy(node)
  return answer ? extractMarkdownFromDom(answer) : ''
}

// A detached copy of the answer, without the thinking card, footer and code block headers, and with
// each Monaco code block turned back into a plain <pre><code> (Monaco draws one element per line).
function answerCopy(node: Node): HTMLElement | undefined {
  if (node.nodeType !== Node.ELEMENT_NODE) return undefined
  const turn = node as Element
  const answers = [...turn.querySelectorAll(QWEN_SELECTORS.answer)]
    .filter(answer => !answer.closest(QWEN_SELECTORS.notAnswer) && !/\bphase-think/.test(answer.className))
  const finalAnswers = answers.filter(answer => answer.classList.contains('phase-answer'))
  const parts = finalAnswers.length > 0 ? finalAnswers : answers
  if (parts.length === 0) return undefined

  const root = document.createElement('div')
  for (const part of parts) {
    const copy = part.cloneNode(true) as Element
    copy.querySelectorAll(QWEN_SELECTORS.codeBlock).forEach(block => block.replaceWith(plainCodeBlock(block)))
    copy.querySelectorAll(QWEN_SELECTORS.notAnswer).forEach(element => element.remove())
    root.append(copy)
  }
  return root
}

function plainCodeBlock(block: Element): HTMLPreElement {
  const lines = [...block.querySelectorAll<HTMLElement>(QWEN_SELECTORS.codeLine)]
    .map(line => ({ top: Number.parseFloat(line.style.top) || 0, text: (line.textContent ?? '').replace(/ /g, ' ') }))
    .sort((a, b) => a.top - b.top)
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = lines.length > 0 ? lines.map(line => line.text).join('\n') : (block.querySelector('code')?.textContent ?? '')
  pre.append(code)
  return pre
}

// The text of an open modal dialog, or undefined when there is none.
export function findBlockingDialog(): string | undefined {
  const dialog = [...document.querySelectorAll<HTMLElement>(QWEN_SELECTORS.modal)].find(isShown)
  // innerText keeps the line breaks between the dialog's parts (jsdom has only textContent).
  return dialog ? (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : undefined
}

function isShown(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

function blockedMessage(dialog: string): string {
  return `Qwen 页面上有弹窗挡住了发送${dialog ? `：「${dialog}」` : ''}，请在 Qwen 页面里处理后重试`
}

// Qwen empties the input box once a message is on its way. If a dialog opens instead (it asks guests
// to confirm their age on the first send), the message did not go out, so this reports it rather
// than leaving the person waiting for a reply that will not come.
async function confirmSent(editor: HTMLTextAreaElement): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < SEND_CONFIRM_MS) {
    await new Promise(resolve => window.setTimeout(resolve, 100))
    if (!editor.isConnected || !editor.value.trim()) return
    const blocked = findBlockingDialog()
    if (blocked !== undefined) throw new Error(blockedMessage(blocked))
  }
}

function findCopyButton(response: Element): HTMLButtonElement | undefined {
  return findClickableCopyButton(response, QWEN_SELECTORS.copyButton)
}

function isQwenGenerating(): boolean {
  return Boolean(findStopButton())
}

function findStopButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>(QWEN_SELECTORS.stopButton)].find(isClickableButton)
}

async function waitForSendButton(editor: HTMLTextAreaElement, timeoutMs: number): Promise<HTMLElement> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const composer = editor.closest(QWEN_SELECTORS.composer) ?? document.body
    const button = [...composer.querySelectorAll<HTMLButtonElement>(QWEN_SELECTORS.sendButton)]
      .find(candidate => isClickableButton(candidate) && !buttonLabelMatches(candidate, /stop|停止/))
    if (button) return button
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }
  throw new Error('Qwen 发送按钮暂不可用，请稍后重试')
}

// Qwen's input box is a React textarea: setting .value directly would be overwritten, so this
// goes through the prototype's setter before firing the input event React listens to.
function setTextareaValue(textarea: HTMLTextAreaElement, content: string): void {
  textarea.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(textarea, content)
  else textarea.value = content
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }))
  textarea.dispatchEvent(new Event('change', { bubbles: true }))
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function collectPromptDiagnostics(): Record<string, unknown> {
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    title: document.title,
    homeUrl: CHAT_SITE_INFO.qwen.homeUrl,
    editorMatches: [...document.querySelectorAll(QWEN_SELECTORS.editor)].slice(0, 5).map(describeElement),
    sendButtonMatches: [...document.querySelectorAll(QWEN_SELECTORS.sendButton)].slice(0, 5).map(describeElement),
    stopButtonMatches: [...document.querySelectorAll(QWEN_SELECTORS.stopButton)].slice(0, 5).map(describeElement),
  }
}
