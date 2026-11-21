// A notice over the group list when the Tavily account has used 80% of its credits, as Tavily last
// said (src/shared/webSearchUsage.ts), with 查看用量 and 知道了 (put away until the limit is reached
// or a new cycle starts). It sits with 备份提醒 and looks like it.
import type { OpenTeamStore } from '../group/types'
import { searchQuotaNoticeDue } from '../shared/webSearchUsage'

export interface WebSearchQuotaNoticeDependencies {
  element: HTMLElement | null
  language(): 'en' | 'zh-CN'
  getStore(): OpenTeamStore
  openUsage(): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export function createWebSearchQuotaNotice(deps: WebSearchQuotaNoticeDependencies): { render(): void } {
  let shown = ''

  function render(): void {
    const box = deps.element
    if (!box) return
    const en = deps.language() === 'en'
    const store = deps.getStore()
    const state = store.settings.webSearch ? searchQuotaNoticeDue(store.webSearchUsage) : undefined
    const percent = state ? Math.round(state.share * 100) : 0
    const whose = state?.scope === 'key' ? (en ? 'This Tavily key' : '这个 Tavily Key ') : (en ? 'Your Tavily account' : 'Tavily 账户')
    const text = !state
      ? ''
      : state.reached
        ? (en ? `${whose} has used all ${state.limit} of its credits this cycle. API members' searches fail until they renew.` : `${whose}本期的 ${state.limit} 个额度已经用完，API 成员的搜索会失败，直到额度恢复。`)
        : (en ? `${whose} has used ${state.used} of its ${state.limit} credits this cycle (${percent}%). Once they are used up, API members' searches fail.` : `${whose}本期已用 ${state.used} / ${state.limit} 个额度（${percent}%）。用完后 API 成员的搜索会失败。`)
    const key = JSON.stringify([en, text])
    if (key === shown) return
    shown = key
    box.hidden = !text
    if (!text) {
      box.replaceChildren()
      return
    }
    const paragraph = document.createElement('p')
    paragraph.className = 'backup-reminder-text'
    paragraph.textContent = text
    const actions = document.createElement('div')
    actions.className = 'backup-reminder-actions'
    const usage = button(en ? 'See usage' : '查看用量', 'btn btn-primary btn-small', () => deps.openUsage())
    const dismiss = button(en ? 'Got it' : '知道了', 'btn btn-ghost btn-small', () => {
      dismiss.disabled = true
      deps.runCommand('WEB_SEARCH_NOTICE_DISMISS').catch(error => {
        dismiss.disabled = false
        deps.showError(error instanceof Error ? error.message : String(error))
      })
    })
    actions.append(usage, dismiss)
    box.replaceChildren(paragraph, actions)
  }

  return { render }
}

function button(label: string, className: string, run: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = label
  node.addEventListener('click', run)
  return node
}
