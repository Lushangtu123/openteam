// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore, ScheduledTask } from '../group/types'
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

function setup(tasks: ScheduledTask[] = [], chatFields: Record<string, unknown> = {}) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatsById['chat-1'] = { id: 'chat-1', name: '早报', mode: 'collaborative', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, scheduledTasks: tasks, ...chatFields }
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const dialog = openScheduledTasksDialog('chat-1', { getStore: () => store, runCommand, now: () => at(16, 9), confirm: () => true })
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  const content = () => q<HTMLTextAreaElement>('#scheduled-task-content')
  const days = () => [...document.querySelectorAll<HTMLInputElement>('.scheduled-task-day input')]
  const time = () => q<HTMLInputElement>('#scheduled-task-time')
  const submit = () => q<HTMLFormElement>('.scheduled-task-form').dispatchEvent(new Event('submit', { cancelable: true }))
  const button = (name: string) => q<HTMLButtonElement>(`[data-scheduled-action="${name}"]`)
  return { store, runCommand, dialog, content, days, time, submit, button }
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
