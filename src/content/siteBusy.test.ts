import { describe, expect, it, vi } from 'vitest'
import { SITE_BUSY_HEARTBEAT_MS, SITE_BUSY_MAX_WAIT_MS, waitUntilSiteIsDone } from './siteBusy'

// A clock that sleeping moves on.
function clock() {
  let time = 0
  return { now: () => time, sleep: vi.fn(async (ms: number) => { time += ms }), advance: (ms: number) => { time += ms } }
}

describe('waiting for a site to finish the reply it is writing before a prompt goes in', () => {
  it('goes ahead at once when the site is not writing', async () => {
    const { now, sleep } = clock()
    const heartbeat = vi.fn()

    expect(await waitUntilSiteIsDone({ isGenerating: () => false, isStopped: () => false, heartbeat, now, sleep })).toBe('done')
    expect(sleep).not.toHaveBeenCalled()
    expect(heartbeat).not.toHaveBeenCalled()
  })

  it('waits while the site writes, saying now and then that the member is still taking the prompt', async () => {
    const { now, sleep } = clock()
    const heartbeat = vi.fn()
    // The site writes for 75 seconds more.
    const isGenerating = () => now() < 75_000

    expect(await waitUntilSiteIsDone({ isGenerating, isStopped: () => false, heartbeat, now, sleep })).toBe('done')
    expect(now()).toBeGreaterThanOrEqual(75_000)
    expect(now()).toBeLessThan(77_000)
    expect(heartbeat).toHaveBeenCalledTimes(Math.floor(75_000 / SITE_BUSY_HEARTBEAT_MS))
  })

  it('gives up when the reply is stopped meanwhile', async () => {
    const { now, sleep } = clock()
    let stopped = false
    const isGenerating = () => {
      if (now() >= 5_000) stopped = true
      return true
    }

    expect(await waitUntilSiteIsDone({ isGenerating, isStopped: () => stopped, heartbeat: vi.fn(), now, sleep })).toBe('stopped')
    expect(now()).toBeLessThan(10_000)
  })

  it('fails, saying why, when the site is still writing after a long while', async () => {
    const { now, sleep } = clock()

    await expect(waitUntilSiteIsDone({ isGenerating: () => true, isStopped: () => false, heartbeat: vi.fn(), now, sleep })).rejects.toThrow(/还在生成上一条回复/)
    expect(now()).toBeGreaterThanOrEqual(SITE_BUSY_MAX_WAIT_MS)
  })
})
