// A text file attached to a message, shown in OpenTeam: before it is sent (from the attachment tray)
// and after (from the message). Markdown is laid out as it reads; other text is shown as it is. The
// window has the file's size and a button to download it. Before sending, the file can be edited
// (onSave): what is saved is what the members get.
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

export interface FilePreviewOptions {
  english: boolean
  onClose?(): void
  // Keeps an edit; resolves to why it cannot be kept, if it cannot. Without it the file is read-only.
  onSave?(text: string): string | undefined | Promise<string | undefined>
}

export function openFilePreview(source: PreviewFile, options: FilePreviewOptions): { close(): void } {
  let file = source
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
  const size = element('p', 'tiny file-preview-size')
  heading.append(title, size)
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const body = element('div', 'file-preview-body')
  body.tabIndex = 0
  body.setAttribute('aria-label', t('文件内容', 'File content'))
  const editor = element('textarea', 'file-preview-editor')
  editor.setAttribute('aria-label', t('编辑文件内容', 'Edit the file'))
  editor.spellcheck = false
  editor.addEventListener('input', () => {
    error.textContent = ''
    renderSize(editor.value)
  })
  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')

  const actions = element('div', 'team-setup-actions file-preview-actions')
  const download = button(t('下载', 'Download'), 'download', () => downloadFile(file))
  const edit = button(t('编辑', 'Edit'), 'edit', () => startEditing())
  const done = button(t('关闭', 'Close'), undefined, () => close(), 'btn btn-primary')
  const cancelEdit = button(t('取消编辑', 'Cancel editing'), undefined, () => stopEditing())
  const save = button(t('保存', 'Save'), undefined, () => void saveEdit(), 'btn btn-primary')

  dialog.append(header, body, editor, error, actions)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  showFile()
  body.focus()

  function renderSize(text: string): void {
    const bytes = new TextEncoder().encode(text).length
    const characters = [...text].length
    size.textContent = t(`${formatBytes(bytes)} · ${characters} 字`, `${formatBytes(bytes)} · ${characters} characters`)
  }

  function showFile(): void {
    renderSize(file.text)
    body.replaceChildren()
    body.classList.toggle('file-preview-markdown', isMarkdownFile(file))
    if (isMarkdownFile(file)) renderMarkdownInto(body, file.text)
    else body.append(element('pre', 'file-preview-text', file.text))
    body.hidden = false
    editor.hidden = true
    error.textContent = ''
    actions.replaceChildren(download, ...(options.onSave ? [edit] : []), done)
  }

  function startEditing(): void {
    editor.value = file.text
    body.hidden = true
    editor.hidden = false
    actions.replaceChildren(cancelEdit, save)
    editor.focus()
    editor.setSelectionRange(0, 0)
    editor.scrollTop = 0
  }

  function stopEditing(): void {
    showFile()
    edit.focus()
  }

  async function saveEdit(): Promise<void> {
    const text = editor.value
    if (!text.trim()) {
      error.textContent = t('内容不能为空；不想要这个文件的话，在输入框上方把它移除。', 'The file cannot be empty; to drop it, remove it above the message box.')
      editor.focus()
      return
    }
    save.disabled = true
    try {
      const refused = await options.onSave?.(text)
      if (refused) {
        error.textContent = refused
        return
      }
      file = { ...file, text }
      showFile()
      edit.focus()
    } finally {
      save.disabled = false
    }
  }

  // Esc leaves editing first (keeping the file as it was), then closes.
  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (!editor.hidden) stopEditing()
    else close()
  }

  function button(label: string, icon: 'download' | 'edit' | undefined, run: () => void, className = 'btn'): HTMLButtonElement {
    const node = element('button', className)
    node.type = 'button'
    if (icon) node.append(createIcon(icon))
    node.append(element('span', '', label))
    node.addEventListener('click', run)
    return node
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
