import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createLocalAgentApprovals } from './localAgentApprovals'

function setup() {
  let store: OpenTeamStore = createDefaultStore()
  store.chatsById['chat-1'] = { id: 'chat-1', name: '群', mode: 'collaborative', roleIds: ['role-1'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.rolesById['role-1'] = { id: 'role-1', chatId: 'chat-1', name: '程序员', status: 'thinking', contextCursor: 0, createdAt: 0, updatedAt: 0 }
  let seq = 0
  const broadcastStoreUpdated = vi.fn()
  const approvals = createLocalAgentApprovals({
    newId: prefix => `${prefix}-${++seq}`,
    now: () => 5,
    mutateStore: async mutator => {
      const result = mutator(store)
      store = structuredClone(store)
      return { store, result }
    },
    broadcastStoreUpdated,
  })
  return { approvals, role: () => store.rolesById['role-1'], broadcastStoreUpdated }
}

const context = { chatId: 'chat-1', roleId: 'role-1' }
const question = { kind: 'run' as const, title: '要执行吗？', options: [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }] }

describe('local agent approvals', () => {
  it('shows the question on the member until the user answers', async () => {
    const { approvals, role, broadcastStoreUpdated } = setup()
    const answer = approvals.ask(context, question)
    await vi.waitFor(() => expect(role().pendingApproval).toEqual({ ...question, id: 'approval-1', createdAt: 5 }))
    await approvals.decide(context, 'approval-1', 'allow')
    expect(await answer).toBe('allow')
    expect(role().pendingApproval).toBeUndefined()
    expect(broadcastStoreUpdated).toHaveBeenCalledTimes(2)
  })

  it('drops the question when the reply is stopped, and reports an answer that came too late', async () => {
    const { approvals, role } = setup()
    const controller = new AbortController()
    const answer = approvals.ask(context, question, controller.signal)
    await vi.waitFor(() => expect(role().pendingApproval?.id).toBe('approval-1'))
    controller.abort()
    expect(await answer).toBeUndefined()
    await vi.waitFor(() => expect(role().pendingApproval).toBeUndefined())
    await expect(approvals.decide(context, 'approval-1', 'allow')).rejects.toThrow('这个请求已经失效')
  })
})
