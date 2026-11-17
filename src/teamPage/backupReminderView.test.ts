// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { BACKUP_DUE_AFTER_MS, BACKUP_SNOOZE_MS, type BackupReminderState } from '../shared/backupReminder'
import { createBackupReminderView } from './backupReminderView'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 10, 17, 10, 0).getTime()

function setup(saved: unknown, options: { messages?: number; language?: 'zh-CN' | 'en'; exportResult?: boolean } = {}) {
  document.body.innerHTML = `
    <div id="backup-reminder" hidden></div>
    <p id="backup-status"></p>
    <button id="backup-reminder-toggle" role="switch" aria-checked="true"></button>
  `
  const store = createDefaultStore()
  store.settings.language = options.language ?? 'zh-CN'
  store.chatOrder = ['chat-1']
  store.chatsById['chat-1'] = { id: 'chat-1', name: 'g', mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  for (let index = 0; index < (options.messages ?? 3); index += 1) store.messagesById[`m${index}`] = { id: `m${index}`, chatId: 'chat-1', seq: index + 1, type: 'user', content: 'x', createdAt: 1, status: 'received' }
  let stored = saved
  let now = NOW
  const exportBackup = vi.fn(async () => options.exportResult ?? true)
  const view = createBackupReminderView({
    document,
    language: () => options.language ?? 'zh-CN',
    getStore: () => store,
    storage: { get: async () => stored, set: async (state: BackupReminderState) => { stored = state } },
    now: () => now,
    exportBackup,
  })
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  return { view, store, $, exportBackup, stored: () => stored as BackupReminderState, setNow: (value: number) => { now = value } }
}

describe('backup reminder', () => {
  it('starts the clock on first use and says nothing yet', async () => {
    const { view, $, stored } = setup(undefined)
    await view.start()
    expect(stored()).toEqual({ enabled: true, firstSeenAt: NOW })
    expect($('backup-reminder').hidden).toBe(true)
    expect($('backup-status').textContent).toBe('还没有备份过')
  })

  it('asks two weeks after the last backup, with how long it has been', async () => {
    // A wall-clock time: 21 days of milliseconds may cross a daylight saving change.
    const { view, $ } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: new Date(2026, 9, 27, 10, 0).getTime() })
    await view.start()
    const banner = $('backup-reminder')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain('已经 21 天没有备份了')
    expect([...banner.querySelectorAll('button')].map(button => button.textContent)).toEqual(['立即备份', '以后再说'])
    expect($('backup-status').textContent).toBe('上次备份：2026-10-27 10:00（21 天前）')
  })

  it('asks someone who never backed up, two weeks after first use', async () => {
    const { view, $ } = setup({ enabled: true, firstSeenAt: NOW - BACKUP_DUE_AFTER_MS })
    await view.start()
    expect($('backup-reminder').textContent).toContain('还没有备份过群聊')
  })

  it('keeps its buttons (and their focus) across page updates', async () => {
    const { view, $ } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: NOW - 30 * DAY })
    await view.start()
    const backUp = $('backup-reminder').querySelector<HTMLButtonElement>('button')!
    backUp.focus()
    view.render()
    expect($('backup-reminder').querySelector('button')).toBe(backUp)
    expect(document.activeElement).toBe(backUp)
  })

  it('backs up from the reminder, and stops asking', async () => {
    const { view, $, exportBackup, stored } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: NOW - 30 * DAY })
    await view.start()
    $('backup-reminder').querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(() => expect(exportBackup).toHaveBeenCalled())
    await vi.waitFor(() => expect(stored().lastBackupAt).toBe(NOW))
    expect($('backup-reminder').hidden).toBe(true)
    expect($('backup-status').textContent).toBe('上次备份：2026-11-17 10:00（今天）')
  })

  it('keeps asking when the backup did not happen', async () => {
    const { view, $, stored } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: NOW - 30 * DAY }, { exportResult: false })
    await view.start()
    $('backup-reminder').querySelector<HTMLButtonElement>('button')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(stored().lastBackupAt).toBe(NOW - 30 * DAY)
    expect($('backup-reminder').hidden).toBe(false)
  })

  it('waits a week after "later"', async () => {
    const { view, $, stored, setNow } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: NOW - 30 * DAY })
    await view.start()
    ;[...$('backup-reminder').querySelectorAll('button')][1].click()
    await vi.waitFor(() => expect(stored().snoozedUntil).toBe(NOW + BACKUP_SNOOZE_MS))
    expect($('backup-reminder').hidden).toBe(true)
    setNow(NOW + BACKUP_SNOOZE_MS)
    view.render()
    expect($('backup-reminder').hidden).toBe(false)
  })

  it('counts any backup, such as one from the settings', async () => {
    const { view, $, stored } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: NOW - 30 * DAY })
    await view.start()
    await view.noteBackup()
    expect(stored().lastBackupAt).toBe(NOW)
    expect($('backup-reminder').hidden).toBe(true)
  })

  it('says nothing with nothing to lose, and can be switched off', async () => {
    const empty = setup({ enabled: true, firstSeenAt: 1 }, { messages: 0 })
    await empty.view.start()
    expect(empty.$('backup-reminder').hidden).toBe(true)

    const { view, $, stored } = setup({ enabled: true, firstSeenAt: 1 })
    await view.start()
    expect($('backup-reminder').hidden).toBe(false)
    $('backup-reminder-toggle').click()
    await vi.waitFor(() => expect(stored().enabled).toBe(false))
    expect($('backup-reminder').hidden).toBe(true)
    expect($('backup-reminder-toggle').getAttribute('aria-checked')).toBe('false')
  })

  it('speaks English when the page does', async () => {
    const { view, $ } = setup({ enabled: true, firstSeenAt: 1, lastBackupAt: NOW - DAY }, { language: 'en' })
    await view.start()
    expect($('backup-status').textContent).toBe('Last backup: 2026-11-16 10:00 (1 day ago)')
  })
})
