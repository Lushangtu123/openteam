// Over a message that belongs to an orchestration (workflow) run: which step and what kind it is,
// and under a review node's reply, the review's decision and reasons.
import type { GroupMessage, OpenTeamStore, OrchestrationReviewResult } from '../group/types'

export function renderOrchestrationMessageLabel(message: GroupMessage): HTMLElement | undefined {
  if (!message.orchestrationKind) return undefined
  const label = document.createElement('div')
  label.className = `orchestration-message-label orchestration-message-${message.orchestrationKind}`
  label.textContent = orchestrationMessageLabelText(message)
  return label
}

function orchestrationMessageLabelText(message: GroupMessage): string {
  const parts = ['编排']
  if (message.orchestrationStageIndex !== undefined) parts.push(`第 ${message.orchestrationStageIndex + 1} 步`)
  parts.push(orchestrationKindLabel(message.orchestrationKind))
  return parts.join(' · ')
}

function orchestrationKindLabel(kind: GroupMessage['orchestrationKind']): string {
  if (kind === 'task') return '任务'
  if (kind === 'role') return '成员'
  if (kind === 'review') return '复核'
  return '状态'
}

export function renderOrchestrationReviewSummary(store: Pick<OpenTeamStore, 'orchestrationRunsById'>, message: GroupMessage): HTMLElement | undefined {
  if (message.orchestrationKind !== 'review') return undefined
  const result = findReviewResultForMessage(store, message)
  if (!result) return undefined
  const summary = document.createElement('div')
  summary.className = 'orchestration-review-summary'
  summary.append(reviewSummaryLine('决策', reviewDecisionLabel(result.decision)))
  if (result.reason) summary.append(reviewSummaryLine('原因', result.reason))
  if (result.failedCriteria.length > 0) summary.append(reviewSummaryLine('未通过', result.failedCriteria.join('、')))
  if (result.nextRoundInstruction) summary.append(reviewSummaryLine('重试说明', result.nextRoundInstruction))
  return summary
}

export function findReviewResultForMessage(store: Pick<OpenTeamStore, 'orchestrationRunsById'>, message: GroupMessage): OrchestrationReviewResult | undefined {
  if (!message.orchestrationRunId) return undefined
  const run = store.orchestrationRunsById[message.orchestrationRunId]
  for (const stageRun of run?.stageRuns ?? []) {
    const result = stageRun.reviewResults?.find(result => result.messageId === message.id)
    if (result) return result
  }
  return undefined
}

function reviewSummaryLine(label: string, value: string): HTMLElement {
  const line = document.createElement('div')
  line.className = 'orchestration-review-line'
  const labelEl = document.createElement('span')
  labelEl.textContent = `${label}：`
  const valueEl = document.createElement('span')
  valueEl.textContent = value
  line.append(labelEl, valueEl)
  return line
}

function reviewDecisionLabel(decision: OrchestrationReviewResult['decision']): string {
  if (decision === 'pass') return '通过'
  return '不通过'
}
