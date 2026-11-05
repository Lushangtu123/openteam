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
}

// Puts files into an AI site's composer the way a user would: pasting them into the input box, or,
// if the site ignores that, choosing them in its file input. Throws unless the site visibly takes
// them, so a prompt is never sent without the images it refers to.
export async function attachFilesToComposer(options: AttachFilesOptions): Promise<void> {
  if (options.files.length === 0) return
  const files = options.files.map(toFile)
  const composer = findComposer(options.editor)
  const baseline = readComposer(composer)

  options.editor.focus()
  const paste = transferOf(files)
  options.editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: paste, bubbles: true, cancelable: true }))
  let result = await waitForAttachment(composer, baseline, options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS)

  if (result === 'none') {
    const input = findFileInput(composer, options.editor.ownerDocument)
    if (input) {
      input.files = transferOf(files).files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      result = await waitForAttachment(composer, baseline, options.attachTimeoutMs ?? ATTACH_TIMEOUT_MS)
    }
  }

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

function findComposer(editor: HTMLElement): HTMLElement {
  const form = editor.closest('form')
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

function findFileInput(composer: HTMLElement, doc: Document): HTMLInputElement | undefined {
  const accepts = (input: HTMLInputElement) => !input.disabled && (!input.accept || /image|\*/.test(input.accept))
  const inComposer = [...composer.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(accepts)
  return inComposer ?? [...doc.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(accepts)
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
