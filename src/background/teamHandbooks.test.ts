import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore, normalizeStoreData } from '../group/store'
import { createBackup, parseBackup, restoreBackup } from '../group/backup'
import { MAX_HANDBOOK_CHARS } from '../group/teamHandbooks'
import type { OpenTeamStore } from '../group/types'

async function setup() {
  vi.resetModules()
  const store = createDefaultStore()
  vi.doMock('./storeAccess', async importOriginal => ({
    ...await importOriginal<typeof import('./storeAccess')>(),
    mutateStore: async (mutator: (draft: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
  }))
  const { createChatHandlers } = await import('./chatHandlers')
  let nextId = 0
  const routes = createChatHandlers({ broadcastStoreUpdated: vi.fn(), getChatStatusFromRoles: () => 'ready', log: { info: vi.fn(), warn: vi.fn() }, newId: prefix => `${prefix}-${++nextId}`, now: () => 1, runtimeFrames: { removeRole: vi.fn() } })
  return { store, command: (type: string, payload: Record<string, unknown>) => routes.find(route => route.type === type)!.handler({ type, ...payload }, {}) }
}

describe('team handbook persistence', () => {
  it('keeps the chosen snapshot when the library is updated and across storage and backup restore', async () => {
    const { store, command } = await setup()
    await command('GROUP_TEAM_HANDBOOK_SAVE', { name: 'PWA Skills', content: '版本一：先验证，再交付。' })
    const handbookId = store.settings.teamHandbooks![0].id
    await command('GROUP_TEAM_CREATE', { task: '开发项目', handbookId, members: [{ modelSource: 'site', chatSite: 'chatgpt' }, { modelSource: 'site', chatSite: 'gemini' }] })
    const chatId = store.currentChatId!
    await command('GROUP_TEAM_HANDBOOK_SAVE', { name: 'PWA Skills', content: '版本二' })
    expect(store.settings.teamHandbooks).toHaveLength(1)
    expect(store.chatsById[chatId].executionHandbook?.content).toBe('版本一：先验证，再交付。')
    const normalized = normalizeStoreData(store)
    expect(normalized.settings.teamHandbooks![0].content).toBe('版本二')
    const parsed = parseBackup(createBackup(normalized, { exportedAt: new Date(0) }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('backup did not parse')
    const restored = restoreBackup(createDefaultStore(), parsed.backup.store, 'merge').store
    expect(restored.settings.teamHandbooks![0].content).toBe('版本二')
    expect(restored.chatsById[chatId].executionHandbook?.content).toBe('版本一：先验证，再交付。')
    await command('GROUP_CHAT_DUPLICATE', { chatId })
    expect(store.chatsById[store.currentChatId!].executionHandbook?.content).toBe('版本一：先验证，再交付。')
  })

  it('rejects blank, oversized and missing handbooks', async () => {
    const { store, command } = await setup()
    for (const content of ['', ' ', 'x'.repeat(MAX_HANDBOOK_CHARS + 1), 'bad\0text']) await expect(command('GROUP_TEAM_HANDBOOK_SAVE', { name: 'PWA', content })).rejects.toThrow('手册无效')
    expect(store.settings.teamHandbooks).toBeUndefined()
    await expect(command('GROUP_TEAM_CREATE', { task: '开发项目', handbookId: 'missing', members: [{ modelSource: 'site', chatSite: 'chatgpt' }, { modelSource: 'site', chatSite: 'gemini' }] })).rejects.toThrow('找不到所选执行手册')
  })
})
