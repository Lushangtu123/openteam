// 项目模式: a coordinator member breaks a goal into tasks for the other members, OpenTeam hands the
// tasks out (side by side when they do not depend on each other), and after each wave of results the
// coordinator checks them against their "done" criteria and re-plans: redo, reassign, add tasks, ask
// the user, or finish with the final deliverable. These are the rules and prompts; the background
// runs them.
import { PROMPT_I18N, normalizeLanguage } from '../shared/i18n'
import { formatAttachedFilesForPrompt } from './messageUploads'
import { roleMentionLabel, type RoleMentionLabelOptions } from './mentionParser'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore, ProjectRun, ProjectTask } from './types'

export const PROJECT_MAX_TASKS = 12
export const PROJECT_DEFAULT_MAX_STEPS = 30
// A task is tried this many times (first try and redos) before it counts as failed.
export const PROJECT_MAX_TASK_ATTEMPTS = 3
// What a prompt quotes of earlier results, at most.
export const PROJECT_MAX_CONTEXT_CHARS = 40_000

export function isProjectActive(project: ProjectRun | undefined): boolean {
  return Boolean(project) && project!.status !== 'done' && project!.status !== 'stopped'
}

// Tasks whose dependencies are done and that are waiting to start.
export function readyTasks(project: ProjectRun): ProjectTask[] {
  const done = new Set(project.tasks.filter(task => task.status === 'done').map(task => task.id))
  return project.tasks.filter(task => (task.status === 'todo' || task.status === 'redo') && task.dependsOn.every(id => done.has(id)))
}

export function tasksInFlight(project: ProjectRun): ProjectTask[] {
  return project.tasks.filter(task => task.status === 'doing')
}

export function allTasksDone(project: ProjectRun): boolean {
  return project.tasks.length > 0 && project.tasks.every(task => task.status === 'done')
}

// Parsing replies

export interface PlannedTask {
  id: string
  title: string
  ownerRoleId: string
  dependsOn: string[]
  detail: string
  doneWhen: string
}

// The JSON object in a reply: inside a ```json fence, or the outermost braces.
export function extractJsonObject(content: string): Record<string, unknown> | undefined {
  const fenced = [...content.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map(match => match[1])
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  const candidates = [...fenced, start >= 0 && end > start ? content.slice(start, end + 1) : '']
  for (const candidate of candidates) {
    const text = candidate.trim()
    if (!text.startsWith('{')) continue
    for (const attempt of [text, text.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const value = JSON.parse(attempt) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
      } catch {
        // Try the next form.
      }
    }
  }
  return undefined
}

// The member a plan names: by name, or a label that contains it ("架构师（Gemini）"), longest
// name first.
export function findMemberByName(name: unknown, members: GroupRole[]): GroupRole | undefined {
  if (typeof name !== 'string' || !name.trim()) return undefined
  const wanted = name.trim().replace(/^@/, '')
  const sorted = [...members].sort((left, right) => right.name.length - left.name.length)
  return sorted.find(role => role.name === wanted) ?? sorted.find(role => wanted.includes(role.name)) ?? sorted.find(role => role.name.includes(wanted))
}

export function readPlannedTasks(raw: unknown, members: GroupRole[], fallbackOwner: GroupRole, takenIds: Set<string> = new Set()): PlannedTask[] {
  if (!Array.isArray(raw)) return []
  const tasks: PlannedTask[] = []
  const ids = new Set(takenIds)
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const detail = typeof record.detail === 'string' ? record.detail.trim() : ''
    if (!title && !detail) continue
    let id = typeof record.id === 'string' && record.id.trim() ? record.id.trim().slice(0, 12) : ''
    if (!id || ids.has(id)) id = nextTaskId(ids)
    ids.add(id)
    tasks.push({
      id,
      title: (title || detail).slice(0, 80),
      ownerRoleId: (findMemberByName(record.owner, members) ?? fallbackOwner).id,
      dependsOn: Array.isArray(record.dependsOn) ? record.dependsOn.filter((dep): dep is string => typeof dep === 'string').map(dep => dep.trim()) : [],
      detail: (detail || title).slice(0, 4000),
      doneWhen: typeof record.doneWhen === 'string' ? record.doneWhen.trim().slice(0, 1000) : '',
    })
  }
  // Dependencies on tasks that do not exist are dropped, and so is a task depending on itself.
  const known = new Set([...takenIds, ...tasks.map(task => task.id)])
  for (const task of tasks) task.dependsOn = [...new Set(task.dependsOn)].filter(dep => known.has(dep) && dep !== task.id)
  return tasks
}

