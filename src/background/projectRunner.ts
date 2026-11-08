// Runs 项目模式 in the background: the coordinator's plan, the user's approval, handing tasks out as
// they become ready, the coordinator's checks after each wave, and the final write-up. Every step is
// a request to one member; replies arrive like any other and move the project on.
import {
  allTasksDone,
  isProjectActive,
  parsePlan,
  parseReview,
  parseTaskOutcome,
  PROJECT_DEFAULT_MAX_STEPS,
  PROJECT_MAX_TASK_ATTEMPTS,
  projectMembers,
  projectRequestText,
  readyTasks,
  tasksInFlight,
} from '../group/project'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, ProjectRequestKind, ProjectRun, ProjectTask } from '../group/types'
import type { MessageUpload } from '../group/messageUploads'
import { mutateStore, requireChat } from './storeAccess'

// A step is taken a moment after the reply it follows, once that member's page is idle.
const PROJECT_STEP_DELAY_MS = 1500
// Steps added when a project that ran out of steps is continued.
const PROJECT_EXTRA_STEPS = 10

export interface ProjectRequestSent {
  request: GroupMessage
  prepared: unknown
}

export interface ProjectRunnerContext {
  now(): number
  newId(prefix: string): string
  log: { info(event: string, details?: Record<string, unknown>): void; warn(event: string, details?: Record<string, unknown>): void }
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  waitForStep(ms: number): Promise<void>
  canTakeTurn(store: OpenTeamStore, chat: GroupChat, role: GroupRole, timestamp: number): boolean
  startRequest(store: OpenTeamStore, chat: GroupChat, role: GroupRole, fields: Pick<GroupMessage, 'content'> & Partial<GroupMessage>, timestamp: number): ProjectRequestSent
  deliverRequest(chatId: string, sent: ProjectRequestSent): Promise<OpenTeamStore | undefined>
  // Told when the project needs the user (plan ready, a question) or has ended, to notify them.
  reportMilestone(store: OpenTeamStore, chatId: string, goalMessageId: string): void
  // Stores the goal's uploaded files (text) as attachments of the goal message.
  attachmentsFor(uploads: MessageUpload[]): GroupMessage['attachments']
}

export interface StartProjectInput {
  chatId: string
  goal: string
  coordinatorRoleId?: string
  maxSteps?: number
  uploads?: MessageUpload[]
}

