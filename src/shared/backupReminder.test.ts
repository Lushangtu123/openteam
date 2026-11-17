import { describe, expect, it } from 'vitest'
import { BACKUP_DUE_AFTER_MS, BACKUP_SNOOZE_MS, backupDue, daysSinceBackup, readBackupReminderState, recordBackup, snoozeBackupReminder, withFirstSeen } from './backupReminder'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const withData = { chats: 2, messages: 30 }

describe('the saved reminder state', () => {
  it('reminds by default, and keeps only numbers it understands', () => {
    expect(readBackupReminderState(undefined)).toEqual({ enabled: true })
    expect(readBackupReminderState({ enabled: false, firstSeenAt: 1, lastBackupAt: 2, snoozedUntil: 3, junk: 'x' })).toEqual({ enabled: false, firstSeenAt: 1, lastBackupAt: 2, snoozedUntil: 3 })
    expect(readBackupReminderState({ lastBackupAt: 'yesterday' })).toEqual({ enabled: true })
  })

  it('remembers when OpenTeam was first seen, once', () => {
    const first = withFirstSeen({ enabled: true }, NOW)
    expect(first).toEqual({ enabled: true, firstSeenAt: NOW })
    expect(withFirstSeen(first, NOW + DAY)).toBe(first)
  })
})

describe('when a backup is due', () => {
  it('is due two weeks after the last backup, or after first use when there has been none', () => {
    expect(backupDue({ enabled: true, lastBackupAt: NOW - BACKUP_DUE_AFTER_MS + DAY }, NOW, withData)).toBe(false)
    expect(backupDue({ enabled: true, lastBackupAt: NOW - BACKUP_DUE_AFTER_MS }, NOW, withData)).toBe(true)
    expect(backupDue({ enabled: true, firstSeenAt: NOW - DAY }, NOW, withData)).toBe(false)
    expect(backupDue({ enabled: true, firstSeenAt: NOW - BACKUP_DUE_AFTER_MS }, NOW, withData)).toBe(true)
  })

  it('is never due with nothing to lose, when switched off, or while snoozed', () => {
    const old = { enabled: true, lastBackupAt: NOW - 60 * DAY }
    expect(backupDue(old, NOW, { chats: 0, messages: 0 })).toBe(false)
    expect(backupDue(old, NOW, { chats: 3, messages: 0 })).toBe(false)
    expect(backupDue({ ...old, enabled: false }, NOW, withData)).toBe(false)
    expect(backupDue({ ...old, snoozedUntil: NOW + DAY }, NOW, withData)).toBe(false)
    expect(backupDue({ ...old, snoozedUntil: NOW - 1 }, NOW, withData)).toBe(true)
  })

  it('is not due before anything is known about first use', () => {
    expect(backupDue({ enabled: true }, NOW, withData)).toBe(false)
  })
})

describe('answering the reminder', () => {
  it('records a backup, which also ends a snooze', () => {
    expect(recordBackup({ enabled: true, snoozedUntil: NOW + DAY }, NOW)).toEqual({ enabled: true, lastBackupAt: NOW })
  })

  it('snoozes for a week', () => {
    expect(snoozeBackupReminder({ enabled: true }, NOW)).toEqual({ enabled: true, snoozedUntil: NOW + BACKUP_SNOOZE_MS })
    expect(BACKUP_SNOOZE_MS).toBe(7 * DAY)
  })

  it('counts whole days since the last backup', () => {
    expect(daysSinceBackup({ enabled: true, lastBackupAt: NOW - 21 * DAY - 5 }, NOW)).toBe(21)
    expect(daysSinceBackup({ enabled: true }, NOW)).toBeUndefined()
  })
})
