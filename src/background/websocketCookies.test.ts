import { describe, expect, it, vi } from 'vitest'
import { buildWebSocketCookieRule, cookieHeader, createWebSocketCookieSync, WEBSOCKET_COOKIE_SITES } from './websocketCookies'

const log = { info: vi.fn(), warn: vi.fn() }

describe('WebSocket handshake cookies for framed sites', () => {
  it('builds the Cookie header from the cookies given', () => {
    expect(cookieHeader([
      { name: 'sso', value: 'abc' },
      { name: '__Host-id-token-nonce', value: 'n=1' },
      { name: 'cf_clearance', value: 'x' },
      { name: '', value: 'ignored' },
    ])).toBe('sso=abc; __Host-id-token-nonce=n=1; cf_clearance=x')
  })

  it('limits the rule to WebSocket handshakes from the site\'s frames in team page tabs', () => {
    expect(buildWebSocketCookieRule(WEBSOCKET_COOKIE_SITES[0], 'sso=abc', [12, 40])).toEqual({
      id: 9001,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value: 'sso=abc' }] },
      condition: { urlFilter: '||grok.com/ws/', resourceTypes: ['websocket'], initiatorDomains: ['grok.com'], tabIds: [12, 40] },
    })
  })

  it('adds the rule while a team page is open, and removes it when none is', async () => {
    let tabIds = [7, 3, 7]
    const updateSessionRules = vi.fn(async () => undefined)
    const getCookies = vi.fn(async () => [{ name: 'sso', value: 'abc' }, { name: 'grok_device_id', value: 'd1' }])
    const sync = createWebSocketCookieSync({ getCookies, updateSessionRules, listTabIds: () => tabIds, log })

    await sync.sync()
    expect(getCookies).toHaveBeenCalledWith('https://grok.com/ws/mgw/')
    expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [9001], addRules: [buildWebSocketCookieRule(WEBSOCKET_COOKIE_SITES[0], 'sso=abc; grok_device_id=d1', [3, 7])] })

    tabIds = []
    await sync.sync()
    expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [9001], addRules: [] })
  })

  it('rebuilds once for a burst of changes, and only cares about the site\'s cookies', async () => {
    const timers: Array<() => void> = []
    const updateSessionRules = vi.fn(async () => undefined)
    const sync = createWebSocketCookieSync({ getCookies: async () => [{ name: 'sso', value: 'abc' }], updateSessionRules, listTabIds: () => [1], log, setTimer: handler => timers.push(handler) })

    sync.schedule()
    sync.schedule()
    sync.schedule()
    expect(timers).toHaveLength(1)
    timers[0]()
    await vi.waitFor(() => expect(updateSessionRules).toHaveBeenCalledTimes(1))

    expect(sync.watchesDomain('.grok.com')).toBe(true)
    expect(sync.watchesDomain('grok.com')).toBe(true)
    expect(sync.watchesDomain('assets.grok.com')).toBe(true)
    expect(sync.watchesDomain('.x.ai')).toBe(false)
    expect(sync.watchesDomain('notgrok.com')).toBe(false)
  })

  it('keeps going when the cookies cannot be read', async () => {
    const updateSessionRules = vi.fn(async () => undefined)
    const sync = createWebSocketCookieSync({ getCookies: async () => { throw new Error('no permission') }, updateSessionRules, listTabIds: () => [1], log })

    await sync.sync()

    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [9001], addRules: [] })
    expect(log.warn).toHaveBeenCalledWith('websocket-cookies:read-failed', { site: 'grok.com', error: 'no permission' })
  })
})
