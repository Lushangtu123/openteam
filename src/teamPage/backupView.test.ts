// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackup } from '../group/backup'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import type { ImageAttachmentBlobRecord } from '../shared/imageAttachmentRepository'
import { createBackupView } from './backupView'

afterEach(() => {
  document.body.replaceChildren()
})

const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 0, 255, 10])

function makeStore(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatOrder = ['chat-1']
  store.chatsById['chat-1'] = { id: 'chat-1', name: '产品会', mode: 'independent', roleIds: [], messageIds: ['msg-1'], nextMessageSeq: 2, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.messagesById['msg-1'] = { id: 'msg-1', chatId: 'chat-1', seq: 1, type: 'assistant', content: '图', createdAt: 1, status: 'received', attachments: [{ id: 'img-1', type: 'image', status: 'ready' } as never] }
  store.settings.externalModelOrder = ['model-1']
  store.settings.externalModelsById = { 'model-1': { id: 'model-1', name: 'GPT API', format: 'openai', baseUrl: 'https://api.example.com', apiKey: 'sk-secret', modelName: 'gpt', createdAt: 1, updatedAt: 1 } }
  return store
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

function readBytes(blob: Blob): Promise<number[]> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)])
    reader.readAsArrayBuffer(blob)
  })
}

function setup(options: { confirm?: boolean } = {}) {
  const store = makeStore()
  const downloads: Array<{ fileName: string; blob: Blob }> = []
  const stored = new Map<string, ImageAttachmentBlobRecord>([['img-1', {
    id: 'img-1', chatId: 'chat-1', messageId: 'msg-1', blob: new Blob([IMAGE_BYTES], { type: 'image/png' }), mimeType: 'image/png', size: IMAGE_BYTES.length, fileName: 'a.png', createdAt: 5,
  }]])
  const images = {
    get: vi.fn(async (id: string) => stored.get(id)),
    put: vi.fn(async (record: ImageAttachmentBlobRecord) => {
      stored.set(record.id, record)
    }),
  }
  const sendRuntimeMessage = vi.fn(async (type: string, _payload?: Record<string, unknown>) => {
    if (type === 'GROUP_STORE_GET') return { ok: true, store }
    return { ok: true, store, restored: { addedChatIds: ['chat-2'], skippedChatIds: ['chat-1'] } }
  })
  const includeApiKeysEl = document.createElement('input')
  includeApiKeysEl.type = 'checkbox'
  const deps = {
    exportButtonEl: document.createElement('button'),
    restoreButtonEl: document.createElement('button'),
    fileInputEl: document.createElement('input'),
    includeApiKeysEl,
    getStore: () => store,
    sendRuntimeMessage: sendRuntimeMessage as never,
    images,
    extensionVersion: '1.0.3',
    applyRestoredStore: vi.fn(),
    showError: vi.fn(),
    showSuccess: vi.fn(),
    confirm: vi.fn(() => options.confirm ?? true),
    download: (fileName: string, blob: Blob) => downloads.push({ fileName, blob }),
    now: () => new Date(2026, 10, 5, 9, 7),
  }
  return { view: createBackupView(deps), deps, store, downloads, images, sendRuntimeMessage, stored }
}

function backupFile(store: OpenTeamStore): Blob {
  const backup = createBackup(store, {
    exportedAt: new Date('2026-11-01T10:00:00Z'),
    images: [{ id: 'img-9', chatId: 'chat-2', messageId: 'msg-9', mimeType: 'image/png', fileName: 'b.png', size: 3, createdAt: 1, data: btoa(String.fromCharCode(1, 2, 3)) }],
  })
  return new Blob([JSON.stringify(backup)], { type: 'application/json' })
}

async function clickInDialog(label: string): Promise<void> {
  await vi.waitFor(() => expect(document.querySelector('.backup-restore-dialog')).not.toBeNull())
  const button = [...document.querySelectorAll<HTMLButtonElement>('.backup-restore-actions button')].find(item => item.textContent === label)
  if (!button) throw new Error(`no ${label} button`)
  button.click()
}

