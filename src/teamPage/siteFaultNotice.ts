// 网站失效提醒 on the page (src/group/siteFaults.ts): a notice over the group list naming each site
// that keeps failing in ways that point at a changed page, with 运行网站自检 and 知道了 (the notice
// stays away until the site replies and then fails again). It sits with 备份提醒 and looks like it.
import { siteFaultMessage, siteFaultNotices } from '../group/siteFaults'
import type { OpenTeamStore } from '../group/types'
import { createIcon } from './icons'

export interface SiteFaultNoticeDependencies {
  element: HTMLElement | null
  language(): 'en' | 'zh-CN'
  getStore(): OpenTeamStore
  startSiteCheck(): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export function createSiteFaultNotice(deps: SiteFaultNoticeDependencies): { render(): void } {
  // What it shows now: built again only when that changes, so a page update keeps the focus.
  let shown = ''

  function render(): void {
    const box = deps.element
    if (!box) return
    const en = deps.language() === 'en'
    const notices = siteFaultNotices(deps.getStore())
    const key = JSON.stringify([en, notices.map(notice => [notice.site, notice.fault.count, notice.fault.step])])
    if (key === shown) return
    shown = key
    box.hidden = notices.length === 0
    if (notices.length === 0) {
      box.replaceChildren()
      return
    }
    const texts = notices.map(notice => {
      const text = document.createElement('p')
      text.className = 'backup-reminder-text'
      text.textContent = siteFaultMessage(notice, en)
      return text
    })
    const actions = document.createElement('div')
    actions.className = 'backup-reminder-actions'
    const check = button(en ? 'Run site check' : '运行网站自检', 'btn btn-primary btn-small', () => deps.startSiteCheck())
    check.prepend(createIcon('retry'))
    const dismiss = button(en ? 'Got it' : '知道了', 'btn btn-ghost btn-small', () => {
      dismiss.disabled = true
      Promise.all(notices.map(notice => deps.runCommand('SITE_FAULT_DISMISS', { site: notice.site })))
        .catch(error => {
          dismiss.disabled = false
          deps.showError(error instanceof Error ? error.message : String(error))
        })
    })
    actions.append(check, dismiss)
    box.replaceChildren(...texts, actions)
  }

  return { render }
}

function button(label: string, className: string, run: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  const text = document.createElement('span')
  text.textContent = label
  node.append(text)
  node.addEventListener('click', run)
  return node
}
