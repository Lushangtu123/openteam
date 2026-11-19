// The window for a group's 定时任务 (src/group/scheduledTasks.ts): the group's tasks with their
// times, next and last runs, and a form to add or change one. The background runs them.
import { defaultMentionTargetForMessage } from '../group/mentionParser'
import { describeSchedule, MAX_SCHEDULED_TASKS_PER_CHAT, nextSlotAfter, SCHEDULED_TASK_CONTENT_MAX } from '../group/scheduledTasks'
import type { OpenTeamStore, ScheduledTask } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface ScheduledTasksDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  now?(): number
  confirm?(message: string): boolean
  // Puts the focus back where the window was opened from.
  onClose?(): void
}

export interface ScheduledTasksDialog {
  // Draws the list again, from the latest store.
  refresh(): void
  close(): void
}

// Monday first, as a week is read; the values are Date.getDay().
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const ZH_DAY = ['日', '一', '二', '三', '四', '五', '六']
const EN_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

let openDialog: ScheduledTasksDialog | undefined

// The open window, if any, so a store update can redraw it.
export function currentScheduledTasksDialog(): ScheduledTasksDialog | undefined {
  return openDialog
}

export function openScheduledTasksDialog(chatId: string, deps: ScheduledTasksDialogDependencies): ScheduledTasksDialog {
  openDialog?.close()
  const now = deps.now ?? (() => Date.now())
  const confirm = deps.confirm ?? (message => window.confirm(message))
  const english = () => normalizeLanguage(deps.getStore().settings.language) === 'en'
  const t = (zh: string, en: string): string => english() ? en : zh
  // The task being changed, or undefined while adding one.
  let editingId: string | undefined
  let busy = false

  const backdrop = element('div', 'modal-backdrop scheduled-tasks-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog scheduled-tasks-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'scheduled-tasks-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2')
  title.id = 'scheduled-tasks-title'
  heading.append(title, element('p', 'tiny', t(
    '到点时，这条消息会像你亲手发的一样发到群里，@ 谁就由谁回答。OpenTeam 没打开时会在后台打开；浏览器关着时错过的那次，12 小时内重新打开会补发一次。',
    'At its time the message is sent to the group as if you typed it; whoever it @mentions answers. OpenTeam opens in the background if it is not open; a time missed while the browser was closed is sent once if the browser comes back within 12 hours.',
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const list = element('ul', 'scheduled-task-list')
  const empty = element('p', 'scheduled-task-empty')
  empty.setAttribute('role', 'status')

  const form = element('form', 'team-setup-form scheduled-task-form')
  form.noValidate = true
  const formTitle = element('h3', 'scheduled-task-form-title')
  const contentField = element('div', 'field')
  const contentLabel = element('label', '', t('到点时发的消息', 'Message to send'))
  contentLabel.htmlFor = 'scheduled-task-content'
  const content = element('textarea')
  content.id = 'scheduled-task-content'
  content.rows = 3
  content.maxLength = SCHEDULED_TASK_CONTENT_MAX
  content.placeholder = t('例如：@所有人 各自总结今天 AI 领域最重要的三条新闻', 'For example: @everyone each sum up today\'s three most important AI news items')
  const mentionHint = element('p', 'tiny scheduled-task-hint')
  mentionHint.id = 'scheduled-task-content-hint'
  content.setAttribute('aria-describedby', mentionHint.id)
  contentField.append(contentLabel, content, mentionHint)

  const daysField = element('fieldset', 'field scheduled-task-days')
  daysField.append(element('legend', '', t('每周哪几天', 'Days of the week')))
  const dayRow = element('div', 'scheduled-task-day-row')
  const dayBoxes = WEEK.map(day => {
    const label = element('label', 'scheduled-task-day')
    const box = element('input')
    box.type = 'checkbox'
    box.value = String(day)
    box.setAttribute('aria-label', t(`星期${ZH_DAY[day]}`, EN_DAY[day]))
    label.append(box, element('span', '', t(ZH_DAY[day], EN_DAY[day])))
    dayRow.append(label)
    return box
  })
  daysField.append(dayRow)

  const timeField = element('div', 'field scheduled-task-time')
  const timeLabel = element('label', '', t('时间', 'Time'))
  timeLabel.htmlFor = 'scheduled-task-time'
  const time = element('input')
  time.id = 'scheduled-task-time'
  time.type = 'time'
  time.required = true
  timeField.append(timeLabel, time)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const cancel = element('button', 'btn')
  cancel.type = 'button'
  cancel.addEventListener('click', () => {
    if (editingId) startAdding()
    else close()
  })
  const submit = element('button', 'btn btn-primary')
  submit.type = 'submit'
  actions.append(cancel, submit)
  form.append(formTitle, contentField, daysField, timeField, error, actions)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void save()
  })
  content.addEventListener('input', () => {
    error.textContent = ''
    renderMentionHint()
  })

  dialog.append(header, list, empty, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)

  const controller: ScheduledTasksDialog = { refresh: render, close }
  openDialog = controller
  startAdding()
  render()
  content.focus()
  return controller

  function chat() {
    return deps.getStore().chatsById[chatId]
  }

  function render(): void {
    const current = chat()
    if (!current) return close()
    title.textContent = t(`「${current.name}」的定时任务`, `Scheduled tasks for "${current.name}"`)
    const tasks = current.scheduledTasks ?? []
    list.replaceChildren(...tasks.map(renderTask))
    list.hidden = tasks.length === 0
    empty.hidden = tasks.length > 0
    empty.textContent = t('还没有定时任务。在下面写好消息、选好时间就能添加。', 'No scheduled task yet. Write a message and pick a time below to add one.')
    const full = !editingId && tasks.length >= MAX_SCHEDULED_TASKS_PER_CHAT
    submit.disabled = busy || full
    if (full) error.textContent = t(`一个群聊最多 ${MAX_SCHEDULED_TASKS_PER_CHAT} 个定时任务`, `A group can have at most ${MAX_SCHEDULED_TASKS_PER_CHAT} scheduled tasks`)
    renderMentionHint()
  }

  function renderTask(task: ScheduledTask): HTMLLIElement {
    const item = element('li', `scheduled-task${task.enabled ? '' : ' is-off'}`)
    item.dataset.scheduledTask = task.id
    const top = element('div', 'scheduled-task-top')
    top.append(element('span', 'scheduled-task-when', describeSchedule(task.days, task.time, english())))
    if (!task.enabled) top.append(element('span', 'scheduled-task-badge', t('已停用', 'Off')))
    item.append(top, element('p', 'scheduled-task-content', task.content))
    const meta = element('p', 'tiny scheduled-task-meta', [nextRunText(task), lastRunText(task)].filter(Boolean).join(english() ? ' · ' : '　'))
    if (task.lastRun?.status === 'failed') meta.classList.add('scheduled-task-failed')
    item.append(meta)
    const buttons = element('div', 'scheduled-task-actions')
    buttons.append(
      action(task, 'run', t('立即运行', 'Run now'), 'retry', () => command('GROUP_SCHEDULED_TASK_RUN', { chatId, taskId: task.id })),
      action(task, 'edit', t('编辑', 'Edit'), 'edit', () => startEditing(task)),
      action(task, 'toggle', task.enabled ? t('停用', 'Switch off') : t('启用', 'Switch on'), undefined, () => command('GROUP_SCHEDULED_TASK_SAVE', { chatId, taskId: task.id, task: { content: task.content, days: task.days, time: task.time, enabled: !task.enabled } })),
      action(task, 'delete', t('删除', 'Delete'), 'trash', () => {
        if (!confirm(t('确定删除这个定时任务吗？', 'Delete this scheduled task?'))) return
        if (editingId === task.id) startAdding()
        void command('GROUP_SCHEDULED_TASK_DELETE', { chatId, taskId: task.id })
      }),
    )
    item.append(buttons)
    return item
  }

  function action(task: ScheduledTask, name: string, label: string, icon: Parameters<typeof createIcon>[0] | undefined, run: () => unknown): HTMLButtonElement {
    const button = element('button', 'btn btn-ghost btn-small scheduled-task-action')
    button.type = 'button'
    button.dataset.scheduledAction = name
    if (icon) button.append(createIcon(icon))
    button.append(element('span', '', label))
    button.setAttribute('aria-label', `${label}${english() ? ': ' : '：'}${describeSchedule(task.days, task.time, english())}`)
    button.addEventListener('click', () => void run())
    return button
  }

  function nextRunText(task: ScheduledTask): string {
    if (!task.enabled) return ''
    const next = nextSlotAfter(task, now())
    return next === undefined ? '' : t(`下次：${formatTime(next)}`, `Next: ${formatTime(next)}`)
  }

  function lastRunText(task: ScheduledTask): string {
    const run = task.lastRun
    if (!run) return ''
    const when = formatTime(run.at)
    if (run.status === 'sent') return run.catchUp ? t(`上次：${when} 补发`, `Last: ${when}, sent late`) : t(`上次：${when} 已发出`, `Last: ${when}, sent`)
    if (run.status === 'skipped') return t(`上次：${when} 跳过（错过超过 12 小时）`, `Last: ${when}, skipped (missed by over 12 hours)`)
    return t(`上次：${when} 没发出：${run.detail ?? ''}`, `Last: ${when}, not sent: ${run.detail ?? ''}`)
  }

  // A message without @ in a group that answers only @mentions is just recorded; say so before it is saved.
  function renderMentionHint(): void {
    const current = chat()
    const text = content.value.trim()
    const recordsOnly = Boolean(current && text && !text.includes('@') && defaultMentionTargetForMessage(text, current) === 'none')
    mentionHint.textContent = recordsOnly
      ? t('这条消息没有 @ 任何成员，这个群里只会记下，不会有人回答。写上 @所有人 或 @成员。', 'This message @mentions no one, so in this group it is only recorded and nobody answers. Add @everyone or a member.')
      : t('和在输入框里一样：@所有人 让大家都回答，@成员 只问他。', 'As in the message box: @everyone asks all, @member asks one.')
    mentionHint.classList.toggle('scheduled-task-warning', recordsOnly)
  }

  function startAdding(): void {
    editingId = undefined
    formTitle.textContent = t('添加定时任务', 'Add a scheduled task')
    submit.textContent = t('添加', 'Add')
    cancel.textContent = t('关闭', 'Close')
    content.value = ''
    for (const box of dayBoxes) box.checked = box.value === '1'
    time.value = '09:00'
    error.textContent = ''
    render()
  }

  function startEditing(task: ScheduledTask): void {
    editingId = task.id
    formTitle.textContent = t('修改定时任务', 'Change the scheduled task')
    submit.textContent = t('保存', 'Save')
    cancel.textContent = t('取消修改', 'Cancel')
    content.value = task.content
    for (const box of dayBoxes) box.checked = task.days.includes(Number(box.value))
    time.value = task.time
    error.textContent = ''
    render()
    content.focus()
  }

  async function save(): Promise<void> {
    if (busy) return
    const days = dayBoxes.filter(box => box.checked).map(box => Number(box.value))
    if (!content.value.trim()) return fail(t('写下到点时要发的消息', 'Write the message to send'), content)
    if (days.length === 0) return fail(t('至少选一天', 'Pick at least one day'), dayBoxes[0])
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) return fail(t('选一个时间', 'Pick a time'), time)
    const editing = editingId ? chat()?.scheduledTasks?.find(task => task.id === editingId) : undefined
    const sent = await command('GROUP_SCHEDULED_TASK_SAVE', {
      chatId,
      ...(editing ? { taskId: editing.id } : {}),
      task: { content: content.value.trim(), days, time: time.value, enabled: editing ? editing.enabled : true },
    })
    if (sent) startAdding()
  }

  async function command(type: string, payload: Record<string, unknown>): Promise<boolean> {
    busy = true
    error.textContent = ''
    render()
    try {
      await deps.runCommand(type, payload)
      return true
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
      return false
    } finally {
      busy = false
      if (openDialog === controller) render()
    }
  }

  function fail(message: string, field: HTMLElement): void {
    error.textContent = message
    field.focus()
  }

  function formatTime(value: number): string {
    return new Date(value).toLocaleString(english() ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    if (openDialog === controller) openDialog = undefined
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
