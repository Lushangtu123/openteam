import type { ReplyImageSource } from '../group/types'
import { bytesToBase64 } from '../shared/base64'
import type { ContentLogger } from './runtimeClient'

// Only the page that made a blob: URL can open it, so images a site shows through one are read
// here and sent with their bytes. Other images keep their https URL, which the background
// downloads itself.

export const MAX_PAGE_IMAGE_BYTES = 25 * 1024 * 1024
const PAGE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])

export async function materializeReplyImages(images: ReplyImageSource[] | undefined, log: ContentLogger, doc: Document = document): Promise<ReplyImageSource[] | undefined> {
  if (!images?.length) return images
  const result: ReplyImageSource[] = []
  for (const image of images) {
    if (image.data || !image.sourceUrl.startsWith('blob:')) {
      result.push(image)
      continue
    }
    try {
      const blob = await readPageImage(image.sourceUrl, doc)
      result.push({ ...image, data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type })
    } catch (error) {
      log.warn('reply-images:read-failed', { error: error instanceof Error ? error.message : String(error) })
      // Sent without its bytes, the image shows in the chat as one that could not be saved.
      result.push(image)
    }
  }
  return result
}

async function readPageImage(sourceUrl: string, doc: Document): Promise<Blob> {
  let blob: Blob | undefined
  try {
    blob = await (await fetch(sourceUrl)).blob()
  } catch {
    blob = await drawPageImage(sourceUrl, doc)
  }
  if (!blob) throw new Error('页面里的图片读不出来')
  if (!PAGE_IMAGE_TYPES.has(blob.type)) throw new Error(`页面里的图片格式不支持：${blob.type || '未知'}`)
  if (blob.size > MAX_PAGE_IMAGE_BYTES) throw new Error('图片超过 25 MB 上限')
  return blob
}

// If fetching the blob: URL is refused, the image already on screen is drawn into a canvas. A
// blob made by the page itself does not taint it.
async function drawPageImage(sourceUrl: string, doc: Document): Promise<Blob | undefined> {
  const image = [...doc.images].find(element => (element.currentSrc || element.src) === sourceUrl && element.complete && element.naturalWidth > 0)
  if (!image) return undefined
  const canvas = doc.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob ?? undefined), 'image/png'))
}
