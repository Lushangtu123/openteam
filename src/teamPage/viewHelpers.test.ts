// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { paintRoleAvatar, plainPreview, roleAvatarSignature, roleToneClass } from './viewHelpers'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('view helpers', () => {
  it('previews a reply without its Markdown marks, on one line', () => {
    expect(plainPreview('**共识**\n- 双方都选 Go\n\n## 分歧\n> 引用')).toBe('共识 双方都选 Go 分歧 引用')
    expect(plainPreview('2 * 3 = 6，a_b 保持原样')).toBe('2 * 3 = 6，a_b 保持原样')
  })
})

describe('member avatars', () => {
  it('draws the name\'s first character on the name\'s colour when nothing is chosen', () => {
    const avatar = document.createElement('div')
    paintRoleAvatar(avatar, 'role-avatar', { name: 'deepseek' })
    expect(avatar.className).toBe(`role-avatar ${roleToneClass('deepseek')}`)
    expect(avatar.textContent).toBe('D')
  })

  it('draws the chosen colour and text, two characters a little smaller', () => {
    const avatar = document.createElement('div')
    paintRoleAvatar(avatar, 'message-avatar', { name: '产品经理', avatarColor: 'tone-3', avatarText: '小D' })
    expect(avatar.className).toBe('message-avatar role-tone-3')
    expect(avatar.querySelector('.avatar-text-pair')?.textContent).toBe('小D')

    paintRoleAvatar(avatar, 'message-avatar', { name: '产品经理', avatarColor: 'tone-3', avatarText: 'P' })
    expect(avatar.innerHTML).toBe('P')
  })

  it('draws a stored picture in place of the colour, and never a link to another site', () => {
    const avatar = document.createElement('div')
    paintRoleAvatar(avatar, 'mention-avatar', { name: '小D', avatarColor: 'tone-1', avatarImage: PNG })
    expect(avatar.className).toBe('mention-avatar has-avatar-image')
    const image = avatar.querySelector('img')!
    expect(image.getAttribute('src')).toBe(PNG)
    expect(image.alt).toBe('')

    paintRoleAvatar(avatar, 'mention-avatar', { name: '小D', avatarImage: 'https://tracker.test/a.png' })
    expect(avatar.querySelector('img')).toBeNull()
    expect(avatar.textContent).toBe('小')
  })

  it('draws a member that has left from the name its messages carry', () => {
    const avatar = document.createElement('div')
    paintRoleAvatar(avatar, 'message-avatar', undefined, 'kimi')
    expect(avatar.className).toBe(`message-avatar ${roleToneClass('kimi')}`)
    expect(avatar.textContent).toBe('K')
  })

  it('changes its signature when the avatar changes', () => {
    const before = roleAvatarSignature({ name: 'a', avatarColor: 'tone-1' })
    expect(roleAvatarSignature({ name: 'a', avatarColor: 'tone-2' })).not.toBe(before)
    expect(roleAvatarSignature({ name: 'a', avatarColor: 'tone-1', avatarImage: PNG })).not.toBe(before)
    expect(roleAvatarSignature(undefined)).toBe('')
  })
})
