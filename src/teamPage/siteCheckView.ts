// The result of a 网站自检 (src/group/siteCheck.ts), at the end of the check's group, in the project
// board's card so that it matches both looks and both themes.
import { siteCheckDeadline, siteCheckExplanation, siteCheckResults, siteCheckSummary, type SiteCheckOutcome, type SiteCheckResult } from '../group/siteCheck'
import type { GroupChat, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'

export interface SiteCheckViewDependencies {
  getStore(): OpenTeamStore
  now(): number
  // Draws the chat again: a site still waiting is reported as not answering once its time is up,
  // which no store change announces.
  requestRender(): void
}

export interface SiteCheckView {
  renderBoard(chat: GroupChat): HTMLElement | undefined
}

const STATUS: Record<SiteCheckOutcome, { zh: string; en: string; tone: string }> = {
  ok: { zh: '正常', en: 'OK', tone: 'done' },
  waiting: { zh: '等待中', en: 'Waiting', tone: 'doing' },
  login: { zh: '需登录', en: 'Sign in', tone: 'blocked' },
  'page-problem': { zh: '页面问题', en: 'Page issue', tone: 'blocked' },
  failed: { zh: '失败', en: 'Failed', tone: 'failed' },
  'not-sent': { zh: '未发出', en: 'Not sent', tone: 'blocked' },
  'no-reply': { zh: '没回复', en: 'No reply', tone: 'failed' },
  'page-hidden': { zh: '没查成', en: 'Not checked', tone: 'blocked' },
}

export function createSiteCheckView(deps: SiteCheckViewDependencies): SiteCheckView {
  // Chats with a redraw already waiting for their time to run out.
  const scheduled = new Set<string>()

  function renderBoard(chat: GroupChat): HTMLElement | undefined {
    if (!chat.siteCheck) return undefined
    const store = deps.getStore()
    const en = normalizeLanguage(store.settings.language) === 'en'
    const results = siteCheckResults(store, chat, deps.now())
    if (results.some(result => result.outcome === 'waiting')) scheduleTimeout(chat)

    const board = element('section', 'project-board site-check-board')
    board.setAttribute('aria-label', en ? 'Site check' : '网站自检')
    const head = element('div', 'project-board-head')
    const title = element('div', 'project-board-title')
    title.append(element('span', 'project-board-chip', en ? 'Site check' : '网站自检'), element('span', '', siteCheckSummary(results, en ? 'en' : 'zh-CN')))
    head.append(title)
    board.append(head)
    if (chat.siteCheck.error) board.append(element('p', 'project-board-detail question site-check-error', chat.siteCheck.error))

    const list = element('ul', 'project-task-list')
    for (const result of results) list.append(resultRow(result, en))
    board.append(list)
    return board
  }

  function resultRow(result: SiteCheckResult, en: boolean): HTMLElement {
    const status = STATUS[result.outcome]
    const row = element('li', `project-task project-task-${status.tone}`)
    const main = element('div', 'project-task-main')
    main.append(element('div', 'project-task-title', result.label), element('p', 'project-board-detail', siteCheckExplanation(result, en)))
    row.append(element('span', 'project-task-status', en ? status.en : status.zh), main)
    return row
  }

  function scheduleTimeout(chat: GroupChat): void {
    const deadline = siteCheckDeadline(deps.getStore(), chat)
    if (deadline === undefined || scheduled.has(chat.id)) return
    scheduled.add(chat.id)
    const wait = Math.max(0, deadline + 1 - deps.now())
    window.setTimeout(() => {
      scheduled.delete(chat.id)
      deps.requestRender()
    }, wait)
  }

  return { renderBoard }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
