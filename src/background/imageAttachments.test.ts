import { describe, expect, it, vi } from 'vitest'
import { createImageAttachmentService, type ImageAttachmentBlobRecord, type ImageAttachmentRepository } from './imageAttachments'

describe('image attachment service', () => {
  it('downloads deduplicated ChatGPT images and stores the original blobs', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    const repository = createFakeRepository(records)
    const fetchImage = vi.fn(async () => new Response(new Blob(['original-image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }))
    const service = createImageAttachmentService({
      fetchImage,
      repository,
      newId: () => 'attachment-1',
      now: () => 123,
    })

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [
        {
          sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file-image&sig=secret',
          alt: '已生成图片：产品草图',
          width: 1024,
          height: 1024,
        },
        {
          sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file-image&sig=secret',
        },
      ],
    })

    expect(fetchImage).toHaveBeenCalledTimes(1)
    expect(records).toHaveLength(1)
    expect(await records[0].blob.text()).toBe('original-image')
    expect(records[0]).toMatchObject({
      id: 'attachment-1',
      chatId: 'chat-1',
      messageId: 'msg-1',
      mimeType: 'image/png',
      fileName: 'chatgpt-image-1.png',
      createdAt: 123,
    })
    expect(attachments).toEqual([{
      id: 'attachment-1',
      type: 'image',
      status: 'ready',
      alt: '已生成图片：产品草图',
      width: 1024,
      height: 1024,
      mimeType: 'image/png',
      size: 14,
      fileName: 'chatgpt-image-1.png',
    }])
    expect(JSON.stringify(attachments)).not.toContain('sig=secret')
  })

  it('downloads trusted Gemini generated images', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    const repository = createFakeRepository(records)
    const fetchImage = vi.fn(async () => new Response(new Blob(['gemini-image'], { type: 'image/webp' }), {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    }))
    const service = createImageAttachmentService({
      fetchImage,
      repository,
      newId: () => 'attachment-gemini',
      now: () => 123,
    })

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [{
        sourceUrl: 'https://lh3.googleusercontent.com/generated-image=s2048',
        alt: '生成图片：产品草图',
      }],
    })

    expect(fetchImage).toHaveBeenCalledWith('https://lh3.googleusercontent.com/generated-image=s2048', expect.objectContaining({
      credentials: 'include',
    }))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: 'attachment-gemini',
      mimeType: 'image/webp',
      fileName: 'gemini-image-1.webp',
    })
    expect(attachments).toMatchObject([{
      id: 'attachment-gemini',
      type: 'image',
      status: 'ready',
      alt: '生成图片：产品草图',
      mimeType: 'image/webp',
      fileName: 'gemini-image-1.webp',
    }])
  })

  it('returns error attachments for unsafe or non-image responses without discarding successful images', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    const repository = createFakeRepository(records)
    const fetchImage = vi.fn(async (url: string) => {
      if (url.includes('good')) {
        return new Response(new Blob(['image'], { type: 'image/webp' }), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        })
      }
      return new Response('<html>login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    })
    let id = 0
    const service = createImageAttachmentService({
      fetchImage,
      repository,
      newId: () => `attachment-${++id}`,
      now: () => 123,
    })

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [
        { sourceUrl: 'http://chatgpt.com/backend-api/estuary/content?id=unsafe' },
        { sourceUrl: 'https://example.com/image.png' },
        { sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=not-image' },
        { sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=good' },
      ],
    })

    expect(fetchImage).toHaveBeenCalledTimes(2)
    expect(records).toHaveLength(1)
    expect(attachments.map(attachment => attachment.status)).toEqual(['error', 'error', 'error', 'ready'])
    expect(attachments[0].error).toBe('不支持的图片来源')
    expect(attachments[2].error).toBe('远端内容不是图片')
  })

  it('stores an image read inside the page without downloading it, by its real type', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    const fetchImage = vi.fn()
    const service = createImageAttachmentService({ fetchImage, repository: createFakeRepository(records), newId: () => 'attachment-1', now: () => 5 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [{ sourceUrl: 'blob:https://chatgpt.com/e4aebf64', alt: 'Generated image 1', data: btoa(String.fromCharCode(...png)), mimeType: 'image/jpeg' }],
    })

    expect(fetchImage).not.toHaveBeenCalled()
    expect(attachments).toEqual([expect.objectContaining({ id: 'attachment-1', status: 'ready', mimeType: 'image/png', size: png.length, fileName: 'chatgpt-image-1.png', alt: 'Generated image 1' })])
    expect(records).toHaveLength(1)
    expect(new Uint8Array(await records[0].blob.arrayBuffer())).toEqual(png)
  })

  it('refuses page image bytes that are not an image, or from another site', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    let next = 0
    const service = createImageAttachmentService({ fetchImage: vi.fn(), repository: createFakeRepository(records), newId: () => `attachment-${++next}`, now: () => 5 })

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [
        { sourceUrl: 'blob:https://chatgpt.com/svg', data: btoa('<svg onload="alert(1)"/>'), mimeType: 'image/png' },
        { sourceUrl: 'blob:https://evil.example/png', data: btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) },
        { sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file', data: btoa(String.fromCharCode(0xff, 0xd8, 0xff)) },
      ],
    })

    expect(attachments.map(attachment => [attachment.status, attachment.error])).toEqual([
      ['error', '页面发来的内容不是图片'],
      ['error', '不支持的图片来源'],
      ['error', '不支持的图片来源'],
    ])
    expect(records).toHaveLength(0)
  })

  it('downloads Grok images and stores Qwen images read in the page', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    let next = 0
    const fetchImage = vi.fn(async () => new Response(new Blob(['grok-jpeg'], { type: 'image/jpeg' }), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    const service = createImageAttachmentService({ fetchImage, repository: createFakeRepository(records), newId: () => `attachment-${++next}`, now: () => 5 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [
        { sourceUrl: 'https://assets.grok.com/users/u1/generated/g1/image.jpg', alt: 'Generated image' },
        { sourceUrl: 'https://cdn.qwenlm.ai/output/u1/image_gen/g1/1.png', data: btoa(String.fromCharCode(...png)) },
        { sourceUrl: 'https://cdn.qwenlm.ai/output/u1/image_gen/g1/2.png' },
      ],
    })

    expect(fetchImage).toHaveBeenCalledTimes(1)
    expect(fetchImage).toHaveBeenCalledWith('https://assets.grok.com/users/u1/generated/g1/image.jpg', expect.objectContaining({ credentials: 'include' }))
    expect(attachments.map(attachment => [attachment.status, attachment.fileName ?? attachment.error])).toEqual([
      ['ready', 'grok-image-1.jpg'],
      ['ready', 'qwen-image-2.png'],
      // Not read in the page: OpenTeam does not download from Qwen's CDN itself.
      ['error', '不支持的图片来源'],
    ])
  })

  it('rejects active image formats such as SVG', async () => {
    const records: ImageAttachmentBlobRecord[] = []
    const service = createImageAttachmentService({
      fetchImage: vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      })),
      repository: createFakeRepository(records),
      newId: () => 'attachment-svg',
      now: () => 123,
    })

    const attachments = await service.captureReplyImages({
      chatId: 'chat-1',
      messageId: 'msg-1',
      images: [{ sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=svg' }],
    })

    expect(records).toHaveLength(0)
    expect(attachments).toMatchObject([{
      status: 'error',
      error: '远端内容不是图片',
    }])
  })
})

function createFakeRepository(records: ImageAttachmentBlobRecord[]): ImageAttachmentRepository {
  return {
    put: vi.fn(async record => {
      records.push(record)
    }),
    get: vi.fn(async id => records.find(record => record.id === id)),
    deleteByIds: vi.fn(async ids => {
      for (const id of ids) {
        const index = records.findIndex(record => record.id === id)
        if (index >= 0) records.splice(index, 1)
      }
    }),
    deleteByMessageIds: vi.fn(async () => undefined),
    deleteByChatId: vi.fn(async () => undefined),
    deleteOrphans: vi.fn(async () => undefined),
  }
}