function nextTaskId(taken: Set<string>): string {
  for (let index = 1; ; index += 1) if (!taken.has(`t${index}`)) return `t${index}`
}

export function parsePlan(content: string, members: GroupRole[], fallbackOwner: GroupRole): PlannedTask[] | undefined {
  const json = extractJsonObject(content)
  const tasks = readPlannedTasks(json?.tasks, members, fallbackOwner).slice(0, PROJECT_MAX_TASKS)
  return tasks.length > 0 && !hasDependencyCycle(tasks) ? tasks : undefined
}

export function hasDependencyCycle(tasks: Array<Pick<PlannedTask, 'id' | 'dependsOn'>>): boolean {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    const cycle = (byId.get(id)?.dependsOn ?? []).some(visit)
    state.set(id, 'done')
    return cycle
  }
  return tasks.some(task => visit(task.id))
}

export interface TaskOutcome {
  status: 'done' | 'blocked'
  summary: string
  blockedReason?: string
}

// The status and summary lines a member ends a task with; a reply without them counts as done.
export function parseTaskOutcome(content: string): TaskOutcome {
  const statusMatch = content.match(/(?:【状态】|\[Status\])\s*[:：]?\s*([^\n]*)/i)
  const summaryMatch = content.match(/(?:【摘要】|\[Summary\])\s*[:：]?\s*([^\n]*)/i)
  const statusText = statusMatch?.[1]?.trim() ?? ''
  const blocked = /^(受阻|阻塞|blocked)/i.test(statusText)
  const blockedReason = blocked ? statusText.replace(/^(受阻|阻塞|blocked)\s*[:：]?\s*/i, '').trim() : undefined
  const body = content.replace(/(?:【状态】|\[Status\])[^\n]*\n?/gi, '').replace(/(?:【摘要】|\[Summary\])[^\n]*\n?/gi, '').trim()
  const summary = (summaryMatch?.[1]?.trim() || body.replace(/\s+/g, ' ').slice(0, 140)).slice(0, 300)
  return { status: blocked ? 'blocked' : 'done', summary, ...(blockedReason ? { blockedReason } : {}) }
}

export interface ReviewDecision {
  taskId: string
  verdict: 'pass' | 'redo' | 'reassign'
  note: string
  ownerRoleId?: string
}

export interface ReviewOutcome {
  decisions: ReviewDecision[]
  newTasks: PlannedTask[]
  question?: string
  finish: boolean
}

export function parseReview(content: string, project: ProjectRun, members: GroupRole[], fallbackOwner: GroupRole): ReviewOutcome | undefined {
  const json = extractJsonObject(content)
  if (!json) return undefined
  const taskIds = new Set(project.tasks.map(task => task.id))
  const decisions: ReviewDecision[] = []
  for (const item of Array.isArray(json.decisions) ? json.decisions : []) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const taskId = typeof record.task === 'string' ? record.task.trim() : ''
    const verdict = record.verdict === 'redo' || record.verdict === 'reassign' ? record.verdict : record.verdict === 'pass' ? 'pass' : undefined
    if (!taskIds.has(taskId) || !verdict) continue
    const owner = verdict === 'reassign' ? findMemberByName(record.owner, members) : undefined
    decisions.push({ taskId, verdict: verdict === 'reassign' && !owner ? 'redo' : verdict, note: typeof record.note === 'string' ? record.note.trim().slice(0, 1000) : '', ...(owner ? { ownerRoleId: owner.id } : {}) })
  }
  const room = Math.max(0, PROJECT_MAX_TASKS - project.tasks.length)
  const newTasks = readPlannedTasks(json.newTasks, members, fallbackOwner, taskIds).slice(0, room)
  const question = typeof json.question === 'string' && json.question.trim() ? json.question.trim().slice(0, 1000) : undefined
  return { decisions, newTasks, ...(question ? { question } : {}), finish: json.finish === true }
}

// Prompts

