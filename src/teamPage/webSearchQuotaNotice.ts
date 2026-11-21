// A notice over the group list when 联网搜索 has used 80% of the monthly allowance the user entered
// (src/shared/webSearchUsage.ts), with 查看用量 and 知道了 (put away until next month). It sits with
// 备份提醒 and looks like it.
import type { OpenTeamStore } from '../group/types'
import { currentMonth, searchQuotaState } from '../shared/webSearchUsage'

export interface WebSearchQuotaNoticeDependencies {
  element: HTMLElement | null
  language(): 'en' | 'zh-CN'
  getStore(): OpenTeamStore
  now(): number
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
    const state = searchQuotaState(store.webSearchUsage, store.settings.webSearch?.monthlyLimit, deps.now())
    const putAway = store.webSearchUsage?.noticeMonth === currentMonth(deps.now())
    const text = state.near && state.limit && !putAway
      ? state.reached
        ? (en ? `Web search used ${state.used} searches this month, the allowance of ${state.limit} you entered. API members' searches may already fail.` : `联网搜索本月已用 ${state.used} 次，到了你填的额度 ${state.limit} 次。API 成员的搜索可能已经失败。`)
        : (en ? `Web search used ${state.used} searches this month, ${Math.round(state.share! * 100)}% of the allowance of ${state.limit} you entered. Once it is used up, API members' searches fail.` : `联网搜索本月已用 ${state.used} 次，是你填的额度 ${state.limit} 次的 ${Math.round(state.share! * 100)}%。用完后 API 成员的搜索会失败。`)
      : ''
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
