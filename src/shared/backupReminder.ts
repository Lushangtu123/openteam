// 备份提醒: groups live only in this browser, and removing the extension deletes them. Two weeks
// after the last backup (or after first use, with none yet), and only when there is something to
// lose, the page asks once; "later" waits a week. Backing up needs no permission: it is the
// existing export. The state is kept in its own storage key, outside the store and its backups.

export const BACKUP_REMINDER_STORAGE_KEY = 'openteamBackupReminder'
const DAY_MS = 24 * 60 * 60 * 1000
export const BACKUP_DUE_AFTER_MS = 14 * DAY_MS
export const BACKUP_SNOOZE_MS = 7 * DAY_MS

export interface BackupReminderState {
  enabled: boolean
  // The first time this page ran with the reminder: the clock for someone who never backed up.
  firstSeenAt?: number
  lastBackupAt?: number
  snoozedUntil?: number
}

export function readBackupReminderState(raw: unknown): BackupReminderState {
  const value = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const state: BackupReminderState = { enabled: value.enabled !== false }
  for (const key of ['firstSeenAt', 'lastBackupAt', 'snoozedUntil'] as const) {
    const time = value[key]
    if (typeof time === 'number' && Number.isFinite(time)) state[key] = time
  }
  return state
}

export function withFirstSeen(state: BackupReminderState, now: number): BackupReminderState {
  return state.firstSeenAt === undefined ? { ...state, firstSeenAt: now } : state
}

export function backupDue(state: BackupReminderState, now: number, data: { chats: number; messages: number }): boolean {
  if (!state.enabled || data.chats === 0 || data.messages === 0) return false
  if (state.snoozedUntil !== undefined && now < state.snoozedUntil) return false
  const since = state.lastBackupAt ?? state.firstSeenAt
  return since !== undefined && now - since >= BACKUP_DUE_AFTER_MS
}

export function recordBackup(state: BackupReminderState, now: number): BackupReminderState {
  const { snoozedUntil: _snoozed, ...rest } = state
  return { ...rest, lastBackupAt: now }
}

export function snoozeBackupReminder(state: BackupReminderState, now: number): BackupReminderState {
  return { ...state, snoozedUntil: now + BACKUP_SNOOZE_MS }
}

export function daysSinceBackup(state: BackupReminderState, now: number): number | undefined {
  return state.lastBackupAt === undefined ? undefined : Math.floor((now - state.lastBackupAt) / DAY_MS)
}
