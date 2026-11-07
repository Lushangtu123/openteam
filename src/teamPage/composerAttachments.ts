import { checkUploadFile, MAX_UPLOADS_PER_MESSAGE, UPLOAD_ACCEPT, type MessageUpload, type UploadKind } from '../group/messageUploads'
import { readDocumentText, type DocumentTextLabels } from './documentText'
import { createIcon } from './icons'

export interface ComposerAttachmentsDependencies {
  trayEl: HTMLElement
  attachButtonEl: HTMLButtonElement
  fileInputEl: HTMLInputElement
  // Where files can be pasted (the message input) and dropped (the whole composer).
  pasteTargetEl: HTMLElement
  dropTargetEl: HTMLElement
  ui(source: string): string
  showError(message: string): void
  onChange(): void
  // Reads a PDF or Office file's text; tests pass their own.
  readDocument?(file: File, labels: DocumentTextLabels): Promise<string>
}

export interface PendingAttachment {
  key: string
  file: File
  kind: UploadKind
  previewUrl?: string
  // A PDF or Office file: its text, read as soon as the file is added.
  text?: Promise<string>
  textLength?: number
}

export interface ComposerAttachments {
  register(): void
  list(): PendingAttachment[]
  // Reads the files for sending. Throws when a text file is not readable text, or a PDF or Office
  // file could not be read.
  readUploads(): Promise<MessageUpload[]>
  take(): PendingAttachment[]
  restore(items: PendingAttachment[]): void
}

