import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { activeSiteLimit, recordSiteLimit, recordSiteSent } from '../group/siteUsage'
import type { OpenTeamStore } from '../group/types'

async function setup() {
  vi.resetModules()
  const store = createDefaultStore()
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return { ...actual, mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }) }
  })
  const { createSiteUsageHandlers } = await import('./siteUsageHandlers')
  const broadcastStoreUpdated = vi.fn()
  const routes = createSiteUsageHandlers({ broadcastStoreUpdated, log: { info: vi.fn() } })
  const run = (message: Record<string, unknown>) => routes.find(route => route.type === 'GROUP_SITE_LIMIT_CLEAR')!.handler({ type: 'GROUP_SITE_LIMIT_CLEAR', ...message }, {})
  return { store, run, broadcastStoreUpdated }
}

describe('saying a limiting site has recovered', () => {
  it('lifts the mark, keeping the day\'s count, and tells the pages', async () => {
    const { store, run, broadcastStoreUpdated } = await setup()
    for (let index = 0; index < 6; index += 1) recordSiteSent(store, 'kimi', 100)
    recordSiteLimit(store, 'kimi', '额度用完', 200)
    await run({ site: 'kimi' })
    expect(activeSiteLimit(store, 'kimi', 300)).toBeUndefined()
    expect(store.siteUsageBySite?.kimi).toMatchObject({ sent: 6, limitCount: 6 })
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(store)
  })

  it('is refused for a site OpenTeam does not know', async () => {
    const { run } = await setup()
    await expect(run({ site: 'nowhere' })).rejects.toThrow('不认识这个网站')
  })
})
