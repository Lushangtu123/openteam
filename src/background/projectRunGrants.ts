// 这个项目都允许: a local agent member asked to run a request of the project that is running may be
// allowed every request of that project at once, so a project with many tasks does not stop at each
// one for a click. The grant is the member's, in that project only (ProjectRun.runAllowedRoleIds),
// and ends with it: a stopped or finished project clears it (projectRunner.ts), and a request outside
// the project (an ordinary question, a task message of an earlier project) is asked about as before.
//
// The agent's own actions are asked about one by one, each run being a new session of the agent, so
// its own "always allow" does not reach the next task. Two kinds may be let through for the rest of
// the project, by member (ProjectRun.toolAllowedKinds): reading and searching, and editing files. A
// command, a delete, a move, a fetch is asked every time: it can do anything. 收回 on the board takes
// a member's grants back, both kinds and the runs.
import { isProjectActive } from '../group/project'
import type { OpenTeamStore, ProjectRun, ProjectToolKind } from '../group/types'
import type { StoreMutationResult } from './storeAccess'

export interface ProjectRunContext {
  chatId: string
  roleId: string
  messageId: string
}

export type ProjectRunAllowance = 'allowed' | 'can-allow'

// The agent's tool kind (ACP: read, edit, delete, move, search, execute, think, fetch, other), as
// one that may be let through for the project, or undefined when it is asked every time.
export function projectToolKind(toolKind: string | undefined): ProjectToolKind | undefined {
  if (toolKind === 'read' || toolKind === 'search') return 'read'
  if (toolKind === 'edit') return 'edit'
  return undefined
}

// The running project this request belongs to: a project request to a member of the group, sent
// since the project started.
function requestProject(store: OpenTeamStore, context: ProjectRunContext): ProjectRun | undefined {
  const chat = store.chatsById[context.chatId]
  const project = chat?.project
  if (!chat || !project || !isProjectActive(project) || !chat.roleIds.includes(context.roleId)) return undefined
  const message = store.messagesById[context.messageId]
  if (!message || message.chatId !== chat.id || !message.projectRequest || message.createdAt < project.createdAt) return undefined
  return project
}

// Undefined: not a request of the running project, so only this run can be allowed.
export function projectRunAllowance(store: OpenTeamStore, context: ProjectRunContext): ProjectRunAllowance | undefined {
  const project = requestProject(store, context)
  if (!project) return undefined
  return project.runAllowedRoleIds?.includes(context.roleId) ? 'allowed' : 'can-allow'
}

// Inside a mutation. False when the request is not the running project's.
export function allowProjectRuns(store: OpenTeamStore, context: ProjectRunContext): boolean {
  const project = requestProject(store, context)
  if (!project) return false
  if (!project.runAllowedRoleIds?.includes(context.roleId)) project.runAllowedRoleIds = [...(project.runAllowedRoleIds ?? []), context.roleId]
  return true
}

// Undefined: not a request of the running project, so the agent's own options only.
export function projectToolAllowance(store: OpenTeamStore, context: ProjectRunContext, kind: ProjectToolKind): ProjectRunAllowance | undefined {
  const project = requestProject(store, context)
  if (!project) return undefined
  return project.toolAllowedKinds?.[context.roleId]?.includes(kind) ? 'allowed' : 'can-allow'
}

// Inside a mutation. False when the request is not the running project's.
export function allowProjectTools(store: OpenTeamStore, context: ProjectRunContext, kind: ProjectToolKind): boolean {
  const project = requestProject(store, context)
  if (!project) return false
  const kinds = project.toolAllowedKinds?.[context.roleId] ?? []
  if (!kinds.includes(kind)) project.toolAllowedKinds = { ...project.toolAllowedKinds, [context.roleId]: [...kinds, kind] }
  return true
}

// 收回: the member's grants in this project, runs and tools. False when it had none.
export function revokeProjectGrants(project: ProjectRun, roleId: string): boolean {
  const runs = project.runAllowedRoleIds?.includes(roleId) ?? false
  const tools = Boolean(project.toolAllowedKinds?.[roleId])
  if (runs) {
    const left = project.runAllowedRoleIds!.filter(id => id !== roleId)
    if (left.length) project.runAllowedRoleIds = left
    else delete project.runAllowedRoleIds
  }
  if (tools) {
    const { [roleId]: _taken, ...left } = project.toolAllowedKinds!
    if (Object.keys(left).length) project.toolAllowedKinds = left
    else delete project.toolAllowedKinds
  }
  return runs || tools
}

// The project stopped or is done: what was given was for this run of it.
export function clearProjectGrants(project: ProjectRun): void {
  delete project.runAllowedRoleIds
  delete project.toolAllowedKinds
}

export interface ProjectRunGrantDependencies {
  loadStore(): Promise<OpenTeamStore>
  mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
  log?: { info(event: string, details?: Record<string, unknown>): void }
}

export function createProjectRunGrants(deps: ProjectRunGrantDependencies) {
  async function give(context: ProjectRunContext, mutator: (store: OpenTeamStore) => boolean, event: string, details: Record<string, unknown>): Promise<boolean> {
    const { store, result } = await deps.mutateStore(mutator)
    if (!result) return false
    deps.log?.info(event, { chatId: context.chatId, roleId: context.roleId, ...details })
    await deps.broadcastStoreUpdated(store)
    return true
  }
  return {
    async check(context: ProjectRunContext): Promise<ProjectRunAllowance | undefined> {
      return projectRunAllowance(await deps.loadStore(), context)
    },
    allow(context: ProjectRunContext): Promise<boolean> {
      return give(context, store => allowProjectRuns(store, context), 'project-grant:runs-allowed', {})
    },
    async checkTool(context: ProjectRunContext, kind: ProjectToolKind): Promise<ProjectRunAllowance | undefined> {
      return projectToolAllowance(await deps.loadStore(), context, kind)
    },
    allowTool(context: ProjectRunContext, kind: ProjectToolKind): Promise<boolean> {
      return give(context, store => allowProjectTools(store, context, kind), 'project-grant:tools-allowed', { kind })
    },
  }
}

export type ProjectRunGrants = ReturnType<typeof createProjectRunGrants>
