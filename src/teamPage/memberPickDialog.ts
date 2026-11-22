// 添加成员 → 让 AI 按任务挑 (src/group/memberPicker.ts): the user writes the task (it starts as the
// latest thing they asked in the group), ticks the models members may use and where roles come from,
// and an API model suggests who to add. The suggestions are listed to keep, drop or give another
// model, then added as members. The second way, 新成员自己认领, adds AIs and lets them claim
// positions as 按任务组队 does (onClaim).
import { latestTaskText, MEMBER_PICK_MAX, memberPickModelKey, memberPickModels, memberPickPlanners, type MemberPick, type MemberPickSource } from '../group/memberPicker'
import type { GroupChat, GroupRole, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface MemberPickDialogDependencies {
  getStore(): OpenTeamStore
  getCurrentChat(): GroupChat | undefined
  // A command whose answer is needed; throws why it failed.
  request(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // 新成员自己认领: the models and how many of each, for the task.
  onClaim?(task: string, members: Array<{ key: string; count: number }>): Promise<void>
  onAdded?(count: number): void
  onClose?(): void
}

let openDialog: { close(): void } | undefined

export function currentMemberPickDialog(): { close(): void } | undefined {
  return openDialog
}

export function openMemberPickDialog(deps: MemberPickDialogDependencies): { close(): void } {
  openDialog?.close()
  const store = deps.getStore()
  const chat = deps.getCurrentChat()
  const en = normalizeLanguage(store.settings.language) === 'en'
  const t = (zh: string, en_: string): string => en ? en_ : zh
  const models = memberPickModels(store)
  const planners = memberPickPlanners(store)
  const members = chat ? chat.roleIds.map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role)) : []
  // Ticked to start with: the models the group's members use, or the default site.
  const used = new Set(members.map(role => memberPickModelKey(role, store.settings.defaultChatSite)))
  if (used.size === 0) used.add(`site:${store.settings.defaultChatSite}`)
  const ticked = new Set(models.filter(model => used.has(model.key)).map(model => model.key))
  const counts = new Map<string, number>()
  let mode: 'list' | 'claim' = 'list'
  let picks: Array<MemberPick & { keep: boolean }> = []
  let busy = false

  const backdrop = element('div', 'modal-backdrop member-pick-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog member-pick-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'member-pick-title')
  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('让 AI 按任务挑成员', 'Let AI pick members for a task'))
  title.id = 'member-pick-title'
  heading.append(title, element('p', 'tiny', t('写下要做的事，选好能用的模型，AI 会参考群里已有的成员，建议再加哪些人。', 'Describe the task and choose the models to use; the AI looks at who is already in the group and suggests whom to add.')))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const form = element('form', 'team-setup-form member-pick-form')
  form.noValidate = true
  form.addEventListener('submit', event => {
    event.preventDefault()
    void (mode === 'list' ? suggest() : claim())
  })

  const taskField = field(t('要做的事', 'The task'), 'member-pick-task')
  const task = element('textarea')
  task.id = 'member-pick-task'
  task.rows = 3
  task.value = chat ? latestTaskText(store, chat) : ''
  task.placeholder = t('例如：给记账小程序加上预算提醒', 'For example: add budget reminders to the budgeting app')
  taskField.append(task)

  const modeField = choiceField(t('怎么挑', 'How'), 'member-pick-mode', [
    ['list', t('AI 出名单，你确认', 'AI suggests, you confirm'), t('一个 API 模型给出建议名单，你看过再加入。', 'An API model suggests a list; you add what you keep.')],
    ['claim', t('新成员自己认领职位', 'New members claim positions'), t('先把选的 AI 加进群，它们参考任务和现有成员，各自认领职位，和「按任务组队」一样。', 'The AIs you choose join first, then each claims a position from the task and the members there, as in "Form a team for a task".')],
  ], 'list', value => {
    mode = value as 'list' | 'claim'
    render()
  })

  const plannerField = field(t('由哪个模型来挑', 'Model that picks'), 'member-pick-planner')
  const planner = element('select')
  planner.id = 'member-pick-planner'
  for (const model of planners) planner.append(new Option(`${model.name} · ${model.modelName}`, model.id))
  plannerField.append(planner)
  if (planners.length === 0) plannerField.append(element('p', 'tiny member-pick-warning', t('需要一个 API 模型来挑：请先在「设置 → 模型」里添加。也可以选「新成员自己认领职位」，不需要 API。', 'Picking needs an API model: add one under Settings → Models first. "New members claim positions" works without one.')))

  const modelsField = field(t('能用的模型', 'Models members may use'))
  const modelList = element('div', 'team-setup-members member-pick-models')
  modelsField.append(modelList)

  const sourceField = choiceField(t('角色从哪里来', 'Where roles come from'), 'member-pick-source', [
    ['library-first', t('先从角色库挑，不够再新写', 'Library first, new ones if needed'), t('优先用你的自定义角色和内置角色，没有合适的再按任务写新角色。', 'Your custom and built-in roles first; new ones written for the task when none fits.')],
    ['new', t('全部按任务新写', 'All written for the task'), t('每个角色都按这次任务写名称和人设。', 'Every role gets a name and persona written for this task.')],
    ['library-only', t('只从角色库挑', 'Only from the library'), t('只在自定义角色和内置角色里选。', 'Only your custom and built-in roles.')],
  ], 'library-first')

  const countField = field(t('最多几位', 'At most'), 'member-pick-count')
  const count = element('select')
  count.id = 'member-pick-count'
  count.append(new Option(t('由 AI 决定', 'Up to the AI'), ''))
  for (let index = 1; index <= MEMBER_PICK_MAX; index += 1) count.append(new Option(t(`${index} 位`, String(index)), String(index)))
  countField.append(count)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const status = element('p', 'tiny member-pick-status')
  status.setAttribute('role', 'status')
  const actions = element('div', 'team-setup-actions')
  const submit = element('button', 'btn btn-primary')
  submit.type = 'submit'
  actions.append(submit)

  const results = element('div', 'member-pick-results')
  results.setAttribute('aria-live', 'polite')
  const resultActions = element('div', 'team-setup-actions member-pick-add-row')
  const add = element('button', 'btn btn-primary', t('加入选中的成员', 'Add the ticked members'))
  add.type = 'button'
  add.addEventListener('click', () => void addPicks())
  resultActions.append(add)

  form.append(taskField, modeField, plannerField, modelsField, sourceField, countField, error, status, actions, results, resultActions)
  dialog.append(header, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  const controller = { close }
  openDialog = controller
  render()
  task.focus()
  return controller

  function render(): void {
    const listing = mode === 'list'
    plannerField.hidden = !listing
    sourceField.hidden = !listing
    countField.hidden = !listing
    submit.textContent = listing ? t('让 AI 挑', 'Ask the AI') : t('加入并让它们认领', 'Add them and let them claim')
    submit.disabled = busy
    modelsField.querySelector('label, .field-label')!.textContent = listing ? t('能用的模型', 'Models members may use') : t('加入哪些 AI，各几位', 'Which AIs join, and how many')
    renderModels()
    results.hidden = !listing || picks.length === 0
    resultActions.hidden = results.hidden
    renderPicks()
  }

  function renderModels(): void {
    modelList.replaceChildren(...models.map(model => {
      const row = element('div', 'team-setup-member')
      const badge = element('span', `role-site-badge ${model.key.startsWith('site:') ? `site-pill-${model.key.slice(5)}` : 'site-pill-external'}`, model.label)
      if (mode === 'list') {
        const box = element('input')
        box.type = 'checkbox'
        box.checked = ticked.has(model.key)
        box.setAttribute('aria-label', model.label)
        box.addEventListener('change', () => {
          if (box.checked) ticked.add(model.key)
          else ticked.delete(model.key)
          row.classList.toggle('team-setup-member-selected', box.checked)
        })
        row.classList.toggle('team-setup-member-selected', box.checked)
        const label = element('label', 'member-pick-model')
        label.append(box, badge)
        row.append(label)
        return row
      }
      const value = element('span', 'team-setup-count', String(counts.get(model.key) ?? 0))
      const step = (delta: number, text: string) => {
        const node = element('button', 'icon-btn team-setup-step')
        node.type = 'button'
        node.setAttribute('aria-label', text)
        node.append(createIcon(delta > 0 ? 'plus' : 'minus'))
        node.addEventListener('click', () => {
          const total = [...counts.values()].reduce((sum, item) => sum + item, 0)
          const next = Math.max(0, Math.min(5, (counts.get(model.key) ?? 0) + delta))
          if (delta > 0 && total >= MEMBER_PICK_MAX) return
          counts.set(model.key, next)
          value.textContent = String(next)
          row.classList.toggle('team-setup-member-selected', next > 0)
        })
        return node
      }
      row.classList.toggle('team-setup-member-selected', (counts.get(model.key) ?? 0) > 0)
      const stepper = element('div', 'team-setup-stepper')
      stepper.append(step(-1, t(`少一个 ${model.label}`, `One fewer ${model.label}`)), value, step(1, t(`多一个 ${model.label}`, `One more ${model.label}`)))
      row.append(badge, stepper)
      return row
    }))
  }

  function renderPicks(): void {
    const options = models.filter(model => ticked.has(model.key))
    results.replaceChildren(...(picks.length ? [element('h3', 'member-pick-results-title', t(`建议加入 ${picks.length} 位`, `${picks.length} suggested`))] : []), ...picks.map((pick, index) => {
      const row = element('div', 'select-row member-pick-row')
      const box = element('input')
      box.type = 'checkbox'
      box.checked = pick.keep
      box.addEventListener('change', () => { pick.keep = box.checked })
      const content = element('span', 'select-row-content')
      const name = element('strong', '', pick.name)
      name.id = `member-pick-name-${index}`
      box.setAttribute('aria-labelledby', name.id)
      content.append(name)
      content.append(element('span', 'member-pick-kind', pick.kind === 'library' ? t('角色库', 'Library') : t('新写', 'New')))
      if (pick.why) content.append(element('div', 'template-description member-pick-why', pick.why))
      if (pick.description) content.append(element('div', 'template-description', pick.description))
      const model = element('select', 'member-pick-row-model')
      model.setAttribute('aria-label', t(`「${pick.name}」用的模型`, `Model for "${pick.name}"`))
      for (const option of options.some(item => item.key === pick.model) ? options : [...models.filter(item => item.key === pick.model), ...options]) model.append(new Option(option.label, option.key))
      model.value = pick.model
      model.addEventListener('change', () => { pick.model = model.value })
      row.append(box, content, model)
      return row
    }))
  }

  async function suggest(): Promise<void> {
    if (busy || !chat) return
    const text = task.value.trim()
    if (!text) return fail(t('先写下要做的事', 'Describe the task first'), task)
    if (planners.length === 0) return fail(t('需要一个 API 模型来挑：请先在「设置 → 模型」里添加。', 'Picking needs an API model: add one under Settings → Models first.'))
    if (ticked.size === 0) return fail(t('至少勾选一个能用的模型', 'Tick at least one model'))
    busy = true
    error.textContent = ''
    status.textContent = t('正在请 AI 挑选…', 'Asking the AI…')
    render()
    try {
      const answer = await deps.request('GROUP_MEMBERS_SUGGEST', {
        chatId: chat.id,
        task: text,
        plannerModelId: planner.value,
        models: models.filter(model => ticked.has(model.key)).map(model => model.key),
        source: (form.querySelector<HTMLInputElement>('input[name="member-pick-source"]:checked')?.value ?? 'library-first') as MemberPickSource,
        ...(count.value ? { count: Number(count.value) } : {}),
      })
      if (typeof answer.error === 'string') throw new Error(answer.error)
      picks = (Array.isArray(answer.picks) ? answer.picks as MemberPick[] : []).map(pick => ({ ...pick, keep: true }))
      status.textContent = t(`${String(answer.planner ?? '')} 建议了 ${picks.length} 位，看过后加入。`, `${String(answer.planner ?? '')} suggested ${picks.length}; add those you keep.`)
    } catch (caught) {
      status.textContent = ''
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy = false
      if (openDialog === controller) render()
    }
  }

  async function addPicks(): Promise<void> {
    if (busy || !chat) return
    const kept = picks.filter(pick => pick.keep)
    if (kept.length === 0) return fail(t('至少勾选一位', 'Tick at least one'))
    const items = kept.map(pick => {
      const model = pick.model.startsWith('external:') ? { modelSource: 'external', externalModelId: pick.model.slice('external:'.length) } : { modelSource: 'site', chatSite: pick.model.slice('site:'.length) }
      return pick.kind === 'library'
        ? { source: 'library', roleTemplateId: pick.templateId, ...model }
        : { source: 'temporary', name: pick.name, ...(pick.description ? { description: pick.description } : {}), systemPrompt: pick.systemPrompt, ...model }
    })
    busy = true
    try {
      await deps.runCommand('GROUP_ROLES_CREATE_BATCH', { chatId: chat.id, items })
      close()
      deps.onAdded?.(kept.length)
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy = false
    }
  }

  async function claim(): Promise<void> {
    if (busy || !chat || !deps.onClaim) return
    const text = task.value.trim()
    if (!text) return fail(t('先写下要做的事', 'Describe the task first'), task)
    const chosen = [...counts.entries()].filter(([, value]) => value > 0).map(([key, value]) => ({ key, count: value }))
    if (chosen.length === 0) return fail(t('至少加一位 AI', 'Add at least one AI'))
    busy = true
    error.textContent = ''
    render()
    try {
      await deps.onClaim(text, chosen)
      close()
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy = false
      if (openDialog === controller) render()
    }
  }

  function fail(message: string, focus?: HTMLElement): void {
    error.textContent = message
    focus?.focus()
  }

  function field(label: string, forId?: string): HTMLElement {
    const wrapper = element('div', 'field')
    const labelEl = forId ? element('label', '', label) : element('p', 'field-label', label)
    if (forId && labelEl instanceof HTMLLabelElement) labelEl.htmlFor = forId
    wrapper.append(labelEl)
    return wrapper
  }

  function choiceField(label: string, name: string, choices: Array<[string, string, string]>, checked: string, onChange?: (value: string) => void): HTMLElement {
    const wrapper = element('fieldset', 'field member-pick-choices')
    wrapper.append(element('legend', 'field-label', label))
    for (const [value, text, hint] of choices) {
      const option = element('label', 'member-pick-choice')
      const input = element('input')
      input.type = 'radio'
      input.name = name
      input.value = value
      input.checked = value === checked
      input.addEventListener('change', () => { if (input.checked) onChange?.(value) })
      const words = element('span', 'member-pick-choice-text')
      words.append(element('span', 'member-pick-choice-label', text), element('span', 'tiny', hint))
      option.append(input, words)
      wrapper.append(option)
    }
    return wrapper
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    if (openDialog === controller) openDialog = undefined
    deps.onClose?.()
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
