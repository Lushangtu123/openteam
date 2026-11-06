import type { PromptFile } from '../group/runtimeProtocol'

// How long a site may take to show an attachment after a paste or a file-input change, and to show
// its own "upload failed" message after that.
const ATTACH_TIMEOUT_MS = 5000
const FAILURE_SETTLE_MS = 2500
const POLL_MS = 200
const UPLOAD_FAILED_TEXT = /failed to upload|upload failed|couldn['’]t upload|unable to upload|上传失败|无法上传|上传出错/i
const ATTACHMENT_HINT = /attach|upload|file|preview|thumbnail|image/i

export interface AttachFilesOptions {
  editor: HTMLElement
  files: PromptFile[]
  attachTimeoutMs?: number
  failureSettleMs?: number
  // See ChatSiteAdapter.revealFileInputs.
  revealFileInputs?(): Promise<(() => void) | undefined>
}

// Puts files into an AI site's composer the way a user would: pasting them into the input box, or,
// if the site ignores that, choosing them in its file input. Throws unless the site visibly takes
// them, so a prompt is never sent without the images it refers to.
export async function attachFilesToComposer(options: AttachFilesOptions): Promise<void> {
  if (options.files.length === 0) return
  const files = options.files.map(toFile)
  const composer = findComposer(options.editor)
  const baseline = readComposer(composer)

  const timeoutMs = options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS
  const paste = async (): Promise<AttachResult> => {
    options.editor.focus()
    options.editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transferOf(files), bubbles: true, cancelable: true }))
    return waitForAttachment(composer, baseline, timeoutMs)
  }
  const choose = async (): Promise<AttachResult> => {
    let input = findFileInput(composer, options.editor.ownerDocument, files.length)
    let close: (() => void) | undefined
    if (!input && options.revealFileInputs) {
      close = await options.revealFileInputs()
      input = findFileInput(composer, options.editor.ownerDocument, files.length)
    }
    try {
      if (!input) return 'none'
      input.files = transferOf(files).files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return await waitForAttachment(composer, baseline, timeoutMs)
    } finally {
      close?.()
    }
  }

  // A site with an upload menu gets the files through its file input; others through a paste.
  const viaInputFirst = Boolean(options.revealFileInputs)
  let result = viaInputFirst ? await choose() : await paste()
  if (result === 'none') result = viaInputFirst ? await paste() : await choose()

  if (result === 'none') throw new Error('图片没有上传成功：网站没有接收文件，可能需要登录，或者网站改版了')
  // A site can show the attachment first and report the failed upload a moment later.
  if (result === 'attached') result = await waitForFailure(composer, baseline, options.failureSettleMs ?? FAILURE_SETTLE_MS)
  if (result === 'failed') throw new Error(`图片没有上传成功：${readFailureText(composer) ?? '网站报告上传失败'}`)
}

interface ComposerSnapshot {
  elements: number
  hinted: number
  images: number
  failed: boolean
}

type AttachResult = 'attached' | 'failed' | 'none'

// The part of the page around the input box where the site shows attached files: its form, or
// the fieldset Gemini uses instead (its previews sit six levels above the input box).
function findComposer(editor: HTMLElement): HTMLElement {
  const form = editor.closest<HTMLElement>('form, fieldset')
  if (form) return form
  let element: HTMLElement = editor
  for (let depth = 0; depth < 4 && element.parentElement && element.parentElement !== element.ownerDocument.body; depth += 1) element = element.parentElement
  return element
}

function readComposer(composer: HTMLElement): ComposerSnapshot {
  const elements = composer.querySelectorAll('*')
  let hinted = 0
  let images = 0
  for (const element of elements) {
    if (element instanceof HTMLImageElement && /^(blob:|data:)/.test(element.src)) images += 1
    const hint = `${element.getAttribute('data-testid') ?? ''} ${typeof element.className === 'string' ? element.className : ''} ${element.getAttribute('aria-label') ?? ''}`
    if (ATTACHMENT_HINT.test(hint)) hinted += 1
  }
  return { elements: elements.length, hinted, images, failed: Boolean(readFailureText(composer)) }
}

function compare(composer: HTMLElement, baseline: ComposerSnapshot): AttachResult {
  const current = readComposer(composer)
  if (current.failed && !baseline.failed) return 'failed'
  if (current.images > baseline.images || current.hinted > baseline.hinted || current.elements >= baseline.elements + 2) return 'attached'
  return 'none'
}

async function waitForAttachment(composer: HTMLElement, baseline: ComposerSnapshot, timeoutMs: number): Promise<AttachResult> {
  for (let waited = 0; waited <= timeoutMs; waited += POLL_MS) {
    const result = compare(composer, baseline)
    if (result !== 'none') return result
    await sleep(POLL_MS)
  }
  return 'none'
}

async function waitForFailure(composer: HTMLElement, baseline: ComposerSnapshot, settleMs: number): Promise<AttachResult> {
  for (let waited = 0; waited <= settleMs; waited += POLL_MS) {
    if (readComposer(composer).failed && !baseline.failed) return 'failed'
    await sleep(POLL_MS)
  }
  return 'attached'
}

function readFailureText(composer: HTMLElement): string | undefined {
  const text = composer.innerText ?? composer.textContent ?? ''
  return text.match(UPLOAD_FAILED_TEXT)?.[0]
}

// The file input that best fits the files: one made for images, then one for any file; one that
// takes several files when there are several; one inside the composer before one elsewhere.
function findFileInput(composer: HTMLElement, doc: Document, count: number): HTMLInputElement | undefined {
  const inputs = [...new Set([
    ...composer.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ...doc.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  ])].filter(input => !input.disabled)
  let best: { input: HTMLInputElement; score: number } | undefined
  for (const input of inputs) {
    const kind = acceptsImages(input.accept) ? 4 : input.accept.trim() ? 0 : 2
    if (kind === 0) continue
    const score = kind + (count > 1 && input.multiple ? 1 : 0) + (composer.contains(input) ? 0.5 : 0)
    if (!best || score > best.score) best = { input, score }
  }
  return best?.input
}

function acceptsImages(accept: string): boolean {
  return /image\/|\*/.test(accept) || /\.(png|jpe?g|webp|gif)\b/i.test(accept)
}

function transferOf(files: File[]): DataTransfer {
  const transfer = new DataTransfer()
  for (const file of files) transfer.items.add(file)
  return transfer
}

function toFile(file: PromptFile): File {
  const binary = atob(file.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], file.fileName, { type: file.mimeType })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
