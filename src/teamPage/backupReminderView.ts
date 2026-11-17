// 备份提醒 on the page (src/shared/backupReminder.ts): a notice over the group list when a backup is
// due, with 立即备份 (the settings' export) and 以后再说; in the settings, when the last backup was
// and a switch for the reminder. Any successful export counts (noteBackup).
import { backupDue, daysSinceBackup, readBackupReminderState, recordBackup, snoozeBackupReminder, withFirstSeen, type BackupReminderState } from '../shared/backupReminder'
import type { OpenTeamStore } from '../group/types'

export interface BackupReminderViewDependencies {
  document: Document
  language(): 'en' | 'zh-CN'
  getStore(): OpenTeamStore
  storage: {
    get(): Promise<unknown>
    set(state: BackupReminderState): Promise<void>
  }
  now(): number
  // The settings' export; true once the file was saved.
  exportBackup(): Promise<boolean>
}

export interface BackupReminderView {
  start(): Promise<void>
  render(): void
  noteBackup(): Promise<void>
}

export function createBackupReminderView(deps: BackupReminderViewDependencies): BackupReminderView {
  const find = <T extends HTMLElement>(id: string) => deps.document.getElementById(id) as T | null
  const bannerEl = find<HTMLElement>('backup-reminder')
  const statusEl = find<HTMLElement>('backup-status')
  const toggleEl = find<HTMLButtonElement>('backup-reminder-toggle')
  let state: BackupReminderState = { enabled: true }
  // What the notice shows now: it is built again only when that changes, so a page update does not
  // take focus away from its buttons.
  let shownNotice: string | undefined

  async function save(next: BackupReminderState): Promise<void> {
    state = next
    render()
    try {
      await deps.storage.set(next)
    } catch {
      // Shown already; the next opening reads what was saved before.
    }
  }

  function render(): void {
    const en = deps.language() === 'en'
    const now = deps.now()
    const store = deps.getStore()
    const due = backupDue(state, now, { chats: store.chatOrder.length, messages: Object.keys(store.messagesById).length })
    const days = daysSinceBackup(state, now)

    if (statusEl) {
      statusEl.textContent = state.lastBackupAt === undefined
        ? (en ? 'No backup yet' : '还没有备份过')
        : en
        ? `Last backup: ${formatTime(state.lastBackupAt)} (${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`})`
        : `上次备份：${formatTime(state.lastBackupAt)}（${days === 0 ? '今天' : `${days} 天前`}）`
    }
    toggleEl?.setAttribute('aria-checked', String(state.enabled))

    if (!bannerEl) return
    bannerEl.hidden = !due
    if (!due) {
      bannerEl.replaceChildren()
      shownNotice = undefined
      return
    }
    const notice = days === undefined
      ? (en ? 'No group has been backed up yet. Groups are kept only in this browser, and removing the extension deletes them.' : '还没有备份过群聊。群聊只保存在这个浏览器里，移除扩展会一起删掉。')
      : (en ? `No backup for ${days} days. Groups are kept only in this browser, and removing the extension deletes them.` : `已经 ${days} 天没有备份了。群聊只保存在这个浏览器里，移除扩展会一起删掉。`)
    if (notice === shownNotice) return
    shownNotice = notice
    const text = deps.document.createElement('p')
    text.className = 'backup-reminder-text'
    text.textContent = notice
    const actions = deps.document.createElement('div')
    actions.className = 'backup-reminder-actions'
    actions.append(
      button(en ? 'Back up now' : '立即备份', 'btn btn-primary btn-small', async () => {
        if (await deps.exportBackup()) await noteBackup()
      }),
      button(en ? 'Later' : '以后再说', 'btn btn-small', () => save(snoozeBackupReminder(state, deps.now()))),
    )
    bannerEl.replaceChildren(text, actions)
  }

  function button(label: string, className: string, onClick: () => Promise<void> | void): HTMLButtonElement {
    const element = deps.document.createElement('button')
    element.type = 'button'
    element.className = className
    element.textContent = label
    element.addEventListener('click', () => void onClick())
    return element
  }

  async function noteBackup(): Promise<void> {
    await save(recordBackup(state, deps.now()))
  }

  toggleEl?.addEventListener('click', () => {
    void save({ ...state, enabled: !state.enabled })
  })

  return {
    async start() {
      let saved: unknown
      try {
        saved = await deps.storage.get()
      } catch {
        saved = undefined
      }
      const read = readBackupReminderState(saved)
      const next = withFirstSeen(read, deps.now())
      if (next !== read) await save(next)
      else {
        state = next
        render()
      }
    },
    render,
    noteBackup,
  }
}

// "2026-11-17 10:00", in the computer's own time.
function formatTime(time: number): string {
  const date = new Date(time)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
