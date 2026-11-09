// Turns a picture the user chose into a small square avatar: the centred square of the picture, drawn
// at ROLE_AVATAR_IMAGE_SIZE and encoded as WebP, smaller and plainer until it fits the store's limit.
import { isStorableAvatarImage, ROLE_AVATAR_IMAGE_MAX_LENGTH, ROLE_AVATAR_IMAGE_SIZE } from '../group/roleProfile'

// Larger files are refused before they are decoded.
export const AVATAR_SOURCE_MAX_BYTES = 10 * 1024 * 1024
export const AVATAR_SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export type AvatarImageProblem = 'type' | 'too-large' | 'unreadable' | 'too-detailed'

export class AvatarImageError extends Error {
  constructor(readonly problem: AvatarImageProblem) {
    super(problem)
  }
}

export function centerSquare(width: number, height: number): { x: number; y: number; size: number } {
  const size = Math.max(0, Math.min(width, height))
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size }
}

// The first encoding that the store accepts, from the full size and quality down.
export function encodeWithinLimit(encode: (size: number, quality: number) => string, limit = ROLE_AVATAR_IMAGE_MAX_LENGTH): string | undefined {
  for (const size of [ROLE_AVATAR_IMAGE_SIZE, 72, 48]) {
    for (const quality of [0.86, 0.72, 0.56, 0.4]) {
      const url = encode(size, quality)
      if (url.length <= limit && isStorableAvatarImage(url)) return url
    }
  }
  return undefined
}

export async function readAvatarImage(file: File): Promise<string> {
  if (!AVATAR_SOURCE_TYPES.includes(file.type)) throw new AvatarImageError('type')
  if (file.size > AVATAR_SOURCE_MAX_BYTES) throw new AvatarImageError('too-large')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AvatarImageError('unreadable')
  }
  try {
    const crop = centerSquare(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context || crop.size === 0) throw new AvatarImageError('unreadable')
    const url = encodeWithinLimit((size, quality) => {
      canvas.width = size
      canvas.height = size
      context.clearRect(0, 0, size, size)
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size)
      return canvas.toDataURL('image/webp', quality)
    })
    if (!url) throw new AvatarImageError('too-detailed')
    return url
  } finally {
    bitmap.close()
  }
}

export function describeAvatarImageProblem(problem: AvatarImageProblem, english: boolean): string {
  switch (problem) {
    case 'type': return english ? 'Choose a PNG, JPEG, WebP or GIF picture' : '请选择 PNG、JPG、WebP 或 GIF 图片'
    case 'too-large': return english ? 'The picture is larger than 10 MB; choose a smaller one' : '图片超过 10 MB，请换一张小一点的'
    case 'unreadable': return english ? 'This picture could not be opened; choose another' : '这张图片打不开，请换一张'
    case 'too-detailed': return english ? 'This picture stays too large even when shrunk; choose a simpler one' : '这张图片缩小后仍然太大，请换一张简单些的'
  }
}
