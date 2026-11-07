import { createBackup, parseBackup, referencedImageIds, summarizeBackup, type BackupImage, type OpenTeamBackup, type RestoreMode } from '../group/backup'
import type { OpenTeamStore } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import type { ImageAttachmentRepository } from '../shared/imageAttachmentRepository'
import type { RuntimeResponse } from './runtimeClient'

export interface BackupViewDependencies {
  exportButtonEl: HTMLButtonElement
  restoreButtonEl: HTMLButtonElement
  fileInputEl: HTMLInputElement
  includeApiKeysEl?: HTMLInputElement
  getStore(): OpenTeamStore
  sendRuntimeMessage<T>(type: string, payload?: Record<string, unknown>): Promise<RuntimeResponse<T>>
  images: Pick<ImageAttachmentRepository, 'get' | 'put'>
  extensionVersion?: string
  // Shows the restored store, dropping page state that belonged to the old data.
  applyRestoredStore(store: OpenTeamStore): void
  showError(message: string): void
  showSuccess(message: string): void
  confirm?(message: string): boolean
  download?(fileName: string, blob: Blob): void
  now?(): Date
}

export interface BackupView {
  registerEvents(): void
  exportBackup(fileNamePrefix?: string): Promise<boolean>
  restoreFromFile(file: Blob): Promise<void>
}

interface RestoreResponse {
  restored?: { addedChatIds: string[]; skippedChatIds: string[] }
}

