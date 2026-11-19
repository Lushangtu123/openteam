// The window where the user chooses a web member's backup: an API model that answers for it when its
// AI site cannot take a prompt (a pop-up, a login page, a site error). See
// src/background/memberBackup.ts.
import type { ExternalModelConfig, GroupRole, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface RoleBackupDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // Puts the focus back where the window was opened from.
  onClose?(): void
}

// The API models a member can have as its backup, in the order the models window lists them.
export function backupModelChoices(store: OpenTeamStore): ExternalModelConfig[] {
  const byId = store.settings.externalModelsById
  const ordered = [...(store.settings.externalModelOrder ?? []), ...Object.keys(byId)]
  return [...new Set(ordered)]
    .map(id => byId[id])
    .filter((model): model is ExternalModelConfig => Boolean(model) && model.format !== 'local-agent' && Boolean(model.apiKey?.trim()))
}

// The member's menu item: its backup, or none.
export function backupModelLabel(store: OpenTeamStore, role: GroupRole, english: boolean): string {
  const model = role.backupModelId ? backupModelChoices(store).find(item => item.id === role.backupModelId) : undefined
  const name = model?.name ?? (english ? 'none' : '无')
  return english ? `Backup model: ${name}` : `备用模型：${name}`
}

export function openRoleBackupDialog(role: GroupRole, deps: RoleBackupDialogDependencies): void {
  document.querySelector('.role-backup-modal')?.remove()
  const store = deps.getStore()
  const english = normalizeLanguage(store.settings.language) === 'en'
  const t = (zh: string, en: string): string => english ? en : zh
  const choices = backupModelChoices(store)
  const current = role.backupModelId && choices.some(model => model.id === role.backupModelId) ? role.backupModelId : ''
  let busy = false

  const backdrop = element('div', 'modal-backdrop role-backup-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog role-backup-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'role-backup-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t(`${role.name} 的备用模型`, `${role.name}'s backup model`))
  title.id = 'role-backup-title'
  heading.append(title, element('p', 'tiny', t(
    '网页用不了时（有弹窗、没登录、网站报错），由这个 API 模型替它回答。回复仍算它的，标着「备用」。',
    'When its web page cannot take a prompt (a pop-up, not signed in, a site error), this API model answers for it. The reply is still its own, marked Backup.',
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const form = element('form', 'team-setup-form role-backup-form')
  form.noValidate = true
  const field = element('div', 'field')
  const label = element('label', '', t('备用模型', 'Backup model'))
  label.htmlFor = 'role-backup-model'
  const select = element('select')
  select.id = 'role-backup-model'
  select.append(option('', t('不设置', 'None')))
  for (const model of choices) select.append(option(model.id, model.name))
  select.value = current
  field.append(label, select)
  if (choices.length === 0) {
    field.append(element('p', 'tiny', t('还没有可用的 API 模型。先在 设置 → 模型 里添加一个。', 'No API model yet. Add one under Settings → Models first.')))
  }

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const cancel = element('button', 'btn', t('取消', 'Cancel'))
  cancel.type = 'button'
  cancel.addEventListener('click', () => close())
  const submit = element('button', 'btn btn-primary', t('保存', 'Save'))
  submit.type = 'submit'
  actions.append(cancel, submit)
  form.append(field, error, actions)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void save()
  })

  dialog.append(header, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  select.focus()

  async function save(): Promise<void> {
    if (busy) return
    if (select.value === current) return close()
    busy = true
    submit.disabled = true
    error.textContent = ''
    try {
      await deps.runCommand('GROUP_ROLE_BACKUP_SET', { roleId: role.id, backupModelId: select.value })
      close()
    } catch (caught) {
      busy = false
      submit.disabled = false
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    }
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

function option(value: string, text: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = text
  return node
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