describe('team page backup', () => {
  it('exports every chat with its images and leaves API keys out unless asked', async () => {
    const { view, downloads, deps } = setup()

    expect(await view.exportBackup()).toBe(true)

    expect(downloads[0].fileName).toBe('openteam-backup-20261105-0907.json')
    const file = JSON.parse(await readBlob(downloads[0].blob))
    expect(file).toMatchObject({ format: 'openteam-backup', version: 1, extensionVersion: '1.0.3' })
    expect(file.store.chatOrder).toEqual(['chat-1'])
    expect(JSON.stringify(file)).not.toContain('sk-secret')
    expect(file.images).toHaveLength(1)
    expect([...atob(file.images[0].data)].map(char => char.charCodeAt(0))).toEqual([...IMAGE_BYTES])
    expect(deps.showSuccess).toHaveBeenCalledWith('已导出备份：1 个群聊、1 条消息')

    deps.includeApiKeysEl.checked = true
    await view.exportBackup()
    expect(await readBlob(downloads[1].blob)).toContain('sk-secret')
  })

  it('merges a backup: writes its images, then asks the background to restore it', async () => {
    const { view, deps, images, sendRuntimeMessage, stored } = setup()
    const source = makeStore()
    source.chatOrder.push('chat-2')
    source.chatsById['chat-2'] = { ...source.chatsById['chat-1'], id: 'chat-2', name: '新群聊', messageIds: [] }

    const restoring = view.restoreFromFile(backupFile(source))
    await vi.waitFor(() => expect(document.querySelector('.backup-restore-counts')).not.toBeNull())
    const customPeople = Object.values(source.roleTemplatesById).filter(template => template.type !== 'builtin').length
    expect([...document.querySelectorAll('.backup-restore-counts dd')].map(item => item.textContent)).toEqual(['2', '1', String(customPeople), '1'])
    expect(document.querySelector('.backup-restore-notes')?.textContent).toContain('备份里有 1 个群聊当前已经存在')
    await clickInDialog('合并到当前数据')
    await restoring

    expect(images.put).toHaveBeenCalledTimes(1)
    expect(await readBytes(stored.get('img-9')!.blob)).toEqual([1, 2, 3])
    const restoreCall = sendRuntimeMessage.mock.calls.find(call => call[0] === 'GROUP_BACKUP_RESTORE')
    expect(restoreCall?.[1]).toMatchObject({ mode: 'merge', backup: { format: 'openteam-backup', images: [] } })
    expect(deps.applyRestoredStore).toHaveBeenCalled()
    expect(deps.showSuccess).toHaveBeenCalledWith('已恢复：新增 1 个群聊，跳过 1 个已存在的群聊')
    expect(document.querySelector('.backup-restore-dialog')).toBeNull()
  })

  it('names the API models that will have to be added again', async () => {
    const { view, store } = setup()
    const source = makeStore()
    source.settings.externalModelOrder = ['model-2']
    source.settings.externalModelsById = { 'model-2': { ...store.settings.externalModelsById['model-1'], id: 'model-2', name: 'Claude API' } }

    const restoring = view.restoreFromFile(backupFile(source))
    await vi.waitFor(() => expect(document.querySelector('.backup-restore-notes')).not.toBeNull())
    expect(document.querySelector('.backup-restore-notes')?.textContent).toContain('需要在「设置 → 模型」里重新添加：Claude API')
    await clickInDialog('取消')
    await restoring
  })

  it('downloads a copy of the current data before replacing it, and does nothing when not confirmed', async () => {
    const declined = setup({ confirm: false })
    const declinedRestore = declined.view.restoreFromFile(backupFile(makeStore()))
    await clickInDialog('替换全部数据')
    await declinedRestore
    expect(declined.sendRuntimeMessage.mock.calls.some(call => call[0] === 'GROUP_BACKUP_RESTORE')).toBe(false)
    expect(declined.downloads).toEqual([])

    const confirmed = setup({ confirm: true })
    const confirmedRestore = confirmed.view.restoreFromFile(backupFile(makeStore()))
    await clickInDialog('替换全部数据')
    await confirmedRestore
    expect(confirmed.downloads.map(item => item.fileName)).toEqual(['openteam-before-restore-20261105-0907.json'])
    const restoreCall = confirmed.sendRuntimeMessage.mock.calls.find(call => call[0] === 'GROUP_BACKUP_RESTORE')
    expect(restoreCall?.[1]).toMatchObject({ mode: 'replace' })
    expect(confirmed.deps.showSuccess).toHaveBeenLastCalledWith('已用备份替换全部数据：1 个群聊')
  })

  it('explains when a file is not a backup', async () => {
    const { view, deps, sendRuntimeMessage } = setup()

    await view.restoreFromFile(new Blob(['not json']))
    await view.restoreFromFile(new Blob([JSON.stringify({ hello: 1 })]))

    expect(deps.showError).toHaveBeenNthCalledWith(1, '无法读取这个文件，请确认它是 OpenTeam 备份')
    expect(deps.showError).toHaveBeenNthCalledWith(2, '这不是 OpenTeam 备份文件')
    expect(sendRuntimeMessage).not.toHaveBeenCalled()
  })
})