export function createBackupView(deps: BackupViewDependencies): BackupView {
  const now = deps.now ?? (() => new Date())
  const confirm = deps.confirm ?? (message => window.confirm(message))
  const download = deps.download ?? downloadBlob
  let busy = false

  function registerEvents(): void {
    deps.exportButtonEl.addEventListener('click', () => {
      void exportBackup()
    })
    deps.restoreButtonEl.addEventListener('click', () => {
      if (busy) return
      deps.fileInputEl.value = ''
      deps.fileInputEl.click()
    })
    deps.fileInputEl.addEventListener('change', () => {
      const file = deps.fileInputEl.files?.[0]
      // Cleared right away, so choosing the same file again still counts as a change.
      deps.fileInputEl.value = ''
      if (file) void restoreFromFile(file)
    })
  }

  async function exportBackup(fileNamePrefix = 'openteam-backup'): Promise<boolean> {
    if (busy) return false
    return withBusy(async () => {
      try {
        const backup = await buildBackup()
        const exportedAt = now()
        download(`${fileNamePrefix}-${fileTimestamp(exportedAt)}.json`, new Blob([JSON.stringify(backup)], { type: 'application/json' }))
        const summary = summarizeBackup(backup)
        if (fileNamePrefix === 'openteam-backup') deps.showSuccess(ui(`已导出备份：${summary.chats} 个群聊、${summary.messages} 条消息`))
        return true
      } catch (error) {
        deps.showError(ui('导出备份失败') + `：${errorMessage(error)}`)
        return false
      }
    })
  }

  async function buildBackup(): Promise<OpenTeamBackup> {
    // A fresh copy from the background, which owns the data.
    const response = await deps.sendRuntimeMessage('GROUP_STORE_GET')
    if (response.ok === false || !response.store) throw new Error(response.error || ui('读取群聊数据失败'))
    const images: BackupImage[] = []
    for (const id of referencedImageIds(response.store)) {
      const record = await deps.images.get(id).catch(() => undefined)
      if (!record) continue
      images.push({
        id: record.id,
        chatId: record.chatId,
        messageId: record.messageId,
        mimeType: record.mimeType,
        fileName: record.fileName,
        size: record.size,
        createdAt: record.createdAt,
        data: await blobToBase64(record.blob),
      })
    }
    return createBackup(response.store, { exportedAt: now(), extensionVersion: deps.extensionVersion, images, includeApiKeys: deps.includeApiKeysEl?.checked === true })
  }

  async function restoreFromFile(file: Blob): Promise<void> {
    if (busy) return
    let parsed: ReturnType<typeof parseBackup>
    try {
      parsed = parseBackup(JSON.parse(await readText(file)))
    } catch {
      parsed = { ok: false, error: '无法读取这个文件，请确认它是 OpenTeam 备份' }
    }
    if (!parsed.ok) {
      deps.showError(ui(parsed.error))
      return
    }

    const backup = parsed.backup
    const configured = deps.getStore().settings.externalModelsById
    const modelsToReAdd = parsed.modelsWithoutKeys.filter(model => !configured[model.id]?.apiKey).map(model => model.name)
    const mode = await chooseRestoreMode(backup, modelsToReAdd)
    if (!mode) return
    if (mode === 'replace') {
      const current = deps.getStore().chatOrder.length
      if (!confirm(ui(`替换会删除当前的 ${current} 个群聊和它们的消息，换成备份里的数据。替换前会先下载一份当前数据的备份。继续吗？`))) return
      // A safety copy first; without it there is no way back.
      if (!await exportBackup('openteam-before-restore')) return
    }

    await withBusy(async () => {
      try {
        for (const image of backup.images) {
          await deps.images.put({
            id: image.id,
            chatId: image.chatId,
            messageId: image.messageId,
            blob: base64ToBlob(image.data, image.mimeType),
            mimeType: image.mimeType,
            size: image.size,
            fileName: image.fileName,
            createdAt: image.createdAt,
          })
        }
        // Images are already written; the store itself does not need them.
        const response = await deps.sendRuntimeMessage<unknown>('GROUP_BACKUP_RESTORE', { backup: { ...backup, images: [] }, mode }) as RuntimeResponse & RestoreResponse
        if (response.ok === false || !response.store) throw new Error(response.error || ui('恢复备份失败'))
        deps.applyRestoredStore(response.store)
        const added = response.restored?.addedChatIds.length ?? 0
        const skipped = response.restored?.skippedChatIds.length ?? 0
        deps.showSuccess(ui(mode === 'replace'
          ? `已用备份替换全部数据：${added} 个群聊`
          : skipped > 0 ? `已恢复：新增 ${added} 个群聊，跳过 ${skipped} 个已存在的群聊` : `已恢复：新增 ${added} 个群聊`))
      } catch (error) {
        deps.showError(ui('恢复备份失败') + `：${errorMessage(error)}`)
      }
    })
  }

  function chooseRestoreMode(backup: OpenTeamBackup, modelsToReAdd: string[]): Promise<RestoreMode | undefined> {
    document.querySelector('.backup-restore-modal')?.remove()
    const summary = summarizeBackup(backup)
    const current = deps.getStore()
    const existing = backup.store.chatOrder.filter(chatId => current.chatsById[chatId]).length

    return new Promise(resolve => {
      const backdrop = document.createElement('div')
      backdrop.className = 'modal-backdrop backup-restore-modal'
      const modal = document.createElement('section')
      modal.className = 'modal backup-restore-dialog'
      modal.setAttribute('role', 'dialog')
      modal.setAttribute('aria-modal', 'true')
      modal.setAttribute('aria-labelledby', 'backup-restore-title')

      const close = (mode?: RestoreMode) => {
        backdrop.remove()
        document.removeEventListener('keydown', onKeydown)
        resolve(mode)
      }
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') close()
      }
      document.addEventListener('keydown', onKeydown)
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) close()
      })

      const header = document.createElement('div')
      header.className = 'modal-header'
      const titleBlock = document.createElement('div')
      const title = document.createElement('h2')
      title.id = 'backup-restore-title'
      title.textContent = ui('从备份恢复')
      const meta = document.createElement('p')
      meta.className = 'tiny'
      const english = normalizeLanguage(deps.getStore().settings.language) === 'en'
      meta.append(text(ui('备份时间')), text(`${english ? ': ' : '：'}${formatDate(backup.exportedAt)}`))
      titleBlock.append(title, meta)
      header.append(titleBlock)

      const counts = document.createElement('dl')
      counts.className = 'backup-restore-counts'
      for (const [label, value] of [['群聊', summary.chats], ['消息', summary.messages], ['自定义人员', summary.people], ['图片', summary.images]] as const) {
        const term = document.createElement('dt')
        term.textContent = ui(label)
        const detail = document.createElement('dd')
        detail.textContent = String(value)
        counts.append(term, detail)
      }

      const notes = document.createElement('div')
      notes.className = 'backup-restore-notes'
      notes.append(paragraph(ui('合并：保留当前数据，只加入当前没有的群聊和人员，设置保持不变。')))
      if (existing > 0) notes.append(paragraph(ui(`备份里有 ${existing} 个群聊当前已经存在，合并时会保留当前的版本。`)))
      notes.append(paragraph(ui('替换：用备份覆盖当前全部数据，替换前会先下载一份当前数据的备份。已配置的 API 模型会保留。')))
      if (modelsToReAdd.length > 0) {
        // The names stay in their own text node, so only the sentence is translated.
        const models = paragraph(ui('这些 API 模型在备份里没有 API Key，需要在「设置 → 模型」里重新添加：'))
        models.append(text(modelsToReAdd.join('、')))
        notes.append(models)
      }

      const actions = document.createElement('div')
      actions.className = 'backup-restore-actions'
      actions.append(
        actionButton('btn btn-primary', ui('合并到当前数据'), () => close('merge')),
        actionButton('btn btn-danger', ui('替换全部数据'), () => close('replace')),
        actionButton('btn btn-ghost', ui('取消'), () => close()),
      )

      modal.append(header, counts, notes, actions)
      backdrop.append(modal)
      document.body.append(backdrop)
      actions.querySelector<HTMLButtonElement>('button')?.focus()
    })
  }

  async function withBusy<T>(run: () => Promise<T>): Promise<T> {
    const wasBusy = busy
    busy = true
    deps.exportButtonEl.disabled = true
    deps.restoreButtonEl.disabled = true
    try {
      return await run()
    } finally {
      busy = wasBusy
      deps.exportButtonEl.disabled = wasBusy
      deps.restoreButtonEl.disabled = wasBusy
    }
  }

  function ui(source: string): string {
    return translateUi(source, normalizeLanguage(deps.getStore().settings.language))
  }

  function formatDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value || '—'
    return date.toLocaleString(normalizeLanguage(deps.getStore().settings.language) === 'en' ? 'en-US' : 'zh-CN')
  }

  return { registerEvents, exportBackup, restoreFromFile }
}

function actionButton(className: string, label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.addEventListener('click', run)
  return button
}

function paragraph(content: string): HTMLParagraphElement {
  const element = document.createElement('p')
  element.textContent = content
  return element
}

function text(content: string): Text {
  return document.createTextNode(content)
}

function fileTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(blob)
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
