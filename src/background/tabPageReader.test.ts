import { describe, expect, it, vi } from 'vitest'
import { createTabPageReader } from './tabPageReader'

function setup(options: { completes?: boolean; readError?: string; text?: string } = {}) {
  const listeners = new Set<(tabId: number, info: { status?: string }) => void>()
  const tabs = {
    create: vi.fn(async (_props: { url: string; active: boolean }) => {
      if (options.completes !== false) setTimeout(() => listeners.forEach(listener => listener(7, { status: 'complete' })), 5)
      return { id: 7 }
    }),
    remove: vi.fn(async (_tabId: number) => undefined),
    get: vi.fn(async (_tabId: number) => ({ id: 7, status: options.completes === false ? 'loading' : 'complete', url: 'https://www.nytimes.com/a' })),
    onUpdated: {
      addListener: (listener: (tabId: number, info: { status?: string }) => void) => listeners.add(listener),
      removeListener: (listener: (tabId: number, info: { status?: string }) => void) => listeners.delete(listener),
    },
  }
  const readTab = vi.fn(async (_tabId: number) => {
    if (options.readError) throw new Error(options.readError)
    return { title: '河马 Fiona', url: 'https://www.nytimes.com/a', text: options.text ?? '正文第一段。\n\n\n\n正文第二段。  ' }
  })
  const reader = createTabPageReader({ tabs, readTab, settleMs: 1, loadTimeoutMs: 40 })
  return { reader, tabs, readTab, listeners }
}

describe('reading a page in a background tab', () => {
  it('opens it without switching to it, reads it once loaded, and closes it', async () => {
    const ctx = setup()
    expect(await ctx.reader.read('https://www.nytimes.com/a')).toEqual({ title: '河马 Fiona', url: 'https://www.nytimes.com/a', text: '正文第一段。\n\n正文第二段。' })
    expect(ctx.tabs.create).toHaveBeenCalledWith({ url: 'https://www.nytimes.com/a', active: false })
    expect(ctx.readTab).toHaveBeenCalledWith(7)
    expect(ctx.tabs.remove).toHaveBeenCalledWith(7)
    expect(ctx.listeners.size).toBe(0)
  })

  it('gives up on a page that does not load in time, and closes it', async () => {
    const ctx = setup({ completes: false })
    await expect(ctx.reader.read('https://www.nytimes.com/a')).rejects.toThrow('在标签页里 30 秒内没有打开')
    expect(ctx.readTab).not.toHaveBeenCalled()
    expect(ctx.tabs.remove).toHaveBeenCalledWith(7)
  })

  it('closes the tab when the page cannot be read, or has no text', async () => {
    const failing = setup({ readError: 'Cannot access contents of the page' })
    await expect(failing.reader.read('https://www.nytimes.com/a')).rejects.toThrow('Cannot access contents of the page')
    expect(failing.tabs.remove).toHaveBeenCalledWith(7)
    const empty = setup({ text: '   ' })
    await expect(empty.reader.read('https://www.nytimes.com/a')).rejects.toThrow('在标签页里也没有读到文字')
    expect(empty.tabs.remove).toHaveBeenCalledWith(7)
  })

  it('reads one page at a time', async () => {
    const ctx = setup()
    await Promise.all([ctx.reader.read('https://a.example/1'), ctx.reader.read('https://a.example/2')])
    const opened = ctx.tabs.create.mock.invocationCallOrder
    const closed = ctx.tabs.remove.mock.invocationCallOrder
    expect(closed[0]).toBeLessThan(opened[1])
  })
})
