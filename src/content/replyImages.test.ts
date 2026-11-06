// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { materializeReplyImages } from './replyImages'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading reply images inside the page', () => {
  it('sends blob: images with their bytes and leaves https images to the background', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }) }))
    vi.stubGlobal('fetch', fetchMock)

    const images = await materializeReplyImages([
      { sourceUrl: 'blob:https://chatgpt.com/abc', alt: 'Generated image 1' },
      { sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file' },
    ], log)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('blob:https://chatgpt.com/abc', { credentials: 'omit' })
    expect(images).toEqual([
      { sourceUrl: 'blob:https://chatgpt.com/abc', alt: 'Generated image 1', data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47)), mimeType: 'image/png' },
      { sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file' },
    ])
  })

  it('reads images marked to be read in the page, without cookies, and drops the mark', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, blob: async () => new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }) }))
    vi.stubGlobal('fetch', fetchMock)

    const images = await materializeReplyImages([{ sourceUrl: 'https://cdn.qwenlm.ai/output/x.png', readInPage: true }], log)

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.qwenlm.ai/output/x.png', { credentials: 'omit' })
    expect(images).toEqual([{ sourceUrl: 'https://cdn.qwenlm.ai/output/x.png', data: btoa(String.fromCharCode(0x89, 0x50)), mimeType: 'image/png' }])
  })

  it('keeps an image it cannot read, so the chat can show it failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    expect(await materializeReplyImages([{ sourceUrl: 'blob:https://chatgpt.com/gone' }], log)).toEqual([{ sourceUrl: 'blob:https://chatgpt.com/gone' }])
    expect(log.warn).toHaveBeenCalledWith('reply-images:read-failed', expect.anything())
  })

  it('does not send page content that is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }) })))

    expect(await materializeReplyImages([{ sourceUrl: 'blob:https://chatgpt.com/svg' }], log)).toEqual([{ sourceUrl: 'blob:https://chatgpt.com/svg' }])
  })

  it('passes nothing through when there are no images', async () => {
    expect(await materializeReplyImages(undefined, log)).toBeUndefined()
  })
})
