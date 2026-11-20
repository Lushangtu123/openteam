// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore, ScheduledTask } from '../group/types'
import type { ResultDestination } from '../group/resultDestinations'
import { currentScheduledTasksDialog, openScheduledTasksDialog } from './scheduledTasksDialog'

afterEach(() => {
  currentScheduledTasksDialog()?.close()
  document.body.innerHTML = ''
})

// Local times. 2026-11-16 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

function task(fields: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: 'sched-1', content: '@所有人 总结今天的新闻', days: [1, 3], time: '08:30', enabled: true, armedAt: 0, createdAt: 0, updatedAt: 0, ...fields }
}

function setup(tasks: ScheduledTask[] = [], chatFields: Record<string, unknown> = {}, options: { destinations?: ResultDestination[]; allow?: boolean } = {}) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  if (options.destinations) store.settings.resultDestinations = options.destinations
  const requestHostAccess = vi.fn(async (_url: string) => options.allow !== false)
  store.chatsById['chat-1'] = { id: 'chat-1', name: '早报', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, scheduledTasks: tasks, ...chatFields }
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const dialog = openScheduledTasksDialog('chat-1', { getStore: () => store, runCommand, now: () => at(16, 9), confirm: () => true, requestHostAccess })
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const content = () => q<HTMLTextAreaElement>('#scheduled-task-content')
  const days = () => [...document.querySelectorAll<HTMLInputElement>('.scheduled-task-day input')]
  const time = () => q<HTMLInputElement>('#scheduled-task-time')
  const submit = () => q<HTMLFormElement>('.scheduled-task-form').dispatchEvent(new Event('submit', { cancelable: true }))
  const button = (name: string) => q<HTMLButtonElement>(`[data-scheduled-action="${name}"]`)
  return { store, runCommand, dialog, content, days, time, submit, button, q, requestHostAccess }
}

describe('the scheduled tasks window', () => {
  it('lists the group\'s tasks with their days, next run and last run', () => {
    setup([task({ lastRun: { at: at(16, 8, 30), status: 'sent' } }), task({ id: 'sched-2', days: [5], time: '18:00', enabled: false, lastRun: { at: at(13, 18), status: 'failed', detail: '以下成员不可用' } })])
    const items = [...document.querySelectorAll('.scheduled-task')]
    expect(items).toHaveLength(2)
    expect(items[0].querySelector('.scheduled-task-when')?.textContent).toBe('每周一、三 08:30')
    expect(items[0].querySelector('.scheduled-task-meta')?.textContent).toMatch(/下次：.*上次：.*已发出/)
    expect(items[1].querySelector('.scheduled-task-badge')?.textContent).toBe('已停用')
    expect(items[1].querySelector('.scheduled-task-meta')?.textContent).toContain('没发出：以下成员不可用')
    expect(document.querySelector('#scheduled-tasks-title')?.textContent).toBe('「早报」的定时任务')
    expect(document.activeElement).toBe(document.querySelector('#scheduled-task-content'))
  })

  it('adds a task with the chosen days and time', async () => {
    const { runCommand, content, days, time, submit } = setup()
    content().value = ' @所有人 总结 '
    days().forEach(box => { box.checked = box.value === '1' || box.value === '0' })
    time().value = '07:45'
    submit()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', task: { content: '@所有人 总结', days: [1, 0], time: '07:45', enabled: true } }))
    await vi.waitFor(() => expect(content().value).toBe(''))
  })

  it('says what is missing instead of sending', () => {
    const { runCommand, content, days, submit } = setup()
    submit()
    expect(document.querySelector('.team-form-error')?.textContent).toBe('写下到点时要发的消息')
    content().value = '@所有人 总结'
    days().forEach(box => { box.checked = false })
    submit()
    expect(document.querySelector('.team-form-error')?.textContent).toBe('至少选一天')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('warns that a message without @ is only recorded in a group that answers @mentions only', () => {
    const { content } = setup()
    content().value = '总结今天的新闻'
    content().dispatchEvent(new Event('input'))
    expect(document.querySelector('#scheduled-task-content-hint')?.textContent).toContain('只会记下')
    content().value = '@所有人 总结'
    content().dispatchEvent(new Event('input'))
    expect(document.querySelector('#scheduled-task-content-hint')?.textContent).not.toContain('只会记下')
  })

  it('changes, switches off, runs now and deletes a task', async () => {
    const { runCommand, content, submit, button } = setup([task()])
    button('edit').click()
    expect(content().value).toBe('@所有人 总结今天的新闻')
    content().value = '@所有人 总结'
    submit()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'sched-1', task: { content: '@所有人 总结', days: [1, 3], time: '08:30', enabled: true } }))
    button('toggle').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_SCHEDULED_TASK_SAVE', { chatId: 'chat-1', taskId: 'sched-1', task: { content: '@所有人 总结今天的新闻', days: [1, 3], time: '08:30', enabled: false } }))
    button('run').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_SCHEDULED_TASK_RUN', { chatId: 'chat-1', taskId: 'sched-1' }))
    button('delete').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_SCHEDULED_TASK_DELETE', { chatId: 'chat-1', taskId: 'sched-1' }))
  })

  it('shows the error a command gives', async () => {
    const { runCommand, button } = setup([task()])
    runCommand.mockRejectedValueOnce(new Error('找不到这个定时任务'))
    button('run').click()
    await vi.waitFor(() => expect(document.querySelector('.team-form-error')?.textContent).toBe('找不到这个定时任务'))
  })

  it('keeps its list as it is when nothing in it changed, so it does not flash or lose focus', () => {
    const { store, dialog } = setup([task()])
    const item = document.querySelector('.scheduled-task')
    store.chatsById['chat-1'].updatedAt = 99
    dialog.refresh()
    expect(document.querySelector('.scheduled-task')).toBe(item)
    store.chatsById['chat-1'].scheduledTasks![0].enabled = false
    dialog.refresh()
    expect(document.querySelector('.scheduled-task')).not.toBe(item)
  })

  it('redraws from the latest store, and closes on Esc', () => {
    const { store, dialog } = setup()
    store.chatsById['chat-1'].scheduledTasks = [task()]
    dialog.refresh()
    expect(document.querySelectorAll('.scheduled-task')).toHaveLength(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.scheduled-tasks-modal')).toBeNull()
    expect(currentScheduledTasksDialog()).toBeUndefined()
  })
})

