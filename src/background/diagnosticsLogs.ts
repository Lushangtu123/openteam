// Chrome stops an idle background service worker, and its recent log entries (src/shared/logger.ts)
// would go with it, often just before the user exports diagnostics about what went wrong. They are
// saved to session storage, which outlives the worker and is cleared when the browser closes.
//
// The recent entries are the last few hundred, gone within the hour on a busy day and with each
// reload of the extension. Warnings and errors, what one looks back for (why this morning's
// 定时自检 failed), are kept apart for a week in local storage, cleaned as every kept entry is.
import { onLogRecorded, recentLogs, restoreRecentLogs, type RecentLogEntry } from '../shared/logger'

export const DIAGNOSTICS_LOGS_KEY = 'openteamRecentLogs'
const SAVE_DELAY_MS = 2000

export interface LogStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export async function keepLogsAcrossRestarts(storage: LogStorageArea | undefined): Promise<void> {
  if (!storage) return
  try {
    const saved = (await storage.get(DIAGNOSTICS_LOGS_KEY))[DIAGNOSTICS_LOGS_KEY]
    if (Array.isArray(saved)) restoreRecentLogs(saved.filter(isLogEntry))
  } catch {
    // Starting without the earlier entries is fine.
  }
  // Saved only once the earlier entries are back, so a save cannot drop them.
  let timer: ReturnType<typeof setTimeout> | undefined
  onLogRecorded(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      storage.set({ [DIAGNOSTICS_LOGS_KEY]: recentLogs() }).catch(() => undefined)
    }, SAVE_DELAY_MS)
  })
}

export const PROBLEM_LOGS_KEY = 'openteamProblemLogs'
export const PROBLEM_LOGS_KEEP_MS = 7 * 24 * 3600_000
export const PROBLEM_LOGS_MAX = 2000
// Logged as warnings at every step that goes well (each delivery, each page asked to load again),
// to follow a delivery while it happens: kept for a week, they would push the problems out.
const ROUTINE_WARNINGS: ReadonlySet<string> = new Set([
  'orchestration-diagnostic:delivery-attempt',
  'orchestration-diagnostic:stage-deliveries-start',
  'orchestration-diagnostic:role-recovery-request:start',
  'orchestration-diagnostic:role-recovery-request:response',
  'orchestration-diagnostic:role-error:mark-result',
  'message-resync-reply:request',
  'message-resync-reply:updated-store',
])

let problems: RecentLogEntry[] = []
let stopKeeping: (() => void) | undefined

export async function keepProblemLogs(storage: LogStorageArea | undefined): Promise<void> {
  if (!storage) return
  try {
    const saved = (await storage.get(PROBLEM_LOGS_KEY))[PROBLEM_LOGS_KEY]
    if (Array.isArray(saved)) problems = lastWeek([...saved.filter(isLogEntry), ...problems])
  } catch {
    // Starting without the earlier ones is fine.
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  stopKeeping?.()
  stopKeeping = onLogRecorded(entry => {
    if ((entry.level !== 'warn' && entry.level !== 'error') || ROUTINE_WARNINGS.has(entry.event)) return
    problems = lastWeek([...problems, entry])
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      storage.set({ [PROBLEM_LOGS_KEY]: problems }).catch(() => undefined)
    }, SAVE_DELAY_MS)
  })
}

// The background's logs to read or export: the week's warnings and errors, and the recent entries
// of every level, each once, oldest first.
export function backgroundLogs(): RecentLogEntry[] {
  const recent = recentLogs()
  const seen = new Set(recent.map(entryKey))
  return [...problems.filter(entry => !seen.has(entryKey(entry))), ...recent].sort((left, right) => left.at - right.at)
}

// For tests: as if the background had just started.
export function forgetProblemLogs(): void {
  stopKeeping?.()
  stopKeeping = undefined
  problems = []
}

function lastWeek(entries: RecentLogEntry[]): RecentLogEntry[] {
  const since = Date.now() - PROBLEM_LOGS_KEEP_MS
  return entries.filter(entry => entry.at >= since).slice(-PROBLEM_LOGS_MAX)
}

function entryKey(entry: RecentLogEntry): string {
  return `${entry.at}|${entry.scope}|${entry.event}|${entry.level}`
}

function isLogEntry(value: unknown): value is RecentLogEntry {
  const entry = value as Partial<RecentLogEntry> | null
  return Boolean(entry) && typeof entry!.at === 'number' && typeof entry!.event === 'string' && typeof entry!.scope === 'string'
}
