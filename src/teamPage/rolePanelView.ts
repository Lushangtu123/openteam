import { CHAT_SITES, chatSiteLabel, isChatSite } from '../group/chatSites'
import { roleMentionLabel, roleMentionLabelOptionsFromSettings } from '../group/mentionParser'
import type { ChatSite, ExternalModelConfig, GroupRole, OpenTeamStore, RoleModelSource, RoleStatus } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import type { TeamPageState } from './appState'
import { createIcon } from './icons'
import { PROBLEM_HEALTH_STATUSES, rolePageHealthLabel, type RolePageHealth } from './roleHealth'

const VISIBLE_CHAT_SITES = CHAT_SITES

interface RolePanelIframeHost {
  recoverRole(role: GroupRole): void
}

export interface RolePanelViewDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  rolePanelEl: HTMLElement
  roleSummaryEl: HTMLElement
  roleListEl: HTMLElement
  iframeHost: RolePanelIframeHost
  getCurrentChat(): unknown
  getCurrentRoles(): GroupRole[]
  emptyCard(title: string, body: string): HTMLElement
  roleToneClass(seed: string | undefined): string
  roleAvatarLabel(name: string | undefined): string
  insertMention(role: GroupRole): void
  refreshCurrentChat(): Promise<void>
  focusRoleFrame(chatId: string, roleId: string | undefined): void
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
  // Live health of a web role's page; without it the card falls back to the stored connection info.
  getRoleHealth?(role: GroupRole): RolePageHealth
  openRoleSite?(role: GroupRole): void
}

export interface RolePanelView {
  renderRolePanel(): void
}

