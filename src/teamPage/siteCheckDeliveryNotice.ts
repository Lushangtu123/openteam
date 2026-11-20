// A notice over the group list when 定时自检 (src/group/siteCheckSchedule.ts) found something to send
// and its destination did not take it: where it did not go and why, 打开定时自检 (whose 测试推送
// asks for the site's access again) and 知道了 (put away for that run). It sits with 备份提醒.
import { chatSiteLabel } from '../group/chatSites'
import type { OpenTeamStore } from '../group/types'

export interface SiteCheckDeliveryNoticeDependencies {
  element: HTMLElement | null
  language(): 'en' | 'zh-CN'
  getStore(): OpenTeamStore
  openSchedule(): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export function createSiteCheckDeliveryNotice(deps: SiteCheckDeliveryNoticeDependencies): { render(): void } {
  let shown = ''

  function render(): void {
    const box = deps.element
    if (!box) return
    const en = deps.language() === 'en'
    const run = deps.getStore().settings.siteCheckSchedule?.lastRun
    const delivery = run?.delivery
    const text = run && delivery?.status === 'failed' && !run.noticeDismissed ? message(run, en) : ''
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
    const open = button(en ? 'Open scheduled check' : '打开定时自检', 'btn btn-primary btn-small', () => deps.openSchedule())
    const dismiss = button(en ? 'Got it' : '知道了', 'btn btn-ghost btn-small', () => {
      dismiss.disabled = true
      deps.runCommand('SITE_CHECK_NOTICE_DISMISS').catch(error => {
        dismiss.disabled = false
        deps.showError(error instanceof Error ? error.message : String(error))
      })
    })
    actions.append(open, dismiss)
    box.replaceChildren(paragraph, actions)
  }

  return { render }
}

function message(run: NonNullable<NonNullable<OpenTeamStore['settings']['siteCheckSchedule']>['lastRun']>, en: boolean): string {
  const delivery = run.delivery!
  const detail = delivery.detail ? (en ? `: ${delivery.detail}` : `：${delivery.detail}`) : ''
  if (run.status === 'failed') {
    return en
      ? `The scheduled site check could not run, and that was not sent to "${delivery.destination}"${detail}`
      : `定时自检没能运行，也没发到「${delivery.destination}」${detail}`
  }
  const sites = (run.problems ?? []).map(item => chatSiteLabel(item.site)).join(en ? ', ' : '、')
  return en
    ? `The scheduled site check found ${sites || 'sites'} needing attention, but that was not sent to "${delivery.destination}"${detail}`
    : `定时自检发现 ${sites || '网站'} 要处理，但没发到「${delivery.destination}」${detail}`
}

function button(label: string, className: string, run: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = label
  node.addEventListener('click', run)
  return node
}