export function createProjectRunner(ctx: ProjectRunnerContext) {
  // Sends what a mutation decided, then tells the page.
  async function sendAll(chatId: string, store: OpenTeamStore, sent: ProjectRequestSent[]): Promise<OpenTeamStore> {
    await ctx.broadcastStoreUpdated(store)
    const stores = await Promise.all(sent.map(request => ctx.deliverRequest(chatId, request)))
    const delivered = stores.filter((value): value is OpenTeamStore => Boolean(value))
    return delivered[delivered.length - 1] ?? store
  }

  function requireProject(chat: GroupChat): ProjectRun {
    if (!chat.project) throw new Error('这个群聊没有项目')
    return chat.project
  }

  function coordinatorOf(store: OpenTeamStore, project: ProjectRun): GroupRole {
    const role = store.rolesById[project.coordinatorRoleId]
    if (!role) throw new Error('找不到项目的协调员')
    return role
  }

  // Inside a mutation: asks the coordinator for a plan, a check or the final write-up (a check of the
  // coordinator's own work goes to another member: see askReview).
  function askCoordinator(store: OpenTeamStore, chat: GroupChat, project: ProjectRun, kind: Exclude<ProjectRequestKind, 'task'>, timestamp: number, asked: GroupRole = coordinatorOf(store, project)): ProjectRequestSent[] {
    const coordinator = asked
    if (!ctx.canTakeTurn(store, chat, coordinator, timestamp)) {
      stop(project, 'unavailable', `${coordinator.id === project.coordinatorRoleId ? '协调员' : '检查人'}「${coordinator.name}」现在不可用`, timestamp)
      return []
    }
    project.steps += 1
    if (kind === 'plan') project.planAttempts += 1
    if (kind === 'review') project.reviewAttempts += 1
    project.status = kind === 'plan' ? 'planning' : kind === 'review' ? 'reviewing' : 'finishing'
    const sent = ctx.startRequest(store, chat, coordinator, {
      content: projectRequestText(kind, coordinator.name, undefined, store.settings.language),
      projectRequest: { kind },
    }, timestamp)
    project.coordinatorRequestId = sent.request.id
    project.updatedAt = timestamp
    return [sent]
  }

  // A check of the new results, never by their author. The coordinator checks the tasks others did;
  // when only its own are new, another member checks them. A retry asks the same member again.
  function askReview(store: OpenTeamStore, chat: GroupChat, project: ProjectRun, timestamp: number, retry = false): ProjectRequestSent[] {
    const coordinator = coordinatorOf(store, project)
    const retried = retry && project.reviewerRoleId ? store.rolesById[project.reviewerRoleId] : undefined
    if (retried) return askCoordinator(store, chat, project, 'review', timestamp, retried)
    const fresh = project.tasks.filter(task => task.status !== 'todo' && !task.checked)
    const others = fresh.filter(task => task.ownerRoleId !== coordinator.id)
    let reviewer = coordinator
    let batch = others
    if (others.length === 0 && fresh.length > 0) {
      batch = fresh
      reviewer = projectMembers(store, chat).find(role => role.id !== coordinator.id && ctx.canTakeTurn(store, chat, role, timestamp)) ?? coordinator
    }
    project.reviewerRoleId = reviewer.id
    project.reviewTaskIds = batch.map(task => task.id)
    return askCoordinator(store, chat, project, 'review', timestamp, reviewer)
  }

  function stop(project: ProjectRun, reason: NonNullable<ProjectRun['stopReason']>, detail: string | undefined, timestamp: number): void {
    project.status = 'stopped'
    project.stopReason = reason
    if (detail) project.stopDetail = detail
    else delete project.stopDetail
    delete project.coordinatorRequestId
    project.updatedAt = timestamp
  }

  function budgetLeft(project: ProjectRun): boolean {
    return project.steps < project.maxSteps
  }

  // Inside a mutation: hands out every task that can start, or, once nothing is running, has the
  // coordinator check the results (or write the final deliverable when everything has passed).
  function continueProject(store: OpenTeamStore, chat: GroupChat, project: ProjectRun, timestamp: number): ProjectRequestSent[] {
    if (project.status === 'stopped' || project.status === 'done') return []
    const sent: ProjectRequestSent[] = []
    const busy = new Set(tasksInFlight(project).map(task => task.ownerRoleId))
    for (const task of readyTasks(project)) {
      if (busy.has(task.ownerRoleId)) continue
      const owner = store.rolesById[task.ownerRoleId]
      if (!owner || !ctx.canTakeTurn(store, chat, owner, timestamp)) continue
      if (!budgetLeft(project)) break
      project.steps += 1
      const request = ctx.startRequest(store, chat, owner, {
        content: projectRequestText('task', owner.name, task, store.settings.language),
        projectRequest: { kind: 'task', taskId: task.id },
      }, timestamp)
      task.status = 'doing'
      task.attempts += 1
      task.requestId = request.request.id
      busy.add(owner.id)
      sent.push(request)
    }
    if (sent.length > 0 || tasksInFlight(project).length > 0) {
      project.status = 'running'
      project.updatedAt = timestamp
      return sent
    }

    // Nothing is running and nothing more can start.
    const everythingChecked = project.tasks.every(task => task.checked || task.status === 'todo')
    if (allTasksDone(project) && everythingChecked) {
      // The final write-up is allowed one step past the limit, so the work is not lost.
      if (project.steps > project.maxSteps) {
        stop(project, 'budget', undefined, timestamp)
        return []
      }
      return askCoordinator(store, chat, project, 'final', timestamp)
    }
    if (!budgetLeft(project)) {
      stop(project, 'budget', undefined, timestamp)
      return []
    }
    project.reviewAttempts = 0
    return askReview(store, chat, project, timestamp)
  }

  // Why the member's reply to a request failed, when it did (its failed reply says).
  function latestFailure(store: OpenTeamStore, chat: GroupChat, requestId: string): string | undefined {
    for (let index = chat.messageIds.length - 1; index >= 0; index -= 1) {
      const message = store.messagesById[chat.messageIds[index]]
      if (message?.type === 'assistant' && message.sourceMessageId === requestId) {
        if (message.status !== 'error' || !message.content.trim()) return undefined
        return message.content.replace(/\n+可以点击下方的.*$/s, '').replace(/^回复失败：/, '').trim().slice(0, 300)
      }
    }
    return undefined
  }

  function latestReply(store: OpenTeamStore, chat: GroupChat, requestId: string): GroupMessage | undefined {
    for (let index = chat.messageIds.length - 1; index >= 0; index -= 1) {
      const message = store.messagesById[chat.messageIds[index]]
      if (message?.type === 'assistant' && message.sourceMessageId === requestId) {
        return message.status === 'received' && message.content.trim() ? message : undefined
      }
    }
    return undefined
  }

  function newTask(planned: { id: string; title: string; ownerRoleId: string; dependsOn: string[]; detail: string; doneWhen: string }): ProjectTask {
    return { ...planned, status: 'todo', attempts: 0 }
  }

  // After a reply to one of the project's requests (or a delivery that failed for good).
  async function advance(chatId: string, requestId: string): Promise<void> {
    const timestamp = ctx.now()
    let milestone: string | undefined
    const { store, result } = await mutateStore(store => {
      const chat = store.chatsById[chatId]
      const project = chat?.project
      const request = store.messagesById[requestId]
      const kind = request?.projectRequest?.kind
      if (!chat || !project || !request || request.chatId !== chatId || !kind) return undefined
      const reply = latestReply(store, chat, requestId)
      const members = projectMembers(store, chat)
      const coordinator = store.rolesById[project.coordinatorRoleId]

      if (kind === 'task') {
        const task = project.tasks.find(candidate => candidate.id === request.projectRequest?.taskId)
        if (!task || task.requestId !== requestId) return undefined
        delete task.requestId
        if (reply) {
          const outcome = parseTaskOutcome(reply.content)
          task.resultMessageId = reply.id
          task.summary = outcome.summary
          task.checked = false
          task.status = outcome.status
          if (outcome.status === 'blocked') task.note = outcome.blockedReason || '成员说这项任务受阻'
        } else {
          const failure = latestFailure(store, chat, requestId)
          if (failure) {
            // The member's page could not do it (a notice in the way, out of quota): sending it
            // again at once fails the same way, so the coordinator decides (another owner, or later).
            task.note = failure
            task.status = 'blocked'
            task.checked = false
          } else {
            task.note = '上一次没有收到回复'
            task.status = task.attempts < PROJECT_MAX_TASK_ATTEMPTS ? 'redo' : 'failed'
            task.checked = task.status !== 'failed'
          }
        }
        project.updatedAt = timestamp
        return continueProject(store, chat, project, timestamp)
      }

      if (project.coordinatorRequestId !== requestId) return undefined
      delete project.coordinatorRequestId
      if (project.status === 'stopped' || !coordinator) return undefined

      if (kind === 'plan') {
        const plan = reply ? parsePlan(reply.content, members, coordinator) : undefined
        if (!plan) {
          if (project.planAttempts < 2) return askCoordinator(store, chat, project, 'plan', timestamp)
          stop(project, 'failed', '协调员没有给出可用的任务清单', timestamp)
          milestone = project.goalMessageId
          return []
        }
        project.tasks = plan.map(newTask)
        project.status = 'awaiting-approval'
        project.updatedAt = timestamp
        milestone = project.goalMessageId
        return []
      }

      if (kind === 'review') {
        let outcome = reply ? parseReview(reply.content, project, members, coordinator) : undefined
        if (!outcome) {
          if (project.reviewAttempts < 2 && budgetLeft(project)) return askReview(store, chat, project, timestamp, true)
          stop(project, 'failed', '协调员没有给出可用的检查结果', timestamp)
          milestone = project.goalMessageId
          return []
        }
        // Verdicts count only for the tasks this check was about; only the coordinator adds tasks,
        // asks the user or finishes.
        const batch = new Set(project.reviewTaskIds ?? [])
        const inBatch = (task: ProjectTask) => batch.size === 0 || batch.has(task.id)
        const byCoordinator = (project.reviewerRoleId ?? project.coordinatorRoleId) === project.coordinatorRoleId
        if (!byCoordinator) outcome = { decisions: outcome.decisions, newTasks: [], finish: false }
        delete project.reviewerRoleId
        delete project.reviewTaskIds
        for (const decision of outcome.decisions) {
          const task = project.tasks.find(candidate => candidate.id === decision.taskId)
          if (!task || task.status === 'doing' || !inBatch(task)) continue
          // A task not started yet has no result to pass or redo; it can only get a new owner.
          if (task.status === 'todo') {
            if (decision.verdict === 'reassign' && decision.ownerRoleId) task.ownerRoleId = decision.ownerRoleId
            continue
          }
          if (decision.verdict === 'pass') {
            task.status = 'done'
            delete task.note
          } else {
            if (decision.verdict === 'reassign' && decision.ownerRoleId) {
              task.ownerRoleId = decision.ownerRoleId
              // A new owner gets a fair try.
              task.attempts = Math.min(task.attempts, PROJECT_MAX_TASK_ATTEMPTS - 1)
            }
            task.note = decision.note || task.note
            task.status = task.attempts < PROJECT_MAX_TASK_ATTEMPTS ? 'redo' : 'failed'
          }
          task.checked = true
        }
        // Results checked here without a verdict count as accepted.
        for (const task of project.tasks) {
          if (inBatch(task) && !task.checked && (task.status === 'done' || task.status === 'blocked' || task.status === 'failed')) task.checked = true
        }
        project.tasks.push(...outcome.newTasks.map(newTask))
        if (outcome.question) {
          project.status = 'waiting-user'
          project.question = outcome.question
          project.updatedAt = timestamp
          milestone = project.goalMessageId
          return []
        }
        delete project.question
        const pending = project.tasks.some(task => task.status === 'todo' || task.status === 'redo' || task.status === 'doing')
        // Results still to be checked (the coordinator's own, by another member) come first.
        const unchecked = project.tasks.some(task => task.status !== 'todo' && !task.checked)
        if (!pending && !unchecked) {
          // Nothing is left to do: write it up if everything passed or the coordinator says it is
          // enough (failed tasks are then left out); otherwise nothing more can happen.
          if (outcome.finish || allTasksDone(project)) {
            if (project.steps > project.maxSteps) {
              stop(project, 'budget', undefined, timestamp)
              milestone = project.goalMessageId
              return []
            }
            return askCoordinator(store, chat, project, 'final', timestamp)
          }
          // A member checked the coordinator's work and a task has failed: the coordinator decides
          // (another owner, a new task, or finishing with what passed).
          if (!byCoordinator && budgetLeft(project)) return askReview(store, chat, project, timestamp)
          stop(project, 'failed', '有任务没有完成，协调员也没有安排下一步', timestamp)
          milestone = project.goalMessageId
          return []
        }
        const sent = continueProject(store, chat, project, timestamp)
        if (!isProjectActive(project)) milestone = project.goalMessageId
        return sent
      }

      // The final write-up.
      if (reply) {
        project.finalMessageId = reply.id
        project.status = 'done'
        delete project.stopReason
      } else {
        stop(project, 'failed', '最终交付没有写出来', timestamp)
      }
      project.updatedAt = timestamp
      milestone = project.goalMessageId
      return []
    })
    if (!result) return
    const responseStore = await sendAll(chatId, store, result)
    if (milestone) ctx.reportMilestone(responseStore, chatId, milestone)
  }

  function onSettled(chatId: string, requestId: string): void {
    void (async () => {
      await ctx.waitForStep(PROJECT_STEP_DELAY_MS)
      await advance(chatId, requestId)
    })().catch(error => ctx.log.warn('project:advance-failed', { chatId, requestId, error: error instanceof Error ? error.message : String(error) }))
  }

  async function start(input: StartProjectInput) {
    const timestamp = ctx.now()
    const goal = input.goal.trim()
    if (!goal) throw new Error('请写下项目目标')
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, input.chatId)
      if (isProjectActive(chat.project)) throw new Error('这个群聊已经有进行中的项目，请先停止它')
      const members = projectMembers(store, chat)
      if (members.length < 2) throw new Error('项目至少需要两位成员')
      const coordinator = (input.coordinatorRoleId ? members.find(role => role.id === input.coordinatorRoleId) : undefined)
        ?? members.find(role => role.modelSource === 'external')
        ?? members[0]
      const goalMessage: GroupMessage = {
        id: ctx.newId('msg'),
        chatId: chat.id,
        seq: chat.nextMessageSeq,
        type: 'user',
        content: goal,
        projectGoal: true,
        targetRoleIds: [],
        ...(input.uploads?.length ? { attachments: ctx.attachmentsFor(input.uploads) } : {}),
        createdAt: timestamp,
        status: 'received',
      }
      store.messagesById[goalMessage.id] = goalMessage
      chat.messageIds.push(goalMessage.id)
      chat.nextMessageSeq += 1
      const maxSteps = Number.isInteger(input.maxSteps) && input.maxSteps! >= 5 && input.maxSteps! <= 100 ? input.maxSteps! : PROJECT_DEFAULT_MAX_STEPS
      const project: ProjectRun = {
        id: ctx.newId('project'),
        goalMessageId: goalMessage.id,
        coordinatorRoleId: coordinator.id,
        status: 'planning',
        tasks: [],
        steps: 0,
        maxSteps,
        planAttempts: 0,
        reviewAttempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      chat.project = project
      const sent = askCoordinator(store, chat, project, 'plan', timestamp)
      if (!isProjectActive(project)) throw new Error(project.stopDetail ?? '协调员现在不可用')
      ctx.log.info('project:started', { chatId: chat.id, members: members.length, maxSteps })
      return { goalMessage, sent }
    })
    const responseStore = await sendAll(input.chatId, store, result.sent)
    return { ok: true, message: result.goalMessage, store: responseStore }
  }

  // Runs a mutation on the group's project and sends what it decided.
  async function act(chatId: string, change: (store: OpenTeamStore, chat: GroupChat, project: ProjectRun, timestamp: number) => ProjectRequestSent[]) {
    const timestamp = ctx.now()
    const { store, result } = await mutateStore(store => {
      const chat = requireChat(store, chatId)
      return change(store, chat, requireProject(chat), timestamp)
    })
    const responseStore = await sendAll(chatId, store, result)
    return { ok: true, store: responseStore }
  }

  function approve(chatId: string) {
    return act(chatId, (store, chat, project, timestamp) => {
      if (project.status !== 'awaiting-approval') throw new Error('现在没有等待确认的计划')
      project.status = 'running'
      return continueProject(store, chat, project, timestamp)
    })
  }

  function replan(chatId: string) {
    return act(chatId, (store, chat, project, timestamp) => {
      if (project.status !== 'awaiting-approval') throw new Error('只有计划等待确认时才能重新规划')
      project.tasks = []
      project.planAttempts = 0
      return askCoordinator(store, chat, project, 'plan', timestamp)
    })
  }

  function setTaskOwner(chatId: string, taskId: string, ownerRoleId: string) {
    return act(chatId, (store, chat, project) => {
      if (project.status !== 'awaiting-approval') throw new Error('只有计划等待确认时才能改负责人')
      const task = project.tasks.find(candidate => candidate.id === taskId)
      if (!task) throw new Error('找不到这个任务')
      if (!projectMembers(store, chat).some(role => role.id === ownerRoleId)) throw new Error('找不到这位成员')
      task.ownerRoleId = ownerRoleId
      return []
    })
  }

  function stopProject(chatId: string) {
    return act(chatId, (_store, _chat, project, timestamp) => {
      if (!isProjectActive(project)) return []
      // Members writing now finish; nothing is sent after.
      stop(project, 'user', undefined, timestamp)
      return []
    })
  }

  // Picks a stopped project up again (with a few more steps if it ran out), or goes on after the
  // user answered the coordinator's question.
  function resume(chatId: string) {
    return act(chatId, (store, chat, project, timestamp) => {
      if (project.status === 'done') throw new Error('项目已经完成')
      if (project.status !== 'stopped' && project.status !== 'waiting-user') throw new Error('项目正在进行')
      if (!project.tasks.length) {
        project.planAttempts = 0
        return askCoordinator(store, chat, project, 'plan', timestamp)
      }
      // Stopped before any work went out: back to the plan, to approve it.
      if (project.tasks.every(task => task.status === 'todo' && task.attempts === 0)) {
        delete project.stopReason
        delete project.stopDetail
        project.status = 'awaiting-approval'
        project.updatedAt = timestamp
        return []
      }
      if (project.steps >= project.maxSteps) project.maxSteps = project.steps + PROJECT_EXTRA_STEPS
      delete project.stopReason
      delete project.stopDetail
      delete project.question
      // Tasks interrupted by the stop start again.
      for (const task of project.tasks) {
        if (task.status === 'doing' && !task.requestId) task.status = 'redo'
      }
      project.status = 'running'
      // What the user added is for the coordinator: it checks again before more work goes out.
      project.reviewAttempts = 0
      if (tasksInFlight(project).length > 0) return []
      return askReview(store, chat, project, timestamp)
    })
  }

  // Inside the send mutation: a message the user sends while a project runs is a note for the
  // coordinator. Returns whether the coordinator was waiting for it.
  function addNote(store: OpenTeamStore, chat: GroupChat, raw: string, timestamp: number): { note: GroupMessage; answered: boolean } {
    const project = requireProject(chat)
    const note: GroupMessage = { id: ctx.newId('msg'), chatId: chat.id, seq: chat.nextMessageSeq, type: 'user', content: raw, projectNoteOf: project.goalMessageId, targetRoleIds: [], createdAt: timestamp, status: 'received' }
    store.messagesById[note.id] = note
    chat.messageIds.push(note.id)
    chat.nextMessageSeq += 1
    chat.updatedAt = timestamp
    return { note, answered: project.status === 'waiting-user' }
  }

  return { start, approve, replan, setTaskOwner, stop: stopProject, resume, addNote, onSettled, advance }
}

export type ProjectRunner = ReturnType<typeof createProjectRunner>
