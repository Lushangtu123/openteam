// A text file attached to a message, shown in OpenTeam: before it is sent (from the attachment tray)
// and after (from the message). Markdown is laid out as it reads; other text is shown as it is. The
// window has the file's size and a button to download it.
import { createIcon } from './icons'
import { renderMarkdownInto } from './markdownRender'
import { formatBytes } from './composerAttachments'

export interface PreviewFile {
  fileName: string
  text: string
  mimeType?: string
}

export function isMarkdownFile(file: Pick<PreviewFile, 'fileName' | 'mimeType'>): boolean {
  return /\.(md|markdown)$/i.test(file.fileName) || /markdown/i.test(file.mimeType ?? '')
}

export function openFilePreview(file: PreviewFile, options: { english: boolean; onClose?(): void }): { close(): void } {
  document.querySelector('.file-preview-modal')?.remove()
  const t = (zh: string, en: string): string => options.english ? en : zh
  const backdrop = element('div', 'modal-backdrop file-preview-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal file-preview-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'file-preview-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', 'file-preview-title', file.fileName)
  title.id = 'file-preview-title'
  const bytes = new TextEncoder().encode(file.text).length
  const characters = [...file.text].length
  heading.append(title, element('p', 'tiny file-preview-size', t(`${formatBytes(bytes)} · ${characters} 字`, `${formatBytes(bytes)} · ${characters} characters`)))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const body = element('div', 'file-preview-body')
  body.tabIndex = 0
  body.setAttribute('aria-label', t('文件内容', 'File content'))
  if (isMarkdownFile(file)) {
    body.classList.add('file-preview-markdown')
    renderMarkdownInto(body, file.text)
  } else {
    body.append(element('pre', 'file-preview-text', file.text))
  }

  const actions = element('div', 'team-setup-actions file-preview-actions')
  const download = element('button', 'btn')
  download.type = 'button'
  download.append(createIcon('download'), element('span', '', t('下载', 'Download')))
  download.addEventListener('click', () => downloadFile(file))
  const done = element('button', 'btn btn-primary', t('关闭', 'Close'))
  done.type = 'button'
  done.addEventListener('click', () => close())
  actions.append(download, done)

  dialog.append(header, body, actions)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  body.focus()

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    options.onClose?.()
  }

  return { close }
}

export function downloadFile(file: PreviewFile): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType || 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
