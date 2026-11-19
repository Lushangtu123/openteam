// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { ExternalModelConfig, GroupRole, OpenTeamStore } from '../group/types'
import { backupModelLabel, openRoleBackupDialog } from './roleBackupDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

function model(id: string, fields: Partial<ExternalModelConfig> = {}): ExternalModelConfig {
  return { id, name: `模型 ${id}`, format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'key', modelName: 'm', createdAt: 0, updatedAt: 0, ...fields }
}

function setup(models: ExternalModelConfig[], roleFields: Partial<GroupRole> = {}) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.externalModelOrder = models.map(item => item.id)
  store.settings.externalModelsById = Object.fromEntries(models.map(item => [item.id, item]))
  const role: GroupRole = { id: 'role-1', chatId: 'chat-1', name: '研究员', modelSource: 'site', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...roleFields }
  const runCommand = vi.fn(async () => undefined)
  const onClose = vi.fn()
  openRoleBackupDialog(role, { getStore: () => store, runCommand, onClose })
  const select = () => document.querySelector<HTMLSelectElement>('#role-backup-model')!
  const save = () => document.querySelector<HTMLFormElement>('.role-backup-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  return { store, runCommand, onClose, select, save }
}

describe('choosing a web member\'s backup model', () => {
  it('offers 不设置 and the API models that can answer, with the current one chosen', () => {
    const { select } = setup([
      model('api', { name: 'DeepSeek API' }),
      model('agent', { name: 'Claude Code', format: 'local-agent', apiKey: '' }),
      model('nokey', { name: '没填 Key', apiKey: '' }),
      model('gemini', { name: 'Gemini API' }),
    ], { backupModelId: 'gemini' })
    expect([...select().options].map(option => [option.value, option.textContent])).toEqual([['', '不设置'], ['api', 'DeepSeek API'], ['gemini', 'Gemini API']])
    expect(select().value).toBe('gemini')
    expect(document.activeElement).toBe(select())
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-labelledby')).toBe('role-backup-title')
    expect(document.querySelector('#role-backup-title')?.textContent).toBe('研究员 的备用模型')
  })

  it('saves the choice, and 不设置 removes it', async () => {
    const first = setup([model('api', { name: 'DeepSeek API' })])
    first.select().value = 'api'
    first.save()
    await vi.waitFor(() => expect(first.runCommand).toHaveBeenCalledWith('GROUP_ROLE_BACKUP_SET', { roleId: 'role-1', backupModelId: 'api' }))
    await vi.waitFor(() => expect(document.querySelector('.role-backup-modal')).toBeNull())
    expect(first.onClose).toHaveBeenCalled()

    const second = setup([model('api', { name: 'DeepSeek API' })], { backupModelId: 'api' })
    second.select().value = ''
    second.save()
    await vi.waitFor(() => expect(second.runCommand).toHaveBeenCalledWith('GROUP_ROLE_BACKUP_SET', { roleId: 'role-1', backupModelId: '' }))
  })

  it('closes without saving when nothing changed, and on Esc', async () => {
    const { runCommand, save } = setup([model('api')], { backupModelId: 'api' })
    save()
    await vi.waitFor(() => expect(document.querySelector('.role-backup-modal')).toBeNull())
    expect(runCommand).not.toHaveBeenCalled()

    setup([model('api')])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.role-backup-modal')).toBeNull()
  })

  it('says where to add an API model when there is none', () => {
    const { select } = setup([model('agent', { format: 'local-agent', apiKey: '' })])
    expect([...select().options].map(option => option.value)).toEqual([''])
    expect(document.querySelector('.role-backup-form')?.textContent).toContain('设置 → 模型')
  })

  it('names the member\'s backup for its menu', () => {
    const store = createDefaultStore()
    store.settings.externalModelsById = { api: model('api', { name: 'DeepSeek API' }) }
    const role = { id: 'r', chatId: 'c', name: '研究员', modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 } as GroupRole
    expect(backupModelLabel(store, role, false)).toBe('备用模型：无')
    expect(backupModelLabel(store, { ...role, backupModelId: 'api' }, false)).toBe('备用模型：DeepSeek API')
    expect(backupModelLabel(store, { ...role, backupModelId: 'api' }, true)).toBe('Backup model: DeepSeek API')
    expect(backupModelLabel(store, { ...role, backupModelId: 'gone' }, false)).toBe('备用模型：无')
  })
})
