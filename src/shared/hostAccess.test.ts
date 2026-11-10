import { describe, expect, it, vi } from 'vitest'
import { hasHostAccess, hostAccessLabel, hostAccessPattern, requestHostAccess } from './hostAccess'

describe('host access for API addresses', () => {
  it('covers the address by its scheme and host, whatever the port and path', () => {
    expect(hostAccessPattern('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/*')
    expect(hostAccessPattern(' https://openrouter.ai/api/v1/ ')).toBe('https://openrouter.ai/*')
    expect(hostAccessPattern('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1/*')
    expect(hostAccessLabel('https://api.deepseek.com/v1')).toBe('api.deepseek.com')
  })

  it('has no pattern for something that is not a web address', () => {
    expect(hostAccessPattern('api.deepseek.com/v1')).toBeUndefined()
    expect(hostAccessPattern('ftp://example.com')).toBeUndefined()
    expect(hostAccessPattern('')).toBeUndefined()
  })

  it('has no pattern for an address with a wildcard host, which would cover many sites or all of them', async () => {
    expect(hostAccessPattern('https://*/v1')).toBeUndefined()
    expect(hostAccessPattern('https://*.example.com/v1')).toBeUndefined()

    const api = { contains: vi.fn(async () => false), request: vi.fn(async () => true) }
    expect(await requestHostAccess('https://*/v1', api)).toBe(false)
    expect(api.request).not.toHaveBeenCalled()
  })

  it('asks the browser only for that address, and only when it is not allowed yet', async () => {
    const api = { contains: vi.fn(async () => false), request: vi.fn(async () => true) }

    expect(await requestHostAccess('https://api.deepseek.com/v1', api)).toBe(true)
    expect(api.request).toHaveBeenCalledWith({ origins: ['https://api.deepseek.com/*'] })

    const allowed = { contains: vi.fn(async () => true), request: vi.fn(async () => true) }
    expect(await requestHostAccess('https://api.deepseek.com/v1', allowed)).toBe(true)
    expect(allowed.request).not.toHaveBeenCalled()
  })

  it('reports a refusal, and a browser error, as no access', async () => {
    expect(await requestHostAccess('https://api.deepseek.com/v1', { contains: async () => false, request: async () => false })).toBe(false)
    expect(await requestHostAccess('https://api.deepseek.com/v1', { contains: async () => false, request: async () => { throw new Error('This function must be called during a user gesture') } })).toBe(false)
    expect(await hasHostAccess('https://api.deepseek.com/v1', { contains: async () => { throw new Error('bad pattern') }, request: async () => true })).toBe(false)
    expect(await hasHostAccess('not a url', { contains: async () => true, request: async () => true })).toBe(false)
  })
})
