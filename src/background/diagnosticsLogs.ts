// Chrome stops an idle background service worker, and its recent log entries (src/shared/logger.ts)
// would go with it, often just before the user exports diagnostics about what went wrong. They are
// saved to session storage, which outlives the worker and is cleared when the browser closes.
import { onLogRecorded, recentLogs, restoreRecentLogs, type RecentLogEntry } from '../shared/logger'

export const DIAGNOSTICS_LOGS_KEY = 'openteamRecentLogs'
const SAVE_DELAY_MS = 2000

export interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export async function keepLogsAcrossRestarts(storage: SessionStorageArea | undefined): Promise<void> {
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

function isLogEntry(value: unknown): value is RecentLogEntry {
  const entry = value as Partial<RecentLogEntry> | null
  return Boolean(entry) && typeof entry!.at === 'number' && typeof entry!.event === 'string' && typeof entry!.scope === 'string'
}
