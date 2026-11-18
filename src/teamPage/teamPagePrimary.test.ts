import { describe, expect, it, vi } from 'vitest'
import { createTeamPagePrimaryCoordinator, TEAM_PAGE_PRIMARY_LOCK_NAME } from './teamPagePrimary'

describe('team page primary coordinator', () => {
  it('becomes primary when the browser grants the page lock', async () => {
    const onPrimaryChange = vi.fn()
    const lockRequest = vi.fn((_name, _options, callback) => {
      const result = callback({})
      if (result instanceof Promise) result.then(() => undefined)
      return Promise.resolve()
    })
    const coordinator = createTeamPagePrimaryCoordinator({
      navigator: { locks: { request: lockRequest } } as never,
      onPrimaryChange,
    })

    const isPrimary = await coordinator.start()

    expect(isPrimary).toBe(true)
    expect(coordinator.isPrimary()).toBe(true)
    expect(lockRequest).toHaveBeenCalledWith(TEAM_PAGE_PRIMARY_LOCK_NAME, { ifAvailable: true }, expect.any(Function))
    expect(onPrimaryChange).toHaveBeenCalledWith(true)
    coordinator.dispose()
  })

  it('stays passive when another team page already holds the lock', async () => {
    const onPrimaryChange = vi.fn()
    const lockRequest = vi.fn((_name, _options, callback) => Promise.resolve(callback(null)))
    const coordinator = createTeamPagePrimaryCoordinator({
      navigator: { locks: { request: lockRequest } } as never,
      window: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() } as never,
      onPrimaryChange,
    })

    const isPrimary = await coordinator.start()

    expect(isPrimary).toBe(false)
    expect(coordinator.isPrimary()).toBe(false)
    expect(onPrimaryChange).toHaveBeenCalledWith(false)
  })

  it('falls back to primary mode when Web Locks are unavailable', async () => {
    const onPrimaryChange = vi.fn()
    const coordinator = createTeamPagePrimaryCoordinator({
      navigator: {} as never,
      onPrimaryChange,
    })

    const isPrimary = await coordinator.start()

    expect(isPrimary).toBe(true)
    expect(coordinator.isPrimary()).toBe(true)
    expect(onPrimaryChange).toHaveBeenCalledWith(true)
  })

  it('lets go for the side panel without counting as pushed aside, and takes over again after it', async () => {
    // One lock, as the browser keeps it: whoever asks while it is free gets it.
    let holder: (() => void) | undefined
    const lockRequest = vi.fn((_name, _options, callback: (lock: object | null) => unknown) => {
      if (holder) return Promise.resolve(callback(null))
      const held = callback({}) as Promise<void>
      holder = () => undefined
      void held.then(() => { holder = undefined })
      return Promise.resolve()
    })
    const onPrimaryChange = vi.fn()
    const coordinator = createTeamPagePrimaryCoordinator({
      navigator: { locks: { request: lockRequest } } as never,
      window: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() } as never,
      onPrimaryChange,
    })
    expect(await coordinator.start()).toBe(true)

    coordinator.yieldToPanel(true)
    expect(coordinator.isPrimary()).toBe(false)
    expect(onPrimaryChange).toHaveBeenLastCalledWith(false, 'yielded')
    await vi.waitFor(() => expect(holder).toBeUndefined())

    coordinator.yieldToPanel(false)
    await vi.waitFor(() => expect(coordinator.isPrimary()).toBe(true))
    expect(onPrimaryChange).toHaveBeenLastCalledWith(true)
    coordinator.dispose()
  })

  it('does not take the lock while it has yielded', async () => {
    const lockRequest = vi.fn((_name, _options, callback) => Promise.resolve(callback(null)))
    const setTimeout = vi.fn(() => 1)
    const coordinator = createTeamPagePrimaryCoordinator({
      navigator: { locks: { request: lockRequest } } as never,
      window: { setTimeout, clearTimeout: vi.fn() } as never,
      onPrimaryChange: vi.fn(),
    })
    coordinator.yieldToPanel(true)
    expect(await coordinator.start()).toBe(false)
    expect(lockRequest).not.toHaveBeenCalled()
    expect(setTimeout).not.toHaveBeenCalled()
  })
})
