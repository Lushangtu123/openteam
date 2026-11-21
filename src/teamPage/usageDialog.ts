// 用量: what the members answered and what it cost, for a time range and all groups or one
// (src/group/usageStats.ts): totals, answers per day, and tables by member, group and site.
import type { OpenTeamStore } from '../group/types'
import { computeUsage, formatCost, rangeStart, type UsageRange, type UsageReport } from '../group/usageStats'
import { spentInRange } from '../group/accountBalance'
import { capBlocks, modelSpendToday, money as capMoney } from '../group/spendCap'
import { normalizeLanguage } from '../shared/i18n'
import { searchesInRange, searchQuotaState } from '../shared/webSearchUsage'
import { accountUsageText } from './webSearchAccountText'
import { createIcon } from './icons'

export interface UsageDialogDependencies {
  getStore(): OpenTeamStore
  now?(): number
  // Reads the DeepSeek and Kimi accounts' balances again (src/background/accountBalances.ts).
  refreshBalances?(): Promise<{ errors?: Array<{ label: string; error: string }> }>
  // Reads the Tavily account's credits again (src/background/webSearcher.ts); throws why not.
  refreshSearchAccount?(): Promise<void>
  // 今天继续用: lifts a model's daily spending cap for today (src/group/spendCap.ts).
  liftSpendCap?(modelId: string): Promise<void>
  // Puts the focus back where the window was opened from.
  onClose?(): void
}

const RANGES: Array<{ range: UsageRange; zh: string; en: string }> = [
  { range: 'today', zh: '今天', en: 'Today' },
  { range: '7d', zh: '近 7 天', en: 'Last 7 days' },
  { range: '30d', zh: '近 30 天', en: 'Last 30 days' },
  { range: 'all', zh: '全部', en: 'All time' },
]

let openDialog: { refresh(): void; close(): void } | undefined

export function currentUsageDialog(): { refresh(): void; close(): void } | undefined {
  return openDialog
}

