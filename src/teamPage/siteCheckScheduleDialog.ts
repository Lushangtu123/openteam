// The window for 定时自检 (src/group/siteCheckSchedule.ts), from the settings: whether it runs, on
// which days at what time, where the sites that need attention are sent, how the last run went, and
// 立即运行. It looks like a group's 定时任务 window, whose destinations it uses.
import { describeSchedule, nextSlotAfter } from '../group/scheduledTasks'
import { chatSiteLabel } from '../group/chatSites'
import { destinationKindName } from '../group/resultDestinations'
import type { SiteCheckSchedule } from '../group/siteCheckSchedule'
import type { OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface SiteCheckScheduleDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  now?(): number
  // Puts the focus back where the window was opened from.
  onClose?(): void
}

export interface SiteCheckScheduleDialog {
  refresh(): void
  close(): void
}

// Monday first, as a week is read; the values are Date.getDay().
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const ZH_DAY = ['日', '一', '二', '三', '四', '五', '六']
const EN_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DEFAULT_DAYS = [1, 2, 3, 4, 5, 6, 0]
const DEFAULT_TIME = '09:00'

let openDialog: SiteCheckScheduleDialog | undefined

export function currentSiteCheckScheduleDialog(): SiteCheckScheduleDialog | undefined {
  return openDialog
}

