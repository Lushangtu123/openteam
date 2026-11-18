export const TEAM_PAGE_PRIMARY_LOCK_NAME = 'openteam:team-page:primary'

type LockLike = Record<string, never>
type LockRequestCallback = (lock: LockLike | null) => Promise<void> | void
type LockManagerLike = {
  request(name: string, options: { ifAvailable: true }, callback: LockRequestCallback): Promise<unknown>
}

export interface TeamPagePrimaryCoordinatorDependencies {
  navigator?: Navigator
  window?: Window
  retryDelayMs?: number
  // 'yielded': this page let go for OpenTeam in the side panel, which holds the member pages now.
  onPrimaryChange(isPrimary: boolean, reason?: 'yielded'): void
  log?: {
    warn(event: string, details?: Record<string, unknown>): void
  }
}

export interface TeamPagePrimaryCoordinator {
  start(): Promise<boolean>
  isPrimary(): boolean
  // While a side panel is open, an OpenTeam tab lets it hold the members' AI pages, and takes them
  // back once it closes (the panel keeps them working while the user is on another tab).
  yieldToPanel(yielding: boolean): void
  dispose(): void
}

const DEFAULT_RETRY_DELAY_MS = 2000

export function createTeamPagePrimaryCoordinator(deps: TeamPagePrimaryCoordinatorDependencies): TeamPagePrimaryCoordinator {
  const lockManager = (deps.navigator as (Navigator & { locks?: LockManagerLike }) | undefined)?.locks
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const timerWindow = deps.window ?? (typeof window === 'undefined' ? undefined : window)
  let primary = false
  let primaryStateKnown = false
  let disposed = false
  let yielding = false
  let releaseLock: (() => void) | undefined
  let retryTimer: number | undefined

  function setPrimary(nextPrimary: boolean, reason?: 'yielded'): void {
    if (primaryStateKnown && primary === nextPrimary) return
    primaryStateKnown = true
    primary = nextPrimary
    if (reason) deps.onPrimaryChange(primary, reason)
    else deps.onPrimaryChange(primary)
  }

  function clearRetry(): void {
    if (retryTimer === undefined) return
    timerWindow?.clearTimeout(retryTimer)
    retryTimer = undefined
  }

  function scheduleRetry(): void {
    if (disposed || yielding || primary || retryTimer !== undefined || !lockManager?.request || !timerWindow) return
    retryTimer = timerWindow.setTimeout(() => {
      retryTimer = undefined
      void tryAcquire()
    }, retryDelayMs)
  }

  async function tryAcquire(): Promise<boolean> {
    if (disposed) return primary
    if (yielding) return false
    if (!lockManager?.request) {
      setPrimary(true)
      return true
    }

    return new Promise<boolean>(resolve => {
      lockManager.request(TEAM_PAGE_PRIMARY_LOCK_NAME, { ifAvailable: true }, lock => {
        if (!lock) {
          setPrimary(false)
          scheduleRetry()
          resolve(false)
          return
        }

        // A side panel opened while the lock was asked for: let it go at once.
        if (yielding) {
          resolve(false)
          return undefined
        }
        clearRetry()
        setPrimary(true)
        resolve(true)
        return new Promise<void>(release => {
          releaseLock = release
        })
      }).catch(error => {
        deps.log?.warn('team-page-primary:lock-failed', { error: error instanceof Error ? error.message : String(error) })
        setPrimary(true)
        resolve(true)
      })
    })
  }

  return {
    start: tryAcquire,
    isPrimary: () => primary,
    yieldToPanel(next) {
      if (yielding === next || disposed) return
      yielding = next
      if (yielding) {
        clearRetry()
        releaseLock?.()
        releaseLock = undefined
        setPrimary(false, 'yielded')
        return
      }
      void tryAcquire()
    },
    dispose: () => {
      disposed = true
      clearRetry()
      releaseLock?.()
      releaseLock = undefined
      setPrimary(false)
    },
  }
}
