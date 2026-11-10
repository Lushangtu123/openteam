import { describe, expect, it, vi } from 'vitest'
import { dropAllSitesAccess, RELOAD_ONCE_WITHIN_MS, type AllSitesAccessDependencies } from './allSitesAccess'

// A browser that holds the old all-sites access until it is removed.
function setup(options: { holdsAllSites?: boolean; droppedAt?: number; removeWorks?: boolean; now?: number } = {}) {
  let holdsAllSites = options.holdsAllSites ?? true
  let droppedAt = options.droppedAt ?? 0
  const deps = {
    permissions: {
      contains: vi.fn(async () => holdsAllSites),
      remove: vi.fn(async () => {
        if (options.removeWorks === false) return false
        holdsAllSites = false
        return true
      }),
    },
    readDroppedAt: vi.fn(async () => droppedAt),
    writeDroppedAt: vi.fn(async (timestamp: number) => { droppedAt = timestamp }),
    reload: vi.fn(),
    now: () => options.now ?? 1_000_000,
    log: { info: vi.fn(), warn: vi.fn() },
  } satisfies AllSitesAccessDependencies
  return { deps, droppedAt: () => droppedAt }
}

describe('giving back the access to every website that old versions required', () => {
  it('does nothing on an install that never had it, or has given it back already', async () => {
    const { deps } = setup({ holdsAllSites: false })

    expect(await dropAllSitesAccess(deps)).toBe('none')
    expect(deps.permissions.remove).not.toHaveBeenCalled()
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('removes only the all-sites pattern, remembers when, and reloads the extension once', async () => {
    const { deps, droppedAt } = setup({ now: 5_000_000 })

    expect(await dropAllSitesAccess(deps)).toBe('dropped')
    expect(deps.permissions.remove).toHaveBeenCalledWith({ origins: ['https://*/*'] })
    expect(droppedAt()).toBe(5_000_000)
    expect(deps.reload).toHaveBeenCalledTimes(1)

    // The start after that reload: nothing left to do.
    expect(await dropAllSitesAccess(deps)).toBe('none')
    expect(deps.reload).toHaveBeenCalledTimes(1)
  })

  it('never reloads twice in a row, even if the access is there again right after', async () => {
    const { deps } = setup({ droppedAt: 5_000_000, now: 5_000_000 + RELOAD_ONCE_WITHIN_MS - 1 })

    expect(await dropAllSitesAccess(deps)).toBe('dropped-without-reload')
    expect(deps.permissions.remove).toHaveBeenCalled()
    expect(deps.reload).not.toHaveBeenCalled()
  })

  it('reloads again when the access comes back much later, as after going back to an old version', async () => {
    const { deps } = setup({ droppedAt: 5_000_000, now: 5_000_000 + RELOAD_ONCE_WITHIN_MS })

    expect(await dropAllSitesAccess(deps)).toBe('dropped')
    expect(deps.reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the browser refuses to remove it, or fails', async () => {
    const refused = setup({ removeWorks: false })
    expect(await dropAllSitesAccess(refused.deps)).toBe('failed')
    expect(refused.deps.reload).not.toHaveBeenCalled()

    const broken = setup()
    broken.deps.permissions.contains.mockRejectedValue(new Error('no permissions API'))
    expect(await dropAllSitesAccess(broken.deps)).toBe('failed')
    expect(broken.deps.reload).not.toHaveBeenCalled()
  })

  it('still reloads when the time of the last removal cannot be read', async () => {
    const { deps } = setup()
    deps.readDroppedAt.mockRejectedValue(new Error('storage unavailable'))

    expect(await dropAllSitesAccess(deps)).toBe('dropped')
    expect(deps.reload).toHaveBeenCalledTimes(1)
  })
})
