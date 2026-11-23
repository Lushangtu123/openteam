// 这个项目都允许: a local agent member asked to run a request of the project that is running may be
// allowed every request of that project at once, so a project with many tasks does not stop at each
// one for a click. The grant is the member's, in that project only (ProjectRun.runAllowedRoleIds),
// and ends with it: a stopped or finished project clears it (projectRunner.ts), and a request outside
// the project (an ordinary question, a task message of an earlier project) is asked about as before.
// The agent's own actions (editing a file, running a command) are still asked about one by one.
import { isProjectActive } from '../group/project'
import type { OpenTeamStore, ProjectRun } from '../group/types'
import type { StoreMutationResult } from './storeAccess'

export interface ProjectRunContext {
  chatId: string
  roleId: string
  messageId: string
}

export type ProjectRunAllowance = 'allowed' | 'can-allow'

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

export interface ProjectRunGrantDependencies {
  loadStore(): Promise<OpenTeamStore>
  mutateStore<T>(mutator: (store: OpenTeamStore) => T | Promise<T>): Promise<StoreMutationResult<T>>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
}

export function createProjectRunGrants(deps: ProjectRunGrantDependencies) {
  return {
    async check(context: ProjectRunContext): Promise<ProjectRunAllowance | undefined> {
      return projectRunAllowance(await deps.loadStore(), context)
    },
    async allow(context: ProjectRunContext): Promise<boolean> {
      const { store, result } = await deps.mutateStore(store => allowProjectRuns(store, context))
      if (result) await deps.broadcastStoreUpdated(store)
      return result
    },
  }
}

export type ProjectRunGrants = ReturnType<typeof createProjectRunGrants>
