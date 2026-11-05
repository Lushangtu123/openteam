import { roleMentionLabel, roleMentionLabelOptionsFromSettings, roleModelLabel } from '../group/mentionParser'
import { collectReplies, comparisonDiscussionRequest, comparisonSummaryRequest, formatComparisonDocument, hasAnswered, pickSummarizer, type ComparedReply, type ReplyComparison } from '../group/replyComparison'
import type { GroupRole, OpenTeamLanguage, OpenTeamStore } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import { renderMarkdownInto } from './markdownRender'

export interface ReplyComparisonViewDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  copyText(text: string): Promise<void>
  showError(message: string): void
  showSuccess(message: string): void
}

export interface ReplyComparisonView {
  open(questionId: string): void
  close(): void
  // Updates an open comparison when replies come in.
  refresh(): void
}

const SUMMARY_FILE_NAME = { 'zh-CN': '回复对比.md', en: 'reply-comparison.md' } as const

export function createReplyComparisonView(deps: ReplyComparisonViewDependencies): ReplyComparisonView {
  let opened: { questionId: string; backdrop: HTMLElement; columns: HTMLElement; footer: HTMLElement; signature: string } | undefined
  let summarizerRoleId: string | undefined
  let sending = false

  function open(questionId: string): void {
    close()
    const comparison = comparisonFor(questionId)
    if (!comparison) return
    // Chosen again for each question: who is best placed depends on who answered it.
    summarizerRoleId = undefined

    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop reply-compare-modal'
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) close()
    })
    const dialog = document.createElement('section')
    dialog.className = 'modal reply-compare-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'reply-compare-title')

    const header = document.createElement('div')
    header.className = 'modal-header reply-compare-header'
    const heading = document.createElement('div')
    const title = document.createElement('h2')
    title.id = 'reply-compare-title'
    title.textContent = ui('对比回复')
    const question = document.createElement('p')
    question.className = 'reply-compare-question'
    question.textContent = comparison.question.content
    heading.append(title, question)
    const closeButton = document.createElement('button')
    closeButton.type = 'button'
    closeButton.className = 'icon-btn modal-close'
    closeButton.setAttribute('aria-label', ui('关闭'))
    closeButton.textContent = '×'
    closeButton.addEventListener('click', () => close())
    header.append(heading, closeButton)

    const columns = document.createElement('div')
    columns.className = 'reply-compare-columns'
    const footer = document.createElement('div')
    footer.className = 'reply-compare-footer'

    dialog.append(header, columns, footer)
    backdrop.append(dialog)
    document.body.append(backdrop)
    document.addEventListener('keydown', handleEscape)
    opened = { questionId, backdrop, columns, footer, signature: '' }
    render(comparison)
    closeButton.focus()
  }

  function close(): void {
    opened?.backdrop.remove()
    opened = undefined
    document.removeEventListener('keydown', handleEscape)
  }

  function refresh(): void {
    if (!opened) return
    const comparison = comparisonFor(opened.questionId)
    if (!comparison) {
      close()
      return
    }
    render(comparison)
  }

  function comparisonFor(questionId: string): ReplyComparison | undefined {
    const question = deps.getStore().messagesById[questionId]
    return question?.type === 'user' ? collectReplies(deps.getStore(), question) : undefined
  }

  function render(comparison: ReplyComparison): void {
    if (!opened) return
    const signature = JSON.stringify(comparison.replies.map(reply => [reply.roleId, reply.status, reply.message?.id, reply.message?.content.length]))
    if (signature !== opened.signature) {
      opened.signature = signature
      // Keep each column where the reader left it while replies stream in.
      const scrollTops = new Map([...opened.columns.querySelectorAll<HTMLElement>('.reply-compare-column')].map(column => [column.dataset.roleId, column.querySelector<HTMLElement>('.reply-compare-body')?.scrollTop ?? 0]))
      opened.columns.style.setProperty('--reply-columns', String(Math.max(1, comparison.replies.length)))
      opened.columns.replaceChildren(...comparison.replies.map(reply => column(reply)))
      for (const element of opened.columns.querySelectorAll<HTMLElement>('.reply-compare-column')) {
        const body = element.querySelector<HTMLElement>('.reply-compare-body')
        if (body) body.scrollTop = scrollTops.get(element.dataset.roleId) ?? 0
      }
    }
    renderFooter(comparison)
  }

  function column(reply: ComparedReply): HTMLElement {
    const element = document.createElement('article')
    element.className = `reply-compare-column reply-compare-${reply.status}`
    element.dataset.roleId = reply.roleId

    const header = document.createElement('header')
    header.className = 'reply-compare-column-header'
    const name = document.createElement('span')
    name.className = 'reply-compare-name'
    name.textContent = reply.roleName
    header.append(name)
    if (reply.role) {
      const model = document.createElement('span')
      model.className = `role-site-badge ${reply.role.modelSource === 'external' ? 'site-pill-external' : `site-pill-${reply.role.chatSite ?? 'gemini'}`}`
      model.textContent = roleModelLabel(reply.role, mentionOptions())
      header.append(model)
    }
    if (reply.status !== 'replied') {
      const state = document.createElement('span')
      state.className = 'reply-compare-state'
      state.textContent = ui({ replying: '正在回复…', failed: '回复失败', waiting: '还没有回复', replied: '' }[reply.status])
      header.append(state)
    }

    const body = document.createElement('div')
    body.className = 'reply-compare-body'
    const content = reply.message?.content.trim()
    if (content) renderMarkdownInto(body, content)
    else body.textContent = ui(reply.status === 'failed' ? '这位人员没有给出回复。' : '回复到了会显示在这里。')
    element.append(header, body)
    return element
  }

  function renderFooter(comparison: ReplyComparison): void {
    if (!opened) return
    const store = deps.getStore()
    const chat = store.chatsById[comparison.question.chatId]
    const roles = (chat?.roleIds ?? []).map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
    const answerers = comparison.replies.filter(reply => reply.status === 'replied' && reply.role).map(reply => reply.role as GroupRole)
    const enough = answerers.length >= 2
    if (!summarizerRoleId || !roles.some(role => role.id === summarizerRoleId)) {
      summarizerRoleId = pickSummarizer(roles, comparison, store.settings.defaultChatSite)?.id
    }

    // Step one: let the people who answered respond to each other, only where they disagree.
    const discuss = document.createElement('button')
    discuss.type = 'button'
    discuss.className = 'btn reply-compare-discuss'
    discuss.textContent = ui('讨论分歧')
    discuss.title = ui('把所有回答发给回答过的人员，请 TA 们只针对不同意的地方回应')
    discuss.disabled = sending || !enough
    discuss.addEventListener('click', () => {
      void send(comparison, answerers, comparisonDiscussionRequest, ui(`已请 ${answerers.length} 位人员针对分歧讨论`))
    })

    const label = document.createElement('label')
    label.className = 'reply-compare-summarizer'
    label.append(document.createTextNode(ui('请')))
    const select = document.createElement('select')
    select.className = 'reply-compare-select'
    for (const role of roles) {
      const option = document.createElement('option')
      option.value = role.id
      option.textContent = roleMentionLabel(role, mentionOptions())
      option.selected = role.id === summarizerRoleId
      select.append(option)
    }
    select.addEventListener('change', () => {
      summarizerRoleId = select.value
      renderFooter(comparison)
    })
    label.append(select)

    const summarizer = roles.find(role => role.id === summarizerRoleId)
    const summarize = document.createElement('button')
    summarize.type = 'button'
    summarize.className = 'btn btn-primary reply-compare-summarize'
    summarize.textContent = ui(sending ? '正在发送…' : '汇总异同')
    summarize.disabled = sending || !enough || !summarizer
    summarize.addEventListener('click', () => {
      if (summarizer) void send(comparison, [summarizer], comparisonSummaryRequest, ui(`已请 ${summarizer.name} 汇总异同`))
    })

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'btn btn-ghost reply-compare-copy'
    copy.textContent = ui('复制对比')
    copy.disabled = answerers.length === 0
    copy.addEventListener('click', () => {
      deps.copyText(comparisonDocument(comparison))
        .then(() => deps.showSuccess(ui('已复制对比内容')))
        .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })

    const hints = document.createElement('div')
    hints.className = 'reply-compare-hints'
    const hint = (text: string, className = '') => {
      const element = document.createElement('p')
      element.className = `reply-compare-hint ${className}`.trim()
      element.textContent = ui(text)
      hints.append(element)
    }
    if (!enough) {
      hint('至少要有两份回复才能讨论或汇总。')
    } else {
      hint('讨论分歧：回答过的人员会收到所有回答，只针对不同意的地方回应。汇总异同：由你选的人员整理共识、分歧和需要核实的地方。')
      if (hasAnswered(comparison, summarizerRoleId)) hint('TA 也回答了这个问题，汇总可能偏向自己的观点。换一位没参与回答、或用不同模型的人员会更客观。', 'reply-compare-warning')
    }
    hint('几位都同意，不代表一定正确：数据、引语和日期请到原始出处核实。', 'reply-compare-factcheck')

    opened.footer.replaceChildren(discuss, label, summarize, copy, hints)
  }

  // Sends the comparison as an attached file to `recipients`, with a request built for its file name.
  async function send(comparison: ReplyComparison, recipients: GroupRole[], request: (fileName: string, language: OpenTeamLanguage) => string, success: string): Promise<void> {
    if (recipients.length === 0 || sending) return
    const language = normalizeLanguage(deps.getStore().settings.language)
    const fileName = SUMMARY_FILE_NAME[language]
    const text = comparisonDocument(comparison)
    sending = true
    renderFooter(comparison)
    try {
      await deps.runCommand('GROUP_MESSAGE_SEND', {
        chatId: comparison.question.chatId,
        raw: `${recipients.map(role => `@${roleMentionLabel(role, mentionOptions())}`).join(' ')} ${request(fileName, language)}`,
        uploads: [{ kind: 'text', fileName, mimeType: 'text/markdown', size: new TextEncoder().encode(text).length, text }],
      })
      close()
      deps.showSuccess(success)
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : String(error))
    } finally {
      sending = false
      if (opened) renderFooter(comparison)
    }
  }

  function comparisonDocument(comparison: ReplyComparison): string {
    return formatComparisonDocument(comparison, normalizeLanguage(deps.getStore().settings.language), reply => reply.role ? roleMentionLabel(reply.role, mentionOptions()) : reply.roleName)
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  function mentionOptions() {
    return roleMentionLabelOptionsFromSettings(deps.getStore().settings)
  }

  function ui(source: string): string {
    return translateUi(source, normalizeLanguage(deps.getStore().settings.language))
  }

  return { open, close, refresh }
}
