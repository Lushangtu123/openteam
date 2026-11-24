import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore, ProjectRun } from '../group/types'
import { allowProjectRuns, allowProjectTools, clearProjectGrants, createProjectRunGrants, projectRunAllowance, projectToolAllowance, projectToolKind, revokeProjectGrants } from './projectRunGrants'

// A group with a project running: two local agent members, the task sent to 程序员, an ordinary
// question to it, and a task message left from an earlier project.
function setup(project: Partial<ProjectRun> = {}): OpenTeamStore {
  const store = createDefaultStore()
  store.chatsById.c = {
    id: 'c', name: '项目群', mode: 'collaborative', roleIds: ['dev', 'qa'], messageIds: ['old-task', 'ask', 'task', 'qa-task'], nextMessageSeq: 5, status: 'running', createdAt: 1, updatedAt: 1,
    project: { id: 'p2', goalMessageId: 'goal', coordinatorRoleId: 'dev', status: 'running', tasks: [], steps: 2, maxSteps: 20, planAttempts: 1, reviewAttempts: 0, createdAt: 100, updatedAt: 100, ...project },
  }
  for (const id of ['dev', 'qa']) store.rolesById[id] = { id, chatId: 'c', name: id === 'dev' ? '程序员' : '测试', modelSource: 'external', externalModelId: 'agent', status: 'thinking', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  const message = (id: string, createdAt: number, projectRequest?: { kind: 'task'; taskId: string }) => {
    store.messagesById[id] = { id, chatId: 'c', seq: 1, type: 'user', content: '做这件事', createdAt, status: 'pending', ...(projectRequest ? { projectRequest } : {}) }
  }
  message('old-task', 50, { kind: 'task', taskId: 't0' })
  message('ask', 120)
  message('task', 130, { kind: 'task', taskId: 't1' })
  message('qa-task', 140, { kind: 'task', taskId: 't2' })
  return store
}

const devTask = { chatId: 'c', roleId: 'dev', messageId: 'task' }

describe('letting a local agent run for the whole project', () => {
  it('can be offered for a request of the running project, and once given, holds for that member only', () => {
    const store = setup()
    expect(projectRunAllowance(store, devTask)).toBe('can-allow')
    expect(allowProjectRuns(store, devTask)).toBe(true)
    expect(store.chatsById.c.project!.runAllowedRoleIds).toEqual(['dev'])
    expect(projectRunAllowance(store, devTask)).toBe('allowed')
    expect(projectRunAllowance(store, { chatId: 'c', roleId: 'qa', messageId: 'qa-task' })).toBe('can-allow')
    // Given twice, kept once.
    allowProjectRuns(store, devTask)
    expect(store.chatsById.c.project!.runAllowedRoleIds).toEqual(['dev'])
  })

  it('is not offered, nor holds, outside the running project', () => {
    const store = setup({ runAllowedRoleIds: ['dev'] })
    // An ordinary question, and a task message from an earlier project (asked again, say).
    expect(projectRunAllowance(store, { chatId: 'c', roleId: 'dev', messageId: 'ask' })).toBeUndefined()
    expect(projectRunAllowance(store, { chatId: 'c', roleId: 'dev', messageId: 'old-task' })).toBeUndefined()
    expect(allowProjectRuns(store, { chatId: 'c', roleId: 'qa', messageId: 'ask' })).toBe(false)
    // A member not in the group, another group, a message that is gone.
    expect(projectRunAllowance(store, { chatId: 'c', roleId: 'stranger', messageId: 'task' })).toBeUndefined()
    expect(projectRunAllowance(store, { chatId: 'other', roleId: 'dev', messageId: 'task' })).toBeUndefined()
    expect(projectRunAllowance(store, { chatId: 'c', roleId: 'dev', messageId: 'gone' })).toBeUndefined()
    // A project stopped or done.
    for (const status of ['stopped', 'done'] as const) {
      const ended = setup({ status, runAllowedRoleIds: ['dev'] })
      expect(projectRunAllowance(ended, devTask)).toBeUndefined()
      expect(allowProjectRuns(ended, devTask)).toBe(false)
    }
  })

  it('reads and writes the store, telling the page when it gives the grant', async () => {
    let store = setup()
    const broadcastStoreUpdated = vi.fn()
    const grants = createProjectRunGrants({
      loadStore: async () => store,
      mutateStore: async mutator => {
        const next = structuredClone(store)
        const result = await mutator(next)
        store = next
        return { store, result }
      },
      broadcastStoreUpdated,
    })
    expect(await grants.check(devTask)).toBe('can-allow')
    expect(await grants.allow(devTask)).toBe(true)
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(store)
    expect(await grants.check(devTask)).toBe('allowed')
  })
})

describe('letting a local agent read or edit for the whole project', () => {
  it('groups the agent\'s tools: reading and searching, editing; anything else (a command, a delete) is asked every time', () => {
    expect(projectToolKind('read')).toBe('read')
    expect(projectToolKind('search')).toBe('read')
    expect(projectToolKind('edit')).toBe('edit')
    for (const kind of ['execute', 'delete', 'move', 'fetch', 'think', 'other', undefined]) expect(projectToolKind(kind)).toBeUndefined()
  })

  it('can be offered for a request of the running project, and once given holds for that member and that kind only', () => {
    const store = setup()
    expect(projectToolAllowance(store, devTask, 'read')).toBe('can-allow')
    expect(allowProjectTools(store, devTask, 'read')).toBe(true)
    allowProjectTools(store, devTask, 'read')
    expect(store.chatsById.c.project!.toolAllowedKinds).toEqual({ dev: ['read'] })
    expect(projectToolAllowance(store, devTask, 'read')).toBe('allowed')
    expect(projectToolAllowance(store, devTask, 'edit')).toBe('can-allow')
    expect(projectToolAllowance(store, { chatId: 'c', roleId: 'qa', messageId: 'qa-task' }, 'read')).toBe('can-allow')
    allowProjectTools(store, devTask, 'edit')
    expect(store.chatsById.c.project!.toolAllowedKinds).toEqual({ dev: ['read', 'edit'] })

    // Outside the running project: not offered, and a grant does not hold.
    expect(projectToolAllowance(store, { chatId: 'c', roleId: 'dev', messageId: 'ask' }, 'read')).toBeUndefined()
    expect(projectToolAllowance(store, { chatId: 'c', roleId: 'dev', messageId: 'old-task' }, 'read')).toBeUndefined()
    expect(allowProjectTools(store, { chatId: 'c', roleId: 'qa', messageId: 'ask' }, 'read')).toBe(false)
    const ended = setup({ status: 'done', toolAllowedKinds: { dev: ['read'] } })
    expect(projectToolAllowance(ended, devTask, 'read')).toBeUndefined()
  })

  it('is taken back with 收回 together with the runs, one member at a time, and ends with the project', () => {
    const store = setup({ runAllowedRoleIds: ['dev', 'qa'], toolAllowedKinds: { dev: ['read', 'edit'], qa: ['read'] } })
    const project = store.chatsById.c.project!
    expect(revokeProjectGrants(project, 'dev')).toBe(true)
    expect(project.runAllowedRoleIds).toEqual(['qa'])
    expect(project.toolAllowedKinds).toEqual({ qa: ['read'] })
    expect(revokeProjectGrants(project, 'dev')).toBe(false)
    expect(revokeProjectGrants(project, 'qa')).toBe(true)
    expect(project.runAllowedRoleIds).toBeUndefined()
    expect(project.toolAllowedKinds).toBeUndefined()
    // Only some tools allowed, the runs asked each time: 收回 takes those back too.
    const tools = setup({ toolAllowedKinds: { qa: ['edit'] } }).chatsById.c.project!
    expect(revokeProjectGrants(tools, 'qa')).toBe(true)
    expect(tools.toolAllowedKinds).toBeUndefined()
    const all = setup({ runAllowedRoleIds: ['dev'], toolAllowedKinds: { dev: ['read'] } }).chatsById.c.project!
    clearProjectGrants(all)
    expect(all.runAllowedRoleIds).toBeUndefined()
    expect(all.toolAllowedKinds).toBeUndefined()
  })

  it('reads and writes the store, telling the page, and logs each grant', async () => {
    let store = setup()
    const broadcastStoreUpdated = vi.fn()
    const log = { info: vi.fn() }
    const grants = createProjectRunGrants({
      loadStore: async () => store,
      mutateStore: async mutator => {
        const next = structuredClone(store)
        const result = await mutator(next)
        store = next
        return { store, result }
      },
      broadcastStoreUpdated,
      log,
    })
    expect(await grants.checkTool(devTask, 'edit')).toBe('can-allow')
    expect(await grants.allowTool(devTask, 'edit')).toBe(true)
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(store)
    expect(await grants.checkTool(devTask, 'edit')).toBe('allowed')
    expect(log.info).toHaveBeenCalledWith('project-grant:tools-allowed', { chatId: 'c', roleId: 'dev', kind: 'edit' })
    await grants.allow(devTask)
    expect(log.info).toHaveBeenCalledWith('project-grant:runs-allowed', { chatId: 'c', roleId: 'dev' })
    // Not the project's request: nothing given, nothing logged.
    log.info.mockClear()
    expect(await grants.allowTool({ chatId: 'c', roleId: 'dev', messageId: 'ask' }, 'read')).toBe(false)
    expect(log.info).not.toHaveBeenCalled()
  })
})
