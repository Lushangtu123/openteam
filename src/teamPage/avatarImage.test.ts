import { describe, expect, it, vi } from 'vitest'
import { ROLE_AVATAR_IMAGE_MAX_LENGTH, ROLE_AVATAR_IMAGE_SIZE } from '../group/roleProfile'
import { AvatarImageError, centerSquare, describeAvatarImageProblem, encodeWithinLimit, readAvatarImage } from './avatarImage'

const url = (length: number) => `data:image/webp;base64,${'A'.repeat(length)}`

describe('avatar pictures', () => {
  it('uses the centred square of the picture', () => {
    expect(centerSquare(400, 300)).toEqual({ x: 50, y: 0, size: 300 })
    expect(centerSquare(120, 301)).toEqual({ x: 0, y: 90, size: 120 })
  })

  it('takes the first encoding that fits, from full size and quality down', () => {
    const encode = vi.fn((size: number, quality: number) => url(size === ROLE_AVATAR_IMAGE_SIZE && quality > 0.6 ? ROLE_AVATAR_IMAGE_MAX_LENGTH : 4000))
    expect(encodeWithinLimit(encode)).toBe(url(4000))
    expect(encode.mock.calls).toEqual([[ROLE_AVATAR_IMAGE_SIZE, 0.86], [ROLE_AVATAR_IMAGE_SIZE, 0.72], [ROLE_AVATAR_IMAGE_SIZE, 0.56]])
  })

  it('gives up on a picture that never fits, or that the browser cannot encode', () => {
    expect(encodeWithinLimit(() => url(ROLE_AVATAR_IMAGE_MAX_LENGTH))).toBeUndefined()
    expect(encodeWithinLimit(() => 'data:,')).toBeUndefined()
  })

  it('refuses other kinds of file and very large files before opening them', async () => {
    await expect(readAvatarImage(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))).rejects.toMatchObject({ problem: 'type' })
    const huge = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 })
    await expect(readAvatarImage(huge)).rejects.toBeInstanceOf(AvatarImageError)
    await expect(readAvatarImage(huge)).rejects.toMatchObject({ problem: 'too-large' })
  })

  it('explains each problem in both languages', () => {
    expect(describeAvatarImageProblem('type', false)).toBe('请选择 PNG、JPG、WebP 或 GIF 图片')
    expect(describeAvatarImageProblem('too-detailed', true)).toBe('This picture stays too large even when shrunk; choose a simpler one')
  })
})