export interface ProjectPromptInput {
  store: OpenTeamStore
  chat: GroupChat
  project: ProjectRun
  request: GroupMessage
  role: GroupRole
  // The member's persona goes with its first task.
  includePersona?: boolean
  language?: OpenTeamLanguage
}

export function buildProjectPrompt(input: ProjectPromptInput): string {
  const kind = input.request.projectRequest?.kind
  if (kind === 'plan') return buildPlanPrompt(input)
  if (kind === 'task') return buildTaskPrompt(input)
  if (kind === 'review') return buildReviewPrompt(input)
  return buildFinalPrompt(input)
}

function goalBlock(input: ProjectPromptInput, en: boolean): string {
  const goal = input.store.messagesById[input.project.goalMessageId]
  return [
    `${en ? 'Project goal (from the user):' : '项目目标（用户提出）：'}\n${goal?.content ?? ''}`,
    goal ? formatAttachedFilesForPrompt(goal, en ? 'en' : 'zh-CN') : '',
  ].filter(Boolean).join('\n\n')
}

// What the user added while the project ran (answers to questions, change requests).
function notesBlock(input: ProjectPromptInput, en: boolean): string {
  const notes = input.chat.messageIds
    .map(id => input.store.messagesById[id])
    .filter((message): message is GroupMessage => Boolean(message && message.projectNoteOf === input.project.goalMessageId && message.content.trim()))
    .map(message => `- ${message.content.trim()}`)
  return notes.length ? `${en ? 'The user added:' : '用户的补充和回答：'}\n${notes.join('\n')}` : ''
}

function memberLines(input: ProjectPromptInput, en: boolean): string {
  const labels = labelOptions(input.store)
  return projectMembers(input.store, input.chat)
    .map(role => `- ${roleMentionLabel(role, labels)}${role.description ? `${en ? ': ' : '：'}${role.description}` : ''}`)
    .join('\n')
}

function labelOptions(store: OpenTeamStore): RoleMentionLabelOptions {
  return {
    defaultChatSite: store.settings.defaultChatSite,
    externalModelNamesById: Object.fromEntries(Object.entries(store.settings.externalModelsById).map(([id, model]) => [id, model.name])),
  }
}

export function projectMembers(store: OpenTeamStore, chat: GroupChat): GroupRole[] {
  return chat.roleIds.map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
}

const TASK_JSON_EXAMPLE = '{"id":"t1","title":"…","owner":"…","dependsOn":[],"detail":"…","doneWhen":"…"}'

function buildPlanPrompt(input: ProjectPromptInput): string {
  const en = normalizeLanguage(input.language) === 'en'
  return [
    en ? `You are "${input.role.name}". This time you coordinate a project carried out by an AI team.` : `你是「${input.role.name}」，这次担任一个 AI 团队项目的协调员。`,
    goalBlock(input, en),
    `${en ? 'Team members (tasks can go only to them, you included):' : '团队成员（任务只能分给他们，也可以分给你自己）：'}\n${memberLines(input, en)}`,
    notesBlock(input, en),
    en
      ? 'Break the goal into 2–8 concrete tasks. Each task must be something one member can finish alone in one reply: say what to do, what to deliver, and how to tell it is done. Give each task to the member it suits best and spread the work. Mark order with dependsOn; tasks without dependencies run at the same time.'
      : '请把目标拆成 2–8 个具体任务。每个任务要能由一位成员在一次回复里独立完成：写清楚做什么、交付什么、怎样算完成。按成员擅长的方向分配，尽量分摊。有先后关系的用 dependsOn 标出；没有依赖的任务会同时进行。',
    `${en ? 'Reply with only one JSON code block, in this form:' : '只回复一个 JSON 代码块，格式如下：'}\n\`\`\`json\n{"tasks":[${TASK_JSON_EXAMPLE}]}\n\`\`\``,
    en ? 'Use the member names exactly as listed (without the model in brackets).' : 'owner 写成员的名字（不带括号里的模型）。',
  ].filter(Boolean).join('\n\n')
}

