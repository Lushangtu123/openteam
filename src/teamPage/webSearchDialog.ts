// The window for 联网搜索 (src/shared/webSearch.ts), from the settings' 模型 tab: the user's Tavily
// key, pasted, tested, saved or removed. Saving and testing ask the browser for api.tavily.com from
// the click, as the browser asks only then. The key is shown only by its ends.
import { maskedSearchKey, readSearchKey, TAVILY_SEARCH_URL } from '../shared/webSearch'
import type { OpenTeamStore } from '../group/types'
import { hostAccessLabel, requestHostAccess } from '../shared/hostAccess'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'
import { searchQuotaState } from '../shared/webSearchUsage'

export interface WebSearchDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // A command whose answer is needed (the test's); throws why it failed.
  request(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>
  requestHostAccess?(url: string): Promise<boolean>
  confirm?(message: string): boolean
  onClose?(): void
}

export interface WebSearchDialog {
  refresh(): void
  close(): void
}

let openDialog: WebSearchDialog | undefined

export function currentWebSearchDialog(): WebSearchDialog | undefined {
  return openDialog
}

export function openWebSearchDialog(deps: WebSearchDialogDependencies): WebSearchDialog {
  openDialog?.close()
  const english = () => normalizeLanguage(deps.getStore().settings.language) === 'en'
  const t = (zh: string, en: string): string => english() ? en : zh
  const requestAccess = deps.requestHostAccess ?? (url => requestHostAccess(url))
  const confirm = deps.confirm ?? (message => window.confirm(message))
  const host = hostAccessLabel(TAVILY_SEARCH_URL)
  let busy = false

  const backdrop = element('div', 'modal-backdrop scheduled-tasks-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog scheduled-tasks-dialog web-search-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'web-search-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('联网搜索', 'Web search'))
  title.id = 'web-search-title'
  const intro = element('p', 'tiny')
  const link = element('a', '', 'tavily.com')
  link.href = 'https://tavily.com/'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  intro.append(
    document.createTextNode(t('允许联网搜索的 API 成员回答时可以用 Tavily 搜索网上的资料，每次回答最多搜 3 次，每次用掉 1 个 Tavily 额度。到 ', 'API members allowed to search can look things up through Tavily as they answer, at most 3 searches an answer, each using one Tavily credit. Sign up at ')),
    link,
    document.createTextNode(t(' 注册（有免费额度），复制控制台里的 API Key 粘贴到这里。Key 只发给 api.tavily.com；导出备份时和 API Key 一样默认不导出。', ' (it has a free allowance), copy the API key from its dashboard and paste it here. The key goes only to api.tavily.com; backups leave it out, as they do API keys.')),
  )
  heading.append(title, intro)
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const state = element('p', 'tiny scheduled-task-meta web-search-state')
  state.setAttribute('role', 'status')

  const form = element('form', 'team-setup-form scheduled-task-form')
  form.noValidate = true
  const field = element('div', 'field')
  const label = element('label', '', t('Tavily API Key', 'Tavily API key'))
  label.htmlFor = 'web-search-key'
  const keyInput = element('input')
  keyInput.id = 'web-search-key'
  keyInput.type = 'password'
  keyInput.autocomplete = 'off'
  keyInput.spellcheck = false
  keyInput.placeholder = 'tvly-…'
  const testStatus = element('p', 'tiny web-search-test-status')
  testStatus.setAttribute('role', 'status')
  field.append(label, keyInput, testStatus)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const saved = element('p', 'site-check-schedule-saved web-search-saved')
  saved.setAttribute('role', 'status')
  saved.hidden = true
  const remove = button(t('移除', 'Remove'), 'btn btn-ghost', () => void removeKey())
  const test = button(t('测试', 'Test'), 'btn', () => testKey())
  const save = button(t('保存', 'Save'), 'btn btn-primary', () => undefined)
  save.type = 'submit'
  actions.append(saved, remove, test, save)
  // The allowance the user's plan gives a month: a notice comes at 80% of it.
  const limitRow = element('div', 'field web-search-limit-row')
  const limitLabel = element('label', '', t('每月额度（可选）', 'Monthly allowance (optional)'))
  limitLabel.htmlFor = 'web-search-limit'
  const limitLine = element('div', 'web-search-limit-line')
  const limitInput = element('input')
  limitInput.id = 'web-search-limit'
  limitInput.type = 'number'
  limitInput.min = '1'
  limitInput.step = '1'
  limitInput.inputMode = 'numeric'
  limitInput.placeholder = t('例如 1000', 'e.g. 1000')
  const limitSave = button(t('保存额度', 'Save allowance'), 'btn', () => void saveLimit())
  limitLine.append(limitInput, limitSave)
  const month = element('p', 'tiny web-search-month')
  month.setAttribute('role', 'status')
  limitRow.append(limitLabel, limitLine, month, element('p', 'tiny', t(
    '填你在 Tavily 的套餐每月能搜多少次，用到八成时 OpenTeam 会提醒你。这里按自然月统计 OpenTeam 的搜索（测试也算）；Tavily 那边按你账户的周期重置。',
    "How many searches your Tavily plan allows a month; OpenTeam tells you at 80%. OpenTeam's searches (tests included) are counted by calendar month here; Tavily resets by your account's own cycle.",
  )))
  form.append(field, error, actions, limitRow)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void saveKey()
  })
  keyInput.addEventListener('input', () => {
    error.textContent = ''
    testStatus.textContent = ''
    saved.hidden = true
  })

  dialog.append(header, state, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)

  const controller: WebSearchDialog = { refresh: render, close }
  openDialog = controller
  render()
  keyInput.focus()
  return controller

  function render(): void {
    const store = deps.getStore()
    const key = store.settings.webSearch?.apiKey
    state.textContent = key ? t(`已设置：${maskedSearchKey(key)}`, `Set: ${maskedSearchKey(key)}`) : t('还没有设置 Key，API 成员不会搜索。', 'No key yet: API members do not search.')
    remove.hidden = !key
    limitRow.hidden = !key
    const quota = searchQuotaState(store.webSearchUsage, store.settings.webSearch?.monthlyLimit, Date.now())
    month.textContent = quota.limit
      ? t(`本月已搜索 ${quota.used} 次，额度 ${quota.limit} 次（${Math.round((quota.share ?? 0) * 100)}%）。用到八成时会提醒你。`, `${quota.used} searches this month, of an allowance of ${quota.limit} (${Math.round((quota.share ?? 0) * 100)}%). You are told at 80%.`)
      : t(`本月已搜索 ${quota.used} 次。`, `${quota.used} searches this month.`)
    if (document.activeElement !== limitInput && !limitInput.value) limitInput.value = store.settings.webSearch?.monthlyLimit ? String(store.settings.webSearch.monthlyLimit) : ''
  }

  async function saveLimit(): Promise<void> {
    const raw = limitInput.value.trim()
    const value = raw ? Number(raw) : null
    if (value !== null && !(Number.isInteger(value) && value >= 1)) {
      error.textContent = t('每月额度要写一个正整数', 'The monthly allowance must be a whole number above 0')
      limitInput.focus()
      return
    }
    try {
      await deps.runCommand('WEB_SEARCH_LIMIT_SET', { monthlyLimit: value })
      error.textContent = ''
      render()
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    }
  }

  async function saveKey(): Promise<void> {
    let apiKey: string
    try {
      apiKey = readSearchKey(keyInput.value)
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
      keyInput.focus()
      return
    }
    // Asked in the click itself: the browser shows its prompt only then.
    const access = requestAccess(TAVILY_SEARCH_URL)
    if (busy) return
    busy = true
    saved.hidden = true
    try {
      await deps.runCommand('WEB_SEARCH_SAVE', { apiKey })
      keyInput.value = ''
      error.textContent = ''
      saved.replaceChildren(createIcon('check'), element('span', '', t('已保存。允许联网搜索的 API 成员回答时就能搜索了。', 'Saved. API members allowed to search can now search as they answer.')))
      saved.hidden = false
      render()
      if (!await access) error.textContent = t(`已保存，但没有允许 OpenTeam 访问 ${host}，搜索会失败。点「测试」可以再允许一次。`, `Saved, but OpenTeam may not reach ${host}, so searches will fail. Click Test to allow it.`)
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy = false
    }
  }

  function testKey(): void {
    const typed = keyInput.value.trim()
    // Asked in the click itself: the browser shows its prompt only then.
    const access = requestAccess(TAVILY_SEARCH_URL)
    testStatus.textContent = t('正在搜索…', 'Searching…')
    void (async () => {
      if (!await access) {
        testStatus.textContent = t(`需要你允许 OpenTeam 访问 ${host}，搜索才能用。`, `OpenTeam needs your permission to reach ${host} to search.`)
        return
      }
      try {
        const answer = await deps.request('WEB_SEARCH_TEST', typed ? { apiKey: typed } : {})
        testStatus.textContent = Number(answer.results) > 0 ? t('能用：搜到了结果。', 'It works: results came back.') : t('能用，但这次没有搜到结果。', 'It works, but this search had no results.')
      } catch (caught) {
        testStatus.textContent = caught instanceof Error ? caught.message : String(caught)
      }
    })()
  }

  async function removeKey(): Promise<void> {
    if (!confirm(t('移除 Tavily 的 API Key 吗？API 成员将不再搜索。', 'Remove the Tavily API key? API members will no longer search.'))) return
    try {
      await deps.runCommand('WEB_SEARCH_SAVE', { remove: true })
      saved.hidden = true
      error.textContent = ''
      render()
      keyInput.focus()
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    }
  }

  function button(text: string, className: string, run: () => void): HTMLButtonElement {
    const node = element('button', className, text)
    node.type = 'button'
    node.addEventListener('click', run)
    return node
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    if (openDialog === controller) openDialog = undefined
    deps.onClose?.()
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