export function openUsageDialog(deps: UsageDialogDependencies): { refresh(): void; close(): void } {
  openDialog?.close()
  const now = deps.now ?? (() => Date.now())
  const english = () => normalizeLanguage(deps.getStore().settings.language) === 'en'
  const t = (zh: string, en: string): string => english() ? en : zh
  let range: UsageRange = '7d'
  let chatId = ''
  let balanceErrors: Array<{ label: string; error: string }> = []
  let refreshing = false
  let searchAccountError = ''
  // The page redraws on every store update, every few seconds while members work; the window is
  // drawn again only when something it shows changed, so it does not flash as it is scrolled.
  let drawnScope = ''
  let drawnContent = ''

  const backdrop = element('div', 'modal-backdrop usage-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal usage-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'usage-title')
  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('用量', 'Usage'))
  title.id = 'usage-title'
  heading.append(title, element('p', 'tiny', t(
    '成员回答了多少次、API 模型用了多少 token。费用按你在「设置 → 模型」里填的单价估算；没填单价的模型只统计 token。',
    'How often members answered and how many tokens the API models used. Costs are estimated from the prices you entered under Settings → Models; models without one count tokens only.',
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const controls = element('div', 'usage-controls')
  const ranges = element('div', 'usage-ranges')
  ranges.setAttribute('role', 'group')
  ranges.setAttribute('aria-label', t('时间范围', 'Time range'))
  const rangeButtons = RANGES.map(item => {
    const button = element('button', 'btn btn-small usage-range')
    button.type = 'button'
    button.dataset.range = item.range
    button.textContent = t(item.zh, item.en)
    button.addEventListener('click', () => {
      range = item.range
      render()
    })
    ranges.append(button)
    return button
  })
  const scope = element('select', 'usage-scope')
  scope.setAttribute('aria-label', t('范围', 'Scope'))
  scope.addEventListener('change', () => {
    chatId = scope.value
    render()
  })
  controls.append(ranges, scope)

  const content = element('div', 'usage-content')
  dialog.append(header, controls, content)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  render()
  rangeButtons[1].focus()
  void refreshBalances()
  void refreshSearchAccount()

  async function refreshSearchAccount(): Promise<void> {
    if (!deps.refreshSearchAccount || !deps.getStore().settings.webSearch) return
    try {
      await deps.refreshSearchAccount()
      searchAccountError = ''
    } catch (error) {
      searchAccountError = error instanceof Error ? error.message : String(error)
    }
    if (openDialog === controller) render()
  }

  async function refreshBalances(): Promise<void> {
    if (!deps.refreshBalances || refreshing) return
    refreshing = true
    render()
    try {
      balanceErrors = (await deps.refreshBalances()).errors ?? []
    } catch (error) {
      balanceErrors = [{ label: t('账户余额', 'Account balances'), error: error instanceof Error ? error.message : String(error) }]
    } finally {
      refreshing = false
      if (openDialog === controller) render()
    }
  }

  function render(): void {
    const store = deps.getStore()
    for (const button of rangeButtons) button.setAttribute('aria-pressed', String(button.dataset.range === range))
    if (chatId && !store.chatsById[chatId]) chatId = ''
    const groups = store.chatOrder.flatMap(id => store.chatsById[id] ? [[id, store.chatsById[id].name]] : [])
    const scopeKey = JSON.stringify([english(), groups])
    if (scopeKey !== drawnScope) {
      drawnScope = scopeKey
      scope.replaceChildren(option('', t('全部群聊', 'All groups')), ...groups.map(([id, name]) => option(id, name)))
    }
    scope.value = chatId
    const report = computeUsage(store, { range, ...(chatId ? { chatId } : {}), now: now() })
    const caps = cappedModels(store).map(model => [model.id, model.name, model.dailyCap, model.pricing?.currency, modelSpendToday(store, model.id, now())])
    const contentKey = JSON.stringify([english(), range, chatId, report, store.accountBalancesById ?? {}, caps, balanceErrors, refreshing, new Date(now()).toDateString(), store.webSearchUsage ?? {}, Boolean(store.settings.webSearch), searchAccountError])
    if (contentKey === drawnContent) return
    drawnContent = contentKey
    const scrolled = dialog.scrollTop
    const accounts = accountsSection(store)
    const capList = capsSection(store)
    const searches = searchesSection(store)
    content.replaceChildren(...sections(report), ...(searches ? [searches] : []), ...(capList ? [capList] : []), ...(accounts ? [accounts] : []))
    dialog.scrollTop = scrolled
  }

  // 联网搜索: the searches in the range (by model), and the Tavily account's credits as Tavily said.
  function searchesSection(store: OpenTeamStore): HTMLElement | undefined {
    const inRange = searchesInRange(store.webSearchUsage, rangeStart(range, now()), now(), chatId || undefined)
    const everSearched = Object.keys(store.webSearchUsage?.days ?? {}).length > 0
    if (!store.settings.webSearch && !everSearched) return undefined
    const section = element('section', 'usage-searches')
    section.append(element('h3', 'usage-section-title', t('联网搜索（Tavily）', 'Web search (Tavily)')))
    const rangeText = inRange.total === 0
      ? (chatId ? t('这个群这段时间没有搜索。', 'No searches in this group in this time.') : t('这段时间没有搜索。', 'No searches in this time.'))
      : inRange.tests > 0
        ? t(`这段时间搜索 ${inRange.total} 次（其中测试 ${inRange.tests} 次）。`, `${inRange.total} searches in this time (${inRange.tests} of them tests).`)
        : t(`这段时间搜索 ${inRange.total} 次。`, `${inRange.total} searches in this time.`)
    section.append(element('p', 'usage-searches-summary', rangeText))
    const account = store.settings.webSearch ? accountUsageText(store.webSearchUsage, english(), now()) : undefined
    if (account) {
      const line = element('p', 'usage-searches-account', t(`Tavily 账户：${account}`, `Tavily account: ${account}`))
      if (searchQuotaState(store.webSearchUsage)?.near) line.classList.add('usage-searches-near')
      section.append(line)
    }
    if (searchAccountError) section.append(element('p', 'usage-account-error tiny', t(`没读到 Tavily 的用量：${searchAccountError}`, `Could not read Tavily's usage: ${searchAccountError}`)))
    const models = Object.entries(inRange.byModel).sort((left, right) => right[1] - left[1])
    if (models.length > 0) {
      section.append(table('', [t('模型', 'Model'), t('搜索', 'Searches')], models.map(([modelId, count]) => [store.settings.externalModelsById[modelId]?.name ?? t('已删除的模型', 'A deleted model'), String(count)]), 'usage-search-models'))
    }
    section.append(element('p', 'tiny usage-account-note', t(
      '每次搜索用掉 1 个 Tavily 额度。上面的次数是 OpenTeam 发出的搜索；账户用量来自 Tavily，包括这个 Key 在别处用掉的额度，用到八成时会提醒你。',
      "Each search uses one Tavily credit. The counts above are OpenTeam's searches; the account's usage comes from Tavily, credits the key used elsewhere included, and you are told at 80%.",
    )))
    return section
  }

  function cappedModels(store: OpenTeamStore) {
    return store.settings.externalModelOrder.flatMap(id => {
      const model = store.settings.externalModelsById[id]
      return model?.pricing && model.dailyCap !== undefined && model.format !== 'local-agent' ? [model] : []
    })
  }

  // 花费上限: each capped model's estimated spend today, and 今天继续用 for one that is stopped.
  function capsSection(store: OpenTeamStore): HTMLElement | undefined {
    const models = cappedModels(store)
    if (models.length === 0) return undefined
    const section = element('section', 'usage-caps')
    section.append(element('h3', 'usage-section-title', t('每日花费上限（估算）', 'Daily spending caps (estimated)')))
    const states = models.map(model => {
      const spend = modelSpendToday(store, model.id, now())
      const blocked = capBlocks(store, model, now())
      const state = spend.lifted
        ? t('今天已放开', 'Lifted for today')
        : blocked
          ? t('已停用到明天', 'Stopped until midnight')
          : spend.spent >= (model.dailyCap ?? 0) * 0.8
            ? t('已过八成', 'Over 80%')
            : t('正常', 'Within the cap')
      return { model, spend, blocked, state }
    })
    const wrap = table('', [t('模型', 'Model'), t('今天估算花费', 'Spent today'), t('每日上限', 'Daily cap'), t('状态', 'State')], states.map(({ model, spend, state }) => [
      model.name,
      capMoney(model, spend.spent),
      capMoney(model, model.dailyCap ?? 0),
      state,
    ]), 'usage-cap-table')
    const rows = [...wrap.querySelectorAll('tbody tr')]
    states.forEach(({ model, blocked }, index) => {
      if (!blocked || !deps.liftSpendCap) return
      const button = element('button', 'btn btn-ghost btn-small usage-cap-lift', t('今天继续用', 'Keep using today'))
      button.type = 'button'
      button.addEventListener('click', () => {
        button.disabled = true
        deps.liftSpendCap!(model.id).catch(() => { button.disabled = false })
      })
      rows[index]?.lastElementChild?.append(button)
    })
    section.append(wrap, element('p', 'tiny usage-account-note', t(
      '按每个模型的单价估算，每次调用后累加，每天 0 点重新计算。到上限后这个模型今天不再被调用（回复、总结、项目任务、作为网页成员的备用都算）。在「设置 → 模型」里改上限。',
      "Estimated from each model's price, added up after every call, and reset at midnight. At the cap the model is not called again today (replies, summaries, project tasks and backing up a web member all count). Change the caps under Settings → Models.",
    )))
    return section
  }

  // What the DeepSeek and Kimi accounts really spent, from their balances (like dsh-whale-widget).
  function accountsSection(store: OpenTeamStore): HTMLElement | undefined {
    const accounts = Object.values(store.accountBalancesById ?? {})
    if (accounts.length === 0 && balanceErrors.length === 0 && !refreshing) return undefined
    const section = element('section', 'usage-accounts')
    const head = element('div', 'usage-accounts-head')
    head.append(element('h3', 'usage-section-title', t('服务商账户（实际消耗）', 'Provider accounts (actual spend)')))
    if (deps.refreshBalances) {
      const refresh = element('button', 'btn btn-ghost btn-small usage-refresh')
      refresh.type = 'button'
      refresh.disabled = refreshing
      refresh.append(createIcon('refresh'), element('span', '', refreshing ? t('读取中…', 'Reading…') : t('刷新余额', 'Refresh balances')))
      refresh.addEventListener('click', () => void refreshBalances())
      head.append(refresh)
    }
    section.append(head)
    const money = (amount: number, currency: 'CNY' | 'USD') => formatCost({ [currency]: amount })
    const start = rangeStart(range, now())
    if (accounts.length > 0) {
      section.append(table('', [t('账户', 'Account'), t('余额', 'Balance'), t('今天消耗', 'Spent today'), t('本时段消耗', 'Spent in range'), t('更新于', 'Updated')], accounts.map(account => [
        `${account.provider === 'deepseek' ? 'DeepSeek' : 'Kimi'} · ${account.label}`,
        money(account.balance, account.currency),
        money(spentInRange(account, rangeStart('today', now()), now()), account.currency),
        money(spentInRange(account, start, now()), account.currency),
        `${new Date(account.checkedAt).toLocaleString(english() ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}${account.error ? t(`（上次读取失败：${account.error}）`, ` (last read failed: ${account.error})`) : ''}`,
      ]), 'usage-account-table'))
    }
    for (const item of balanceErrors) section.append(element('p', 'usage-account-error tiny', t(`没读到「${item.label}」的余额：${item.error}`, `Could not read the balance of "${item.label}": ${item.error}`)))
    section.append(element('p', 'tiny usage-account-note', t(
      '从 DeepSeek、Kimi 读取的账户余额：每次余额减少就记为当天的消耗，充值不算。这是整个账户的消费，也包括 OpenTeam 以外（比如 DSH）用掉的，从 OpenTeam 开始读取时算起；每小时读一次，打开这个窗口时也会读。',
      "Balances read from DeepSeek and Kimi: each drop counts as that day's spend, top-ups do not. It is the whole account's spend, use outside OpenTeam (DSH, say) included, from when OpenTeam began reading; it is read every hour and when this window opens.",
    )))
    return section
  }

  function sections(report: UsageReport): HTMLElement[] {
    if (report.total.replies === 0) return [element('p', 'usage-empty', t('这段时间里还没有成员回答过。', 'No member answered in this time.'))]
    const total = report.total
    const tiles = element('div', 'usage-tiles')
    tiles.append(
      tile(t('回答', 'Answers'), String(total.replies)),
      tile(t('输入 token', 'Input tokens'), formatNumber(total.inputTokens)),
      tile(t('输出 token', 'Output tokens'), formatNumber(total.outputTokens)),
      tile(t('估算费用', 'Estimated cost'), formatCost(total.cost), total.unpricedTokens > 0 ? t(`另有 ${formatNumber(total.unpricedTokens)} token 没有单价`, `${formatNumber(total.unpricedTokens)} tokens have no price`) : undefined),
    )
    const result: HTMLElement[] = [tiles]
    if (report.days.length > 1) result.push(dayChart(report))
    result.push(table(t('按成员', 'By member'), [t('成员', 'Member'), t('群', 'Group'), t('模型', 'Model'), t('回答', 'Answers'), t('输入', 'Input'), t('输出', 'Output'), t('费用', 'Cost')], report.members.map(row => [
      row.removed ? t(`${row.name}（已移出）`, `${row.name} (left)`) : row.name,
      row.chatName,
      `${row.model}${row.kind === 'web' ? t(' · 网页', ' · web') : row.kind === 'agent' ? t(' · 本机智能体', ' · local agent') : ''}`,
      row.backupReplies > 0 ? t(`${row.replies}（备用 ${row.backupReplies}）`, `${row.replies} (backup ${row.backupReplies})`) : String(row.replies),
      formatNumber(row.inputTokens),
      formatNumber(row.outputTokens),
      formatCost(row.cost),
    ]), 'usage-members'))
    if (!chatId && report.chats.length > 1) {
      result.push(table(t('按群聊', 'By group'), [t('群', 'Group'), t('回答', 'Answers'), t('输入', 'Input'), t('输出', 'Output'), t('费用', 'Cost')], report.chats.map(row => [row.name, String(row.replies), formatNumber(row.inputTokens), formatNumber(row.outputTokens), formatCost(row.cost)]), 'usage-chats'))
    }
    if (report.sites.length > 0) {
      result.push(table(t('网页成员（按网站）', 'Web members (by site)'), [t('网站', 'Site'), t('自己回答', 'Answered itself'), t('上次限流时', 'Last limited at')], report.sites.map(row => [row.label, String(row.replies), row.limitCount ? t(`第 ${row.limitCount} 条`, `message ${row.limitCount}`) : '—']), 'usage-sites'))
    }
    return result
  }

  // Answers per day, as bars; each bar's height is its share of the busiest day.
  function dayChart(report: UsageReport): HTMLElement {
    const figure = element('figure', 'usage-chart')
    figure.append(element('figcaption', 'usage-section-title', t('每天的回答', 'Answers per day')))
    const bars = element('div', 'usage-bars')
    const most = Math.max(1, ...report.days.map(day => day.replies))
    for (const day of report.days) {
      const column = element('div', 'usage-bar')
      column.title = t(`${day.day}：${day.replies} 次回答`, `${day.day}: ${day.replies} answers`)
      const fill = element('span', 'usage-bar-fill')
      fill.style.height = `${Math.round(day.replies / most * 100)}%`
      column.append(element('span', 'usage-bar-count', day.replies > 0 ? String(day.replies) : ''), fill, element('span', 'usage-bar-day', day.day.slice(5)))
      bars.append(column)
    }
    figure.append(bars)
    return figure
  }

  function tile(label: string, value: string, note?: string): HTMLElement {
    const node = element('div', 'usage-tile')
    node.append(element('span', 'usage-tile-label', label), element('strong', 'usage-tile-value', value))
    if (note) node.append(element('span', 'usage-tile-note', note))
    return node
  }

  function table(caption: string, headings: string[], rows: string[][], className: string): HTMLElement {
    const wrap = element('div', `usage-table-wrap ${className}`)
    const node = element('table', 'usage-table')
    if (caption) node.append(element('caption', 'usage-section-title', caption))
    const head = element('tr')
    for (const text of headings) {
      const cell = element('th', '', text)
      cell.scope = 'col'
      head.append(cell)
    }
    const thead = element('thead')
    thead.append(head)
    const body = element('tbody')
    for (const row of rows) {
      const line = element('tr')
      for (const text of row) line.append(element('td', '', text))
      body.append(line)
    }
    node.append(thead, body)
    wrap.append(node)
    return wrap
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    if (openDialog === controller) openDialog = undefined
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }

  const controller = { refresh: render, close }
  openDialog = controller
  return controller
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