export function openSiteCheckScheduleDialog(deps: SiteCheckScheduleDialogDependencies): SiteCheckScheduleDialog {
  openDialog?.close()
  const now = deps.now ?? (() => Date.now())
  const english = () => normalizeLanguage(deps.getStore().settings.language) === 'en'
  const t = (zh: string, en: string): string => english() ? en : zh
  let busy = false
  let drawnChoices = ''
  let drawnStatus = ''

  const backdrop = element('div', 'modal-backdrop scheduled-tasks-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog scheduled-tasks-dialog site-check-schedule-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'site-check-schedule-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('定时自检', 'Scheduled site check'))
  title.id = 'site-check-schedule-title'
  heading.append(title, element('p', 'tiny', t(
    '到点时 OpenTeam 会打开并切到它所在窗口的前面，像点「开始检查」一样给每个网站发一句「只回复 OK」（用你的账号，各一条），查完回到你原来打开的群。都正常时删掉检查用的群；有网站要处理时保留它，并把这些网站发到你选的推送地址。都正常时不发。',
    'At its time OpenTeam opens and becomes the shown tab of its window, then asks every site to reply OK, as Start check does (one message on each, with your accounts), and goes back to the group you had open. When every site works the check\'s group is removed; when some need attention it is kept, and those sites go to the destination you choose. Nothing is sent when every site works.',
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const status = element('p', 'tiny scheduled-task-meta site-check-schedule-status')
  status.setAttribute('role', 'status')

  const form = element('form', 'team-setup-form scheduled-task-form')
  form.noValidate = true
  const enabledLabel = element('label', 'settings-checkbox site-check-schedule-enabled')
  const enabled = element('input')
  enabled.type = 'checkbox'
  enabled.id = 'site-check-schedule-enabled'
  enabledLabel.append(enabled, document.createTextNode(` ${t('按时自动检查', 'Check automatically')}`))

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
  timeLabel.htmlFor = 'site-check-schedule-time'
  const time = element('input')
  time.id = 'site-check-schedule-time'
  time.type = 'time'
  time.required = true
  timeField.append(timeLabel, time)

  const destinationField = element('div', 'field scheduled-task-destination-field')
  const destinationLabel = element('label', '', t('有网站要处理时发送到', 'When a site needs attention, send it to'))
  destinationLabel.htmlFor = 'site-check-schedule-destination'
  const destinationChoice = element('select')
  destinationChoice.id = 'site-check-schedule-destination'
  const destinationHint = element('p', 'tiny')
  destinationField.append(destinationLabel, destinationChoice, destinationHint)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const runNow = element('button', 'btn')
  runNow.type = 'button'
  runNow.append(createIcon('retry'), element('span', '', t('立即运行', 'Run now')))
  runNow.addEventListener('click', () => void command(runNow, 'SITE_CHECK_SCHEDULE_RUN'))
  const save = element('button', 'btn btn-primary', t('保存', 'Save'))
  save.type = 'submit'
  // Says the save worked, until something is changed again.
  const saved = element('p', 'site-check-schedule-saved')
  saved.setAttribute('role', 'status')
  saved.hidden = true
  actions.append(saved, runNow, save)
  form.append(enabledLabel, daysField, timeField, destinationField, error, actions)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void saveSchedule()
  })
  for (const input of [enabled, time, destinationChoice, ...dayBoxes]) {
    input.addEventListener('change', () => {
      error.textContent = ''
      showSaved(false)
    })
  }

  dialog.append(header, status, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)

  const controller: SiteCheckScheduleDialog = { refresh: render, close }
  openDialog = controller
  fillForm(schedule())
  render()
  enabled.focus()
  return controller

  function schedule(): SiteCheckSchedule | undefined {
    return deps.getStore().settings.siteCheckSchedule
  }

  function fillForm(current: SiteCheckSchedule | undefined): void {
    enabled.checked = current ? current.enabled : true
    const days = current?.days ?? DEFAULT_DAYS
    for (const box of dayBoxes) box.checked = days.includes(Number(box.value))
    time.value = current?.time ?? DEFAULT_TIME
    renderChoices()
    destinationChoice.value = current?.destinationId && [...destinationChoice.options].some(option => option.value === current.destinationId) ? current.destinationId : ''
  }

  function render(): void {
    renderChoices()
    const current = schedule()
    const key = JSON.stringify([english(), current, Math.floor(now() / 60_000)])
    if (key !== drawnStatus) {
      drawnStatus = key
      status.textContent = statusText(current)
      status.classList.toggle('scheduled-task-failed', current?.lastRun?.status === 'failed' || current?.lastRun?.status === 'problems' || current?.lastRun?.delivery?.status === 'failed')
    }
  }

  // The destinations, drawn again only when they changed.
  function renderChoices(): void {
    const all = deps.getStore().settings.resultDestinations ?? []
    const key = JSON.stringify([english(), all.map(item => [item.id, item.name, item.kind])])
    if (key === drawnChoices) return
    drawnChoices = key
    const chosen = destinationChoice.value
    destinationChoice.replaceChildren(new Option(t('不发送', 'Nowhere'), ''), ...all.map(item => new Option(`${item.name}${t(`（${destinationKindName(item.kind, false)}）`, ` (${destinationKindName(item.kind, true)})`)}`, item.id)))
    destinationChoice.value = all.some(item => item.id === chosen) ? chosen : ''
    destinationHint.textContent = all.length
      ? t('只发需要处理的网站和怎么处理。', 'Only the sites that need attention, and what to do.')
      : t('还没有推送地址：在任意群聊的「定时任务」窗口里添加。', 'No destination yet: add one in any group\'s Scheduled tasks window.')
  }

  function statusText(current: SiteCheckSchedule | undefined): string {
    if (!current) return t('还没有设置。', 'Not set yet.')
    const when = describeSchedule(current.days, current.time, english())
    const next = current.enabled ? nextSlotAfter(current, now()) : undefined
    const parts = [current.enabled ? (next === undefined ? when : t(`${when}，下次：${formatTime(next)}`, `${when}; next: ${formatTime(next)}`)) : t('已停用', 'Off')]
    const run = current.lastRun
    if (run) {
      const at = formatTime(run.at)
      if (run.status === 'ok') parts.push(t(`上次：${at} 全部正常`, `Last: ${at}, every site works`))
      else if (run.status === 'problems') {
        const sites = (run.problems ?? []).map(item => chatSiteLabel(item.site)).join(t('、', ', '))
        parts.push(t(`上次：${at} 要处理：${sites}（检查用的群已保留）`, `Last: ${at}, needs attention: ${sites} (the check's group was kept)`))
      } else if (run.status === 'skipped') parts.push(t(`上次：${at} 跳过（错过超过 12 小时）`, `Last: ${at}, skipped (missed by over 12 hours)`))
      else parts.push(t(`上次：${at} 没能检查：${run.detail ?? ''}`, `Last: ${at}, could not check: ${run.detail ?? ''}`))
      const delivery = run.delivery
      if (delivery?.status === 'sent') parts.push(t(`已发送到「${delivery.destination}」`, `Sent to "${delivery.destination}"`))
      else if (delivery?.status === 'failed') parts.push(t(`没发到「${delivery.destination}」：${delivery.detail ?? ''}`, `Not sent to "${delivery.destination}": ${delivery.detail ?? ''}`))
      else if (delivery?.status === 'sending') parts.push(t(`正在发到「${delivery.destination}」`, `Sending to "${delivery.destination}"`))
    }
    return parts.join(english() ? ' · ' : '　')
  }

  async function saveSchedule(): Promise<void> {
    const days = dayBoxes.filter(box => box.checked).map(box => Number(box.value))
    if (days.length === 0) {
      error.textContent = t('至少选一天', 'Pick at least one day')
      return
    }
    if (!time.value) {
      error.textContent = t('选一个时间', 'Pick a time')
      time.focus()
      return
    }
    showSaved(false)
    const done = await command(save, 'SITE_CHECK_SCHEDULE_SAVE', { schedule: { days, time: time.value, enabled: enabled.checked, ...(destinationChoice.value ? { destinationId: destinationChoice.value } : {}) } })
    if (done) {
      error.textContent = ''
      showSaved(true)
    }
  }

  function showSaved(shown: boolean): void {
    saved.hidden = !shown
    if (!shown) return saved.replaceChildren()
    const current = schedule()
    const next = current?.enabled ? nextSlotAfter(current, now()) : undefined
    const text = !current?.enabled
      ? t('已保存，定时自检已停用', 'Saved; the scheduled check is off')
      : next === undefined ? t('已保存', 'Saved') : t(`已保存，下次检查：${formatTime(next)}`, `Saved; next check: ${formatTime(next)}`)
    saved.replaceChildren(createIcon('check'), element('span', '', text))
  }

  // One command at a time. The buttons are not disabled meanwhile: a save takes a moment, and buttons
  // greyed out and back for it flash.
  async function command(button: HTMLButtonElement, type: string, payload?: Record<string, unknown>): Promise<boolean> {
    if (busy) return false
    busy = true
    try {
      await deps.runCommand(type, payload)
      return true
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
      return false
    } finally {
      busy = false
      button.focus()
    }
  }

  // As the 定时任务 window shows times.
  function formatTime(value: number): string {
    return new Date(value).toLocaleString(english() ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
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