const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'
const morning: ResultDestination = { id: 'd1', kind: 'wecom', name: '晨报群', url: WECOM, createdAt: 1 }

describe('sending a scheduled task\'s result', () => {
  it('lets a task send its result to a destination, and keeps it when the task is switched off', async () => {
    const { runCommand, content, submit, button, q } = setup([task({ destinationId: 'd1', lastRun: { at: at(16, 8, 30), status: 'sent', messageId: 'm', delivery: { status: 'sent', at: at(16, 8, 32), destination: '晨报群' } } })], {}, { destinations: [morning] })
    expect(document.querySelector('.scheduled-task-meta')?.textContent).toContain('结果已发送到「晨报群」')
    const choice = q<HTMLSelectElement>('#scheduled-task-destination')
    expect([...choice.options].map(option => option.textContent)).toEqual(['不发送', '晨报群（企业微信群机器人）'])
    expect(choice.value).toBe('')
    content().value = '@所有人 总结'
    choice.value = 'd1'
    submit()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_SCHEDULED_TASK_SAVE', expect.objectContaining({ task: expect.objectContaining({ destinationId: 'd1' }) })))
    button('toggle').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenLastCalledWith('GROUP_SCHEDULED_TASK_SAVE', expect.objectContaining({ taskId: 'sched-1', task: expect.objectContaining({ enabled: false, destinationId: 'd1' }) })))
    button('edit').click()
    expect(choice.value).toBe('d1')
  })

  it('says when sending the result failed', () => {
    setup([task({ destinationId: 'd1', lastRun: { at: at(16, 8, 30), status: 'sent', messageId: 'm', delivery: { status: 'failed', at: at(16, 8, 32), destination: '晨报群', detail: 'invalid webhook url（93000）' } } })], {}, { destinations: [morning] })
    const meta = document.querySelector('.scheduled-task-meta')!
    expect(meta.textContent).toContain('结果没发到「晨报群」：invalid webhook url（93000）')
    expect(meta.classList.contains('scheduled-task-failed')).toBe(true)
  })

  it('adds a destination once the browser allows its site, with a secret only where it signs', async () => {
    const { runCommand, q, requestHostAccess } = setup()
    expect(q('.result-destination-empty').textContent).toBe('还没有推送地址。')
    const kind = q<HTMLSelectElement>('#result-destination-kind')
    kind.value = 'wecom'
    kind.dispatchEvent(new Event('change'))
    expect(q<HTMLElement>('.result-destination-secret').hidden).toBe(true)
    kind.value = 'feishu'
    kind.dispatchEvent(new Event('change'))
    expect(q<HTMLElement>('.result-destination-secret').hidden).toBe(false)
    q<HTMLInputElement>('#result-destination-name').value = '飞书晨报'
    q<HTMLInputElement>('#result-destination-url').value = ' https://open.feishu.cn/open-apis/bot/v2/hook/abc '
    q<HTMLInputElement>('#result-destination-secret').value = 'sec'
    q<HTMLFormElement>('.result-destination-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('RESULT_DESTINATION_ADD', { destination: { kind: 'feishu', name: '飞书晨报', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: 'sec' } }))
    expect(requestHostAccess).toHaveBeenCalledWith('https://open.feishu.cn/open-apis/bot/v2/hook/abc')
  })

  it('does not add one whose site the browser was not allowed to reach', async () => {
    const { runCommand, q } = setup([], {}, { allow: false })
    q<HTMLInputElement>('#result-destination-url').value = 'https://hooks.example.com/x'
    const kind = q<HTMLSelectElement>('#result-destination-kind')
    kind.value = 'webhook'
    kind.dispatchEvent(new Event('change'))
    q<HTMLFormElement>('.result-destination-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(q('.result-destination-status').textContent).toBe('需要你允许 OpenTeam 访问 hooks.example.com，才能往这里推送。'))
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('tests and deletes a destination', async () => {
    const { runCommand, q } = setup([], {}, { destinations: [morning, { ...morning, id: 'd2', name: '旧地址', url: '' }] })
    const rows = [...document.querySelectorAll('.result-destination')]
    expect(rows.map(row => row.querySelector('.result-destination-name')?.textContent)).toEqual(['晨报群', '旧地址'])
    expect(rows[1].textContent).toContain('没有地址（从不含 Key 的备份恢复），请删掉后重新添加')
    rows[0].querySelector<HTMLButtonElement>('[data-destination-action="test"]')!.click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('RESULT_DESTINATION_TEST', { destinationId: 'd1' }))
    await vi.waitFor(() => expect(q('.result-destination-status').textContent).toBe('测试消息已发到「晨报群」，去那里看看收到没有。'))
    rows[0].querySelector<HTMLButtonElement>('[data-destination-action="delete"]')!.click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('RESULT_DESTINATION_DELETE', { destinationId: 'd1' }))
  })
})


describe('adding an overseas destination', () => {
  it('offers Slack, Discord and Telegram, and asks a Telegram bot for its token and chat', async () => {
    const { runCommand, q, requestHostAccess } = setup()
    const kind = q<HTMLSelectElement>('#result-destination-kind')
    expect([...kind.options].map(option => option.textContent)).toEqual(['飞书群机器人', '企业微信群机器人', '钉钉群机器人', 'Slack', 'Discord', 'Telegram 机器人', '通用 Webhook'])
    expect(q<HTMLElement>('.result-destination-chat').hidden).toBe(true)
    kind.value = 'telegram'
    kind.dispatchEvent(new Event('change'))
    expect(q<HTMLElement>('.result-destination-chat').hidden).toBe(false)
    expect(q<HTMLElement>('.result-destination-secret').hidden).toBe(true)
    expect(q<HTMLInputElement>('#result-destination-url').placeholder).toBe('Bot Token，如 123456789:AA…')
    q<HTMLInputElement>('#result-destination-url').value = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
    q<HTMLInputElement>('#result-destination-chat-id').value = '-1001234567890'
    q<HTMLFormElement>('.result-destination-form').dispatchEvent(new Event('submit', { cancelable: true }))
    const url = 'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage'
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('RESULT_DESTINATION_ADD', { destination: { kind: 'telegram', name: 'Telegram 机器人', url, chatId: '-1001234567890' } }))
    expect(requestHostAccess).toHaveBeenCalledWith(url)

    kind.value = 'slack'
    kind.dispatchEvent(new Event('change'))
    expect(q<HTMLElement>('.result-destination-chat').hidden).toBe(true)
    expect(q<HTMLInputElement>('#result-destination-url').placeholder).toBe('https://hooks.slack.com/services/…')
  })
})
