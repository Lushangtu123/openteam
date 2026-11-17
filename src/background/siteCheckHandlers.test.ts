import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import type { RuntimeMessage } from './runtimeClient'

async function setup(failOn?: string) {
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
  // Stands in for the other handlers: a group is made when asked, the rest only answer ok.
  const route = vi.fn(async (message: RuntimeMessage) => {
    routed.push(message)
    if (message.type === failOn) return { ok: false, error: `${failOn} failed` }
    if (message.type === 'GROUP_CHAT_CREATE') {
      store.chatsById['chat-check'] = { id: 'chat-check', name: String(message.name), mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
      return { ok: true, chat: { id: 'chat-check' }, store }
    }
    return { ok: true, store }
  })
  const broadcastStoreUpdated = vi.fn()
  const { SITE_CHECK_ROUTE_TYPES, createSiteCheckHandlers } = await import('./siteCheckHandlers')
  const routes = createSiteCheckHandlers({ route, broadcastStoreUpdated, now: () => new Date(2026, 10, 17, 9, 5).getTime() })
  const start = () => Promise.resolve(routes.find(entry => entry.type === 'GROUP_SITE_CHECK_START')!.handler({ type: 'GROUP_SITE_CHECK_START' }, {})) as Promise<{ ok: boolean; chatId?: string }>
  return { store, routes, routed, start, broadcastStoreUpdated, SITE_CHECK_ROUTE_TYPES }
}

describe('background site check', () => {
  it('makes a group with one member on each site, marks it, opens it and asks everyone to reply OK', async () => {
    const { store, routes, routed, start, broadcastStoreUpdated, SITE_CHECK_ROUTE_TYPES } = await setup()
    expect(routes.map(entry => entry.type)).toEqual(SITE_CHECK_ROUTE_TYPES)

    const response = await start()

    expect(response).toMatchObject({ ok: true, chatId: 'chat-check' })
    expect(routed.map(message => message.type)).toEqual(['GROUP_CHAT_CREATE', 'GROUP_ROLES_CREATE_BATCH', 'GROUP_CHAT_SWITCH', 'GROUP_MESSAGE_SEND'])
    expect(routed[0]).toMatchObject({ name: '网站自检 11-17 09:05', mode: 'independent' })
    const items = routed[1].items as Array<Record<string, unknown>>
    expect(items.map(item => item.chatSite)).toEqual(['gemini', 'chatgpt', 'deepseek', 'grok', 'qwen', 'kimi'])
    expect(items[0]).toMatchObject({ source: 'temporary', name: 'Gemini', modelSource: 'site' })
    expect(routed[2]).toMatchObject({ chatId: 'chat-check' })
    expect(routed[3]).toMatchObject({ chatId: 'chat-check', raw: expect.stringMatching(/^@all .*OK/) })
    // Marked before the question goes out, so the page shows the check from the start.
    expect(store.chatsById['chat-check'].siteCheck).toEqual({ startedAt: new Date(2026, 10, 17, 9, 5).getTime() })
    expect(broadcastStoreUpdated).toHaveBeenCalled()
  })

  it('stops and says why when a step fails', async () => {
    const { routed, start } = await setup('GROUP_ROLES_CREATE_BATCH')
    await expect(start()).rejects.toThrow('GROUP_ROLES_CREATE_BATCH failed')
    expect(routed.map(message => message.type)).toEqual(['GROUP_CHAT_CREATE', 'GROUP_ROLES_CREATE_BATCH'])
  })
})