function buildTaskPrompt(input: ProjectPromptInput): string {
  const en = normalizeLanguage(input.language) === 'en'
  const task = input.project.tasks.find(candidate => candidate.id === input.request.projectRequest?.taskId)
  if (!task) throw new Error('找不到这个项目任务')
  const dependencies = task.dependsOn
    .map(id => input.project.tasks.find(candidate => candidate.id === id))
    .filter((candidate): candidate is ProjectTask => Boolean(candidate))
  const share = Math.floor(PROJECT_MAX_CONTEXT_CHARS / Math.max(1, dependencies.length))
  const dependencyResults = dependencies.map(dependency => {
    const owner = input.store.rolesById[dependency.ownerRoleId]?.name ?? ''
    const result = resultText(input.store, dependency, share, en)
    return `${en ? `[${dependency.id} · ${dependency.title} · ${owner}]` : `【${dependency.id} · ${dependency.title} · ${owner}】`}\n${result}`
  })
  return [
    en ? `You are "${input.role.name}", working on one task of an AI team's project.` : `你是「${input.role.name}」，在一个 AI 团队项目里负责一项任务。`,
    input.role.description ? `${en ? 'Your responsibility:' : '你的职责：'}\n${input.role.description}` : '',
    input.includePersona && input.role.systemPrompt ? `${en ? 'Persona:' : '人设：'}\n${input.role.systemPrompt}` : '',
    goalBlock(input, en),
    `${en ? `Your task (${task.id} · ${task.title}):` : `你的任务（${task.id} · ${task.title}）：`}\n${task.detail}`,
    task.doneWhen ? `${en ? 'It is done when:' : '完成标准：'}\n${task.doneWhen}` : '',
    task.note && task.attempts > 0 ? `${en ? 'Feedback on your last attempt:' : '上一次结果的检查意见：'}\n${task.note}` : '',
    dependencyResults.length ? `${en ? 'Results of the tasks yours builds on:' : '你的任务依赖的结果：'}\n\n${dependencyResults.join('\n\n')}` : '',
    notesBlock(input, en),
    en
      ? `Do the task now and give a result that can be used as it is. Then end with two lines:\n[Status] done (or: blocked: the reason)\n[Summary] one sentence on what you delivered\n${PROMPT_I18N.en.responseLanguageInstruction}`
      : `请直接完成任务，给出可以直接使用的成果。最后另起两行写：\n【状态】完成（或：受阻：原因）\n【摘要】一句话说明你交付了什么\n${PROMPT_I18N['zh-CN'].responseLanguageInstruction}`,
  ].filter(Boolean).join('\n\n')
}

function resultText(store: OpenTeamStore, task: ProjectTask, maxChars: number, en: boolean): string {
  const message = task.resultMessageId ? store.messagesById[task.resultMessageId] : undefined
  const text = (message?.content ?? task.summary ?? '').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n${en ? '[…the rest is omitted]' : '［……其余部分已省略］'}`
}

function statusLabel(task: ProjectTask, en: boolean): string {
  const labels: Record<ProjectTask['status'], [string, string]> = {
    todo: ['未开始', 'not started'],
    redo: ['待重做', 'to redo'],
    doing: ['进行中', 'in progress'],
    done: ['已完成', 'done'],
    blocked: ['受阻', 'blocked'],
    failed: ['失败', 'failed'],
  }
  return labels[task.status][en ? 1 : 0]
}

function buildReviewPrompt(input: ProjectPromptInput): string {
  const en = normalizeLanguage(input.language) === 'en'
  // New results are quoted in full (as far as they fit); results already checked, by their summary.
  const fresh = input.project.tasks.filter(task => task.status !== 'todo' && !task.checked)
  const share = Math.floor(PROJECT_MAX_CONTEXT_CHARS / Math.max(1, fresh.length))
  const taskLines = input.project.tasks.map(task => {
    const owner = input.store.rolesById[task.ownerRoleId]?.name ?? ''
    const head = en
      ? `[${task.id} · ${task.title} · owner: ${owner} · ${statusLabel(task, en)}]`
      : `【${task.id} · ${task.title} · 负责人：${owner} · ${statusLabel(task, en)}】`
    const parts = [head, task.doneWhen ? `${en ? 'Done when:' : '完成标准：'}${task.doneWhen}` : '']
    if (task.status === 'blocked' && task.note) parts.push(`${en ? 'Blocked:' : '受阻原因：'}${task.note}`)
    if (task.resultMessageId) parts.push(`${en ? 'Result:' : '结果：'}\n${task.checked ? task.summary ?? '' : resultText(input.store, task, share, en)}`)
    return parts.filter(Boolean).join('\n')
  })
  const example = `{"decisions":[{"task":"t1","verdict":"pass","note":"…"}],"newTasks":[],"finish":false}`
  return [
    en ? `You are "${input.role.name}", the coordinator of this project.` : `你是「${input.role.name}」，这个项目的协调员。`,
    goalBlock(input, en),
    `${en ? 'Team members:' : '团队成员：'}\n${memberLines(input, en)}`,
    `${en ? 'Tasks and results:' : '任务和结果：'}\n\n${taskLines.join('\n\n')}`,
    notesBlock(input, en),
    en
      ? 'Check each new result against its "done when" and decide what happens next. For each checked task give a verdict: "pass", "redo" (with what to fix in note) or "reassign" (with the new owner). Blocked or failed tasks need a decision too. Add newTasks only if the goal cannot be reached without them. Ask a question only when the user must decide something. Set finish to true only when every task has passed and the goal is reached.'
      : '请检查每个新结果是否达到完成标准，并决定下一步。对每个检查的任务给出 verdict："pass"（通过）、"redo"（重做，在 note 里写清要改什么）或 "reassign"（换人，写上新的 owner）。受阻或失败的任务也要给出决定。只有不加任务就无法完成目标时才写 newTasks。只有需要用户拍板时才写 question。只有所有任务都通过、目标已经达成时，finish 才为 true。',
    `${en ? 'Reply with only one JSON code block, in this form:' : '只回复一个 JSON 代码块，格式如下：'}\n\`\`\`json\n${example}\n\`\`\``,
    en ? `New tasks use the same form as in the plan: ${TASK_JSON_EXAMPLE}` : `newTasks 里每个任务的格式和计划里一样：${TASK_JSON_EXAMPLE}`,
  ].filter(Boolean).join('\n\n')
}

