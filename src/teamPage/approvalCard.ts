// What a local agent member waits on: a run to allow (with the whole task), or one of the agent's
// actions. The buttons are the agent's own choices. The chat shows the cards, and so do windows that
// cover the chat while members reply (the team-formation card), so the question is never hidden.
import type { GroupRole, PendingApproval } from '../group/types'

export interface ApprovalCardDependencies {
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

// One per place that shows the cards. A card is built once per question and reused while it waits,
// so re-rendering keeps the task text the user opened and the buttons disabled after a click.
export function createApprovalCards(deps: ApprovalCardDependencies) {
  let cache = new Map<string, HTMLElement>()

  // The waiting members' cards, by role id.
  function cardsByRole(chatId: string, roles: GroupRole[]): Map<string, HTMLElement> {
    const next = new Map<string, HTMLElement>()
    const byRole = new Map<string, HTMLElement>()
    for (const role of roles) {
      const approval = role.pendingApproval
      if (!approval) continue
      const node = cache.get(approval.id) ?? buildApprovalCard(chatId, role, approval, deps)
      next.set(approval.id, node)
      byRole.set(role.id, node)
    }
    cache = next
    return byRole
  }

  return { cardsByRole }
}

function buildApprovalCard(chatId: string, role: GroupRole, approval: PendingApproval, deps: ApprovalCardDependencies): HTMLElement {
  const card = document.createElement('section')
  card.className = `approval-card approval-${approval.kind}`
  card.dataset.approvalId = approval.id
  card.setAttribute('role', 'alertdialog')
  const title = document.createElement('div')
  title.className = 'approval-card-title'
  title.textContent = approval.title
  card.append(title)
  if (approval.detail && approval.kind === 'run') {
    const details = document.createElement('details')
    details.className = 'approval-card-detail'
    const summary = document.createElement('summary')
    summary.textContent = '看看要执行的任务'
    const text = document.createElement('pre')
    text.textContent = approval.detail
    details.append(summary, text)
    card.append(details)
  } else if (approval.detail) {
    const detail = document.createElement('p')
    detail.className = 'approval-card-note'
    detail.textContent = approval.detail
    card.append(detail)
  }
  const actions = document.createElement('div')
  actions.className = 'approval-card-actions'
  let primaryGiven = false
  for (const option of approval.options) {
    const button = document.createElement('button')
    button.type = 'button'
    const allow = option.kind?.startsWith('allow') ?? false
    button.className = `btn btn-small${allow && !primaryGiven ? ' btn-primary' : ''}`
    if (allow) primaryGiven = true
    button.textContent = option.label
    button.addEventListener('click', () => {
      for (const other of actions.querySelectorAll('button')) other.disabled = true
      deps.runCommand('GROUP_LOCAL_AGENT_DECIDE', { chatId, roleId: role.id, approvalId: approval.id, optionId: option.id })
        .catch(error => {
          for (const other of actions.querySelectorAll('button')) other.disabled = false
          deps.showError(error instanceof Error ? error.message : String(error))
        })
    })
    actions.append(button)
  }
  card.append(actions)
  return card
}
