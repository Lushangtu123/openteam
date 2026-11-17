// The result of a 网站自检 (src/group/siteCheck.ts), at the end of the check's group, in the project
// board's card so that it matches both looks and both themes.
import { SITE_CHECK_TIMEOUT_MS, siteCheckResults, siteCheckSummary, type SiteCheckOutcome, type SiteCheckResult } from '../group/siteCheck'
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

    const list = element('ul', 'project-task-list')
    for (const result of results) list.append(resultRow(result, en))
    board.append(list)
    return board
  }

  function resultRow(result: SiteCheckResult, en: boolean): HTMLElement {
    const status = STATUS[result.outcome]
    const row = element('li', `project-task project-task-${status.tone}`)
    const main = element('div', 'project-task-main')
    main.append(element('div', 'project-task-title', result.label), element('p', 'project-board-detail', explanation(result, en)))
    row.append(element('span', 'project-task-status', en ? status.en : status.zh), main)
    return row
  }

  function scheduleTimeout(chat: GroupChat): void {
    const store = deps.getStore()
    const question = chat.messageIds.map(id => store.messagesById[id]).find(message => message?.type === 'user')
    if (!question || scheduled.has(chat.id)) return
    scheduled.add(chat.id)
    const wait = Math.max(0, question.createdAt + SITE_CHECK_TIMEOUT_MS + 1 - deps.now())
    window.setTimeout(() => {
      scheduled.delete(chat.id)
      deps.requestRender()
    }, wait)
  }

  return { renderBoard }
}

function explanation(result: SiteCheckResult, en: boolean): string {
  const detail = result.detail ? (en ? ` (${result.detail})` : `（${result.detail}）`) : ''
  switch (result.outcome) {
    case 'ok':
      return en ? 'Sends, and its reply is read back.' : '能发送，也能读到回复。'
    case 'waiting':
      return en ? 'Waiting for its reply.' : '正在等它回复。'
    case 'login':
      return en ? 'The site asks to sign in. Click "Open site" on its member card, sign in, then check again.' : '网站要求登录。点成员卡片上的「打开网站」登录后，再查一次。'
    case 'page-problem':
      return en ? `Something covers or breaks the page${detail}. Open the AI pages to see it.` : `页面被挡住或出错${detail}。打开 AI 网页看看。`
    case 'failed':
      return en ? `Sending or reading the reply failed${detail}.` : `发送或读取回复失败${detail}。`
    case 'not-sent':
      return en ? 'The question did not reach the page in 3 minutes.' : '3 分钟内没能把提问送进页面。'
    case 'no-reply':
      return en ? 'The question reached the page, but no reply was read in 3 minutes. The site may have changed.' : '提问已送进页面，但 3 分钟内没读到回复，网站可能改版了。'
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
