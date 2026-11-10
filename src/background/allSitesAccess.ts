// Earlier versions required access to every website. The browser keeps that access when an
// update makes it optional, so an existing install would stay as broad as before. This gives it
// back, once, when the extension starts.
//
// Giving it back has a side effect in Chrome: the sites the manifest still requires (the AI chat
// sites, the image hosts) lose their access too, until the extension is loaded again. So the
// extension reloads itself right after; that load grants exactly what the manifest lists.
import { ALL_SITES_PATTERN } from '../shared/hostAccess'

export const ALL_SITES_DROPPED_AT_KEY = 'openteam.allSitesAccessDroppedAt'
// A second reload this soon after the first would mean the access came back by itself; it is not
// tried again, so the extension can never reload in a loop.
export const RELOAD_ONCE_WITHIN_MS = 5 * 60_000

export type AllSitesAccessResult = 'none' | 'dropped' | 'dropped-without-reload' | 'failed'

export interface AllSitesAccessDependencies {
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>
    remove(permissions: { origins: string[] }): Promise<boolean>
  }
  // When the access was last given back (0 if never), kept across reloads.
  readDroppedAt(): Promise<number>
  writeDroppedAt(timestamp: number): Promise<void>
  reload(): void
  now(): number
  log: { info(event: string, details?: Record<string, unknown>): void; warn(event: string, details?: Record<string, unknown>): void }
}

export async function dropAllSitesAccess(deps: AllSitesAccessDependencies): Promise<AllSitesAccessResult> {
  const all = { origins: [ALL_SITES_PATTERN] }
  try {
    if (!await deps.permissions.contains(all)) return 'none'
    if (!await deps.permissions.remove(all) || await deps.permissions.contains(all)) {
      deps.log.warn('all-sites-access:not-dropped')
      return 'failed'
    }
    const droppedAt = await deps.readDroppedAt().catch(() => 0)
    const timestamp = deps.now()
    if (droppedAt > 0 && timestamp - droppedAt < RELOAD_ONCE_WITHIN_MS) {
      deps.log.warn('all-sites-access:dropped-again', { sinceLastMs: timestamp - droppedAt })
      return 'dropped-without-reload'
    }
    await deps.writeDroppedAt(timestamp)
    deps.log.info('all-sites-access:dropped')
    deps.reload()
    return 'dropped'
  } catch (error) {
    deps.log.warn('all-sites-access:failed', { error: error instanceof Error ? error.message : String(error) })
    return 'failed'
  }
}
