// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupRole, OpenTeamStore } from '../group/types'
import { AvatarImageError } from './avatarImage'
import { openRoleProfileDialog } from './roleProfileDialog'
import { TEAM_STYLESHEETS } from './teamStylesheets'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

afterEach(() => {
  document.body.replaceChildren()
})

function makeStore(language: 'zh-CN' | 'en' = 'zh-CN'): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = language
  const role = (id: string, name: string, chatSite: GroupRole['chatSite']): GroupRole => ({ id, chatId: 'c1', name, chatSite, status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 })
  store.rolesById = { r1: role('r1', 'DeepSeek', 'deepseek'), r2: role('r2', 'Kimi', 'kimi') }
  store.chatsById.c1 = { id: 'c1', name: '群', mode: 'collaborative', roleIds: ['r1', 'r2'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  return store
}

function open(store = makeStore(), roleId = 'r1', readImage?: (file: File) => Promise<string>) {
  const runCommand = vi.fn(async () => undefined)
  const onClose = vi.fn()
  openRoleProfileDialog(store.rolesById[roleId], { getStore: () => store, runCommand, onClose, ...(readImage ? { readImage } : {}) })
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const type = (selector: string, value: string) => {
    const input = $<HTMLInputElement>(selector)
    input.value = value
    input.dispatchEvent(new Event('input'))
  }
  const save = () => $<HTMLFormElement>('.role-profile-form').requestSubmit()
  return { store, runCommand, onClose, $, type, save }
}

describe('member name and avatar window', () => {
  it('opens on the member\'s name, focused, with its avatar and colour', () => {
    const { $ } = open()
    expect($('.role-profile-dialog').getAttribute('aria-labelledby')).toBe('role-profile-title')
    expect($('#role-profile-title').textContent).toBe('编辑名字和头像')
    expect(document.activeElement).toBe($('#role-profile-name'))
    expect($<HTMLInputElement>('#role-profile-name').value).toBe('DeepSeek')
    expect($('.role-profile-preview').textContent).toBe('D')
    expect(document.querySelectorAll('.role-profile-swatch input:checked')).toHaveLength(1)
    expect($('.role-profile-remove-image').hasAttribute('hidden')).toBe(true)
  })

  it('saves a new name with the colour it showed, so the colour stays', async () => {
    const { $, type, save, runCommand, onClose } = open()
    const shown = $<HTMLInputElement>('.role-profile-swatch input:checked').value
    type('#role-profile-name', ' 小D ')
    expect($('.role-profile-preview').textContent).toBe('小')
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_PROFILE_UPDATE', { roleId: 'r1', patch: { name: '小D', avatarColor: shown } }))
    await vi.waitFor(() => expect(document.querySelector('.role-profile-modal')).toBeNull())
    expect(onClose).toHaveBeenCalled()
  })

  it('names what is wrong with a name and keeps the window open', () => {
    const { $, type, save, runCommand } = open()
    type('#role-profile-name', '')
    save()
    expect($('.team-form-error').textContent).toBe('名字不能为空')
    expect($('#role-profile-name').getAttribute('aria-invalid')).toBe('true')
    type('#role-profile-name', 'kimi')
    expect($('#role-profile-name').hasAttribute('aria-invalid')).toBe(false)
    save()
    expect($('.team-form-error').textContent).toBe('这个群里已经有叫「kimi」的成员')
    type('#role-profile-name', '所有人')
    save()
    expect($('.team-form-error').textContent).toBe('「所有人」用来 @ 所有人或编排，请换一个名字')
    type('#role-profile-name', 'A B')
    save()
    expect($('.team-form-error').textContent).toBe('名字不能包含空格')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('speaks English when the page does', () => {
    const { $, type, save } = open(makeStore('en'))
    expect($('#role-profile-title').textContent).toBe('Edit name and avatar')
    expect($('.role-profile-upload').textContent).toBe('Upload a picture')
    expect($('.role-profile-swatch input').getAttribute('aria-label')).toBe('Colour 1')
    type('#role-profile-name', 'Kimi')
    save()
    expect($('.team-form-error').textContent).toBe('Another member here is already called "Kimi"')
  })

  it('saves a chosen colour and avatar text, and checks the text', async () => {
    const { $, type, save, runCommand } = open()
    const swatch = document.querySelectorAll<HTMLInputElement>('.role-profile-swatch input')[4]
    swatch.checked = true
    swatch.dispatchEvent(new Event('change'))
    type('#role-profile-text', '深度求索')
    save()
    expect($('.team-form-error').textContent).toBe('头像文字最多 2 个字')
    type('#role-profile-text', '深度')
    expect($('.role-profile-preview').className).toContain('role-tone-4')
    expect($('.role-profile-preview .avatar-text-pair').textContent).toBe('深度')
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_PROFILE_UPDATE', { roleId: 'r1', patch: { avatarText: '深度', avatarColor: 'tone-4' } }))
  })

  it('shrinks an uploaded picture, shows it, and can remove it again', async () => {
    const readImage = vi.fn(async () => PNG)
    const { $, save, runCommand } = open(makeStore(), 'r1', readImage)
    const input = $<HTMLInputElement>('.role-profile-image-actions input[type="file"]')
    const file = new File(['x'], 'me.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect($('.role-profile-preview img')?.getAttribute('src')).toBe(PNG))
    expect(readImage).toHaveBeenCalledWith(file)
    expect($('.role-profile-upload').textContent).toBe('换一张图片')
    expect($('.role-profile-remove-image').hasAttribute('hidden')).toBe(false)
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_PROFILE_UPDATE', { roleId: 'r1', patch: { avatarImage: PNG, avatarColor: expect.stringMatching(/^tone-\d$/) } }))
  })

  it('keeps the remove button off screen while it is hidden, though buttons are drawn as flex boxes', () => {
    const css = TEAM_STYLESHEETS.map(name => readFileSync(resolve(process.cwd(), 'public/styles', name), 'utf8')).join('\n')
    const at = css.indexOf('.role-profile-image-actions .btn[hidden]')
    expect(at).toBeGreaterThan(-1)
    expect(css.slice(at, css.indexOf('}', at))).toContain('display: none')
  })

  it('removes a stored picture', async () => {
    const store = makeStore()
    Object.assign(store.rolesById.r1, { avatarImage: PNG, avatarColor: 'tone-2' })
    const { $, save, runCommand } = open(store)
    expect($('.role-profile-preview img')).not.toBeNull()
    $<HTMLButtonElement>('.role-profile-remove-image').click()
    expect($('.role-profile-preview img')).toBeNull()
    expect(document.activeElement).toBe($('.role-profile-upload'))
    save()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_PROFILE_UPDATE', { roleId: 'r1', patch: { avatarImage: '' } }))
  })

  it('explains a picture it cannot use', async () => {
    const { $ } = open(makeStore(), 'r1', async () => { throw new AvatarImageError('type') })
    const input = $<HTMLInputElement>('.role-profile-image-actions input[type="file"]')
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.svg', { type: 'image/svg+xml' })] })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect($('.team-form-error').textContent).toBe('请选择 PNG、JPG、WebP 或 GIF 图片'))
  })

  it('closes without saving when nothing changed, on Cancel, or on Escape', async () => {
    const first = open()
    first.save()
    await Promise.resolve()
    expect(first.runCommand).not.toHaveBeenCalled()
    expect(document.querySelector('.role-profile-modal')).toBeNull()

    const second = open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.role-profile-modal')).toBeNull()
    expect(second.onClose).toHaveBeenCalled()
  })

  it('shows the error the store gives and lets the user try again', async () => {
    const { $, type, save, runCommand } = open()
    runCommand.mockRejectedValueOnce(new Error('找不到人员：r1'))
    type('#role-profile-name', '小D')
    save()
    await vi.waitFor(() => expect($('.team-form-error').textContent).toBe('找不到人员：r1'))
    expect($<HTMLButtonElement>('.team-setup-actions .btn-primary').disabled).toBe(false)
  })
})