function buildFinalPrompt(input: ProjectPromptInput): string {
  const en = normalizeLanguage(input.language) === 'en'
  const done = input.project.tasks.filter(task => task.resultMessageId)
  const share = Math.floor(PROJECT_MAX_CONTEXT_CHARS / Math.max(1, done.length))
  const results = done.map(task => `${en ? `[${task.title}]` : `【${task.title}】`}\n${resultText(input.store, task, share, en)}`)
  return [
    en ? `You are "${input.role.name}", the coordinator of this project. The work is finished.` : `你是「${input.role.name}」，这个项目的协调员。各项任务已经完成。`,
    goalBlock(input, en),
    `${en ? 'What each task produced:' : '各任务的成果：'}\n\n${results.join('\n\n')}`,
    notesBlock(input, en),
    en
      ? `Combine these results into one complete final deliverable for the user, in Markdown: start with a 3–5 sentence summary of the outcome, then give the full content. Do not describe the process or mention task numbers. ${PROMPT_I18N.en.responseLanguageInstruction}`
      : `请把这些成果整合成一份完整的最终交付，直接给用户，用 Markdown：先用 3–5 句话总结结论，再给出完整内容。不要描述过程，不要提任务编号。${PROMPT_I18N['zh-CN'].responseLanguageInstruction}`,
  ].filter(Boolean).join('\n\n')
}

// The notice shown in the chat for each request.
export function projectRequestText(kind: 'plan' | 'task' | 'review' | 'final', roleName: string, task: ProjectTask | undefined, languageInput: OpenTeamLanguage | undefined): string {
  const en = normalizeLanguage(languageInput) === 'en'
  if (kind === 'plan') return en ? `Project · ${roleName} plans the tasks` : `项目 · 请「${roleName}」拆分任务`
  if (kind === 'review') return en ? `Project · ${roleName} checks the results` : `项目 · 请「${roleName}」检查结果`
  if (kind === 'final') return en ? `Project · ${roleName} writes the final deliverable` : `项目 · 请「${roleName}」整理最终交付`
  const attempt = task && task.attempts > 0 ? (en ? ` (try ${task.attempts + 1})` : `（第 ${task.attempts + 1} 次）`) : ''
  return en
    ? `Project · task ${task?.id ?? ''} "${task?.title ?? ''}" to ${roleName}${attempt}`
    : `项目 · 任务 ${task?.id ?? ''}「${task?.title ?? ''}」交给「${roleName}」${attempt}`
}
