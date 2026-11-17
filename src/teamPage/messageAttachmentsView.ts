// What a message carries besides its text: images (drawn from the browser's image store, with a
// download button) and text files (chips that download the file). Image object URLs are kept while
// a message on screen shows them, and released once none does.
import type { GroupMessage, MessageFileAttachment, MessageImageAttachment } from '../group/types'
import type { ImageAttachmentBlobRecord } from '../shared/imageAttachmentRepository'
import { formatBytes } from './composerAttachments'

export interface MessageAttachmentsViewDependencies {
  loadImageAttachment?(id: string): Promise<ImageAttachmentBlobRecord | undefined>
  showError(message: string): void
  // Reads the reply again from its page, for an image that could not be read.
  resync(message: GroupMessage): void
  iconButton(label: string, icon: 'download', onClick: () => void): HTMLButtonElement
}

export interface MessageAttachmentsView {
  renderImageGrid(message: GroupMessage): HTMLElement | undefined
  renderFileList(message: GroupMessage): HTMLElement | undefined
  // Releases the object URLs of images no message in `messages` shows.
  releaseUnused(messages: GroupMessage[]): void
}

export function createMessageAttachmentsView(deps: MessageAttachmentsViewDependencies): MessageAttachmentsView {
  const imageObjectUrls = new Map<string, string>()
  const imageLoadPromises = new Map<string, Promise<string | undefined>>()

  function renderMessageImageGrid(message: GroupMessage): HTMLElement | undefined {
    const attachments = message.attachments?.filter(attachment => attachment.type === 'image') ?? []
    if (attachments.length === 0) return undefined

    const grid = document.createElement('div')
    grid.className = `message-image-grid image-count-${Math.min(attachments.length, 4)}`
    // Uploads carry no dimensions, so they keep their own size instead of filling the bubble.
    if (attachments.every(attachment => attachment.source === 'user-upload')) grid.classList.add('message-image-grid-uploads')
    for (const attachment of attachments) {
      grid.append(renderImageAttachment(message, attachment))
    }
    return grid
  }

  function renderMessageFileList(message: GroupMessage): HTMLElement | undefined {
    const files = message.attachments?.filter((attachment): attachment is MessageFileAttachment => attachment.type === 'file') ?? []
    if (files.length === 0) return undefined
    const list = document.createElement('div')
    list.className = 'message-file-list'
    for (const file of files) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'message-file-chip'
      chip.title = `下载 ${file.fileName}`
      const icon = document.createElement('span')
      icon.className = 'message-file-icon'
      icon.textContent = file.fileName.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toUpperCase() ?? 'TXT'
      const name = document.createElement('span')
      name.className = 'message-file-name'
      name.textContent = file.fileName
      const size = document.createElement('span')
      size.className = 'message-file-size'
      size.textContent = formatBytes(file.size)
      chip.append(icon, name, size)
      chip.addEventListener('click', event => {
        event.stopPropagation()
        const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType || 'text/plain' }))
        const link = document.createElement('a')
        link.href = url
        link.download = file.fileName
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      list.append(chip)
    }
    return list
  }

  function renderImageAttachment(message: GroupMessage, attachment: MessageImageAttachment): HTMLElement {
    const tile = document.createElement('div')
    tile.className = `message-image-tile ${attachment.status === 'error' ? 'message-image-error' : 'message-image-loading'}`

    if (attachment.status === 'error') {
      const errorText = document.createElement('span')
      errorText.textContent = attachment.error || '图片获取失败'
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'message-image-retry'
      retry.textContent = '重新同步'
      retry.addEventListener('click', event => {
        event.stopPropagation()
        deps.resync(message)
      })
      tile.append(errorText, retry)
      return tile
    }

    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'message-image-preview'
    preview.setAttribute('aria-label', '预览图片')
    preview.disabled = true
    const image = document.createElement('img')
    image.alt = attachment.alt || (attachment.source === 'user-upload' ? attachment.fileName : undefined) || 'ChatGPT 生成图片'
    image.loading = 'lazy'
    image.decoding = 'async'
    if (attachment.width) image.width = attachment.width
    if (attachment.height) image.height = attachment.height
    preview.append(image)

    const download = deps.iconButton('下载图片', 'download', () => {
      downloadImageAttachment(attachment).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
    download.classList.add('message-image-download')
    download.disabled = true
    tile.append(preview, download)

    loadImageObjectUrl(attachment.id)
      .then(url => {
        if (!url || !tile.isConnected) {
          if (url && !tile.isConnected) releaseImageUrl(attachment.id)
          return
        }
        image.src = url
        preview.disabled = false
        download.disabled = false
        tile.classList.remove('message-image-loading')
        preview.addEventListener('click', () => window.open(url, '_blank', 'noopener'))
      })
      .catch(error => {
        tile.className = 'message-image-tile message-image-error'
        tile.replaceChildren()
        const errorText = document.createElement('span')
        errorText.textContent = error instanceof Error ? error.message : '图片读取失败'
        tile.append(errorText)
      })

    return tile
  }

  async function loadImageObjectUrl(attachmentId: string): Promise<string | undefined> {
    const cached = imageObjectUrls.get(attachmentId)
    if (cached) return cached
    const pending = imageLoadPromises.get(attachmentId)
    if (pending) return pending

    const load = (async () => {
      const record = await deps.loadImageAttachment?.(attachmentId)
      if (!record) throw new Error('本地图片不可用，请重新同步')
      const url = URL.createObjectURL(record.blob)
      imageObjectUrls.set(attachmentId, url)
      return url
    })().finally(() => {
      imageLoadPromises.delete(attachmentId)
    })
    imageLoadPromises.set(attachmentId, load)
    return load
  }

  async function downloadImageAttachment(attachment: MessageImageAttachment): Promise<void> {
    const url = await loadImageObjectUrl(attachment.id)
    if (!url) throw new Error('本地图片不可用，请重新同步')
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = attachment.fileName || 'chatgpt-image.png'
    anchor.rel = 'noreferrer'
    anchor.click()
  }

  function releaseUnusedImageUrls(messages: GroupMessage[]): void {
    const activeIds = new Set(messages.flatMap(message => message.attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.status === 'ready').map(attachment => attachment.id))
    for (const attachmentId of imageObjectUrls.keys()) {
      if (!activeIds.has(attachmentId)) releaseImageUrl(attachmentId)
    }
  }

  function releaseImageUrl(attachmentId: string): void {
    const url = imageObjectUrls.get(attachmentId)
    if (!url) return
    URL.revokeObjectURL(url)
    imageObjectUrls.delete(attachmentId)
  }

  return { renderImageGrid: renderMessageImageGrid, renderFileList: renderMessageFileList, releaseUnused: releaseUnusedImageUrls }
}
