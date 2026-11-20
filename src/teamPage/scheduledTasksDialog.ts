// The window for a group's 定时任务 (src/group/scheduledTasks.ts): the group's tasks with their
// times, next and last runs, and a form to add or change one. The background runs them.
import { defaultMentionTargetForMessage } from '../group/mentionParser'
import { describeSchedule, MAX_SCHEDULED_TASKS_PER_CHAT, nextSlotAfter, SCHEDULED_TASK_CONTENT_MAX } from '../group/scheduledTasks'
import type { OpenTeamStore, ScheduledTask } from '../group/types'
import { destinationKindName, readDestinationInput, RESULT_DESTINATION_KINDS, type ResultDestination, type ResultDestinationKind } from '../group/resultDestinations'
import { requestHostAccess } from '../shared/hostAccess'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface ScheduledTasksDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  now?(): number
  confirm?(message: string): boolean
  // Asks the browser to let OpenTeam reach a destination's site (from a click).
  requestHostAccess?(url: string): Promise<boolean>
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
  let drawnList = ''
  let drawnDestinations = ''
  let drawnChoices = ''
  const requestAccess = deps.requestHostAccess ?? (url => requestHostAccess(url))

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
    '到点时，这条消息会像你亲手发的一样发到群里，@ 谁就由谁回答。要问网页成员时，OpenTeam 会打开并切到它所在窗口的前面（不会把 Chrome 提到其他程序前面），网页成员要在显示着的页面里才能回答。浏览器关着时错过的那次，12 小时内重新打开会补发一次。',
    'At its time the message is sent to the group as if you typed it; whoever it @mentions answers. When it asks web members, OpenTeam opens and becomes the shown tab of its window (Chrome is not brought in front of other apps): web members answer only from a page that is shown. A time missed while the browser was closed is sent once if the browser comes back within 12 hours.',
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

  // 把结果发出去: where the round's result goes once it is answered (src/group/resultDestinations.ts).
  const destinationField = element('div', 'field scheduled-task-destination-field')
  const destinationLabel = element('label', '', t('答完后把结果发送到', 'When answered, send the result to'))
  destinationLabel.htmlFor = 'scheduled-task-destination'
  const destinationChoice = element('select')
  destinationChoice.id = 'scheduled-task-destination'
  destinationField.append(destinationLabel, destinationChoice, element('p', 'tiny', t(
    '群里有汇总时发汇总，没有就发每位成员的回答。推送地址在窗口下方添加。',
    'The summary when the group sums rounds up, otherwise every member\'s answer. Add destinations at the bottom of this window.',
  )))

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
  form.append(formTitle, contentField, daysField, timeField, destinationField, error, actions)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void save()
  })
  content.addEventListener('input', () => {
    error.textContent = ''
    renderMentionHint()
  })

  // The destinations: added here, tested, deleted.
  const destinationsSection = element('section', 'result-destinations')
  destinationsSection.append(element('h3', 'scheduled-task-form-title', t('推送地址', 'Destinations')), element('p', 'tiny', t(
    '飞书、企业微信、钉钉：在群里添加「自定义机器人」；Slack、Discord：在频道里添加 Incoming Webhook / Webhook，把地址填在这里。Telegram：填机器人的 Token（在 BotFather 里拿到）和群组或频道的 Chat ID。也可以填任何 https 地址，收到的是 JSON。地址和 Token 就是钥匙，备份时和 API Key 一样默认不导出。',
    'Feishu, WeCom, DingTalk: add a custom robot to the group; Slack, Discord: add an incoming webhook to the channel, and enter its address here. Telegram: enter the bot\'s token (from BotFather) and the group or channel\'s chat ID. Or any https address, which receives JSON. Addresses and tokens are keys: backups leave them out, as they do API keys.',
  )))
  const destinationList = element('ul', 'result-destination-list')
  const destinationEmpty = element('p', 'tiny result-destination-empty', t('还没有推送地址。', 'No destination yet.'))
  const destinationForm = element('form', 'team-setup-form result-destination-form')
  destinationForm.noValidate = true
  const kindChoice = element('select')
  kindChoice.id = 'result-destination-kind'
  kindChoice.setAttribute('aria-label', t('推送方式', 'Kind'))
  for (const kind of RESULT_DESTINATION_KINDS) kindChoice.append(new Option(destinationKindName(kind, english()), kind))
  const nameInput = element('input')
  nameInput.id = 'result-destination-name'
  nameInput.placeholder = t('名称（可选）', 'Name (optional)')
  nameInput.setAttribute('aria-label', t('名称', 'Name'))
  const urlInput = element('input')
  urlInput.id = 'result-destination-url'
  urlInput.type = 'url'
  urlInput.setAttribute('aria-label', t('Webhook 地址', 'Webhook address'))
  const secretWrap = element('div', 'result-destination-secret')
  const secretInput = element('input')
  secretInput.id = 'result-destination-secret'
  secretInput.placeholder = t('签名密钥（开了签名校验 / 加签才填）', 'Signing secret (only if signing is on)')
  secretInput.setAttribute('aria-label', t('签名密钥', 'Signing secret'))
  secretWrap.append(secretInput)
  // Telegram: the group or channel the bot posts to.
  const chatWrap = element('div', 'result-destination-chat')
  const chatInput = element('input')
  chatInput.id = 'result-destination-chat-id'
  chatInput.placeholder = t('Chat ID，如 -1001234567890 或 @频道名', 'Chat ID, such as -1001234567890 or @channel')
  chatInput.setAttribute('aria-label', 'Chat ID')
  chatWrap.append(chatInput)
  const addDestination = element('button', 'btn', t('添加推送地址', 'Add destination'))
  addDestination.type = 'submit'
  destinationForm.append(kindChoice, nameInput, urlInput, secretWrap, chatWrap, addDestination)
  const destinationStatus = element('p', 'tiny result-destination-status')
  destinationStatus.setAttribute('role', 'status')
  destinationsSection.append(destinationList, destinationEmpty, destinationForm, destinationStatus)
  kindChoice.addEventListener('change', showKindFields)
  destinationForm.addEventListener('submit', event => {
    event.preventDefault()
    void addNewDestination()
  })
  showKindFields()

  dialog.append(header, list, empty, form, destinationsSection)
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
    // Drawn again only when the tasks or what they read as changed: the page redraws on every store
    // update, and a list built anew each time flashes and loses the focus on its buttons.
    const listKey = JSON.stringify([english(), tasks, busy, Math.floor(now() / 60_000)])
    if (listKey !== drawnList) {
      drawnList = listKey
      list.replaceChildren(...tasks.map(renderTask))
    }
    list.hidden = tasks.length === 0
    empty.hidden = tasks.length > 0
    renderDestinations()
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
    const meta = element('p', 'tiny scheduled-task-meta', [nextRunText(task), lastRunText(task), deliveryText(task)].filter(Boolean).join(english() ? ' · ' : '　'))
    if (task.lastRun?.status === 'failed' || (task.destinationId && task.lastRun?.delivery?.status === 'failed')) meta.classList.add('scheduled-task-failed')
    item.append(meta)
    const buttons = element('div', 'scheduled-task-actions')
    buttons.append(
      action(task, 'run', t('立即运行', 'Run now'), 'retry', () => command('GROUP_SCHEDULED_TASK_RUN', { chatId, taskId: task.id })),
      action(task, 'edit', t('编辑', 'Edit'), 'edit', () => startEditing(task)),
      action(task, 'toggle', task.enabled ? t('停用', 'Switch off') : t('启用', 'Switch on'), undefined, () => command('GROUP_SCHEDULED_TASK_SAVE', { chatId, taskId: task.id, task: { content: task.content, days: task.days, time: task.time, enabled: !task.enabled, ...(task.destinationId ? { destinationId: task.destinationId } : {}) } })),
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

  // Where the task's result goes, and how the last one went.
  function deliveryText(task: ScheduledTask): string {
    if (!task.destinationId) return ''
    const current = destinations().find(item => item.id === task.destinationId)
    const delivery = task.lastRun?.delivery
    const name = delivery?.destination ?? current?.name ?? ''
    if (delivery?.status === 'sent') return t(`结果已发送到「${name}」`, `Result sent to "${name}"`)
    if (delivery?.status === 'failed') return t(`结果没发到「${name}」：${delivery.detail ?? ''}`, `Result not sent to "${name}": ${delivery.detail ?? ''}`)
    if (delivery?.status === 'sending') return t(`正在把结果发到「${name}」`, `Sending the result to "${name}"`)
    return current ? t(`结果会发到「${current.name}」`, `Result goes to "${current.name}"`) : ''
  }

  function destinations(): ResultDestination[] {
    return deps.getStore().settings.resultDestinations ?? []
  }

  // The list, and the task form's choices, drawn again only when the destinations changed.
  function renderDestinations(): void {
    const all = destinations()
    const key = JSON.stringify([english(), all.map(item => [item.id, item.name, item.kind, Boolean(item.url)])])
    if (key !== drawnChoices) {
      drawnChoices = key
      const chosen = destinationChoice.value
      destinationChoice.replaceChildren(new Option(t('不发送', 'Nowhere'), ''), ...all.map(item => new Option(`${item.name}${t(`（${destinationKindName(item.kind, false)}）`, ` (${destinationKindName(item.kind, true)})`)}`, item.id)))
      destinationChoice.value = all.some(item => item.id === chosen) ? chosen : ''
    }
    if (key === drawnDestinations) return
    drawnDestinations = key
    destinationList.replaceChildren(...all.map(destinationRow))
    destinationList.hidden = all.length === 0
    destinationEmpty.hidden = all.length > 0
  }

  function destinationRow(destination: ResultDestination): HTMLLIElement {
    const item = element('li', 'result-destination')
    const text = element('div', 'result-destination-text')
    text.append(element('span', 'result-destination-name', destination.name), element('span', 'tiny', `${destinationKindName(destination.kind, english())}${destination.chatId ? ` · ${destination.chatId}` : ''}`))
    if (!destination.url) text.append(element('span', 'tiny scheduled-task-failed', t('没有地址（从不含 Key 的备份恢复），请删掉后重新添加', 'No address (restored from a backup without keys); delete it and add it again')))
    const test = element('button', 'btn btn-ghost btn-small', t('测试', 'Test'))
    test.type = 'button'
    test.dataset.destinationAction = 'test'
    test.disabled = !destination.url
    test.setAttribute('aria-label', t(`测试：${destination.name}`, `Test: ${destination.name}`))
    test.addEventListener('click', () => void testDestination(destination))
    const remove = element('button', 'btn btn-ghost btn-small', t('删除', 'Delete'))
    remove.type = 'button'
    remove.dataset.destinationAction = 'delete'
    remove.setAttribute('aria-label', t(`删除：${destination.name}`, `Delete: ${destination.name}`))
    remove.addEventListener('click', () => {
      if (!confirm(t(`删除推送地址「${destination.name}」吗？用它的定时任务将不再发送结果。`, `Delete the destination "${destination.name}"? Tasks using it will send their results nowhere.`))) return
      void destinationCommand('RESULT_DESTINATION_DELETE', { destinationId: destination.id }, t('已删除。', 'Deleted.'))
    })
    item.append(text, test, remove)
    return item
  }

  function showKindFields(): void {
    const kind = kindChoice.value as ResultDestinationKind
    secretWrap.hidden = kind !== 'feishu' && kind !== 'dingtalk'
    chatWrap.hidden = kind !== 'telegram'
    urlInput.type = kind === 'telegram' ? 'text' : 'url'
    urlInput.setAttribute('aria-label', kind === 'telegram' ? 'Bot Token' : t('Webhook 地址', 'Webhook address'))
    urlInput.placeholder = {
      feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
      wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
      dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=…',
      slack: 'https://hooks.slack.com/services/…',
      discord: 'https://discord.com/api/webhooks/…',
      telegram: t('Bot Token，如 123456789:AA…', 'Bot token, such as 123456789:AA…'),
      webhook: 'https://…',
    }[kind]
  }

  async function addNewDestination(): Promise<void> {
    let destination: ReturnType<typeof readDestinationInput>
    try {
      destination = readDestinationInput({ kind: kindChoice.value, name: nameInput.value, url: urlInput.value, secret: secretInput.value, chatId: chatInput.value })
    } catch (caught) {
      destinationStatus.textContent = caught instanceof Error ? caught.message : String(caught)
      urlInput.focus()
      return
    }
    if (!await allowed(destination.url)) return
    const added = await destinationCommand('RESULT_DESTINATION_ADD', { destination }, t('已添加。可以点「测试」看看能不能收到。', 'Added. Click Test to see whether it arrives.'))
    if (!added) return
    nameInput.value = ''
    urlInput.value = ''
    secretInput.value = ''
    chatInput.value = ''
  }

  async function testDestination(destination: ResultDestination): Promise<void> {
    if (!await allowed(destination.url)) return
    await destinationCommand('RESULT_DESTINATION_TEST', { destinationId: destination.id }, t(`测试消息已发到「${destination.name}」，去那里看看收到没有。`, `A test message was sent to "${destination.name}"; see whether it arrived.`))
  }

  // The browser asks the user to let OpenTeam reach the site, the first time.
  async function allowed(url: string): Promise<boolean> {
    if (await requestAccess(url)) return true
    const host = new URL(url).hostname
    destinationStatus.textContent = t(`需要你允许 OpenTeam 访问 ${host}，才能往这里推送。`, `OpenTeam needs your permission to reach ${host} to send there.`)
    return false
  }

  async function destinationCommand(type: string, payload: Record<string, unknown>, done: string): Promise<boolean> {
    destinationStatus.textContent = t('处理中…', 'Working…')
    try {
      await deps.runCommand(type, payload)
      destinationStatus.textContent = done
      return true
    } catch (caught) {
      destinationStatus.textContent = caught instanceof Error ? caught.message : String(caught)
      return false
    } finally {
      if (openDialog === controller) render()
    }
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
    destinationChoice.value = ''
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
    renderDestinations()
    destinationChoice.value = destinations().some(item => item.id === task.destinationId) ? task.destinationId! : ''
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
      task: { content: content.value.trim(), days, time: time.value, enabled: editing ? editing.enabled : true, ...(destinationChoice.value ? { destinationId: destinationChoice.value } : {}) },
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
