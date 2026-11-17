import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import type { RuntimeMessage } from './runtimeClient'

// readyAfter: how many checks pass before each member's page is ready (never, when left out of it).
async function setup(options: { failOn?: string; readyAfter?: Record<string, number> } = {}) {
  const { failOn } = options
  vi.resetModules()
  const store = createDefaultStore()
  vi.doMock('./storeAccess', async importOriginal => {
    const actual = await importOriginal<typeof import('./storeAccess')>()
    return {
      ...actual,
      mutateStore: async (mutator: (store: OpenTeamStore) => unknown) => ({ store, result: await mutator(store) }),
    }
  })
  const routed: RuntimeMessage[] = []
  // Stands in for the other handlers.
  const route = vi.fn<[RuntimeMessage], Promise<unknown>>()
  const broadcastStoreUpdated = vi.fn()
  let clock = new Date(2026, 10, 17, 9, 5).getTime()
  let checks = 0
  const readyAfter = options.readyAfter ?? Object.fromEntries(['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'kimi'].map(site => [site, 0]))
  const runtimeFrames = {
    getByRole: (_chatId: string, roleId: string) => {
      const site = store.rolesById[roleId]?.chatSite ?? ''
      return site in readyAfter && checks >= readyAfter[site] ? { ready: true } as never : undefined
    },
  }
  const waitFor = vi.fn(async (ms: number) => {
    checks += 1
    clock += ms
  })
  // Stands in for the roles handler: each item becomes a member of the group.
  let checksAtSend: number | undefined
  route.mockImplementation(async (message: RuntimeMessage) => {
    routed.push(message)
    if (message.type === 'GROUP_MESSAGE_SEND') checksAtSend = checks
    if (message.type === failOn) return { ok: false, error: `${failOn} failed` }
    if (message.type === 'GROUP_CHAT_CREATE') {
      store.chatsById['chat-check'] = { id: 'chat-check', name: String(message.name), mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
      return { ok: true, chat: { id: 'chat-check' }, store }
    }
    if (message.type === 'GROUP_ROLES_CREATE_BATCH') {
      for (const item of message.items as Array<{ chatSite: string; name: string }>) {
        const id = `role-${item.chatSite}`
        store.rolesById[id] = { id, chatId: 'chat-check', name: item.name, chatSite: item.chatSite as never, modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 }
        store.chatsById['chat-check'].roleIds.push(id)
      }
    }
    return { ok: true, store }
  })
  const { SITE_CHECK_ROUTE_TYPES, createSiteCheckHandlers } = await import('./siteCheckHandlers')
  const routes = createSiteCheckHandlers({ route, broadcastStoreUpdated, runtimeFrames, waitFor, now: () => clock })
  const start = () => Promise.resolve(routes.find(entry => entry.type === 'GROUP_SITE_CHECK_START')!.handler({ type: 'GROUP_SITE_CHECK_START' }, {})) as Promise<{ ok: boolean; chatId?: string }>
  return { store, routes, routed, start, broadcastStoreUpdated, waitFor, SITE_CHECK_ROUTE_TYPES, checksAtSend: () => checksAtSend }
}

describe('background site check', () => {
  it('makes a group with one member on each site, marks it, opens it and asks everyone to reply OK once their pages are ready', async () => {
    const { store, routes, routed, start, broadcastStoreUpdated, SITE_CHECK_ROUTE_TYPES, checksAtSend } = await setup({ readyAfter: { gemini: 0, chatgpt: 1, claude: 1, deepseek: 3, grok: 2, qwen: 0, kimi: 1 } })
    expect(routes.map(entry => entry.type)).toEqual(SITE_CHECK_ROUTE_TYPES)

    // Answers as soon as the group is open; the question goes out once every page is ready.
    const response = await start()
    expect(response).toMatchObject({ ok: true, chatId: 'chat-check' })
    await vi.waitFor(() => expect(routed.map(message => message.type)).toEqual(['GROUP_CHAT_CREATE', 'GROUP_ROLES_CREATE_BATCH', 'GROUP_CHAT_SWITCH', 'GROUP_MESSAGE_SEND']))
    expect(routed[0]).toMatchObject({ name: '网站自检 11-17 09:05', mode: 'independent' })
    const items = routed[1].items as Array<Record<string, unknown>>
    expect(items.map(item => item.chatSite)).toEqual(['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'qwen', 'kimi'])
    expect(items[0]).toMatchObject({ source: 'temporary', name: 'Gemini', modelSource: 'site' })
    expect(routed[2]).toMatchObject({ chatId: 'chat-check' })
    expect(routed[3]).toMatchObject({ chatId: 'chat-check', raw: expect.stringMatching(/^@all .*OK/) })
    // DeepSeek's page was the last to be ready, after three checks.
    expect(checksAtSend()).toBe(3)
    // Marked before the question goes out, so the page shows the check from the start.
    expect(store.chatsById['chat-check'].siteCheck).toEqual({ startedAt: new Date(2026, 10, 17, 9, 5).getTime() })
    expect(broadcastStoreUpdated).toHaveBeenCalled()
  })

  it('stops and says why when a step fails', async () => {
    const { routed, start } = await setup({ failOn: 'GROUP_ROLES_CREATE_BATCH' })
    await expect(start()).rejects.toThrow('GROUP_ROLES_CREATE_BATCH failed')
    expect(routed.map(message => message.type)).toEqual(['GROUP_CHAT_CREATE', 'GROUP_ROLES_CREATE_BATCH'])
  })

  it('asks the members whose pages are ready when the others are still not after the wait', async () => {
    const { routed, start, store } = await setup({ readyAfter: { gemini: 0, chatgpt: 0 } })
    await start()
    await vi.waitFor(() => expect(routed.slice(-1)[0]?.type).toBe('GROUP_MESSAGE_SEND'))
    expect(store.chatsById['chat-check'].siteCheck?.error).toBeUndefined()
  })

  it('says on the group why nothing was asked when no page became ready', async () => {
    const { routed, start, store, broadcastStoreUpdated } = await setup({ readyAfter: {} })
    await start()
    await vi.waitFor(() => expect(store.chatsById['chat-check'].siteCheck?.error).toBeTruthy())
    expect(store.chatsById['chat-check'].siteCheck?.error).toContain('OpenTeam')
    expect(routed.map(message => message.type)).not.toContain('GROUP_MESSAGE_SEND')
    expect(broadcastStoreUpdated).toHaveBeenCalledTimes(2)
  })
})
