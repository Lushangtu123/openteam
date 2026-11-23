import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore, ProjectRun } from '../group/types'
import { allowProjectRuns, createProjectRunGrants, projectRunAllowance } from './projectRunGrants'

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
