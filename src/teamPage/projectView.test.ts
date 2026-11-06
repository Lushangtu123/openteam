// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, ProjectRun, ProjectTask } from '../group/types'
import { createProjectView } from './projectView'

afterEach(() => document.body.replaceChildren())

function role(id: string, name: string, extra: Partial<GroupRole> = {}): GroupRole {
  return { id, chatId: 'chat-1', name, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...extra }
}

function task(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { id, title: `任务${id}`, detail: '', ownerRoleId: 'a', dependsOn: [], doneWhen: '', status: 'todo', attempts: 0, ...extra }
}

function setup(project?: Partial<ProjectRun>, roles = [role('a', '架构师'), role('b', '产品经理', { modelSource: 'external' })]) {
  const store: OpenTeamStore = createDefaultStore()
  const chat: GroupChat = { id: 'chat-1', name: '项目', mode: 'collaborative', roleIds: roles.map(member => member.id), messageIds: ['goal'], nextMessageSeq: 2, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatsById[chat.id] = chat
  for (const member of roles) store.rolesById[member.id] = member
  const goal: GroupMessage = { id: 'goal', chatId: chat.id, seq: 1, type: 'user', content: '写上线方案', projectGoal: true, createdAt: 0, status: 'received' }
  store.messagesById.goal = goal
  if (project) chat.project = { id: 'p1', goalMessageId: 'goal', coordinatorRoleId: 'b', status: 'running', tasks: [], steps: 3, maxSteps: 30, planAttempts: 1, reviewAttempts: 0, createdAt: 0, updatedAt: 0, ...project }
  const runCommand = vi.fn(async () => undefined)
  const showError = vi.fn()
  const view = createProjectView({ getStore: () => store, getCurrentChat: () => chat, getCurrentRoles: () => roles, getLanguage: () => 'zh-CN', getDraft: () => '草稿里的目标', runCommand, showError })
  return { store, chat, goal, view, runCommand, showError }
}

describe('project board', () => {
  it('shows the plan for approval, with owners to change and the actions it needs', () => {
    const { chat, goal, view, runCommand } = setup({ status: 'awaiting-approval', tasks: [task('t1'), task('t2', { ownerRoleId: 'b', dependsOn: ['t1'] })] })
    const board = view.renderBoard(chat, [goal])!
    expect(board.textContent).toContain('计划拟好了 · 2 项任务')
    expect(board.textContent).toContain('已用 3/30 步')
    expect(board.querySelector('.project-board-goal')?.textContent).toBe('写上线方案')
    expect(board.querySelector('[data-task-id="t2"] .project-task-note')?.textContent).toBe('等 t1 完成')

    const owner = board.querySelector<HTMLSelectElement>('[data-task-id="t1"] select.project-task-owner')!
    owner.value = 'b'
    owner.dispatchEvent(new Event('change'))
    expect(runCommand).toHaveBeenCalledWith('GROUP_PROJECT_SET_OWNER', { chatId: 'chat-1', taskId: 't1', roleId: 'b' })
    const buttons = [...board.querySelectorAll<HTMLButtonElement>('.project-board-actions button')]
    expect(buttons.map(button => button.textContent)).toEqual(['开始执行', '重新规划', '取消项目'])
    buttons[0].click()
    expect(runCommand).toHaveBeenCalledWith('GROUP_PROJECT_APPROVE', { chatId: 'chat-1' })
  })

  it('shows progress, the coordinator’s question, and the end', () => {
    const running = setup({ status: 'running', tasks: [task('t1', { status: 'done', checked: true, summary: '方案写好了' }), task('t2', { status: 'doing' }), task('t3', { status: 'redo', note: '补上风险' })] })
    const board = running.view.renderBoard(running.chat, [running.goal])!
    expect(board.textContent).toContain('执行中 · 1/3 完成')
    expect([...board.querySelectorAll('.project-task-status')].map(status => status.textContent)).toEqual(['通过', '进行中', '返工'])
    expect(board.querySelector('[data-task-id="t3"] .project-task-note')?.textContent).toBe('补上风险')
    expect(board.querySelector('[data-task-id="t1"] .project-task-owner')?.textContent).toBe('架构师')
    expect([...board.querySelectorAll('.project-board-actions button')].map(button => button.textContent)).toEqual(['停止项目'])

    const asking = setup({ status: 'waiting-user', question: '预算多少？', tasks: [task('t1', { status: 'done' })] })
    expect(asking.view.renderBoard(asking.chat, [asking.goal])!.querySelector('.project-board-detail.question')?.textContent).toContain('预算多少？')

    const done = setup({ status: 'done', finalMessageId: 'final', tasks: [task('t1', { status: 'done', checked: true })] })
    const finished = done.view.renderBoard(done.chat, [done.goal])!
    expect(finished.textContent).toContain('项目完成')
    expect([...finished.querySelectorAll('.project-board-actions button')].map(button => button.textContent)).toEqual(['查看最终交付'])
    // Once the user moves on, a finished project's board goes away.
    const next: GroupMessage = { id: 'next', chatId: 'chat-1', seq: 9, type: 'user', content: '下一个', createdAt: 0, status: 'received' }
    expect(done.view.renderBoard(done.chat, [done.goal, next])).toBeUndefined()

    const stopped = setup({ status: 'stopped', stopReason: 'budget', tasks: [task('t1')] })
    const pausedBoard = stopped.view.renderBoard(stopped.chat, [stopped.goal])!
    expect(pausedBoard.textContent).toContain('30 步已经用完')
    expect([...pausedBoard.querySelectorAll('.project-board-actions button')].map(button => button.textContent)).toEqual(['继续执行'])
  })
})

describe('project start window', () => {
  it('starts a project with the goal, the coordinator (an API member by default) and the step limit', async () => {
    const { view, runCommand } = setup()
    view.openSetup()
    const goal = document.querySelector<HTMLTextAreaElement>('#project-setup-goal')!
    expect(goal.value).toBe('草稿里的目标')
    expect(document.querySelector<HTMLSelectElement>('#project-setup-coordinator')!.value).toBe('b')
    document.querySelector<HTMLSelectElement>('#project-setup-steps')!.value = '50'
    document.querySelector<HTMLFormElement>('.project-setup-dialog form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_PROJECT_START', { chatId: 'chat-1', goal: '草稿里的目标', coordinatorRoleId: 'b', maxSteps: 50 }))
    await vi.waitFor(() => expect(document.querySelector('.project-setup-modal')).toBeNull())
  })

  it('explains when a project cannot start', () => {
    const tooSmall = setup(undefined, [role('a', '架构师')])
    tooSmall.view.openSetup()
    expect(tooSmall.showError).toHaveBeenCalledWith('项目至少需要两位成员')
    const busy = setup({ status: 'running' })
    busy.view.openSetup()
    expect(busy.showError).toHaveBeenCalledWith('这个群聊已经有进行中的项目，请先停止它')
    expect(document.querySelector('.project-setup-modal')).toBeNull()
  })
})