export function createRolePanelView(deps: RolePanelViewDependencies): RolePanelView {
  function renderRolePanel(): void {
    const roles = deps.getCurrentRoles()
    const store = deps.getStore()
    const selectedRole = deps.state.selectedRoleId ? store.rolesById[deps.state.selectedRoleId] : undefined
    deps.rolePanelEl.classList.toggle('open', deps.state.peopleDrawerOpen)
    deps.roleSummaryEl.textContent = ui(`${roles.length} 位成员${selectedRole ? ` · 当前：${selectedRole.name}` : ''}`)
    deps.roleListEl.replaceChildren()

    if (!deps.getCurrentChat()) {
      deps.roleListEl.append(deps.emptyCard(ui('未选择群聊'), ui('选择群聊后可添加、查看、恢复和唤醒人员。')))
    } else if (roles.length === 0) {
      deps.roleListEl.append(deps.emptyCard(ui('暂无人员'), ui('点「添加成员」，从人员库批量加入或临时添加。')))
    } else {
      for (const role of roles) deps.roleListEl.append(roleCard(role))
    }
  }

  function roleCard(role: GroupRole): HTMLElement {
    const card = document.createElement('section')
    card.className = `role-card${role.id === deps.state.selectedRoleId ? ' active' : ''}`
    card.addEventListener('click', () => {
      deps.state.selectedRoleId = role.id
      deps.state.roleSiteMenuRoleId = undefined
      deps.state.roleActionMenuRoleId = undefined
      renderRolePanel()
    })

    const avatar = document.createElement('div')
    avatar.className = `role-avatar ${deps.roleToneClass(role.name)}`
    avatar.textContent = deps.roleAvatarLabel(role.name)
    wireMentionShortcut(avatar, role)

    const main = document.createElement('div')
    main.className = 'role-card-main'

    const row = document.createElement('div')
    row.className = 'role-row'
    const name = document.createElement('div')
    name.className = 'role-name'
    name.textContent = role.name
    wireMentionShortcut(name, role)
    row.append(name, statusPill(role.status, ui(roleStatusLabel(role.status))))

    const description = document.createElement('div')
    description.className = 'role-description'
    description.textContent = role.description || ui('未填写人员描述')

    const health = role.modelSource === 'external' ? undefined : deps.getRoleHealth?.(role)
    const meta = document.createElement('div')
    meta.className = 'chat-row tiny role-meta'
    meta.append(roleSiteControl(role), roleContextProgress(role, ui), health ? roleHealthBadge(health) : roleConnectionStatus(role, ui))
    main.append(row, description, meta)

    // One ⋯ button per card; its menu holds the prompt, the web page's actions and, last, removing.
    const actions = document.createElement('div')
    actions.className = 'role-card-actions'
    actions.append(roleMoreButton(role))
    if (deps.state.roleActionMenuRoleId === role.id) actions.append(roleActionMenu(role))
    card.append(avatar, main, actions)

    const healthHelp = health ? roleHealthHelp(role, health) : undefined
    if (healthHelp) {
      // Below the whole card: the middle column is too narrow for advice and buttons.
      card.append(healthHelp)
    } else if (role.status === 'error') {
      const error = document.createElement('div')
      error.className = 'reference-box'
      error.textContent = ui('人员异常。若目标站点未登录，请打开登录页后点击恢复人员。')
      main.append(error)
    }
    return card
  }

  function roleMoreButton(role: GroupRole): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'icon-btn role-more-btn'
    button.dataset.roleMore = role.id
    const open = deps.state.roleActionMenuRoleId === role.id
    button.setAttribute('aria-label', language() === 'en' ? `More for ${role.name}` : `${role.name} 的更多操作`)
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', String(open))
    button.append(createIcon('more'))
    button.addEventListener('click', event => {
      event.stopPropagation()
      deps.state.roleSiteMenuRoleId = undefined
      deps.state.roleActionMenuRoleId = open ? undefined : role.id
      renderRolePanel()
      if (!open) deps.roleListEl.querySelector<HTMLButtonElement>('.role-action-menu [role="menuitem"]')?.focus()
    })
    return button
  }

  function roleActionMenu(role: GroupRole): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'role-action-menu'
    menu.setAttribute('role', 'menu')
    menu.addEventListener('click', event => event.stopPropagation())
    const web = role.modelSource !== 'external'
    menu.append(rolePromptDetailButton(role))
    if (web) menu.append(roleRefreshButton(role), roleJumpButton(role))
    menu.append(roleDeleteButton(role))
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRoleActionMenu()
        deps.roleListEl.querySelector<HTMLButtonElement>(`[data-role-more="${CSS.escape(role.id)}"]`)?.focus()
      }
    })
    return menu
  }

  function closeRoleActionMenu(): void {
    deps.state.roleActionMenuRoleId = undefined
    renderRolePanel()
  }

  function roleMenuItem(className: string, icon: Parameters<typeof createIcon>[0], label: string, ariaLabel: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `role-action-item ${className}`
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-label', ariaLabel)
    const text = document.createElement('span')
    text.textContent = ui(label)
    button.append(createIcon(icon), text)
    button.addEventListener('click', event => {
      event.stopPropagation()
      deps.state.roleActionMenuRoleId = undefined
      run()
    })
    return button
  }

  function rolePromptDetailButton(role: GroupRole): HTMLButtonElement {
    const button = roleMenuItem('role-prompt-detail', 'prompt', '查看提示词', language() === 'en' ? `View ${role.name}'s prompt` : `查看 ${role.name} 的提示词`, () => {
      renderRolePanel()
      openRolePromptDetail(role)
    })
    button.dataset.rolePromptDetail = role.id
    return button
  }

  function openRolePromptDetail(role: GroupRole): void {
    document.querySelector('.role-prompt-modal')?.remove()

    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop role-prompt-modal'
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) backdrop.remove()
    })

    const modal = document.createElement('section')
    modal.className = 'modal template-detail-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-labelledby', 'role-prompt-detail-title')
    modal.addEventListener('click', event => event.stopPropagation())

    const header = document.createElement('div')
    header.className = 'modal-header'
    const copy = document.createElement('div')
    const title = document.createElement('h2')
    title.id = 'role-prompt-detail-title'
    title.textContent = role.name
    const description = document.createElement('p')
    description.className = 'tiny'
    description.textContent = role.description || ui('未填写人员描述')
    copy.append(title, description)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'icon-btn modal-close role-prompt-close'
    close.setAttribute('aria-label', ui('关闭提示词详情'))
    close.append(createIcon('close'))
    close.addEventListener('click', () => backdrop.remove())
    header.append(copy, close)

    const prompt = document.createElement('pre')
    prompt.className = 'template-prompt-preview'
    prompt.textContent = role.systemPrompt?.trim() || ui('未填写提示词')

    modal.append(header, prompt)
    backdrop.append(modal)
    document.body.append(backdrop)
    close.focus()
  }

  // Web members only: reloads the member's AI page.
  function roleRefreshButton(role: GroupRole): HTMLButtonElement {
    const button = roleMenuItem('role-refresh', 'refresh', '刷新网页', language() === 'en' ? `Refresh ${role.name}'s member window` : `刷新 ${role.name} 的成员窗口`, () => {
      renderRolePanel()
      reloadRoleFrame(role)
    })
    button.dataset.roleRefresh = role.id
    return button
  }

  function reloadRoleFrame(role: GroupRole): void {
    deps.iframeHost.recoverRole(role)
    deps.runCommand('GROUP_ROLE_RECOVER', { chatId: role.chatId, roleId: role.id })
      .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function roleHealthBadge(health: RolePageHealth): HTMLElement {
    const badge = document.createElement('span')
    badge.className = `role-meta-item role-health role-health-${health.status}`
    badge.dataset.health = health.status
    badge.textContent = ui(rolePageHealthLabel(health))
    if (health.detail) badge.title = health.detail
    return badge
  }

  // What went wrong with the role's page and what the user can do about it.
  function roleHealthHelp(role: GroupRole, health: RolePageHealth): HTMLElement | undefined {
    if (!PROBLEM_HEALTH_STATUSES.has(health.status)) return undefined
    const help = document.createElement('div')
    help.className = 'reference-box role-health-help'
    const text = document.createElement('p')
    text.textContent = ui(roleHealthAdvice(health, role))
    help.append(text)
    if (health.detail) {
      const detail = document.createElement('p')
      detail.className = 'role-health-detail'
      detail.textContent = health.detail
      help.append(detail)
    }

    const actions = document.createElement('div')
    actions.className = 'role-health-actions'
    const needsSiteVisit = health.status === 'login-required' || health.status === 'unresponsive' || health.reason === 'verification'
    if (needsSiteVisit && deps.openRoleSite) actions.append(roleHealthAction('打开网站', () => deps.openRoleSite?.(role)))
    if (health.reason === 'overlay') actions.append(roleHealthAction('查看网页', () => deps.focusRoleFrame(role.chatId, role.id)))
    actions.append(roleHealthAction('重新加载', () => reloadRoleFrame(role)))
    help.append(actions)
    return help
  }

  function roleHealthAction(label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-ghost btn-small role-health-action'
    button.textContent = ui(label)
    button.addEventListener('click', event => {
      event.stopPropagation()
      run()
    })
    return button
  }

  // Web members only: shows the member's AI page.
  function roleJumpButton(role: GroupRole): HTMLButtonElement {
    return roleMenuItem('role-jump', 'external', '查看网页', language() === 'en' ? `Jump to ${role.name}'s source window` : `跳转到 ${role.name} 的原始窗口`, () => {
      renderRolePanel()
      deps.focusRoleFrame(role.chatId, role.id)
    })
  }

  // Last in the menu, and asks first.
  function roleDeleteButton(role: GroupRole): HTMLButtonElement {
    const button = roleMenuItem('role-delete', 'trash', '移出群聊', language() === 'en' ? `Delete ${role.name}` : `删除 ${role.name}`, () => {
      deps.state.roleSiteMenuRoleId = undefined
      kickRoleFromChat(role).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
    button.dataset.roleDelete = role.id
    return button
  }

  function roleSiteControl(role: GroupRole): HTMLElement {
    const control = document.createElement('div')
    control.className = 'role-site-control'
    const sitePill = document.createElement('button')
    sitePill.type = 'button'
    const model = roleModelOption(role, deps.getStore())
    sitePill.className = `site-pill ${model.className}`
    sitePill.setAttribute('aria-expanded', String(deps.state.roleSiteMenuRoleId === role.id))
    sitePill.textContent = model.label
    sitePill.addEventListener('click', event => {
      event.stopPropagation()
      deps.state.roleActionMenuRoleId = undefined
      deps.state.roleSiteMenuRoleId = deps.state.roleSiteMenuRoleId === role.id ? undefined : role.id
      renderRolePanel()
    })
    control.append(sitePill)
    if (deps.state.roleSiteMenuRoleId === role.id) control.append(roleSiteMenu(role))
    return control
  }

  function roleSiteMenu(role: GroupRole): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'role-site-menu'
    menu.addEventListener('click', event => event.stopPropagation())
    for (const model of selectableModels(deps.getStore())) {
      const option = document.createElement('button')
      option.type = 'button'
      const active = roleModelKey(role, deps.getStore()) === model.key
      option.className = `role-site-option${active ? ' active' : ''}`
      option.textContent = active ? `✓ ${model.label}` : model.label
      option.addEventListener('click', () => {
        deps.state.roleSiteMenuRoleId = undefined
        if (active) {
          renderRolePanel()
          return
        }
        switchRoleSite(role, model.key).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
      })
      menu.append(option)
    }
    return menu
  }

  async function kickRoleFromChat(role: GroupRole): Promise<void> {
    if (!window.confirm(`确定将「${role.name}」移出当前群聊吗？历史聊天记录会保留。`)) {
      renderRolePanel()
      return
    }
    await deps.runCommand('GROUP_ROLE_DELETE', { roleId: role.id })
  }

  async function switchRoleSite(role: GroupRole, modelKey: string): Promise<void> {
    if (roleModelKey(role, deps.getStore()) === modelKey) return
    const patch = rolePatchForModelKey(modelKey)
    await deps.runCommand('GROUP_ROLE_UPDATE', { roleId: role.id, patch })
    const updatedRole = deps.getStore().rolesById[role.id]
    if (!updatedRole) return
    if (updatedRole.modelSource === 'external') return
    deps.iframeHost.recoverRole(updatedRole)
    await deps.runCommand('GROUP_ROLE_RECOVER', { chatId: updatedRole.chatId, roleId: updatedRole.id })
  }

  return { renderRolePanel }

  function language() {
    return normalizeLanguage(deps.getStore().settings.language)
  }

  function ui(source: string): string {
    return translateUi(source, language())
  }

  function wireMentionShortcut(element: HTMLElement, role: GroupRole): void {
    element.classList.add('mention-shortcut')
    element.title = `@${roleMentionLabel(role, roleMentionLabelOptionsFromSettings(deps.getStore().settings))}`
    element.addEventListener('click', event => {
      event.stopPropagation()
      deps.insertMention(role)
    })
    element.addEventListener('contextmenu', event => {
      event.preventDefault()
      event.stopPropagation()
      deps.insertMention(role)
    })
  }
}

function siteLabel(site: ChatSite | undefined): string {
  return chatSiteLabel(site)
}

function selectableModels(store: OpenTeamStore): Array<{ key: string; label: string; className: string }> {
  return [
    ...VISIBLE_CHAT_SITES.map(site => ({ key: modelKeyForSite(site), label: siteLabel(site), className: `site-pill-${site}` })),
    ...externalModels(store).map(model => ({ key: modelKeyForExternal(model.id), label: `API · ${model.name}`, className: 'site-pill-external' })),
  ]
}

function roleModelOption(role: GroupRole, store: OpenTeamStore): { key: string; label: string; className: string } {
  const key = roleModelKey(role, store)
  return selectableModels(store).find(model => model.key === key) ?? { key, label: 'API · 未配置', className: 'site-pill-external' }
}

function roleModelKey(role: Pick<GroupRole, 'modelSource' | 'externalModelId' | 'chatSite'>, store: OpenTeamStore): string {
  if (role.modelSource === 'external' && role.externalModelId) return modelKeyForExternal(role.externalModelId)
  return modelKeyForSite(role.chatSite ?? store.settings.defaultChatSite)
}

function rolePatchForModelKey(key: string): { modelSource: RoleModelSource; chatSite?: ChatSite; externalModelId?: string } {
  const externalModelId = key.startsWith('external:') ? key.slice('external:'.length) : ''
  if (externalModelId) return { modelSource: 'external', externalModelId }
  return { modelSource: 'site', chatSite: visibleChatSite(key.startsWith('site:') ? key.slice('site:'.length) : key) }
}

function externalModels(store: OpenTeamStore): ExternalModelConfig[] {
  return store.settings.externalModelOrder
    .map(modelId => store.settings.externalModelsById[modelId])
    .filter((model): model is ExternalModelConfig => Boolean(model))
}

function modelKeyForSite(site: ChatSite): string {
  return `site:${site}`
}

function modelKeyForExternal(modelId: string): string {
  return `external:${modelId}`
}

function visibleChatSite(value: string | undefined): ChatSite {
  return isChatSite(value) ? value : 'gemini'
}

function statusPill(status: string, label: string): HTMLElement {
  const pill = document.createElement('span')
  pill.className = `status-pill status-${status}`
  pill.textContent = label
  return pill
}

function roleContextProgress(role: GroupRole, ui: (source: string) => string): HTMLElement {
  const progress = document.createElement('span')
  progress.className = 'role-meta-item'
  progress.textContent = ui(role.contextCursor > 0 ? `已读 ${role.contextCursor} 条` : '还没读过群消息')
  return progress
}

// Claude.ai refuses to run inside another page, so a Claude web member cannot work here.
const CLAUDE_EMBED_ADVICE = 'Claude 网页会检查自己是否被嵌在别的页面里，发现后就拒绝运行，所以在 OpenTeam 里用不了 Claude 网页版。可以改用 Claude API：在「外部模型」里添加 Anthropic 格式的模型，再让这个人员使用它。'

export function roleHealthAdvice(health: RolePageHealth, role?: Pick<GroupRole, 'chatSite' | 'modelSource'>): string {
  const claudeWeb = role?.modelSource !== 'external' && role?.chatSite === 'claude'
  if (health.reason === 'embed-blocked') return claudeWeb ? CLAUDE_EMBED_ADVICE : '这个网站会检查自己是否被嵌在别的页面里，发现后就拒绝运行，所以在 OpenTeam 里用不了它的网页版。可以改用这个模型的 API，在「外部模型」里添加。'
  if (health.status === 'unresponsive' && claudeWeb) return CLAUDE_EMBED_ADVICE
  if (health.status === 'unresponsive') return '网页 20 秒内没有连上 OpenTeam。常见原因是网站跳转到了登录页、网络不通，或者网站拒绝在这里打开。可以先在新标签页打开网站登录，再点「重新加载」。'
  if (health.status === 'login-required') return '这个网站还没有登录。请在新标签页打开网站登录，然后点「重新加载」。'
  if (health.reason === 'verification') return '网站要求完成人机验证。请在新标签页打开网站完成验证，然后点「重新加载」。'
  if (health.reason === 'http-error') return '网站拒绝了这次访问，可能是网络、地区或访问频率的限制。稍后再试，或者换一个网络。'
  if (health.reason === 'overlay') return '页面上有弹窗（例如 Cookie 提示）挡住了输入框。点「查看网页」把它关掉。'
  if (health.reason === 'no-editor') return '页面里找不到输入框，可能还没加载完，或者网站改版了。可以点「重新加载」再试。'
  if (health.reason === 'site-error') return '网站显示了错误信息，消息可能发不出去。'
  return '网页暂时无法使用。可以点「重新加载」再试。'
}

function roleConnectionStatus(role: GroupRole, ui: (source: string) => string): HTMLElement {
  const status = document.createElement('span')
  status.className = 'role-meta-item'
  if (role.siteHealth) {
    const label = ui(siteHealthLabel(role.siteHealth.status))
    status.textContent = role.siteHealth.detail ? `${label}：${role.siteHealth.detail}` : label
    return status
  }
  status.textContent = ui(role.modelSource === 'external' ? '通过 API 回复' : role.geminiConversationUrl ? '网页已连接' : '等待连接')
  return status
}

function siteHealthLabel(status: NonNullable<GroupRole['siteHealth']>['status']): string {
  const labels: Record<NonNullable<GroupRole['siteHealth']>['status'], string> = {
    ready: '页面可用',
    generating: '页面回复中',
    error: '页面异常',
    blocked: '页面被阻止',
    unauthorized: '需要登录',
    loading: '页面加载中',
  }
  return labels[status]
}

function roleStatusLabel(status: RoleStatus): string {
  const labels: Record<RoleStatus, string> = {
    pending: '待唤醒',
    loading: '加载中',
    ready: '在线',
    thinking: '回复中',
    stopped: '已停止',
    error: '异常',
  }
  return labels[status]
}
