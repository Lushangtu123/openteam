// 项目模式 in the page: the window that starts a project (goal, files, coordinator, step limit), and
// the task board at the end of the chat that shows the plan, each task's owner and progress, and
// the actions the project needs (start, re-plan, stop, continue).
import type { MessageUpload } from '../group/messageUploads'
import { isProjectActive } from '../group/project'
import { isOpenTeamRequest } from '../group/roundSummary'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, ProjectRun, ProjectTask } from '../group/types'
import { normalizeLanguage, translateUi, type TeamLanguage } from '../shared/i18n'
import { createComposerAttachments } from './composerAttachments'

export interface ProjectViewDependencies {
  getStore(): OpenTeamStore
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getLanguage(): TeamLanguage
  // The text in the message box, offered as the goal.
  getDraft(): string
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

const STEP_CHOICES = [20, 30, 50]

export function createProjectView(deps: ProjectViewDependencies) {
  let setup: HTMLElement | undefined
  let boardCache: { key: string; node: HTMLElement } | undefined

  function t(zh: string, en: string): string {
    return normalizeLanguage(deps.getLanguage()) === 'en' ? en : zh
  }

  // ----- Start window -----

  function openSetup(): void {
    closeSetup()
    const chat = deps.getCurrentChat()
    const roles = deps.getCurrentRoles()
    if (!chat) return deps.showError(t('先选择一个群聊', 'Choose a group first'))
    if (isProjectActive(chat.project)) return deps.showError(t('这个群聊已经有进行中的项目，请先停止它', 'This group already has a project running; stop it first'))
    if (roles.length < 2) return deps.showError(t('项目至少需要两位成员', 'A project needs at least two members'))

    const backdrop = element('div', 'modal-backdrop project-setup-modal')
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) closeSetup()
    })
    const dialog = element('section', 'modal team-setup-dialog project-setup-dialog')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'project-setup-title')

    const header = element('div', 'modal-header')
    const heading = element('div')
    const title = element('h2', '', t('开始一个项目', 'Start a project'))
    title.id = 'project-setup-title'
    heading.append(title, element('p', 'tiny', t('协调员把目标拆成任务分给成员，成员各自完成，协调员检查结果、安排返工，最后整理出完整交付。', 'The coordinator breaks the goal into tasks for the members, checks what they deliver, asks for rework, and finally puts the deliverable together.')))
    const close = element('button', 'icon-btn modal-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', t('关闭', 'Close'))
    close.addEventListener('click', () => closeSetup())
    header.append(heading, close)

    const form = element('form', 'team-setup-form')
    form.noValidate = true

    const goalField = field(t('项目目标', 'Project goal'), 'project-setup-goal')
    const goal = element('textarea')
    goal.id = 'project-setup-goal'
    goal.rows = 4
    goal.value = deps.getDraft()
    goal.placeholder = t('例如：为我们的记账 App 写一份上线方案，包括功能清单、技术方案、测试计划和推广文案', 'For example: write a launch plan for our budgeting app, with the feature list, technical design, test plan and launch copy')
    goalField.append(goal)

    const filesField = field(t('资料（选填）', 'Files (optional)'))
    const tray = element('div', 'attachment-tray team-setup-tray')
    tray.hidden = true
    const attach = element('button', 'btn btn-small team-setup-attach', t('添加文件', 'Add files'))
    attach.type = 'button'
    const fileInput = element('input')
    fileInput.type = 'file'
    fileInput.hidden = true
    filesField.append(tray, attach, fileInput, element('p', 'tiny', t('PDF、Word、Excel、PPT 或文本文件，会交给协调员和每位成员参考。', 'PDF, Word, Excel, PowerPoint or text files; the coordinator and every member get them.')))

    const coordinatorField = field(t('协调员', 'Coordinator'), 'project-setup-coordinator')
    const coordinator = element('select')
    coordinator.id = 'project-setup-coordinator'
    const preferred = roles.find(role => role.modelSource === 'external') ?? roles[0]
    for (const role of roles) {
      const option = element('option', '', role.modelSource === 'external' ? `${role.name}（API）` : role.name)
      option.value = role.id
      option.selected = role.id === preferred.id
      coordinator.append(option)
    }
    coordinatorField.append(coordinator, element('p', 'tiny', t('负责拆任务、检查结果和整理交付。API 成员更快更稳，有的话优先用它。', 'Plans the tasks, checks the results and writes the deliverable. An API member is faster and steadier, when there is one.')))

    const stepsField = field(t('最多步数', 'Step limit'), 'project-setup-steps')
    const steps = element('select')
    steps.id = 'project-setup-steps'
    for (const value of STEP_CHOICES) {
      const option = element('option', '', t(`${value} 步`, `${value} steps`))
      option.value = String(value)
      option.selected = value === 30
      steps.append(option)
    }
    stepsField.append(steps, element('p', 'tiny', t('每次请成员做事（拆任务、做任务、检查、整理）算一步。用完会停下，可以再继续。', 'Each request to a member (planning, a task, a check, the write-up) is a step. When they run out the project pauses; you can continue it.')))

    const error = element('p', 'team-form-error')
    error.setAttribute('role', 'alert')
    const actions = element('div', 'team-setup-actions')
    const cancel = element('button', 'btn', t('取消', 'Cancel'))
    cancel.type = 'button'
    cancel.addEventListener('click', () => closeSetup())
    const submit = element('button', 'btn btn-primary', t('开始规划', 'Plan it'))
    submit.type = 'submit'
    actions.append(cancel, submit)
    form.append(goalField, filesField, coordinatorField, stepsField, error, actions)

    const files = createComposerAttachments({
      trayEl: tray,
      attachButtonEl: attach,
      fileInputEl: fileInput,
      pasteTargetEl: goal,
      dropTargetEl: form,
      ui: source => translateUi(source, normalizeLanguage(deps.getLanguage())),
      showError: text => { error.textContent = text },
      onChange: () => { error.textContent = '' },
    })
    files.register()

    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (!goal.value.trim()) {
        error.textContent = t('请写下项目目标', 'Write the project goal')
        goal.focus()
        return
      }
      let uploads: MessageUpload[]
      try {
        uploads = await files.readUploads()
      } catch (caught) {
        error.textContent = caught instanceof Error ? caught.message : String(caught)
        return
      }
      if (uploads.some(upload => upload.kind === 'image')) {
        error.textContent = t('项目暂不支持图片附件，可以附上 PDF、Word 或文本文件', 'Projects do not take images yet; attach PDF, Word or text files')
        return
      }
      submit.disabled = true
      try {
        await deps.runCommand('GROUP_PROJECT_START', { chatId: chat.id, goal: goal.value.trim(), coordinatorRoleId: coordinator.value, maxSteps: Number(steps.value), ...(uploads.length ? { uploads } : {}) })
        closeSetup()
      } catch (caught) {
        error.textContent = caught instanceof Error ? caught.message : String(caught)
        submit.disabled = false
      }
    })

    dialog.append(header, form)
    backdrop.append(dialog)
    document.body.append(backdrop)
    document.addEventListener('keydown', handleEscape)
    setup = backdrop
    goal.focus()
  }

  function closeSetup(): void {
    setup?.remove()
    setup = undefined
    document.removeEventListener('keydown', handleEscape)
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeSetup()
  }

  // ----- Task board -----

  // Shown while the project runs, and after it ends until the user moves on.
  function renderBoard(chat: GroupChat, messages: GroupMessage[]): HTMLElement | undefined {
    const project = chat.project
    if (!project) return undefined
    if (!isProjectActive(project)) {
      const latestOwn = [...messages].reverse().find(message => message.type === 'user' && !isOpenTeamRequest(message))
      if (!latestOwn || (latestOwn.id !== project.goalMessageId && latestOwn.projectNoteOf !== project.goalMessageId)) return undefined
    }
    const store = deps.getStore()
    const roles = chat.roleIds.map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
    const key = JSON.stringify([chat.id, project, roles.map(role => [role.id, role.name]), deps.getLanguage()])
    if (boardCache?.key === key) return boardCache.node

    const board = element('section', `project-board project-${project.status}`)
    board.setAttribute('aria-label', t('项目看板', 'Project board'))

    const head = element('div', 'project-board-head')
    const titleLine = element('div', 'project-board-title')
    titleLine.append(element('span', 'project-board-chip', t('项目', 'Project')), element('strong', '', statusTitle(project)))
    const steps = element('span', 'project-board-steps', t(`已用 ${project.steps}/${project.maxSteps} 步`, `${project.steps}/${project.maxSteps} steps used`))
    head.append(titleLine, steps)
    board.append(head)

    const goal = store.messagesById[project.goalMessageId]
    if (goal) board.append(element('p', 'project-board-goal', goal.content.replace(/\s+/g, ' ').slice(0, 160)))
    const detail = statusDetail(project, store)
    if (detail) board.append(element('p', `project-board-detail${project.status === 'waiting-user' ? ' question' : ''}`, detail))

    if (project.tasks.length) {
      const list = element('ol', 'project-task-list')
      for (const task of project.tasks) list.append(taskRow(chat, project, task, roles))
      board.append(list)
    }

    const actions = element('div', 'project-board-actions')
    const command = (label: string, type: string, primary = false, payload: Record<string, unknown> = {}) => {
      const button = element('button', `btn btn-small${primary ? ' btn-primary' : ''}`, label)
      button.type = 'button'
      button.addEventListener('click', () => {
        button.disabled = true
        deps.runCommand(type, { chatId: chat.id, ...payload })
          .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
          .finally(() => { button.disabled = false })
      })
      actions.append(button)
    }
    if (project.status === 'awaiting-approval') {
      command(t('开始执行', 'Start the work'), 'GROUP_PROJECT_APPROVE', true)
      command(t('重新规划', 'Plan again'), 'GROUP_PROJECT_REPLAN')
      command(t('取消项目', 'Cancel project'), 'GROUP_PROJECT_STOP')
    } else if (project.status === 'stopped') {
      command(t('继续执行', 'Continue'), 'GROUP_PROJECT_CONTINUE', true)
    } else if (project.status === 'done') {
      const view = element('button', 'btn btn-small btn-primary', t('查看最终交付', 'See the deliverable'))
      view.type = 'button'
      view.addEventListener('click', () => {
        document.querySelector(`[data-message-id="${project.finalMessageId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
      actions.append(view)
    } else {
      command(t('停止项目', 'Stop project'), 'GROUP_PROJECT_STOP')
    }
    board.append(actions)
    boardCache = { key, node: board }
    return board
  }

  function statusTitle(project: ProjectRun): string {
    const done = project.tasks.filter(task => task.status === 'done').length
    switch (project.status) {
      case 'planning': return t('正在拆分任务', 'Planning the tasks')
      case 'awaiting-approval': return t(`计划拟好了 · ${project.tasks.length} 项任务`, `Plan ready · ${project.tasks.length} tasks`)
      case 'running': return t(`执行中 · ${done}/${project.tasks.length} 完成`, `Working · ${done}/${project.tasks.length} done`)
      case 'reviewing': return t('协调员正在检查结果', 'The coordinator is checking the results')
      case 'waiting-user': return t('需要你决定', 'Needs your decision')
      case 'finishing': return t('正在整理最终交付', 'Writing the final deliverable')
      case 'done': return t('项目完成', 'Project finished')
      default: return t('项目已停止', 'Project stopped')
    }
  }

  function statusDetail(project: ProjectRun, store: OpenTeamStore): string {
    const coordinator = store.rolesById[project.coordinatorRoleId]?.name ?? ''
    switch (project.status) {
      case 'planning': return t(`「${coordinator}」正在把目标拆成任务。`, `${coordinator} is breaking the goal into tasks.`)
      case 'awaiting-approval': return t('看一下任务和负责人，可以改负责人。想改计划就在输入框写意见，再点「重新规划」。', 'Check the tasks and owners; you can change owners. To change the plan, write what you want in the message box, then click Plan again.')
      case 'running': return t('你现在发的消息会转给协调员，下次检查时会看到。', 'What you send now goes to the coordinator for its next check.')
      case 'reviewing': return t(`「${coordinator}」在对照完成标准检查结果，决定通过、返工还是加任务。`, `${coordinator} is checking the results against their done criteria: pass, rework or new tasks.`)
      case 'waiting-user': return `${project.question ?? ''}\n${t('直接在输入框回答，项目会继续。', 'Answer in the message box and the project goes on.')}`
      case 'finishing': return t(`「${coordinator}」正在把各项成果整合成最终交付。`, `${coordinator} is putting the results together.`)
      case 'done': return t('最终交付在上方。', 'The final deliverable is above.')
      default:
        if (project.stopReason === 'budget') return t(`${project.maxSteps} 步已经用完。继续会再给 10 步。`, `All ${project.maxSteps} steps are used. Continuing adds 10 more.`)
        if (project.stopReason === 'user') return t('已经停止。正在写的成员会写完，之后不会再发新的请求。', 'Stopped. Members writing now finish; nothing new is sent.')
        return project.stopDetail ?? ''
    }
  }

  function taskRow(chat: GroupChat, project: ProjectRun, task: ProjectTask, roles: GroupRole[]): HTMLElement {
    const row = element('li', `project-task project-task-${task.status}`)
    row.dataset.taskId = task.id
    const status = element('span', 'project-task-status', taskStatusLabel(task))
    const main = element('div', 'project-task-main')
    const titleLine = element('div', 'project-task-title')
    titleLine.append(element('span', 'project-task-id', task.id), element('span', '', task.title))
    main.append(titleLine)
    const line = task.status === 'blocked' || task.status === 'redo' || task.status === 'failed' ? task.note : task.summary
    if (line) main.append(element('p', 'project-task-note', line))
    else if (task.dependsOn.length && task.status === 'todo') main.append(element('p', 'project-task-note', t(`等 ${task.dependsOn.join('、')} 完成`, `Waits for ${task.dependsOn.join(', ')}`)))

    let owner: HTMLElement
    if (project.status === 'awaiting-approval') {
      const select = element('select', 'project-task-owner')
      select.setAttribute('aria-label', t(`${task.id} 的负责人`, `Owner of ${task.id}`))
      for (const role of roles) {
        const option = element('option', '', role.name)
        option.value = role.id
        option.selected = role.id === task.ownerRoleId
        select.append(option)
      }
      select.addEventListener('change', () => {
        deps.runCommand('GROUP_PROJECT_SET_OWNER', { chatId: chat.id, taskId: task.id, roleId: select.value })
          .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
      })
      owner = select
    } else {
      owner = element('span', 'project-task-owner', roles.find(role => role.id === task.ownerRoleId)?.name ?? '')
    }
    row.append(status, main, owner)
    return row
  }

  function taskStatusLabel(task: ProjectTask): string {
    const labels: Record<ProjectTask['status'], [string, string]> = {
      todo: ['待开始', 'To do'],
      redo: ['返工', 'Rework'],
      doing: ['进行中', 'Working'],
      done: [task.checked ? '通过' : '已提交', task.checked ? 'Passed' : 'Submitted'],
      blocked: ['受阻', 'Blocked'],
      failed: ['失败', 'Failed'],
    }
    return t(...labels[task.status])
  }

  return { openSetup, closeSetup, renderBoard }
}

export type ProjectView = ReturnType<typeof createProjectView>

function field(label: string, forId?: string): HTMLElement {
  const wrapper = element('div', 'field')
  const caption = element('label', '', label)
  if (forId) caption.htmlFor = forId
  wrapper.append(caption)
  return wrapper
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
