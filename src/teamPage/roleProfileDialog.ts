// The window where the user renames a member and changes its avatar: a preset colour, up to two
// characters, or a picture. It changes this chat's member only, not the people library.
import {
  avatarTextProblem,
  avatarToneKey,
  chatRoleNames,
  describeRoleProfileProblem,
  roleAvatarTone,
  roleNameProblem,
  ROLE_AVATAR_TEXT_MAX_CHARACTERS,
  ROLE_AVATAR_TONE_COUNT,
} from '../group/roleProfile'
import type { GroupRole, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { AVATAR_SOURCE_TYPES, AvatarImageError, describeAvatarImageProblem, readAvatarImage } from './avatarImage'
import { getAvatarInitial } from './chatExperience'
import { createIcon } from './icons'
import { paintRoleAvatar } from './viewHelpers'

export interface RoleProfileDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // Puts the focus back where the window was opened from.
  onClose?(): void
  // Replaceable in tests, where pictures cannot be decoded.
  readImage?(file: File): Promise<string>
}

export function openRoleProfileDialog(role: GroupRole, deps: RoleProfileDialogDependencies): void {
  document.querySelector('.role-profile-modal')?.remove()
  const store = deps.getStore()
  const english = normalizeLanguage(store.settings.language) === 'en'
  const t = (zh: string, en: string): string => english ? en : zh
  const chat = store.chatsById[role.chatId]
  const otherNames = chat ? chatRoleNames(store, chat, role.id) : []
  const readImage = deps.readImage ?? readAvatarImage

  // What the window shows. Nothing is stored until the user saves.
  const draft = {
    name: role.name,
    avatarText: role.avatarText ?? '',
    avatarColor: avatarToneKey(roleAvatarTone(role)),
    avatarImage: role.avatarImage ?? '',
  }
  let colorChosen = false
  let busy = false

  const backdrop = element('div', 'modal-backdrop role-profile-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog role-profile-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'role-profile-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('编辑名字和头像', 'Edit name and avatar'))
  title.id = 'role-profile-title'
  heading.append(title, element('p', 'tiny', t('只改这个群聊里的成员，角色库里的不变。', 'Changes this chat\'s member only; the people library stays as it is.')))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const form = element('form', 'team-setup-form role-profile-form')
  form.noValidate = true

  // The avatar as it will look, beside the name.
  const identity = element('div', 'role-profile-identity')
  const preview = element('div')
  preview.setAttribute('aria-hidden', 'true')
  const nameField = element('div', 'field role-profile-name-field')
  const nameLabel = element('label', '', t('名字', 'Name'))
  nameLabel.htmlFor = 'role-profile-name'
  const nameInput = element('input')
  nameInput.id = 'role-profile-name'
  nameInput.type = 'text'
  nameInput.autocomplete = 'off'
  nameInput.spellcheck = false
  nameInput.value = role.name
  nameInput.setAttribute('aria-describedby', 'role-profile-name-hint')
  const nameHint = element('p', 'tiny', t('@ 它时用这个名字；它之前的消息也会显示新名字。', 'Mention it by this name; its earlier messages show the new name too.'))
  nameHint.id = 'role-profile-name-hint'
  nameField.append(nameLabel, nameInput, nameHint)
  identity.append(preview, nameField)

  const colorField = element('fieldset', 'field role-profile-colors')
  colorField.append(element('legend', '', t('头像颜色', 'Avatar colour')))
  const swatches = element('div', 'role-profile-swatches')
  for (let index = 0; index < ROLE_AVATAR_TONE_COUNT; index += 1) {
    const value = avatarToneKey(index)
    const swatch = element('label', 'role-profile-swatch')
    const radio = element('input')
    radio.type = 'radio'
    radio.name = 'role-profile-tone'
    radio.value = value
    radio.checked = value === draft.avatarColor
    radio.setAttribute('aria-label', t(`颜色 ${index + 1}`, `Colour ${index + 1}`))
    radio.addEventListener('change', () => {
      draft.avatarColor = value
      colorChosen = true
      renderPreview()
    })
    const chip = element('span', `role-avatar role-tone-${index} role-profile-swatch-chip`)
    chip.setAttribute('aria-hidden', 'true')
    chip.append(createIcon('check'))
    swatch.append(radio, chip)
    swatches.append(swatch)
  }
  colorField.append(swatches)

  const textField = element('div', 'field role-profile-text-field')
  const textLabel = element('label', '', t('头像文字（选填）', 'Avatar text (optional)'))
  textLabel.htmlFor = 'role-profile-text'
  const textInput = element('input')
  textInput.id = 'role-profile-text'
  textInput.type = 'text'
  textInput.autocomplete = 'off'
  textInput.spellcheck = false
  textInput.value = draft.avatarText
  textInput.setAttribute('aria-describedby', 'role-profile-text-hint')
  const textHint = element('p', 'tiny', t(`最多 ${ROLE_AVATAR_TEXT_MAX_CHARACTERS} 个字；留空就用名字的第一个字。`, `Up to ${ROLE_AVATAR_TEXT_MAX_CHARACTERS} characters; leave it empty to use the name's first character.`))
  textHint.id = 'role-profile-text-hint'
  textField.append(textLabel, textInput, textHint)

  const imageField = element('div', 'field role-profile-image-field')
  imageField.setAttribute('role', 'group')
  imageField.setAttribute('aria-labelledby', 'role-profile-image-label')
  imageField.setAttribute('aria-describedby', 'role-profile-image-hint')
  const imageLabel = element('span', 'role-profile-label', t('头像图片（选填）', 'Avatar picture (optional)'))
  imageLabel.id = 'role-profile-image-label'
  const imageActions = element('div', 'role-profile-image-actions')
  const uploadButton = element('button', 'btn btn-small role-profile-upload')
  uploadButton.type = 'button'
  const removeButton = element('button', 'btn btn-small btn-ghost role-profile-remove-image', t('移除图片', 'Remove the picture'))
  removeButton.type = 'button'
  const fileInput = element('input')
  fileInput.type = 'file'
  fileInput.accept = AVATAR_SOURCE_TYPES.join(',')
  fileInput.hidden = true
  imageActions.append(uploadButton, removeButton, fileInput)
  const imageHint = element('p', 'tiny', t('PNG、JPG、WebP 或 GIF，会裁成正方形、缩小后保存；有图片时头像显示图片。', 'PNG, JPEG, WebP or GIF; cropped to a square and shrunk before it is saved. A picture shows in place of the colour and text.'))
  imageHint.id = 'role-profile-image-hint'
  imageField.append(imageLabel, imageActions, imageHint)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const cancel = element('button', 'btn', t('取消', 'Cancel'))
  cancel.type = 'button'
  cancel.addEventListener('click', () => close())
  const submit = element('button', 'btn btn-primary', t('保存', 'Save'))
  submit.type = 'submit'
  actions.append(cancel, submit)
  form.append(identity, colorField, textField, imageField, error, actions)

  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value
    clearProblem(nameInput)
    renderPreview()
  })
  textInput.addEventListener('input', () => {
    draft.avatarText = textInput.value
    clearProblem(textInput)
    renderPreview()
  })
  uploadButton.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (file) void choosePicture(file)
  })
  removeButton.addEventListener('click', () => {
    draft.avatarImage = ''
    error.textContent = ''
    renderPreview()
    uploadButton.focus()
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    void save()
  })

  dialog.append(header, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  renderPreview()
  nameInput.focus()
  nameInput.select()

  function renderPreview(): void {
    const name = draft.name.trim() || role.name
    paintRoleAvatar(preview, 'role-avatar role-profile-preview', {
      name,
      avatarColor: draft.avatarColor,
      avatarText: draft.avatarText.trim() || undefined,
      avatarImage: draft.avatarImage || undefined,
    })
    textInput.placeholder = getAvatarInitial(name)
    uploadButton.textContent = draft.avatarImage ? t('换一张图片', 'Choose another picture') : t('上传图片', 'Upload a picture')
    removeButton.hidden = !draft.avatarImage
    submit.disabled = busy
    uploadButton.disabled = busy
  }

  async function choosePicture(file: File): Promise<void> {
    busy = true
    error.textContent = ''
    renderPreview()
    try {
      draft.avatarImage = await readImage(file)
    } catch (caught) {
      error.textContent = caught instanceof AvatarImageError ? describeAvatarImageProblem(caught.problem, english) : message(caught)
    } finally {
      busy = false
      renderPreview()
      uploadButton.focus()
    }
  }

  async function save(): Promise<void> {
    if (busy) return
    const name = draft.name.trim()
    // An unchanged name is kept even if another member shares it, as members added earlier may.
    const nameProblem = name === role.name ? undefined : roleNameProblem(name, otherNames)
    if (nameProblem) return showProblem(nameInput, describeRoleProfileProblem(nameProblem, store.settings.language, name))
    const avatarText = draft.avatarText.trim()
    const textProblem = avatarText ? avatarTextProblem(avatarText) : undefined
    if (textProblem) return showProblem(textInput, describeRoleProfileProblem(`avatar-text-${textProblem}`, store.settings.language))

    const patch: Record<string, string> = {}
    if (name !== role.name) patch.name = name
    if (avatarText !== (role.avatarText ?? '')) patch.avatarText = avatarText
    if (draft.avatarImage !== (role.avatarImage ?? '')) patch.avatarImage = draft.avatarImage
    // The colour the window showed is kept, so a new name does not bring a different colour.
    if ((colorChosen || Object.keys(patch).length > 0) && draft.avatarColor !== role.avatarColor) patch.avatarColor = draft.avatarColor
    if (Object.keys(patch).length === 0) return close()

    busy = true
    renderPreview()
    try {
      await deps.runCommand('GROUP_ROLE_PROFILE_UPDATE', { roleId: role.id, patch })
      close()
    } catch (caught) {
      busy = false
      error.textContent = message(caught)
      renderPreview()
    }
  }

  function showProblem(input: HTMLInputElement, text: string): void {
    error.textContent = text
    input.setAttribute('aria-invalid', 'true')
    input.focus()
  }

  function clearProblem(input: HTMLInputElement): void {
    input.removeAttribute('aria-invalid')
    error.textContent = ''
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
