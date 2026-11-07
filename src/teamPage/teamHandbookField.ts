import { MAX_HANDBOOK_CHARS, MAX_HANDBOOK_FILE_BYTES } from '../group/teamHandbooks'
import type { OpenTeamStore } from '../group/types'

export function createTeamHandbookField(deps: {
  getStore(): OpenTeamStore
  runCommand(type: string, payload: Record<string, unknown>): Promise<void>
  t(zh: string, en: string): string
  showError(message: string): void
}) {
  const field = document.createElement('div')
  field.className = 'field'
  const label = document.createElement('label')
  label.htmlFor = 'team-setup-handbook'
  label.textContent = deps.t('执行手册（选填）', 'Execution handbook (optional)')
  const controls = document.createElement('div')
  controls.className = 'team-handbook-controls'
  const select = document.createElement('select')
  select.id = 'team-setup-handbook'
  const selectWrap = document.createElement('div')
  selectWrap.className = 'team-handbook-select'
  selectWrap.append(select)
  const upload = document.createElement('button')
  upload.type = 'button'
  upload.className = 'btn btn-small'
  upload.textContent = deps.t('导入技能手册', 'Import a skill handbook')
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.md,.txt,text/markdown,text/plain'
  input.hidden = true
  const hint = document.createElement('p')
  hint.className = 'tiny'
  hint.textContent = deps.t('可导入 PWA 等技能的 Markdown 或文本手册。选中后随每次任务发送给成员，请只放入愿意分享的内容。', 'Import a Markdown or text handbook, such as PWA skills. The selected content accompanies every task to members; include only what you want to share.')
  const preview = document.createElement('details')
  preview.className = 'team-handbook-preview'
  const summary = document.createElement('summary')
  summary.textContent = deps.t('查看手册内容', 'Preview handbook')
  const text = document.createElement('pre')
  preview.append(summary, text)
  controls.append(selectWrap, upload)
  field.append(label, controls, input, hint, preview)

  function renderPreview(): void {
    const handbook = deps.getStore().settings.teamHandbooks?.find(item => item.id === select.value)
    preview.hidden = !handbook
    text.textContent = handbook?.content ?? ''
  }

  function renderOptions(selected = ''): void {
    const none = new Option(deps.t('不使用手册', 'No handbook'), '')
    select.replaceChildren(none, ...(deps.getStore().settings.teamHandbooks ?? []).map(item => new Option(item.name, item.id)))
    select.value = selected
    renderPreview()
  }

  select.addEventListener('change', renderPreview)
  upload.addEventListener('click', () => input.click())
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    upload.disabled = true
    try {
      if (!/\.(md|txt)$/i.test(file.name) || file.size > MAX_HANDBOOK_FILE_BYTES) throw new Error(deps.t('请选择 1 MB 以内的 Markdown 或文本手册', 'Choose a Markdown or text handbook of at most 1 MB'))
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error(deps.t('读取手册失败', 'Could not read the handbook')))
        reader.onabort = () => reject(new Error(deps.t('读取手册已取消', 'Reading the handbook was cancelled')))
        reader.readAsText(file)
      })
      if (!content.trim() || content.length > MAX_HANDBOOK_CHARS || content.includes('\0')) throw new Error(deps.t('手册内容不能为空，且不能超过 256K 字符', 'The handbook must contain text and be at most 256K characters'))
      const name = file.name.replace(/\.(md|txt)$/i, '').trim()
      await deps.runCommand('GROUP_TEAM_HANDBOOK_SAVE', { name, content })
      const saved = deps.getStore().settings.teamHandbooks?.find(item => item.name === name)
      if (!saved) throw new Error(deps.t('手册尚未保存，请重试', 'The handbook was not saved; try again'))
      renderOptions(saved.id)
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : String(error))
    } finally {
      input.value = ''
      upload.disabled = false
    }
  })
  renderOptions()
  return { field, payload: () => select.value ? { handbookId: select.value } : {} }
}