export function createComposerAttachments(deps: ComposerAttachmentsDependencies): ComposerAttachments {
  let items: PendingAttachment[] = []
  let nextKey = 0

  function register(): void {
    deps.fileInputEl.accept = UPLOAD_ACCEPT
    deps.fileInputEl.multiple = true
    deps.attachButtonEl.addEventListener('click', () => {
      deps.fileInputEl.value = ''
      deps.fileInputEl.click()
    })
    deps.fileInputEl.addEventListener('change', () => {
      add([...(deps.fileInputEl.files ?? [])])
      deps.fileInputEl.value = ''
    })
    deps.pasteTargetEl.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length === 0) return
      event.preventDefault()
      add(files)
    })
    deps.dropTargetEl.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      deps.dropTargetEl.classList.add('drop-active')
    })
    deps.dropTargetEl.addEventListener('dragleave', () => deps.dropTargetEl.classList.remove('drop-active'))
    deps.dropTargetEl.addEventListener('drop', event => {
      deps.dropTargetEl.classList.remove('drop-active')
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      event.preventDefault()
      add(files)
    })
  }

  function add(files: File[]): void {
    const errors: string[] = []
    for (const file of files) {
      if (items.length >= MAX_UPLOADS_PER_MESSAGE) {
        errors.push(deps.ui(`一条消息最多 ${MAX_UPLOADS_PER_MESSAGE} 个附件`))
        break
      }
      const check = checkUploadFile(file.name, file.type, file.size)
      if (!check.ok) {
        errors.push(deps.ui(check.error))
        continue
      }
      nextKey += 1
      const item: PendingAttachment = { key: `attachment-${nextKey}`, file, kind: check.kind, previewUrl: check.kind === 'image' ? URL.createObjectURL(file) : undefined }
      items.push(item)
      if (item.kind === 'document') startReading(item)
    }
    changed()
    if (errors.length > 0) deps.showError(errors.join('\n'))
  }

  // Reading starts right away, so a file that cannot be read is reported while it is added.
  function startReading(item: PendingAttachment): void {
    const labels: DocumentTextLabels = {
      pageLabel: page => deps.ui(`—— 第 ${page} 页 ——`),
      sheetLabel: name => deps.ui(`—— 工作表：${name} ——`),
    }
    item.text = (deps.readDocument ?? readDocumentText)(item.file, labels)
    item.text.then(text => {
      item.textLength = text.length
      if (items.includes(item)) render()
    }, (error: unknown) => {
      if (!items.includes(item)) return
      remove(item.key)
      deps.showError(deps.ui(error instanceof Error ? error.message : String(error)))
    })
  }

  function remove(key: string): void {
    const item = items.find(candidate => candidate.key === key)
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
    items = items.filter(candidate => candidate.key !== key)
    changed()
  }

  function changed(): void {
    render()
    deps.onChange()
  }

  function render(): void {
    deps.trayEl.replaceChildren()
    deps.trayEl.hidden = items.length === 0
    if (items.length === 0) return

    const list = document.createElement('div')
    list.className = 'attachment-tray-items'
    for (const item of items) list.append(chip(item))
    const hint = document.createElement('p')
    hint.className = 'attachment-tray-hint'
    hint.textContent = items.some(item => item.kind === 'document')
      ? deps.ui('附件只在发送时上传给对应的 AI 网站或模型。PDF 和 Office 文件发送的是读出的文字。')
      : deps.ui('附件只在发送时上传给对应的 AI 网站或模型。')
    deps.trayEl.append(list, hint)
  }

  function chip(item: PendingAttachment): HTMLElement {
    const element = document.createElement('div')
    element.className = `attachment-chip attachment-chip-${item.kind}`
    element.title = item.file.name
    if (item.previewUrl) {
      const image = document.createElement('img')
      image.src = item.previewUrl
      image.alt = item.file.name
      element.append(image)
    } else {
      const icon = document.createElement('span')
      icon.className = 'attachment-chip-icon'
      icon.textContent = fileExtension(item.file.name)
      element.append(icon)
    }
    const meta = document.createElement('span')
    meta.className = 'attachment-chip-meta'
    const name = document.createElement('span')
    name.className = 'attachment-chip-name'
    name.textContent = item.file.name
    const size = document.createElement('span')
    size.className = 'attachment-chip-size'
    size.textContent = item.kind !== 'document'
      ? formatBytes(item.file.size)
      : item.textLength === undefined
        ? deps.ui('读取中…')
        : `${formatBytes(item.file.size)} · ${deps.ui(`${item.textLength} 字`)}`
    meta.append(name, size)
    const removeButton = document.createElement('button')
    removeButton.type = 'button'
    removeButton.className = 'attachment-chip-remove'
    removeButton.setAttribute('aria-label', deps.ui('移除附件'))
    removeButton.append(createIcon('close'))
    removeButton.addEventListener('click', () => remove(item.key))
    element.append(meta, removeButton)
    return element
  }

  async function readUploads(): Promise<MessageUpload[]> {
    const uploads: MessageUpload[] = []
    for (const item of items) {
      if (item.kind === 'image') {
        uploads.push({ kind: 'image', fileName: item.file.name, mimeType: item.file.type, size: item.file.size, data: await readBase64(item.file) })
        continue
      }
      if (item.kind === 'document') {
        // Sent as the text read from it; waits here if the file is still being read.
        const text = await (item.text ?? Promise.reject(new Error('not read')))
        uploads.push({ kind: 'text', fileName: item.file.name, mimeType: item.file.type || 'application/octet-stream', size: item.file.size, text })
        continue
      }
      const text = await readText(item.file)
      // A NUL byte or many undecodable characters mean this is not a text file after all.
      const replacements = text.match(/�/g)?.length ?? 0
      if (text.includes('\u0000') || replacements > Math.max(8, text.length / 100)) throw new Error(deps.ui(`无法读取文本文件：${item.file.name}（不是 UTF-8 文本）`))
      uploads.push({ kind: 'text', fileName: item.file.name, mimeType: item.file.type || 'text/plain', size: item.file.size, text })
    }
    return uploads
  }

  function take(): PendingAttachment[] {
    const taken = items
    items = []
    changed()
    return taken
  }

  function restore(restored: PendingAttachment[]): void {
    if (restored.length === 0) return
    items = [...restored, ...items].slice(0, MAX_UPLOADS_PER_MESSAGE)
    changed()
  }

  return { register, list: () => items, readUploads, take, restore }
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(file, 'utf-8')
  })
}

function fileExtension(fileName: string): string {
  return fileName.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toUpperCase() ?? 'TXT'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
