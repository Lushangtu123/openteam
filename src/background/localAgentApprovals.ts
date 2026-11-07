// Questions a local agent member waits on: whether to run a task at all, and whether to allow one of
// the agent's actions. The question is put on the member (so the page shows it) and the run waits
// for the user's answer; stopping the reply drops the question.
import type { OpenTeamStore, PendingApproval } from '../group/types'

export interface ApprovalContext {
  chatId: string
  roleId: string
}

export interface LocalAgentApprovalsDependencies {
  newId(prefix: string): string
  now(): number
  mutateStore<T>(mutator: (store: OpenTeamStore) => T): Promise<{ store: OpenTeamStore; result: T }>
  broadcastStoreUpdated(store: OpenTeamStore): Promise<void> | void
}

export function createLocalAgentApprovals(deps: LocalAgentApprovalsDependencies) {
  const waiting = new Map<string, { context: ApprovalContext; resolve(optionId: string | undefined): void }>()

  async function setOnRole(context: ApprovalContext, approval: PendingApproval | undefined, onlyId?: string): Promise<void> {
    const { store } = await deps.mutateStore(store => {
      const role = store.rolesById[context.roleId]
      if (!role || (role.chatId !== context.chatId && !store.chatsById[context.chatId]?.roleIds.includes(role.id))) return
      if (approval) role.pendingApproval = approval
      else if (!onlyId || role.pendingApproval?.id === onlyId) delete role.pendingApproval
    })
    await deps.broadcastStoreUpdated(store)
  }

  // Shows the question and waits; resolves to the chosen option, or undefined when the run stops.
  async function ask(context: ApprovalContext, question: Omit<PendingApproval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return undefined
    const id = deps.newId('approval')
    const answer = new Promise<string | undefined>(resolve => {
      waiting.set(id, { context, resolve })
      signal?.addEventListener('abort', () => void finish(id, undefined), { once: true })
    })
    await setOnRole(context, { ...question, id, createdAt: deps.now() })
    return answer
  }

  async function finish(id: string, optionId: string | undefined): Promise<boolean> {
    const entry = waiting.get(id)
    if (!entry) return false
    waiting.delete(id)
    // The question leaves the page before the run goes on, so the page never gets the older state
    // after what the run does next.
    await setOnRole(entry.context, undefined, id)
    entry.resolve(optionId)
    return true
  }

  // The user's answer. A question whose run is gone (the browser restarted the background) is
  // cleared and reported.
  async function decide(context: ApprovalContext, approvalId: string, optionId: string): Promise<void> {
    if (await finish(approvalId, optionId)) return
    await setOnRole(context, undefined, approvalId)
    throw new Error('这个请求已经失效（可能后台重启过），请重新发送任务。')
  }

  return { ask, decide }
}

export type LocalAgentApprovals = ReturnType<typeof createLocalAgentApprovals>
